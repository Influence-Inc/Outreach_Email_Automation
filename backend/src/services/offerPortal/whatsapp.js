'use strict';

// Offer-portal WhatsApp channel. Supports two backends behind one surface
// (businessNumber / sendWhatsAppText / normalizePhone / renderOfferOutreachBody)
// so callers (offers.js, outreach.js, offerWebhook.js) never change:
//
//   • 'cloud'  — Meta WhatsApp Cloud API, DIRECT (no BSP markup). Sends via
//                Graph API: POST {BASE}/{VERSION}/{PHONE_NUMBER_ID}/messages
//                with `Authorization: Bearer {ACCESS_TOKEN}` and a JSON body.
//                Our creator-initiated flow (creator texts "Hi" first) runs in
//                Meta's free 24h service window, so replies cost nothing.
//   • 'twilio' — Twilio's REST Messages API (BSP). Basic-Auth SID:token, a
//                form-encoded From/To/Body body.
//
// Which one is chosen: WHATSAPP_PROVIDER ('cloud' | 'twilio') wins; unset, we
// auto-detect Cloud when its access token is present, else Twilio — so simply
// setting the WHATSAPP_CLOUD_* vars flips the provider. Sends are skipped
// gracefully when the active provider's creds are absent, so dev never breaks.
//
// 24h window: both providers reject free-form text sent to a user who hasn't
// messaged us in the last 24h (Twilio HTTP 400 code 63016; Meta 4xx code
// 131047/131026). The AiSensy-era session-template fallback was dropped on the
// Twilio swap and is not reintroduced here — a send outside the window fails
// with a clear error and can be retried once the creator messages us again.

const { extractProviderMessageId } = require('./deliveryStatus');

// --- Provider selection ----------------------------------------------------
function whatsappProvider() {
  const explicit = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'cloud' || explicit === 'twilio') return explicit;
  // Auto-detect: Cloud when its access token is set, else fall back to Twilio.
  return process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ? 'cloud' : 'twilio';
}

// --- Twilio config ---------------------------------------------------------
function accountSid() {
  return process.env.TWILIO_ACCOUNT_SID || '';
}
function authToken() {
  return process.env.TWILIO_AUTH_TOKEN || '';
}
function apiBase() {
  return (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
}
function messagesUrl() {
  return `${apiBase()}/2010-04-01/Accounts/${encodeURIComponent(accountSid())}/Messages.json`;
}

// --- Meta WhatsApp Cloud API config ---------------------------------------
function cloudToken() {
  return process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || '';
}
function cloudPhoneNumberId() {
  return process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || '';
}
function cloudApiBase() {
  return (process.env.WHATSAPP_CLOUD_API_BASE || 'https://graph.facebook.com').replace(/\/$/, '');
}
function cloudApiVersion() {
  return process.env.WHATSAPP_CLOUD_API_VERSION || 'v21.0';
}
function cloudMessagesUrl() {
  return `${cloudApiBase()}/${cloudApiVersion()}/${encodeURIComponent(cloudPhoneNumberId())}/messages`;
}

// Our own WhatsApp Business number (E.164 with leading "+"), shown in the invite
// email so a creator knows what to text. For Twilio it doubles as the `From` on
// every send; for Cloud API the sender is bound to PHONE_NUMBER_ID, so this is a
// display value only.
function businessNumber() {
  return whatsappProvider() === 'cloud'
    ? process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER || ''
    : process.env.TWILIO_WHATSAPP_FROM || '';
}

// Bare digits — used to match inbound sender numbers (last-10-digit fallback in
// the webhook) and to normalise stored numbers before wrapping/sending.
function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// Twilio requires the address prefixed with "whatsapp:" and in E.164 with a "+".
function toWhatsAppAddr(raw) {
  const digits = normalizePhone(raw);
  return digits ? `whatsapp:+${digits}` : '';
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString('base64')}`;
}

function buildTwilioForm({ from, to, body }) {
  const params = new URLSearchParams();
  params.set('From', toWhatsAppAddr(from));
  params.set('To', toWhatsAppAddr(to));
  params.set('Body', body);
  return params;
}

// Extract Twilio's error code from a JSON error body so callers/logs can spot
// the 63016 (outside-24h-window) case without regex-matching the message text.
function extractTwilioErrorCode(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed.code === 'number' ? parsed.code : null;
  } catch (_) {
    return null;
  }
}

// Meta Cloud API returns { messages: [{ id: 'wamid...' }] } on a successful
// send — that wamid is what later status webhooks quote, so it's the id we store
// to correlate the outbound offer_messages row with its delivery callbacks.
function extractCloudMessageId(data) {
  if (!data || typeof data !== 'object') return null;
  const m = Array.isArray(data.messages) ? data.messages[0] : null;
  return m && typeof m.id === 'string' ? m.id : null;
}

// Free-form session text via Twilio (within Meta's 24h window). Outside the
// window Twilio returns HTTP 400 code 63016 — surfaced verbatim in the error.
async function sendTwilioText({ to, body }) {
  if (!accountSid() || !authToken() || !process.env.TWILIO_WHATSAPP_FROM) {
    console.warn(
      `[offer-whatsapp] TWILIO_ACCOUNT_SID/AUTH_TOKEN/WHATSAPP_FROM not set — skipping text to ${to}`,
    );
    return { sent: false, skipped: true };
  }
  const recipient = toWhatsAppAddr(to);
  if (!recipient) return { sent: false, error: 'invalid recipient number' };

  try {
    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: buildTwilioForm({ from: process.env.TWILIO_WHATSAPP_FROM, to, body }).toString(),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { sent: true, id: extractProviderMessageId(data) };
    }
    const text = await res.text().catch(() => '');
    const code = extractTwilioErrorCode(text);
    const suffix = code ? ` (twilio code ${code})` : '';
    return { sent: false, error: `${res.status} ${text.slice(0, 200)}${suffix}` };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// Free-form session text via Meta WhatsApp Cloud API (within the 24h window).
// Outside it Meta returns a 4xx (error code 131047/131026) — surfaced verbatim.
async function sendCloudText({ to, body }) {
  if (!cloudToken() || !cloudPhoneNumberId()) {
    console.warn(
      `[offer-whatsapp] WHATSAPP_CLOUD_ACCESS_TOKEN/PHONE_NUMBER_ID not set — skipping text to ${to}`,
    );
    return { sent: false, skipped: true };
  }
  const recipient = normalizePhone(to);
  if (!recipient) return { sent: false, error: 'invalid recipient number' };

  try {
    const res = await fetch(cloudMessagesUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloudToken()}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { sent: true, id: extractCloudMessageId(data) };
    }
    const text = await res.text().catch(() => '');
    return { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// The public send used by offers.js / offerWebhook.js — dispatches to whichever
// provider is configured so callers stay vendor-agnostic.
async function sendWhatsAppText({ to, body }) {
  return whatsappProvider() === 'cloud' ? sendCloudText({ to, body }) : sendTwilioText({ to, body });
}

// The offer-reveal message body (free-form session reply used by
// deliverOfferOverChannel) — also stored in offer_messages so the admin can see
// what the creator received. Points them straight at the portal link to view
// AND accept the offer. Copy, not vendor-specific plumbing — unchanged.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE — here's your ${brandName} collaboration offer. Tap to view the full details and accept it here: ${offerUrl} (open until ${expiryDate}).`;
}

// Sent once an admin publishes the creator's personalised content brief (see
// offers.deliverBriefToCreator) — a free-form session reply on an already-
// established channel, same style as renderOfferOutreachBody.
function renderContentBriefReadyBody({ firstName, brandName, briefUrl }) {
  return `Hi ${firstName}, this is INFLUENCE — your ${brandName} content brief is ready! Take a look here: ${briefUrl}`;
}

module.exports = {
  whatsappProvider,
  normalizePhone,
  toWhatsAppAddr,
  businessNumber,
  sendWhatsAppText,
  renderOfferOutreachBody,
  renderContentBriefReadyBody,
  // Exposed for tests.
  buildTwilioForm,
  basicAuthHeader,
  extractTwilioErrorCode,
  extractCloudMessageId,
  messagesUrl,
  cloudMessagesUrl,
  sendTwilioText,
  sendCloudText,
};
