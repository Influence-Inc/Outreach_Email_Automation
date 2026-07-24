'use strict';

// Offer-portal email channel. Ported from Influence-CDB-portal (src/lib/email.ts).
// Uses Resend's REST API directly via fetch (no extra npm dependency). Sends are
// skipped gracefully when RESEND_API_KEY is absent, so nothing breaks in dev.
// Live sending needs a key and a Resend-verified sending domain.

const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

function apiKey() {
  return process.env.RESEND_API_KEY || '';
}
function fromAddress() {
  return process.env.OFFER_EMAIL_FROM || process.env.EMAIL_FROM || 'INFLUENCE <offers@useinfluence.xyz>';
}

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.OFFER_PORTAL_BASE_URL || '').replace(/\/$/, '');
}

// Target for the "Text us on iMessage" email button. A raw `sms:` href gets
// stripped by Gmail (and some other webmail), so the button links to our hosted
// https redirect page (GET /go/imessage, see services/offerPortal/imessage.js +
// server.js) — an https link email clients keep clickable — which then opens
// Messages to our business number. Falls back to the direct `sms:` link only when
// no base URL is configured (dev), so the button is never empty. `imE164` is the
// clean "+<digits>" iMessage number.
function imessageButtonHref(imE164) {
  const base = baseUrl();
  return base ? `${base}/go/imessage` : `sms:${imE164}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;font-size:15px;line-height:1.6;">
${inner}
  </div>
  <p style="max-width:480px;margin:16px auto 0;text-align:center;color:#a3a3a3;font-size:12px;letter-spacing:0.08em;">INFLUENCE</p>
</body></html>`;
}

async function deliver({ to, subject, text, html }) {
  const key = apiKey();
  if (!key) {
    console.warn(`[offer-email] RESEND_API_KEY not set — skipping "${subject}" -> ${to}`);
    return { sent: false, skipped: true };
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ from: fromAddress(), to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, error: `${res.status} ${body.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data && data.id };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// Offer outreach email — short, with the offer link as a clear CTA. The closing
// line follows the approved reference copy: "Please accept or decline through
// the above link." (the page does the selling, not the email).
async function sendOfferEmail({ to, firstName, brandName, offerUrl, expiryDate }) {
  const subject = `New collaboration opportunity — ${brandName}`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `We have a new collaboration opportunity for you with ${brandName}. Based on your previous work with us, we think this would be a great fit. Here are the full details and terms: ${offerUrl}`,
    ``,
    `The offer is open until ${expiryDate}. Please accept or decline through the above link.`,
    ``,
    `— Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>We have a new collaboration opportunity for you with <strong>${escapeHtml(brandName)}</strong>. Based on your previous work with us, we think this would be a great fit.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>The offer is open until <strong>${escapeHtml(expiryDate)}</strong>. Please accept or decline through the above link.</p>
    <p style="margin-top:24px;">— Team INFLUENCE</p>`);

  return deliver({ to, subject, text, html });
}

// Invite email — sent instead of the full offer when the creator has a
// WhatsApp/iMessage number on file and at least one of those channels is
// configured. Deliberately withholds the offer details: the creator has to
// text us first, which turns the actual offer send into a free-form reply
// within an open conversation rather than cold outreach (no WhatsApp template
// approval needed, and iMessage never gets an unsolicited first message).
// whatsappNumber / imessageNumber are our own business numbers (E.164) for
// each channel that's actually usable for this creator — either may be null.
// `reminder` softens the subject + opening for the 32h nudge to a creator who
// went quiet after the first invite (see offers.sendUsedCreatorInviteFollowup).
function renderPortalInviteEmail({ firstName, brandName, whatsappNumber, imessageNumber, reminder = false }) {
  const subject = reminder
    ? `Reminder: your ${brandName} collaboration opportunity`
    : `A ${brandName} collaboration opportunity for you`;
  const opener = reminder
    ? `Just following up on the collaboration opportunity we shared with ${brandName} — we'd still love to work with you.`
    : `We have a new collaboration opportunity for you with ${brandName}. Based on your previous work with us, we think this would be a great fit.`;

  const lines = [];
  if (whatsappNumber) lines.push(`WhatsApp: ${whatsappNumber}`);
  if (imessageNumber) lines.push(`iMessage: ${imessageNumber}`);

  const text = [
    `Hi ${firstName},`,
    ``,
    opener,
    ``,
    `If you're interested, send us a quick "Hi" and we'll share the full details and next steps right there:`,
    ...lines.map((l) => `  ${l}`),
    ``,
    `— Team INFLUENCE`,
  ].join('\n');

  // Numbers may be stored with human formatting (e.g. "+1 (205) 370-6046"); the
  // link targets need bare/E.164 forms. WhatsApp uses wa.me (an https link, always
  // clickable). iMessage can't: a raw "sms:" link is stripped by Gmail's HTML
  // sanitizer, leaving a dead button — so the iMessage button links to our https
  // redirect page (imessageButtonHref → GET /go/imessage) which opens Messages.
  const waDigits = whatsappNumber ? whatsappNumber.replace(/[^\d]/g, '') : null;
  const imE164 = imessageNumber ? `+${imessageNumber.replace(/[^\d]/g, '')}` : null;
  const buttons = [
    waDigits
      ? `<a href="https://wa.me/${waDigits}?text=Hi" style="background:#25D366;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;margin:4px;">Text us on WhatsApp</a>`
      : '',
    imessageNumber
      ? `<a href="${escapeHtml(imessageButtonHref(imE164))}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;margin:4px;">Text us on iMessage</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const plainNumbers = lines.map((l) => `<p style="margin:4px 0;color:#525252;">${escapeHtml(l)}</p>`).join('');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${escapeHtml(opener)}</p>
    <p>If you're interested, send us a quick "Hi" and we'll share the full details and next steps right there:</p>
    <p style="text-align:center;margin:32px 0;">${buttons}</p>
    ${plainNumbers}
    <p style="margin-top:24px;">— Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendPortalInviteEmail({ to, firstName, brandName, whatsappNumber, imessageNumber, reminder = false }) {
  const { subject, text, html } = renderPortalInviteEmail({
    firstName,
    brandName,
    whatsappNumber,
    imessageNumber,
    reminder,
  });
  return deliver({ to, subject, text, html });
}

// Combined offer + contact email for USED creators: reveals the offer-portal
// negotiation link (view / accept / decline / counter on the page) AND invites
// the creator to continue over WhatsApp/iMessage — both paths in one outreach
// email. Unlike renderPortalInviteEmail (which deliberately withholds the offer),
// this INCLUDES the link, because for used creators we want the negotiation link
// in the outreach itself. whatsappNumber/imessageNumber are our own business
// numbers for each usable channel and may be null (then no contact block shows,
// and it reads as a plain offer email).
function renderOfferWithContactEmail({ firstName, brandName, offerUrl, expiryDate, whatsappNumber, imessageNumber, reminder = false }) {
  const subject = reminder
    ? `Reminder: your ${brandName} collaboration offer`
    : `New collaboration opportunity — ${brandName}`;
  const lead = reminder
    ? `Just following up — your ${brandName} collaboration offer is still open.`
    : `We have a new collaboration opportunity for you with ${brandName}. Based on your previous work with us, we think this would be a great fit.`;
  const leadHtml = reminder
    ? `Just following up — your <strong>${escapeHtml(brandName)}</strong> collaboration offer is still open.`
    : `We have a new collaboration opportunity for you with <strong>${escapeHtml(brandName)}</strong>. Based on your previous work with us, we think this would be a great fit.`;

  const contactLines = [];
  if (whatsappNumber) contactLines.push(`WhatsApp: ${whatsappNumber}`);
  if (imessageNumber) contactLines.push(`iMessage: ${imessageNumber}`);

  const text = [
    `Hi ${firstName},`,
    ``,
    `${lead} Here are the full details and terms: ${offerUrl}`,
    ``,
    `The offer is open until ${expiryDate}. You can accept, decline or counter right there.`,
    ...(contactLines.length
      ? ['', `Prefer to chat? Message us and we'll take it from there:`, ...contactLines.map((l) => `  ${l}`)]
      : []),
    ``,
    `— Team INFLUENCE`,
  ].join('\n');

  // Numbers may be stored with human formatting; wa.me wants bare digits and
  // sms: wants a clean "+<digits>" (see renderPortalInviteEmail for the rationale).
  const waDigits = whatsappNumber ? whatsappNumber.replace(/[^\d]/g, '') : null;
  const imE164 = imessageNumber ? `+${imessageNumber.replace(/[^\d]/g, '')}` : null;
  const contactButtons = [
    waDigits
      ? `<a href="https://wa.me/${waDigits}?text=Hi" style="background:#25D366;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;margin:4px;">Text us on WhatsApp</a>`
      : '',
    imessageNumber
      ? `<a href="${escapeHtml(imessageButtonHref(imE164))}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;margin:4px;">Text us on iMessage</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');
  const contactBlock = contactButtons
    ? `<p style="margin:28px 0 4px;color:#525252;">Prefer to chat? Message us and we'll take it from there:</p>
    <p style="text-align:center;margin:8px 0;">${contactButtons}</p>`
    : '';

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${leadHtml}</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>The offer is open until <strong>${escapeHtml(expiryDate)}</strong>. You can accept, decline or counter right there.</p>
    ${contactBlock}
    <p style="margin-top:24px;">— Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendOfferWithContactEmail({ to, firstName, brandName, offerUrl, expiryDate, whatsappNumber, imessageNumber, reminder = false }) {
  const { subject, text, html } = renderOfferWithContactEmail({
    firstName,
    brandName,
    offerUrl,
    expiryDate,
    whatsappNumber,
    imessageNumber,
    reminder,
  });
  return deliver({ to, subject, text, html });
}

// Thank-you confirmation email on acceptance.
async function sendOfferConfirmationEmail({ to, firstName, brandName }) {
  const subject = `Offer confirmed — ${brandName}`;
  const text = [
    `Hi ${firstName}, thanks for accepting the collaboration with ${brandName}. We are looking forward to working with you. Our team will reach out within 1–2 business days with the next steps.`,
    ``,
    `— Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)}, thanks for accepting the collaboration with <strong>${escapeHtml(brandName)}</strong>. We are looking forward to working with you. Our team will reach out within 1&ndash;2 business days with the next steps.</p>
    <p style="margin-top:24px;">— Team INFLUENCE</p>`);

  return deliver({ to, subject, text, html });
}

module.exports = {
  sendOfferEmail,
  sendOfferConfirmationEmail,
  renderPortalInviteEmail,
  sendPortalInviteEmail,
  renderOfferWithContactEmail,
  sendOfferWithContactEmail,
};
