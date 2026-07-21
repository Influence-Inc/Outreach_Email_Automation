'use strict';

// Offer-portal WhatsApp channel via AiSensy. Ported from Influence-CDB-portal
// (src/lib/whatsapp.ts). AiSensy uses a pre-approved template referenced by
// `campaignName` with 4 ordered params: {{1}} First Name, {{2}} Brand Name,
// {{3}} Offer Link, {{4}} Expiry Date. Sends are skipped gracefully when
// AISENSY_API_KEY is absent, so dev never breaks.

const { extractProviderMessageId } = require('./deliveryStatus');

function apiKey() {
  return process.env.AISENSY_API_KEY || '';
}
// Our own WhatsApp Business number (E.164), shown in the invite email so a
// creator knows what to text. This is a display value only — AiSensy's
// campaign/text APIs route through whichever number is tied to AISENSY_API_KEY
// on their end regardless of what's configured here.
function businessNumber() {
  return process.env.AISENSY_WHATSAPP_NUMBER || '';
}
function campaignName() {
  return process.env.AISENSY_CAMPAIGN_NAME || 'offer_outreach';
}
function apiUrl() {
  return process.env.AISENSY_API_URL || 'https://backend.aisensy.com/campaign/t1/api/v2';
}
// AiSensy's free-form session-message endpoint (within the 24h customer window).
function textApiUrl() {
  return process.env.AISENSY_TEXT_API_URL || 'https://backend.aisensy.com/direct-apis/t1/messages';
}

// Strip "+" / spaces / dashes — AiSensy + Meta want bare digits ("919812345670").
function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function sendOfferOutreachWhatsApp({ to, firstName, brandName, offerUrl, expiryDate }) {
  if (!apiKey()) {
    console.warn(`[offer-whatsapp] AISENSY_API_KEY not set — skipping outreach to ${to}`);
    return { sent: false, skipped: true };
  }
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: apiKey(),
        campaignName: campaignName(),
        destination: normalizePhone(to),
        userName: 'INFLUENCE',
        templateParams: [firstName, brandName, offerUrl, expiryDate],
        source: 'deal-studio',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => null);
    return { sent: true, id: extractProviderMessageId(data) };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// A pre-approved "utility" template whose single body param {{1}} carries an
// arbitrary message — used to reach a creator OUTSIDE Meta's 24h session window,
// where free-form session text is rejected.
function sessionFallbackCampaign() {
  return process.env.AISENSY_SESSION_CAMPAIGN || '';
}

// Deliver `body` through the session-fallback template. Returns null when no
// fallback template is configured (so the caller keeps the original error).
async function sendViaSessionTemplate({ to, body }) {
  const campaign = sessionFallbackCampaign();
  if (!campaign) return null;
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: apiKey(),
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

// Free-form session text (within the 24h window after the creator messages us).
// Used for thank-you / polite-close / deflection / too-high / review replies.
// Outside the 24h window Meta rejects free-form text, so a failed send falls back
// to the session template (when AISENSY_SESSION_CAMPAIGN is configured) which
// carries the same body — so a delayed reply still reaches the creator.
async function sendWhatsAppText({ to, body }) {
  if (!apiKey()) {
    console.warn(`[offer-whatsapp] AISENSY_API_KEY not set — skipping text to ${to}`);
    return { sent: false, skipped: true };
  }
  let result;
  try {
    const res = await fetch(textApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
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
  const fallback = await sendViaSessionTemplate({ to, body });
  if (fallback && fallback.sent) {
    console.warn(`[offer-whatsapp] free-form text failed (${result.error}); delivered via session template`);
    return fallback;
  }
  if (fallback) return { sent: false, error: `session: ${result.error}; template: ${fallback.error}` };
  return result;
}

// The exact WhatsApp template body — stored in offer_messages so the admin can
// see what the creator received.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE. We have a new collab opportunity for you with ${brandName}. Check out the details here: ${offerUrl} — valid until ${expiryDate}.`;
}

module.exports = {
  normalizePhone,
  businessNumber,
  sendOfferOutreachWhatsApp,
  sendWhatsAppText,
  sendViaSessionTemplate,
  renderOfferOutreachBody,
};
