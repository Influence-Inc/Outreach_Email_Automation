'use strict';

// Offer-portal iMessage channel via Linq (https://linqapp.com) Partner API v3.
// Linq models a message as a `chat` whose content is an array of typed `parts`;
// a plain-text iMessage is a single { type: 'text', value } part. A send is a
// POST to the chats endpoint with a Bearer token — your SANDBOX token selects
// the sandbox environment (same base URL as production):
//
//   POST $IMESSAGE_API_URL                     (default: Linq /chats)
//   Authorization: Bearer $IMESSAGE_API_KEY
//   Content-Type: application/json
//   { from, to: [ "+1..." ], message: { parts: [ { type: 'text', value } ] } }
//
// Sends are skipped gracefully when IMESSAGE_API_KEY / IMESSAGE_FROM_NUMBER are
// absent, so dev never breaks and the plumbing goes live the moment the sandbox
// creds are set. Mirrors the WhatsApp/email pattern: iMessage has no template
// concept, so the "outreach" is just a text message carrying the offer link.

const { extractProviderMessageId } = require('./deliveryStatus');

const DEFAULT_API_URL = 'https://api.linqapp.com/api/partner/v3/chats';

function apiKey() {
  return process.env.IMESSAGE_API_KEY || '';
}
function apiUrl() {
  return process.env.IMESSAGE_API_URL || DEFAULT_API_URL;
}
function fromNumber() {
  return process.env.IMESSAGE_FROM_NUMBER || '';
}

// Linq requires E.164 WITH the leading "+" (e.g. "+12223334444"). This is why
// iMessage can't reuse WhatsApp's normalizePhone, which strips the "+" to bare
// digits (what AiSensy/Meta want). Drops spaces/dashes/parens, treats a leading
// "00" international prefix as "+", and re-adds a single "+".
function toE164(raw) {
  const digits = String(raw || '')
    .replace(/^\s*\+/, '') // remember a leading +
    .replace(/^00/, '') // 00 international prefix → drop (becomes +)
    .replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// The exact JSON body Linq expects. Pure + exported so the shape can be
// unit-tested without a network call.
function buildLinqPayload({ from, to, body }) {
  return {
    from: toE164(from),
    to: [toE164(to)],
    message: { parts: [{ type: 'text', value: body }] },
  };
}

async function sendIMessageText({ to, body }) {
  if (!apiKey() || !fromNumber()) {
    console.warn(
      `[offer-imessage] IMESSAGE_API_KEY/IMESSAGE_FROM_NUMBER not set — skipping iMessage to ${to}`,
    );
    return { sent: false, skipped: true };
  }
  const recipient = toE164(to);
  if (!recipient) return { sent: false, error: 'invalid recipient number' };
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(buildLinqPayload({ from: fromNumber(), to: recipient, body })),
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

// Offer outreach over iMessage — same copy as the WhatsApp template body so the
// creator gets a consistent message whichever channel reaches them.
function renderOfferOutreachBody({ firstName, brandName, offerUrl, expiryDate }) {
  return `Hi ${firstName}, this is INFLUENCE. We have a new collab opportunity for you with ${brandName}. Check out the details here: ${offerUrl} — valid until ${expiryDate}.`;
}

async function sendOfferOutreachIMessage(params) {
  return sendIMessageText({ to: params.to, body: renderOfferOutreachBody(params) });
}

module.exports = {
  toE164,
  buildLinqPayload,
  sendIMessageText,
  sendOfferOutreachIMessage,
  renderOfferOutreachBody,
};
