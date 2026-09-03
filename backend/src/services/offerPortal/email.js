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

// Executed-agreement copies get their own sender, separate from the offers@
// address the rest of this module uses: a creator replying to a contract copy
// ("this fee is wrong", "please resend") is raising a contract question, and it
// should land with whoever handles contracts rather than in the offer-outreach
// stream. contracts@useinfluence.xyz is verified in Resend as its own sender,
// so signed-agreement copies go from there; CONTRACT_EMAIL_FROM overrides the
// default if the address ever needs to change without redeploying.
function contractFromAddress() {
  return process.env.CONTRACT_EMAIL_FROM || 'INFLUENCE Contracts <contracts@useinfluence.xyz>';
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

// Whether live sending is possible at all. Callers that would otherwise do
// expensive work before a send (rendering a contract PDF, sweeping the DB for
// unsent copies) check this first rather than building a payload deliver() will
// only warn about and drop.
function isConfigured() {
  return !!apiKey();
}

// Wrap a Buffer as a Resend attachment. Resend takes the file inline as base64
// under `content`, so nothing has to be hosted for the recipient to fetch.
function attachment(filename, buffer) {
  return { filename, content: Buffer.from(buffer).toString('base64') };
}

// `attachments` is Resend's own shape: [{ filename, content }] where content is
// the file's bytes base64-encoded (see attachment() above). Omitted from the
// payload entirely when there are none, so every existing plain send is
// byte-for-byte unchanged. `from` overrides the default sender for the one case
// that needs its own address (contract copies); everything else omits it.
async function deliver({ to, subject, text, html, attachments, from }) {
  const key = apiKey();
  if (!key) {
    console.warn(`[offer-email] RESEND_API_KEY not set — skipping "${subject}" -> ${to}`);
    return { sent: false, skipped: true };
  }
  const payload = { from: from || fromAddress(), to, subject, text, html };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
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
// does the selling, not the email, so the copy stays brief and neutral.
function renderOfferEmail({ firstName, brandName, offerUrl, expiryDate }) {
  const subject = `Your ${brandName} collaboration offer is ready`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `A new collaboration offer from ${brandName} is available for you.`,
    ``,
    `Review the full offer here: ${offerUrl}`,
    ``,
    `The offer is available until ${expiryDate}. You can accept, decline, or submit a counter offer directly from the offer page.`,
    ``,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>A new collaboration offer from <strong>${escapeHtml(brandName)}</strong> is available for you.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>The offer is available until <strong>${escapeHtml(expiryDate)}</strong>. You can accept, decline, or submit a counter offer directly from the offer page.</p>
    <p style="margin-top:24px;">Team INFLUENCE</p>`);

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
    : `Your ${brandName} collaboration offer is still open.`;
  const leadHtml = reminder
    ? `Just a quick reminder &mdash; your <strong>${escapeHtml(brandName)}</strong> collaboration offer is still open, and we'd love for you to take a look.`
    : `Your <strong>${escapeHtml(brandName)}</strong> collaboration offer is still open.`;

  const text = [
    `Hi ${firstName},`,
    ``,
    lead,
    ``,
    `You can review the offer, accept, decline, or submit a counter offer here:`,
    ``,
    offerUrl,
    ``,
    `The offer is available until ${expiryDate}.`,
    ``,
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
    ? `<p style="text-align:center;margin:24px 0 0;">${contactButtons}</p>`
    : '';

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${leadHtml}</p>
    <p>You can review the offer, accept, decline, or submit a counter offer here:</p>
    <p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View the offer</a></p>
    <p>The offer is available until <strong>${escapeHtml(expiryDate)}</strong>.</p>
    ${contactBlock}
    <p style="margin-top:24px;">Team INFLUENCE</p>`);

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
    `Hi ${firstName},`,
    ``,
    `A new ${brandName} campaign is available for you.`,
    ``,
    `Review the offer and campaign details here: ${offerUrl}`,
    ``,
    `The offer is available until ${expiryDate}. You can accept, decline, or submit a counter offer directly from the offer page linked above.`,
    ``,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>A new <strong>${escapeHtml(brandName)}</strong> campaign is available for you.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(offerUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">Review the offer</a></p>
    <p>The offer is available until <strong>${escapeHtml(expiryDate)}</strong>. You can accept, decline, or submit a counter offer directly from the offer page linked above.</p>
    <p style="margin-top:24px;">Team INFLUENCE</p>`);

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

  const text = [
    `Hi ${firstName},`,
    ``,
    congratsLine,
    ``,
    `Your ${brandName} collaboration has now been completed.`,
    ``,
    `We'll be in touch when another collaboration is a good fit.`,
    ``,
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
  const buttonBlock = buttons ? `<p style="text-align:center;margin:24px 0;">${buttons}</p>` : '';

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>${escapeHtml(congratsLine)}</p>
    <p>Your <strong>${escapeHtml(brandName)}</strong> collaboration has now been completed.</p>
    ${buttonBlock}
    <p>We'll be in touch when another collaboration is a good fit.</p>
    <p style="margin-top:24px;">Team INFLUENCE</p>`);

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

// (Removed: renderOfferConfirmationEmail / sendOfferConfirmationEmail.)
// The old "we'll follow up in 1–2 business days" confirmation email is gone —
// the creator's next step (sign the mini-contract, then receive their
// personalised brief link) happens right on the portal, so an extra inbox
// email would set the wrong expectation.

// Content-brief-ready email — the direct-email fallback in
// offers.deliverBriefToCreator, used when the creator has neither an
// established WhatsApp/iMessage conversation nor a live cold-outreach thread,
// but we do have an address on file. Short and link-first, same voice as
// renderOfferEmail.
function renderBriefReadyEmail({ firstName, brandName, briefUrl }) {
  const subject = `Your ${brandName} content brief is ready`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `Your content brief for ${brandName} is ready.`,
    ``,
    `The brief includes the campaign requirements and everything needed for you to get started.`,
    ``,
    `View your brief here: ${briefUrl}`,
    ``,
    `Team INFLUENCE`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Your content brief for <strong>${escapeHtml(brandName)}</strong> is ready.</p>
    <p>The brief includes the campaign requirements and everything needed for you to get started.</p>
    <p style="text-align:center;margin:32px 0;"><a href="${escapeHtml(briefUrl)}" style="background:#171717;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">View your brief</a></p>
    <p style="margin-top:24px;">Team INFLUENCE</p>`);

  return { subject, text, html };
}

async function sendBriefReadyEmail({ to, firstName, brandName, briefUrl }) {
  const { subject, text, html } = renderBriefReadyEmail({ firstName, brandName, briefUrl });
  return deliver({ to, subject, text, html });
}

// Signed-agreement copy — sent to the creator the moment they sign, with the
// executed PDF attached (services/signedContractEmail.js builds it). Creators
// routinely ask for "a copy of what I signed" days later; this puts it in their
// inbox before they have to ask. Short by design: the document IS the message,
// so the email only says the agreement is complete and that a copy is attached.
// Sent from the contracts@ sender (contractFromAddress) and signed off as
// "INFLUENCE Contracts" so replies go to the contract team, not offers@.
function renderSignedContractEmail({ firstName, brandName, campaignName }) {
  const brand = brandName || 'the brand';
  const forCampaign = campaignName ? ` for ${campaignName}` : '';
  const subject = `Your signed ${brand} agreement`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `Your agreement with ${brand}${forCampaign} has been signed and completed.`,
    ``,
    `A copy of the signed agreement is attached for your records.`,
    ``,
    `INFLUENCE Contracts`,
  ].join('\n');

  const html = shell(`    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Your agreement with <strong>${escapeHtml(brand)}</strong>${forCampaign ? ` for ${escapeHtml(campaignName)}` : ''} has been signed and completed.</p>
    <p>A copy of the signed agreement is attached for your records.</p>
    <p style="margin-top:24px;">INFLUENCE Contracts</p>`);

  return { subject, text, html };
}

// `pdf` is the rendered agreement (a Buffer) and `filename` the name it should
// land under in the creator's inbox — from services/contractPdf.js for the full
// contract, services/miniContractPdf.js for the portal one. Sent from the
// contracts@ address, not the offers@ default.
async function sendSignedContractEmail({ to, firstName, brandName, campaignName, pdf, filename }) {
  const { subject, text, html } = renderSignedContractEmail({ firstName, brandName, campaignName });
  return deliver({
    to,
    from: contractFromAddress(),
    subject,
    text,
    html,
    attachments: pdf ? [attachment(filename || 'Contract-Signed.pdf', pdf)] : [],
  });
}

// Plain prose email for the campaign-update lane (services/creatorUpdates.js).
// Unlike every render* above, the copy is passed IN rather than built here —
// those templates each sell one specific thing and own their layout, whereas
// this is the fallback route for a message whose real home is WhatsApp
// (updateMessages.js writes it once, for both channels). Paragraphs are split on
// blank lines so the plain-text body and the HTML stay the same message.
function renderProseEmail({ subject, body }) {
  const text = String(body || '');
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `    <p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
  return { subject, text, html: shell(paragraphs) };
}

async function sendProseEmail({ to, subject, body }) {
  return deliver({ to, ...renderProseEmail({ subject, body }) });
}

module.exports = {
  isConfigured,
  attachment,
  contractFromAddress,
  renderOfferEmail,
  sendOfferEmail,
  renderPortalInviteEmail,
  sendPortalInviteEmail,
  renderOfferWithContactEmail,
  sendOfferWithContactEmail,
  renderNewCampaignOfferEmail,
  sendNewCampaignOfferEmail,
  renderGraduationEmail,
  sendGraduationEmail,
  renderBriefReadyEmail,
  sendBriefReadyEmail,
  renderSignedContractEmail,
  sendSignedContractEmail,
  renderProseEmail,
  sendProseEmail,
};
