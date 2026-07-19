'use strict';

// Offer-portal iMessage channel. There is no first-party iMessage API, so this
// talks to a generic HTTP iMessage gateway (e.g. Sendblue / LoopMessage-style):
//   POST $IMESSAGE_API_URL  { to, body }   Authorization: Bearer $IMESSAGE_API_KEY
// Mirrors the WhatsApp/email pattern exactly: sends are skipped gracefully when
// IMESSAGE_API_KEY is absent, so dev never breaks and the plumbing is real the
// moment a gateway is configured. iMessage has no template concept, so the
// "outreach" is just a text message carrying the offer link.

const { normalizePhone } = require('./whatsapp');

function apiKey() {
  return process.env.IMESSAGE_API_KEY || '';
}
function apiUrl() {
  return process.env.IMESSAGE_API_URL || '';
}
function senderName() {
  return process.env.IMESSAGE_SENDER_NAME || 'INFLUENCE';
}

async function sendIMessageText({ to, body }) {
  if (!apiKey() || !apiUrl()) {
    console.warn(`[offer-imessage] IMESSAGE_API_KEY/URL not set — skipping iMessage to ${to}`);
    return { sent: false, skipped: true };
  }
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        to: normalizePhone(to),
        body,
        from: senderName(),
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

// Offer outreach over iMessage — same copy as the WhatsApp template body so the
// creator gets a consistent message whichever channel reaches them.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE. We have a new collab opportunity for you with ${brandName}. Check out the details here: ${offerUrl} — valid until ${expiryDate}.`;
}

async function sendOfferOutreachIMessage(params) {
  return sendIMessageText({ to: params.to, body: renderOfferOutreachBody(params) });
}

module.exports = { sendIMessageText, sendOfferOutreachIMessage, renderOfferOutreachBody };
