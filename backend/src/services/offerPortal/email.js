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

// Offer outreach email — short, with the offer link as a clear CTA. The page
// does the selling, not the email, so the copy stays brief and warm.
function renderOfferEmail({ firstName, brandName, offerUrl, expiryDate }) {
  const subject = `Your ${brandName} collaboration offer is ready`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `Great news — ${brandName} would love to collaborate with you again, and we've put together an offer we think you'll enjoy.`,
    ``,
    `You can review the full details and terms here: ${offerUrl}`,
    ``,
    `It's open until ${expiryDate}, so feel free to accept or decline directly from the page whenever you're ready.`,
    ``,
    `Looking forward to working with you again,`,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Great news &mdash; <strong>${escapeHtml(brandName)}</strong> would love to collaborate with you again, and we've put together an offer we think you'll enjoy.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>It's open until <strong>${escapeHtml(expiryDate)}</strong>, so feel free to accept or decline directly from the page whenever you're ready.</p>
    <p style="margin-top:24px;">Looking forward to working with you again,<br/>Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendOfferEmail({ to, firstName, brandName, offerUrl, expiryDate }) {
  const { subject, text, html } = renderOfferEmail({ firstName, brandName, offerUrl, expiryDate });
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
    ? `Reminder: your ${brandName} opportunity is still waiting`
    : `${brandName} has a new opportunity for you`;
  const opener = reminder
    ? `Just following up on the ${brandName} opportunity we mentioned — we'd still love to have you on board.`
    : `We're kicking off a new collaboration with ${brandName}, and after how well things went last time, we'd love to have you on board again.`;

  const lines = [];
  if (whatsappNumber) lines.push(`WhatsApp: ${whatsappNumber}`);
  if (imessageNumber) lines.push(`iMessage: ${imessageNumber}`);

  const text = [
    `Hi ${firstName},`,
    ``,
    opener,
    ``,
    `Just send us a quick "Hi" below and we'll share all the details right away:`,
    ...lines.map((l) => `  ${l}`),
    ``,
    `Talk soon,`,
    `Team INFLUENCE`,
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
    <p>Just send us a quick "Hi" below and we'll share all the details right away:</p>
    <p style="text-align:center;margin:32px 0;">${buttons}</p>
    ${plainNumbers}
    <p style="margin-top:24px;">Talk soon,<br/>Team INFLUENCE</p>`);

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
    ? `Reminder: your ${brandName} offer is still open`
    : `A new collaboration from ${brandName} is ready for you`;
  const lead = reminder
    ? `Just a quick reminder — your ${brandName} collaboration offer is still open, and we'd love for you to take a look.`
    : `${brandName} has a new collaboration lined up for you, and given how well our last project went, we think you'd be a great fit again.`;
  const leadHtml = reminder
    ? `Just a quick reminder &mdash; your <strong>${escapeHtml(brandName)}</strong> collaboration offer is still open, and we'd love for you to take a look.`
    : `<strong>${escapeHtml(brandName)}</strong> has a new collaboration lined up for you, and given how well our last project went, we think you'd be a great fit again.`;

  const contactLines = [];
  if (whatsappNumber) contactLines.push(`WhatsApp: ${whatsappNumber}`);
  if (imessageNumber) contactLines.push(`iMessage: ${imessageNumber}`);

  const text = [
    `Hi ${firstName},`,
    ``,
    `${lead} Here's the full offer: ${offerUrl}`,
    ``,
    `It's open until ${expiryDate} — you're welcome to accept, decline, or send us a counter directly from the page.`,
    ...(contactLines.length
      ? ['', `Prefer to chat first? We're just a message away:`, ...contactLines.map((l) => `  ${l}`)]
      : []),
    ``,
    `Looking forward to it,`,
    `Team INFLUENCE`,
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
    ? `<p style="margin:28px 0 4px;color:#525252;">Prefer to chat first? We're just a message away:</p>
    <p style="text-align:center;margin:8px 0;">${contactButtons}</p>`
    : '';

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${leadHtml}</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>It's open until <strong>${escapeHtml(expiryDate)}</strong> &mdash; you're welcome to accept, decline, or send us a counter directly from the page.</p>
    ${contactBlock}
    <p style="margin-top:24px;">Looking forward to it,<br/>Team INFLUENCE</p>`);

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

// New-campaign offer email for a USED creator whose "Send email" click has
// auto-priced their offer (see offers.sendUsedCreatorOffer). Deliberately short
// and offer-portal-focused: a friendly greeting, the new-campaign hook, and the
// portal link where they can review + accept/decline/counter. NO "text Hi"
// chat CTAs — a Used creator already knows how to reach us on WhatsApp/iMessage
// (see graduation.js), and if they're already messaging us in this campaign the
// offer is delivered directly on that channel instead of by email.
function renderNewCampaignOfferEmail({ firstName, brandName, offerUrl, expiryDate }) {
  const subject = `A new ${brandName} collaboration for you, ${firstName}`;
  const text = [
    `Hey ${firstName},`,
    ``,
    `We're running a new ${brandName} campaign and thought of you right away — it felt like a great fit given how our last collaboration went.`,
    ``,
    `If you're up for it, the offer is ready to review: ${offerUrl}`,
    `It's open until ${expiryDate}, and you can accept, decline, or send a counter right there.`,
    ``,
    `Thank you,`,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hey ${escapeHtml(firstName)},</p>
    <p>We're running a new <strong>${escapeHtml(brandName)}</strong> campaign and thought of you right away &mdash; it felt like a great fit given how our last collaboration went.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">Review the offer</a></p>
    <p>It's open until <strong>${escapeHtml(expiryDate)}</strong>, and you can accept, decline, or send a counter right there.</p>
    <p style="margin-top:24px;">Thank you,<br/>Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendNewCampaignOfferEmail({ to, firstName, brandName, offerUrl, expiryDate }) {
  const { subject, text, html } = renderNewCampaignOfferEmail({ firstName, brandName, offerUrl, expiryDate });
  return deliver({ to, subject, text, html });
}

// Graduation email — sent ONCE when a creator first completes all the
// deliverables of a campaign (see graduation.js). Congratulates them and invites
// them to connect on WhatsApp/iMessage so future collabs run over messaging. The
// congrats paragraph (`congratsLine`) is personalized by Claude upstream, with a
// static fallback; this template wraps it with the greeting + the "send Hi"
// connect buttons to our business numbers (either may be null).
function renderGraduationEmail({ firstName, brandName, congratsLine, whatsappNumber, imessageNumber }) {
  const subject = `Congratulations on your ${brandName} collaboration, ${firstName}! 🎉`;

  const lines = [];
  if (whatsappNumber) lines.push(`WhatsApp: ${whatsappNumber}`);
  if (imessageNumber) lines.push(`iMessage: ${imessageNumber}`);

  const text = [
    `Hi ${firstName},`,
    ``,
    congratsLine,
    ``,
    `If you'd like to hear about future collaborations, just send us a quick "Hi" and we'll share the details right there:`,
    ...lines.map((l) => `  ${l}`),
    ``,
    `Thank you,`,
    `Team INFLUENCE`,
  ].join('\n');

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
    <p>${escapeHtml(congratsLine)}</p>
    <p>If you'd like to hear about future collaborations, just send us a quick "Hi" and we'll share the details right there:</p>
    <p style="text-align:center;margin:32px 0;">${buttons}</p>
    ${plainNumbers}
    <p style="margin-top:24px;">Thank you,<br/>Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendGraduationEmail({ to, firstName, brandName, congratsLine, whatsappNumber, imessageNumber }) {
  const { subject, text, html } = renderGraduationEmail({
    firstName,
    brandName,
    congratsLine,
    whatsappNumber,
    imessageNumber,
  });
  return deliver({ to, subject, text, html });
}

// Thank-you confirmation email on acceptance.
function renderOfferConfirmationEmail({ firstName, brandName }) {
  const subject = `You're all set, ${firstName}! 🎉`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `Thank you for accepting the ${brandName} collaboration — we're genuinely excited to have you on board!`,
    ``,
    `Our team will follow up within 1–2 business days with the next steps to get everything moving.`,
    ``,
    `Excited to create something great together,`,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Thank you for accepting the <strong>${escapeHtml(brandName)}</strong> collaboration &mdash; we're genuinely excited to have you on board!</p>
    <p>Our team will follow up within 1&ndash;2 business days with the next steps to get everything moving.</p>
    <p style="margin-top:24px;">Excited to create something great together,<br/>Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendOfferConfirmationEmail({ to, firstName, brandName }) {
  const { subject, text, html } = renderOfferConfirmationEmail({ firstName, brandName });
  return deliver({ to, subject, text, html });
}

module.exports = {
  renderOfferEmail,
  sendOfferEmail,
  renderOfferConfirmationEmail,
  sendOfferConfirmationEmail,
  renderPortalInviteEmail,
  sendPortalInviteEmail,
  renderOfferWithContactEmail,
  sendOfferWithContactEmail,
  renderNewCampaignOfferEmail,
  sendNewCampaignOfferEmail,
  renderGraduationEmail,
  sendGraduationEmail,
};
