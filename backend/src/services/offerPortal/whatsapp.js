'use strict';

// Offer-portal WhatsApp channel. Supports two backends behind one surface
// (businessNumber / sendWhatsAppText / normalizePhone / renderOfferOutreachBody)
// so callers (offers.js, outreach.js, offerWebhook.js) never change:
//
//   • 'cloud'  — Meta WhatsApp Cloud API, DIRECT (no BSP markup). Sends via
//                Graph API: POST {BASE}/{VERSION}/{PHONE_NUMBER_ID}/messages
//                with `Authorization: Bearer {ACCESS_TOKEN}` and a JSON body.
//                Our creator-initiated flow (creator texts "Hi" first) runs in
//                Meta's free 24h service window, so replies cost nothing.
//   • 'twilio' — Twilio's REST Messages API (BSP). Basic-Auth SID:token, a
//                form-encoded From/To/Body body.
//
// Which one is chosen: WHATSAPP_PROVIDER ('cloud' | 'twilio') wins; unset, we
// auto-detect Cloud when its access token is present, else Twilio — so simply
// setting the WHATSAPP_CLOUD_* vars flips the provider. Sends are skipped
// gracefully when the active provider's creds are absent, so dev never breaks.
//
// 24h window: both providers reject free-form text sent to a user who hasn't
// messaged us in the last 24h (Twilio HTTP 400 code 63016; Meta 4xx code
// 131047/131026). The AiSensy-era session-template fallback was dropped on the
// Twilio swap and is not reintroduced here — a send outside the window fails
// with a clear error and can be retried once the creator messages us again.

const { extractProviderMessageId } = require('./deliveryStatus');

// --- Provider selection ----------------------------------------------------
function whatsappProvider() {
  const explicit = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'cloud' || explicit === 'twilio') return explicit;
  // Auto-detect: Cloud when its access token is set, else fall back to Twilio.
  return process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ? 'cloud' : 'twilio';
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
  return whatsappProvider() === 'cloud'
    ? process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER || ''
    : process.env.TWILIO_WHATSAPP_FROM || '';
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

// The public send used by offers.js / offerWebhook.js — dispatches to whichever
// provider is configured so callers stay vendor-agnostic.
async function sendWhatsAppText({ to, body }) {
  return whatsappProvider() === 'cloud' ? sendCloudText({ to, body }) : sendTwilioText({ to, body });
}

// --- Interactive reply buttons --------------------------------------------
// Meta caps an interactive message at 3 reply buttons with 20-character titles
// and a 1024-character body (a quarter of the plain-text limit) and rejects the
// whole send if any is exceeded — so the limits are enforced here rather than
// discovered as a 400 with the message lost.
const MAX_BUTTONS = 3;
const BUTTON_TITLE_MAX = 20;
const INTERACTIVE_BODY_MAX = 1024;

// Free-form interactive message with tappable reply buttons. Cloud API only, and
// subject to the same 24h window as text. Meta echoes the tapped button's TITLE
// back as the inbound message body, so the titles double as the words our reply
// classifier sees — see offerPortal/replies.js.
async function sendCloudButtons({ to, body, buttons }) {
  if (!cloudToken() || !cloudPhoneNumberId()) {
    console.warn(
      `[offer-whatsapp] WHATSAPP_CLOUD_ACCESS_TOKEN/PHONE_NUMBER_ID not set — skipping buttons to ${to}`,
    );
    return { sent: false, skipped: true };
  }
  const recipient = normalizePhone(to);
  if (!recipient) return { sent: false, error: 'invalid recipient number' };

  const replies = (buttons || [])
    .filter((b) => b && b.title)
    .slice(0, MAX_BUTTONS)
    .map((b, i) => ({
      type: 'reply',
      reply: {
        id: String(b.id || `opt_${i}`).slice(0, 256),
        title: String(b.title).slice(0, BUTTON_TITLE_MAX),
      },
    }));
  // Nothing tappable left — a plain text send still delivers the message.
  if (!replies.length) return sendCloudText({ to, body });

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
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: String(body || '') },
          action: { buttons: replies },
        },
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

// Ask a question with tappable options where the provider supports them, and the
// same question with the options written out where it doesn't (Twilio, or a body
// too long for an interactive message). A creator can always answer either way —
// the buttons are an affordance, never the only route.
async function sendWhatsAppChoice({ to, body, buttons, fallbackHint }) {
  const hint = fallbackHint || (buttons || []).map((b) => b && b.title).filter(Boolean).join(' or ');
  const asText = () => sendWhatsAppText({ to, body: hint ? `${body}\n\n${hint}` : body });

  if (whatsappProvider() !== 'cloud') return asText();
  if (String(body || '').length > INTERACTIVE_BODY_MAX) return asText();
  return sendCloudButtons({ to, body, buttons });
}

// A single call-to-action button that OPENS A LINK, distinct from
// sendCloudButtons' quick-reply buttons — those echo their title back as the
// creator's next message, which makes no sense for a URL. Cloud API only:
// Twilio has no ad-hoc equivalent outside pre-approved Content Templates, which
// this codebase deliberately avoids (see the WHATSAPP_PROVIDER notes in
// .env.example) — sendWhatsAppLink below falls back to the link written into
// the message text for Twilio.
async function sendCloudLinkButton({ to, body, buttonText, url }) {
  if (!cloudToken() || !cloudPhoneNumberId()) {
    console.warn(`[offer-whatsapp] WHATSAPP_CLOUD_ACCESS_TOKEN/PHONE_NUMBER_ID not set — skipping link button to ${to}`);
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
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: String(body || '') },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: String(buttonText || 'View').slice(0, BUTTON_TITLE_MAX),
              url: String(url),
            },
          },
        },
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

// Send a message whose call to action is a LINK: a tappable "View Offer"-style
// button on Cloud, or the same message with the link written out everywhere
// else (Twilio, or a body too long for an interactive message) — the link is
// never silently dropped. `fallbackBody` is the full text WITH the link baked
// in (renderOfferOutreachBody); `body` is the button-message text, which must
// NOT repeat the link since the button already carries it.
async function sendWhatsAppLink({ to, body, buttonText, url, fallbackBody }) {
  if (whatsappProvider() !== 'cloud' || String(body || '').length > INTERACTIVE_BODY_MAX) {
    return sendWhatsAppText({ to, body: fallbackBody });
  }
  return sendCloudLinkButton({ to, body, buttonText, url });
}

// --- Template messages (outside the 24h window) ----------------------------
// Everything above is a FREE-FORM send, which Meta only permits inside the 24h
// window a creator's own inbound message opens. The campaign-update lane (see
// services/creatorUpdates.js) has to reach creators who signed a contract and
// then went quiet for a week — a brief published on Tuesday, an approval on
// Friday — so it needs the one thing free-form text cannot do: start a
// conversation.
//
// That is what a template is: copy submitted to Meta in advance and approved by
// them, sendable at any time. The variables are positional ({{1}}, {{2}}, …) and
// must match the approved copy exactly — Meta rejects the send otherwise, which
// is why the template NAMES live in env vars: the copy is registered in the
// WhatsApp Manager, not here, and the two are matched by configuration rather
// than by a deploy.
//
// Cloud API only. Twilio's equivalent (Content Templates) is deliberately not
// used anywhere in this codebase, so under provider=twilio these skip with
// `templatesUnsupported` and the caller leaves the update queued until the
// creator writes in and the free-form window opens.

function templateLanguage() {
  return process.env.WHATSAPP_TEMPLATE_LANG || 'en';
}

// Whether a template send can even be attempted right now: Cloud provider with
// send credentials. Callers check this to decide between "send it as a template"
// and "hold it until the creator opens a window".
function templatesAvailable() {
  return whatsappProvider() === 'cloud' && !!cloudToken() && !!cloudPhoneNumberId();
}

// Build the `components` array for a template send. Body variables are
// positional and go out in the order given; `buttonUrlSuffix` fills the dynamic
// part of a URL button whose approved copy ends in {{1}} (Meta takes only the
// SUFFIX — the fixed prefix lives in the approved template, so passing a whole
// https:// URL here would produce a doubled link).
function buildTemplateComponents({ bodyParams, buttonUrlSuffix }) {
  const components = [];
  const params = (bodyParams || []).filter((v) => v != null).map((v) => ({ type: 'text', text: String(v) }));
  if (params.length) components.push({ type: 'body', parameters: params });
  if (buttonUrlSuffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(buttonUrlSuffix) }],
    });
  }
  return components;
}

// Send a pre-approved template. Returns the same { sent, id?, skipped?, error? }
// shape as every other send here, so callers never special-case it.
async function sendWhatsAppTemplate({ to, name, languageCode, bodyParams, buttonUrlSuffix }) {
  if (whatsappProvider() !== 'cloud') {
    return { sent: false, skipped: true, reason: 'templates_unsupported_on_twilio' };
  }
  if (!cloudToken() || !cloudPhoneNumberId()) {
    console.warn(
      `[offer-whatsapp] WHATSAPP_CLOUD_ACCESS_TOKEN/PHONE_NUMBER_ID not set — skipping template to ${to}`,
    );
    return { sent: false, skipped: true, reason: 'not_configured' };
  }
  if (!name) return { sent: false, skipped: true, reason: 'no_template_configured' };
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
        type: 'template',
        template: {
          name: String(name),
          language: { code: languageCode || templateLanguage() },
          components: buildTemplateComponents({ bodyParams, buttonUrlSuffix }),
        },
      }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { sent: true, id: extractCloudMessageId(data), template: String(name) };
    }
    const text = await res.text().catch(() => '');
    // The two that actually happen in production, named rather than left as a
    // raw 400: the template isn't approved (or the name is misspelled), and the
    // variable count doesn't match the approved copy. Both look identical in a
    // log otherwise, and both are fixed in the WhatsApp Manager, not in code.
    const hint = /132001|does not exist/i.test(text)
      ? ' — template not found/approved for this WABA; check the name and language in WhatsApp Manager'
      : /132000|param/i.test(text)
        ? ' — variable count does not match the approved template body'
        : '';
    return { sent: false, error: `${res.status} ${text.slice(0, 200)}${hint}` };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

// The offer-reveal message body (free-form session reply used by
// deliverOfferOverChannel) — also stored in offer_messages so the admin can see
// what the creator received. Points them straight at the portal link to view
// AND accept the offer. This is the FALLBACK text (Twilio, or an oversized
// body) — the link is written out inline. For Cloud, sendWhatsAppLink sends
// renderOfferOutreachIntro as the message and the same link as a tappable
// button instead.
//
// No greeting here — "Hi {firstName}, this is INFLUENCE" only opens the FIRST
// message of the conversation (replies.renderBriefIntro); every later message
// is a reply in an already-introduced thread, and reintroducing ourselves on
// every send read like a broken mail merge.
function renderOfferOutreachBody({ brandName, offerUrl, expiryDate }) {
  return `Here are the details for your ${brandName} collaboration.\n\nReview the full offer and confirm here: ${offerUrl}\n\nOpen until ${expiryDate}.`;
}

// Same offer-reveal copy as renderOfferOutreachBody, but without the link
// text — used as the body of the Cloud "View Offer" button message, where the
// link lives on the button instead of repeated in the message.
function renderOfferOutreachIntro({ brandName, expiryDate }) {
  return `Here are the details for your ${brandName} collaboration.\n\nTap below to review the full offer and confirm.\n\nOpen until ${expiryDate}.`;
}

// Sent once an admin publishes the creator's personalised content brief (see
// offers.deliverBriefToCreator) — a free-form session reply on an already-
// established channel. No greeting — see renderOfferOutreachBody above.
function renderContentBriefReadyBody({ brandName, briefUrl }) {
  return `Your ${brandName} content brief is ready.\n\nEverything you need to start creating is here: ${briefUrl}`;
}

module.exports = {
  whatsappProvider,
  normalizePhone,
  toWhatsAppAddr,
  businessNumber,
  sendWhatsAppText,
  sendWhatsAppChoice,
  sendWhatsAppTemplate,
  templatesAvailable,
  templateLanguage,
  buildTemplateComponents,
  sendCloudButtons,
  sendWhatsAppLink,
  sendCloudLinkButton,
  MAX_BUTTONS,
  BUTTON_TITLE_MAX,
  INTERACTIVE_BODY_MAX,
  renderOfferOutreachBody,
  renderOfferOutreachIntro,
  renderContentBriefReadyBody,
  // Exposed for tests.
  buildTwilioForm,
  basicAuthHeader,
  extractTwilioErrorCode,
  extractCloudMessageId,
  messagesUrl,
  cloudMessagesUrl,
  sendTwilioText,
  sendCloudText,
};
