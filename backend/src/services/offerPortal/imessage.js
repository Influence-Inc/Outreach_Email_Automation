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

// Our own iMessage sender number, shown in the invite email so a creator knows
// what to text. Same value the send path uses as the Linq `from` field.
const businessNumber = fromNumber;

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// HTML for the public GET /go/imessage page. The email's "Text us on iMessage"
// button links here (an https link email clients keep clickable) instead of a raw
// `sms:` link (which Gmail strips); this page then opens the visitor's Messages
// app to our business iMessage number. It auto-redirects and also shows a
// tappable button + the number as a fallback (the manual tap always works, even
// where a scripted redirect to the sms: scheme is blocked). Uses IMESSAGE_FROM_
// NUMBER; renders a friendly notice when that isn't configured.
function renderRedirectPage() {
  const e164 = toE164(fromNumber());
  const display = fromNumber() || e164;
  const head =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Text us on iMessage</title>';
  const bodyStyle =
    "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    'padding:48px 24px;text-align:center;color:#171717;background:#f5f5f5;';

  if (!e164) {
    return `${head}</head><body style="${bodyStyle}"><p>Messaging isn't set up yet — please reply to our email instead.</p></body></html>`;
  }

  const smsHref = `sms:${e164}`;
  const smsAttr = escapeAttr(smsHref);
  return (
    `${head}<meta http-equiv="refresh" content="0;url=${smsAttr}"></head>` +
    `<body style="${bodyStyle}">` +
    `<p style="font-size:16px;">Opening Messages…</p>` +
    `<p style="margin:28px 0;"><a href="${smsAttr}" style="background:#171717;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block;font-weight:600;font-size:16px;">Open iMessage</a></p>` +
    `<p style="color:#525252;">or text us at <a href="${smsAttr}" style="color:#171717;">${escapeAttr(display)}</a></p>` +
    `<script>setTimeout(function(){location.href=${JSON.stringify(smsHref)};},50);</script>` +
    `</body></html>`
  );
}

module.exports = {
  toE164,
  buildLinqPayload,
  businessNumber,
  sendIMessageText,
  sendOfferOutreachIMessage,
  renderOfferOutreachBody,
  renderRedirectPage,
};
