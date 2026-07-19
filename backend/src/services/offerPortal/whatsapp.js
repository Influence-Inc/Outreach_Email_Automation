'use strict';

// Offer-portal WhatsApp channel via AiSensy. Ported from Influence-CDB-portal
// (src/lib/whatsapp.ts). AiSensy uses a pre-approved template referenced by
// `campaignName` with 4 ordered params: {{1}} First Name, {{2}} Brand Name,
// {{3}} Offer Link, {{4}} Expiry Date. Sends are skipped gracefully when
// AISENSY_API_KEY is absent, so dev never breaks.

function apiKey() {
  return process.env.AISENSY_API_KEY || '';
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
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// Free-form session text (within the 24h window after the creator messages us).
// Used for thank-you / polite-close / deflection replies.
async function sendWhatsAppText({ to, body }) {
  if (!apiKey()) {
    console.warn(`[offer-whatsapp] AISENSY_API_KEY not set — skipping text to ${to}`);
    return { sent: false, skipped: true };
  }
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
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// The exact WhatsApp template body — stored in offer_messages so the admin can
// see what the creator received.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE. We have a new collab opportunity for you with ${brandName}. Check out the details here: ${offerUrl} — valid until ${expiryDate}.`;
}

module.exports = {
  normalizePhone,
  sendOfferOutreachWhatsApp,
  sendWhatsAppText,
  renderOfferOutreachBody,
};
