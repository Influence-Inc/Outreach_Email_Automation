'use strict';

// Offer-portal WhatsApp channel via Twilio's REST API. Ported over from AiSensy;
// same public surface (businessNumber / sendWhatsAppText / normalizePhone /
// renderOfferOutreachBody) so callers (offers.js, outreach.js, offerWebhook.js)
// don't change. Sends are skipped gracefully when TWILIO_* creds are absent, so
// dev never breaks.
//
// Twilio's Messages endpoint:
//   POST {TWILIO_API_BASE}/2010-04-01/Accounts/{SID}/Messages.json
//   Authorization: Basic base64(SID:AUTH_TOKEN)
//   Content-Type: application/x-www-form-urlencoded
//   From=whatsapp:+18005551234&To=whatsapp:+15556667777&Body=...
// (see https://www.twilio.com/docs/whatsapp/api).
//
// 24h window: Meta rejects free-form text sent to a user who hasn't messaged us
// in the last 24 hours; Twilio surfaces this as HTTP 400 with `code: 63016`.
// The AiSensy-era session-template fallback (AISENSY_SESSION_CAMPAIGN) was
// deliberately dropped as part of this swap; a send outside the window will
// fail with a clear error and the message can be retried once the creator
// messages us again. To re-enable a template fallback later, wire a Twilio
// Content Template send here (Content API with ContentSid/ContentVariables) —
// no other file needs to change.

const { extractProviderMessageId } = require('./deliveryStatus');

function accountSid() {
  return process.env.TWILIO_ACCOUNT_SID || '';
}
function authToken() {
  return process.env.TWILIO_AUTH_TOKEN || '';
}
// Our own WhatsApp Business number (E.164 with leading "+"), shown in the invite
// email so a creator knows what to text, AND used as the `From` on every send.
// Unlike AiSensy — where the sender number was implicit in the API key — Twilio
// requires an explicit `From` per request, so a wrong/missing value here fails
// the send loudly instead of silently routing elsewhere.
function businessNumber() {
  return process.env.TWILIO_WHATSAPP_FROM || '';
}
function apiBase() {
  return (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
}
function messagesUrl() {
  return `${apiBase()}/2010-04-01/Accounts/${encodeURIComponent(accountSid())}/Messages.json`;
}

// Bare digits — used to match inbound sender numbers (last-10-digit fallback in
// the webhook) and to normalise stored numbers before wrapping with "whatsapp:".
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

// Free-form session text (within Meta's 24h window after the creator messages
// us). Used for the brand brief, thank-you, polite-close, deflection, too-high,
// and manual review replies. Outside the window Twilio returns HTTP 400 with
// code 63016 — surfaced verbatim in the error so the reason is visible in logs.
async function sendWhatsAppText({ to, body }) {
  if (!accountSid() || !authToken() || !businessNumber()) {
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
      body: buildTwilioForm({ from: businessNumber(), to, body }).toString(),
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

// The offer-reveal message body (free-form session reply used by
// deliverOfferOverChannel) — also stored in offer_messages so the admin can see
// what the creator received. Points them straight at the portal link to view
// AND accept the offer, so they know exactly what to do next. Unchanged from
// the AiSensy era — this is copy, not vendor-specific plumbing.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE — here's your ${brandName} collaboration offer. Tap to view the full details and accept it here: ${offerUrl} (open until ${expiryDate}).`;
}

module.exports = {
  normalizePhone,
  toWhatsAppAddr,
  businessNumber,
  sendWhatsAppText,
  renderOfferOutreachBody,
  // Exposed for tests.
  buildTwilioForm,
  basicAuthHeader,
  extractTwilioErrorCode,
  messagesUrl,
};
