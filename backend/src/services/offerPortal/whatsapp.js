'use strict';

// Offer-portal WhatsApp channel. Supports two backends behind one surface
// (businessNumber / sendWhatsAppText / normalizePhone / renderOfferOutreachBody)
// so callers (offers.js, outreach.js, offerWebhook.js) never change:
//
//   • 'aisensy' — AiSensy (WhatsApp BSP on top of Meta). Free-form session text
//                 via its direct-messages endpoint (`Authorization: Bearer
//                 {AISENSY_API_KEY}`); the sender is bound to the number tied to
//                 the API key. Keeps a session-template fallback for reaching a
//                 creator OUTSIDE the 24h window (AISENSY_SESSION_CAMPAIGN).
//   • 'cloud'  — Meta WhatsApp Cloud API, DIRECT (no BSP markup). Sends via
//                Graph API: POST {BASE}/{VERSION}/{PHONE_NUMBER_ID}/messages
//                with `Authorization: Bearer {ACCESS_TOKEN}` and a JSON body.
//                Our creator-initiated flow (creator texts "Hi" first) runs in
//                Meta's free 24h service window, so replies cost nothing.
//   • 'twilio' — Twilio's REST Messages API (BSP). Basic-Auth SID:token, a
//                form-encoded From/To/Body body.
//
// Which one is chosen: WHATSAPP_PROVIDER ('aisensy' | 'cloud' | 'twilio') wins;
// unset, we auto-detect by whichever creds are present (AiSensy → Cloud →
// Twilio) — so setting a provider's vars flips to it. Sends are skipped
// gracefully when the active provider's creds are absent, so dev never breaks.
//
// 24h window: Meta rejects free-form text sent to a user who hasn't messaged us
// in the last 24h (Twilio HTTP 400 code 63016; Meta 4xx code 131047/131026).
// AiSensy retries such a send through a session template (AISENSY_SESSION_CAMPAIGN)
// so a delayed reply still lands; Twilio/Cloud surface the error to retry once
// the creator messages us again.

const { extractProviderMessageId } = require('./deliveryStatus');

// --- Provider selection ----------------------------------------------------
function whatsappProvider() {
  const explicit = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'aisensy' || explicit === 'cloud' || explicit === 'twilio') return explicit;
  // Auto-detect by whichever provider's creds are present.
  if (process.env.AISENSY_API_KEY) return 'aisensy';
  if (process.env.WHATSAPP_CLOUD_ACCESS_TOKEN) return 'cloud';
  return 'twilio';
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
  const p = whatsappProvider();
  if (p === 'aisensy') return process.env.AISENSY_WHATSAPP_NUMBER || '';
  if (p === 'cloud') return process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER || '';
  return process.env.TWILIO_WHATSAPP_FROM || '';
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

// --- AiSensy config (WhatsApp BSP) ----------------------------------------
function aisensyApiKey() {
  return process.env.AISENSY_API_KEY || '';
}
function aisensyApiUrl() {
  return process.env.AISENSY_API_URL || 'https://backend.aisensy.com/campaign/t1/api/v2';
}
// AiSensy's free-form session-message endpoint (within the 24h customer window).
function aisensyTextApiUrl() {
  return process.env.AISENSY_TEXT_API_URL || 'https://backend.aisensy.com/direct-apis/t1/messages';
}
// A pre-approved "utility" template whose single {{1}} body param carries an
// arbitrary message — the only way to reach a creator OUTSIDE the 24h window.
function aisensySessionCampaign() {
  return process.env.AISENSY_SESSION_CAMPAIGN || '';
}

// Deliver `body` through the AiSensy session-fallback template. Returns null when
// no fallback template is configured (so the caller keeps the original error).
async function aisensySendViaSessionTemplate({ to, body }) {
  const campaign = aisensySessionCampaign();
  if (!campaign) return null;
  try {
    const res = await fetch(aisensyApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: aisensyApiKey(),
        campaignName: campaign,
        destination: normalizePhone(to),
        userName: 'INFLUENCE',
        templateParams: [body],
        source: 'deal-studio',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => null);
    return { sent: true, id: extractProviderMessageId(data), viaTemplate: true };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// Free-form session text via AiSensy's direct-messages endpoint (within Meta's
// 24h window). Outside the window Meta rejects free-form text, so a failed send
// falls back to the session template (AISENSY_SESSION_CAMPAIGN) which carries the
// same body — so a delayed reply still reaches the creator.
async function sendAisensyText({ to, body }) {
  if (!aisensyApiKey()) {
    console.warn(`[offer-whatsapp] AISENSY_API_KEY not set — skipping text to ${to}`);
    return { sent: false, skipped: true };
  }
  let result;
  try {
    const res = await fetch(aisensyTextApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aisensyApiKey()}`,
      },
      body: JSON.stringify({
        to: normalizePhone(to),
        type: 'text',
        recipient_type: 'individual',
        text: { body },
      }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { sent: true, id: extractProviderMessageId(data) };
    }
    const text = await res.text().catch(() => '');
    result = { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
  } catch (err) {
    result = { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }

  // Free-form failed (commonly: outside the 24h window) — try the template.
  const fallback = await aisensySendViaSessionTemplate({ to, body });
  if (fallback && fallback.sent) {
    console.warn(`[offer-whatsapp] free-form text failed (${result.error}); delivered via session template`);
    return fallback;
  }
  if (fallback) return { sent: false, error: `session: ${result.error}; template: ${fallback.error}` };
  return result;
}

// The public send used by offers.js / offerWebhook.js — dispatches to whichever
// provider is configured so callers stay vendor-agnostic.
async function sendWhatsAppText({ to, body }) {
  const p = whatsappProvider();
  if (p === 'aisensy') return sendAisensyText({ to, body });
  if (p === 'cloud') return sendCloudText({ to, body });
  return sendTwilioText({ to, body });
}

// The offer-reveal message body (free-form session reply used by
// deliverOfferOverChannel) — also stored in offer_messages so the admin can see
// what the creator received. Points them straight at the portal link to view
// AND accept the offer. Copy, not vendor-specific plumbing — unchanged.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE — here's your ${brandName} collaboration offer. Tap to view the full details and accept it here: ${offerUrl} (open until ${expiryDate}).`;
}

module.exports = {
  whatsappProvider,
  normalizePhone,
  toWhatsAppAddr,
  businessNumber,
  sendWhatsAppText,
  renderOfferOutreachBody,
  // Exposed for tests.
  buildTwilioForm,
  basicAuthHeader,
  extractTwilioErrorCode,
  extractCloudMessageId,
  messagesUrl,
  cloudMessagesUrl,
  sendTwilioText,
  sendCloudText,
  sendAisensyText,
  aisensySendViaSessionTemplate,
};
