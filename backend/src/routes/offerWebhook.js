'use strict';

// Inbound offer-portal webhooks + reply bot. AiSensy (WhatsApp) and Linq (the
// iMessage gateway) POST each creator reply here; we:
//   1. match the sender to a creator by their WhatsApp / iMessage number
//   2. a pending offer's conversation runs in stages (offers.messaging_stage —
//      this is how the offer ever reaches WhatsApp/iMessage; nothing is ever
//      pushed there cold, see offers.js's module comment):
//        not yet briefed → send the brand/product brief + a yes/no interest
//          check (never the raw offer) — almost always triggered by "Hi"
//        briefed, awaiting interest → classify the reply as yes/no on
//          INTEREST (not a rate decision yet): yes reveals the full offer,
//          no declines the opportunity, unclear gets a Yes/No nudge
//        revealed → falls through to step 3 below, same as always
//   3. classify the body (accept / decline / other) against the REAL offer
//   4. accept/decline with a pending offer → call respondToOffer — the SAME
//      backend path the web Accept button uses (a WhatsApp "yes" and a web
//      Accept can never drift apart)
//   5. anything else → send the deflection reply and flag needs_review so it
//      surfaces for a human in the dashboard.
// Ported from Influence-CDB-portal (api/webhooks/aisensy/route.ts), generalised
// to both channels. Linq nests the reply differently from AiSensy (its content
// lives in message.parts[].value and the sender in sender_handle, under an
// event envelope), so parseInbound handles both shapes.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const offers = require('../services/offers');
const negotiation = require('../services/negotiation');
const {
  classifyReply,
  parseRequestedRate,
  isOptOut,
  isOptIn,
  tooHighReply,
  interestClarificationMessage,
  firstContactHoldingMessage,
  DEFLECTION_MESSAGE,
  OPT_OUT_CONFIRMATION,
  OPT_IN_CONFIRMATION,
} = require('../services/offerPortal/replies');
const { normalizePhone, sendWhatsAppText } = require('../services/offerPortal/whatsapp');
const { sendIMessageText } = require('../services/offerPortal/imessage');
const {
  parseStatusEvent,
  extractProviderMessageId,
  NEW_MESSAGE_EVENTS,
} = require('../services/offerPortal/deliveryStatus');

const router = express.Router();

const getString = (obj, key) => {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
};

// Linq wraps each event under `data`; AiSensy and other gateways are flat. Look
// under `data` when it's present, else treat the payload itself as the event.
function unwrap(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  return payload && typeof payload === 'object' ? payload : {};
}

// Event kind, if the gateway sends one. Linq: "message.created", "reaction.*",
// "participant.*", "call.*", read/typing events. AiSensy inbound has none.
// NB: only event_type/event — never the bare `type`, which AiSensy uses for the
// message CONTENT type (text/image), not an event kind.
function eventType(payload) {
  return getString(payload, 'event_type') || getString(payload, 'event') || null;
}

// The sender's phone/handle. Linq puts it in sender_handle ({ handle, service }
// or a bare string); other gateways use one of several flat aliases.
function extractSender(d) {
  const sh = d.sender_handle;
  if (sh && typeof sh === 'object' && typeof sh.handle === 'string') return sh.handle;
  if (typeof sh === 'string') return sh;
  return (
    getString(d, 'from') ||
    getString(d, 'handle') ||
    getString(d, 'phoneNumber') ||
    getString(d, 'phone_number') ||
    getString(d, 'wa_id') ||
    getString(d, 'mobile') ||
    getString(d, 'sender') ||
    null
  );
}

// The message text. Linq: message.parts[] (join the text parts; a non-text part
// such as an image or imessage_app becomes a placeholder). Other gateways: flat
// message/body/content/text aliases.
function extractBody(d) {
  const msg = d.message;
  const parts =
    msg && typeof msg === 'object' && Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(d.parts)
        ? d.parts
        : null;
  if (parts) {
    const texts = parts
      .filter((p) => p && (p.type === 'text' || p.type == null) && typeof p.value === 'string')
      .map((p) => p.value.trim())
      .filter(Boolean);
    if (texts.length) return texts.join(' ');
    const firstType = (parts[0] && parts[0].type) || 'unknown';
    return `[non-text message: ${firstType}]`;
  }
  const textField = d.text;
  return (
    getString(d, 'message') ||
    getString(d, 'body') ||
    getString(d, 'content') ||
    getString(textField, 'body') ||
    (typeof textField === 'string' ? textField : null)
  );
}

// Normalise an inbound webhook into { from, body } — or { ignore } for events we
// deliberately skip (non-message events, and echoes of our own outbound sends),
// or null when there's no sender to match on. Handles both the Linq envelope and
// the flat AiSensy shape.
function parseInbound(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Only a genuinely new inbound message is a reply. Everything else — reactions,
  // receipts, typing, participant/call events, and delivery-status events
  // (message.delivered/read/failed) — is ignored here (status callbacks are
  // handled before this in the webhook route).
  const evt = eventType(payload);
  if (evt && !NEW_MESSAGE_EVENTS.has(evt.toLowerCase())) return { ignore: `event:${evt}` };

  const d = unwrap(payload);

  // Skip echoes of our own outbound messages (Linq streams both directions).
  const dir = getString(d, 'direction');
  if (dir && !/^(in|incoming|inbound|received)/i.test(dir)) return { ignore: `direction:${dir}` };

  const from = extractSender(d);
  if (!from) return null;

  let body = extractBody(d);
  if (!body) {
    const type = getString(d, 'type') || 'unknown';
    body = `[non-text message: ${type}]`;
  }
  return { from: normalizePhone(from), body };
}

// Timing-safe string compare that never throws on a length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verify a Linq inbound webhook's HMAC signature against IMESSAGE_WEBHOOK_SECRET.
// Verification is disabled when no secret is configured (sandbox-friendly), the
// same convention the Instantly webhook uses. Linq's docs reference BOTH the
// Standard Webhooks spec (webhook-id / webhook-timestamp / webhook-signature,
// secret "whsec_<base64>", base64 HMAC-SHA256 over "{id}.{timestamp}.{body}")
// and custom X-Linq-Signature / X-Linq-Timestamp headers (hex HMAC-SHA256), so
// we accept whichever the sandbox actually emits. Confirm the scheme in your
// Linq dashboard and prune the unused branch once known.
function verifyLinqSignature(req) {
  const secret = process.env.IMESSAGE_WEBHOOK_SECRET;
  if (!secret) return true; // verification disabled if secret not set

  // HMAC the raw request bytes (captured in server.js), not a re-serialized copy
  // of the parsed body — key order/whitespace differences would never match.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

  // --- Standard Webhooks (https://www.standardwebhooks.com) ---
  const swSig = req.headers['webhook-signature'];
  if (swSig) {
    const id = String(req.headers['webhook-id'] || '');
    const ts = String(req.headers['webhook-timestamp'] || '');
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
    // The header is a space-separated list of "v1,<sig>" tokens.
    return String(swSig)
      .split(' ')
      .some((tok) => safeEqual(tok.includes(',') ? tok.split(',')[1] : tok, expected));
  }

  // --- Linq custom-header variant ---
  const linqSig = req.headers['x-linq-signature'];
  if (linqSig) {
    const ts = String(req.headers['x-linq-timestamp'] || '');
    const signed = ts ? `${ts}.${raw}` : raw;
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    let got = String(linqSig);
    if (got.startsWith('sha256=')) got = got.slice(7);
    return safeEqual(got, expected);
  }

  // Secret configured but no recognised signature header — reject, and make the
  // reason visible in the logs rather than dropping the reply silently.
  console.warn(
    '[offer-webhook] iMessage secret set but no recognised Linq signature header; saw:',
    Object.keys(req.headers).filter((h) => /sig|webhook|linq/i.test(h)),
  );
  return false;
}

// Shared-secret check for the AiSensy WhatsApp webhook (header or query param).
function authorizedSecret(req, secretEnv) {
  const secret = process.env[secretEnv];
  if (!secret) return true; // dev mode — no secret configured
  const header = req.headers['x-webhook-secret'];
  const query = req.query && req.query.secret;
  return header === secret || query === secret;
}

// Match an inbound number to a creator whose contact column (whatsapp/imessage)
// matches. Compares on bare digits, then falls back to the last 10 digits so a
// present/absent country code doesn't miss the match.
// Pure matcher: pick the row whose contact matches fromDigits — exact bare-digits
// first, else last-10-digits suffix (so a present/absent country code doesn't
// miss). Each row exposes a normalisable `contact`. Extracted for unit testing.
function pickMatch(rows, fromDigits) {
  const tail = (s) => s.slice(-10);
  let suffix = null;
  for (const r of rows) {
    const digits = normalizePhone(r.contact);
    if (!digits) continue;
    if (digits === fromDigits) return r; // exact wins immediately
    if (tail(digits) && tail(digits) === tail(fromDigits)) suffix = suffix || r;
  }
  return suffix;
}

async function matchCreator(contactColumn, fromDigits) {
  const rows = await db.many(
    `SELECT id, whatsapp, imessage, first_name, full_name, established_channel, ${contactColumn} AS contact
     FROM creators WHERE ${contactColumn} IS NOT NULL`,
  );
  return pickMatch(rows, fromDigits);
}

// Pure routing for an inbound reply: which backend action it maps to. Keeps the
// webhook's decision — and the guarantee that a messaged accept/decline converges
// on the SAME respondToOffer the web button uses — unit-testable.
function decideInboundAction({ intent, hasPendingOffer, requestedRate }) {
  if ((intent === 'accept' || intent === 'decline') && hasPendingOffer) {
    return { action: 'respond', response: intent === 'accept' ? 'accepted' : 'declined' };
  }
  if (intent === 'other' && hasPendingOffer && requestedRate) {
    return { action: 'negotiate', requestedRate };
  }
  return { action: 'review' };
}

const firstNameOf = (creator) =>
  (creator.first_name && String(creator.first_name).trim()) ||
  (creator.full_name ? String(creator.full_name).trim().split(/\s+/)[0] : '') ||
  'there';

// Send a free-form text on the creator's channel and log it as an outbound
// offer_message. Best-effort — a send failure is logged, never thrown.
async function sendChannelMessage(channel, creator, offerId, body) {
  const to = channel === 'imessage' ? creator.imessage : creator.whatsapp;
  if (!to) return;
  try {
    const send = channel === 'imessage' ? sendIMessageText : sendWhatsAppText;
    const result = await send({ to, body });
    if (result.sent) {
      await db.query(
        `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
         VALUES ($1, $2, 'outbound', $3, $4, $5)`,
        [creator.id, offerId, channel, body, result.id || null],
      );
    }
  } catch (err) {
    console.error(`[offer-webhook] ${channel} send failed`, err.message);
  }
}

const sendDeflection = (channel, creator, offerId) =>
  sendChannelMessage(channel, creator, offerId, DEFLECTION_MESSAGE);

// Shared handler for both channels. `authFn(req)` returns true when the request
// is authentic (WhatsApp: shared secret; iMessage: Linq HMAC signature).
async function handleInbound(channel, contactColumn, authFn, req, res) {
  if (!authFn(req)) return res.status(401).json({ ok: false });

  // Log the exact inbound shape (truncated) so the provider's real schema can be
  // verified against parseInbound from the Railway logs — including sends from a
  // number that isn't yet a known creator, which never reach the DB below.
  try {
    console.log(`[offer-webhook] inbound ${channel} raw:`, JSON.stringify(req.body).slice(0, 1000));
  } catch (_) {
    /* body not serialisable — ignore */
  }

  // A delivery/read/failed status callback (not a reply) → update the outbound
  // row it refers to and stop. Checked before parseInbound so a status event is
  // never mistaken for a creator reply.
  const statusEvent = parseStatusEvent(req.body);
  if (statusEvent) {
    const result = await offers.recordDeliveryStatus({ channel, ...statusEvent });
    return res.json({ ok: true, status: statusEvent.status, updated: result.updated || 0 });
  }

  const parsed = parseInbound(req.body);
  if (!parsed) return res.json({ ok: true, ignored: 'unparseable' });
  if (parsed.ignore) return res.json({ ok: true, ignored: parsed.ignore });

  const matched = await matchCreator(contactColumn, parsed.from);
  if (!matched) {
    console.warn(`[offer-webhook] inbound ${channel} from unknown number ${parsed.from}`);
    return res.json({ ok: true, ignored: 'unknown_sender' });
  }

  // Idempotency: providers retry webhook deliveries. If this exact inbound
  // message was already recorded, skip re-processing — accept/decline is already
  // guarded by respondToOffer, but a retried counter or "other" would otherwise
  // double-act (a second counter-offer, a duplicate needs_review row).
  const providerMessageId = extractProviderMessageId(req.body);
  if (providerMessageId) {
    const seen = await db.one(
      `SELECT 1 FROM offer_messages
        WHERE direction = 'inbound' AND provider_message_id = $1 LIMIT 1`,
      [providerMessageId],
    );
    if (seen) return res.json({ ok: true, deduped: true });
  }

  // Compliance: STOP/UNSUBSCRIBE opt-out (and START opt-in). Handled before any
  // offer logic — an opt-out must suppress future automated sends regardless of
  // offer state. The single confirmation is sent directly (it isn't gated by the
  // opt-out flag we just set), which is standard practice.
  if (isOptOut(parsed.body)) {
    await db.query(
      `UPDATE creators SET messaging_opted_out = TRUE, messaging_opted_out_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [matched.id],
    );
    await db.query(
      `INSERT INTO offer_messages (creator_id, direction, channel, body, raw_payload, provider_message_id)
       VALUES ($1, 'inbound', $2, $3, $4::jsonb, $5)`,
      [matched.id, channel, parsed.body, JSON.stringify(req.body ?? null), providerMessageId],
    );
    await sendChannelMessage(channel, matched, null, OPT_OUT_CONFIRMATION);
    return res.json({ ok: true, outcome: 'opted_out' });
  }
  if (isOptIn(parsed.body)) {
    await db.query(
      `UPDATE creators SET messaging_opted_out = FALSE, messaging_opted_out_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [matched.id],
    );
    await db.query(
      `INSERT INTO offer_messages (creator_id, direction, channel, body, raw_payload, provider_message_id)
       VALUES ($1, 'inbound', $2, $3, $4::jsonb, $5)`,
      [matched.id, channel, parsed.body, JSON.stringify(req.body ?? null), providerMessageId],
    );
    await sendChannelMessage(channel, matched, null, OPT_IN_CONFIRMATION);
    return res.json({ ok: true, outcome: 'opted_in' });
  }

  const pendingOffer = await db.one(
    `SELECT id, token, messaging_stage FROM offers WHERE creator_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [matched.id],
  );
  const fallbackOffer = pendingOffer
    ? null
    : await db.one(
        `SELECT id FROM offers WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [matched.id],
      );

  // No offer exists yet: the creator is engaging before an admin has priced one (a
  // USED creator who reached us on WhatsApp/iMessage — see outreach.sendOutreach).
  // On FIRST contact, open with the brand/product brief + a yes/no interest check
  // (brand details, gauge interest) — the offer + portal link follows once an
  // admin prices it and delivers on this same channel. On later messages (already
  // briefed, still no priced offer), reply with a warm holding line. Either way we
  // establish the channel and flag it for a human to price. established_channel is
  // set by this branch, so it's NULL only on the very first contact.
  if (!pendingOffer && !fallbackOffer) {
    const firstContact = !matched.established_channel;
    await db.query(
      `UPDATE creators SET established_channel = COALESCE(established_channel, $2), updated_at = NOW() WHERE id = $1`,
      [matched.id, channel],
    );
    // Put the creator in front of an admin to PRICE & SEND the offer: compute
    // suggested offers from their scraped views + move to AWAITING_APPROVAL, so
    // "Decide offer" appears in Deal Studio. Without this a Used creator who
    // texts "Hi" sits at a null stage forever with no way to send them an offer.
    // Idempotent + best-effort — a repeated "Hi" never re-flags or resets.
    try {
      await negotiation.startOfferForCreator(matched.id);
    } catch (err) {
      console.error('[offer-webhook] startOfferForCreator failed', err.message);
    }
    await db.query(
      `INSERT INTO offer_messages (creator_id, direction, channel, body, needs_review, raw_payload, provider_message_id)
       VALUES ($1, 'inbound', $2, $3, TRUE, $4::jsonb, $5)`,
      [matched.id, channel, parsed.body, JSON.stringify(req.body ?? null), providerMessageId],
    );
    if (firstContact) {
      const brief = await offers.sendUsedCreatorBrief(matched.id, channel);
      return res.json({
        ok: true,
        outcome: brief.sent ? 'briefed_no_offer' : 'brief_failed',
        needsReview: true,
      });
    }
    await sendChannelMessage(channel, matched, null, firstContactHoldingMessage(firstNameOf(matched)));
    return res.json({ ok: true, outcome: 'awaiting_offer', needsReview: true });
  }

  // A pending offer's messaging conversation runs in stages (offers.
  // messaging_stage) rather than dumping the rate on first contact:
  //   null     — this offer has never been briefed on this channel. First
  //              contact (almost always just "Hi") triggers the brand/product
  //              brief + a yes/no interest check — never the raw offer.
  //   briefed  — awaiting a yes/no on INTEREST (not yet a rate decision).
  //              yes → reveal the full offer; no → decline the opportunity;
  //              unclear → nudge toward Yes/No instead of the generic
  //              deflection, which would be a non-sequitur here.
  //   revealed — the real offer is out; falls through to the normal
  //              accept/decline/counter flow below, unchanged.
  const logInboundAtOffer = (needsReview = false) =>
    db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, needs_review, raw_payload, provider_message_id)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6::jsonb, $7)`,
      [matched.id, pendingOffer.id, channel, parsed.body, needsReview, JSON.stringify(req.body ?? null), providerMessageId],
    );

  if (pendingOffer && !pendingOffer.messaging_stage) {
    const briefed = await offers.sendOfferBriefing(pendingOffer.id, channel);
    await logInboundAtOffer(!briefed.sent);
    return res.json({ ok: true, outcome: briefed.sent ? 'briefed' : 'briefing_failed' });
  }

  if (pendingOffer && pendingOffer.messaging_stage === 'briefed') {
    const interest = classifyReply(parsed.body);
    let outcome;
    let needsReview = false;
    if (interest === 'accept') {
      const revealed = await offers.deliverOfferOverChannel(pendingOffer.id, channel);
      outcome = revealed.sent ? 'offer_revealed' : 'offer_reveal_failed';
      needsReview = !revealed.sent;
    } else if (interest === 'decline') {
      const result = await offers.respondToOffer({ token: pendingOffer.token, response: 'declined', channel });
      outcome = result.ok ? 'declined_at_brief' : 'declined_at_brief_failed';
      needsReview = !result.ok;
    } else {
      await sendChannelMessage(channel, matched, pendingOffer.id, interestClarificationMessage(firstNameOf(matched)));
      outcome = 'interest_unclear';
      needsReview = true;
    }
    await logInboundAtOffer(needsReview);
    return res.json({ ok: true, outcome, needsReview });
  }

  const attachedOfferId = (pendingOffer && pendingOffer.id) || (fallbackOffer && fallbackOffer.id) || null;

  const intent = classifyReply(parsed.body);
  const requestedRate = intent === 'other' ? parseRequestedRate(parsed.body) : null;
  const decision = decideInboundAction({ intent, hasPendingOffer: !!pendingOffer, requestedRate });

  let needsReview = false;
  let shouldDeflect = false;
  let outcome = 'deflected';

  if (decision.action === 'respond') {
    // Same backend path as the web Accept/Decline button — no drift.
    const result = await offers.respondToOffer({
      token: pendingOffer.token,
      response: decision.response,
      channel,
    });
    if (result.ok) {
      outcome = 'responded'; // respondToOffer already sent the follow-up
    } else {
      needsReview = true;
      shouldDeflect = true;
    }
  } else if (decision.action === 'negotiate') {
    // A counter-rate ask ("can you do $500?") → the SAME CPM counter engine the
    // web offer page uses, so a messaged counter and a web counter can't drift.
    const neg = await offers.negotiateBudget({
      token: pendingOffer.token,
      requestedRate: decision.requestedRate,
    });
    if (neg && neg.ok && neg.outcome === 'countered') {
      outcome = 'countered'; // negotiateBudget already delivered the counter link
    } else if (neg && neg.ok && neg.outcome === 'too_high') {
      outcome = 'too_high';
      needsReview = true; // above the ceiling — surface for a human too
      await sendChannelMessage(
        channel,
        matched,
        attachedOfferId,
        tooHighReply(firstNameOf(matched), neg.originalRateFormatted),
      );
    } else {
      // Negotiation errored → human review + deflection.
      needsReview = true;
      shouldDeflect = true;
    }
  } else {
    // Nothing actionable (unrecognised, or accept/decline with no pending offer).
    needsReview = true;
    shouldDeflect = true;
  }

  // Persist the raw payload alongside the parsed body so the exact provider
  // schema stays inspectable (verification, and any future parser tightening).
  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, needs_review, raw_payload, provider_message_id)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6::jsonb, $7)`,
    [matched.id, attachedOfferId, channel, parsed.body, needsReview, JSON.stringify(req.body ?? null), providerMessageId],
  );

  if (shouldDeflect) await sendDeflection(channel, matched, attachedOfferId);

  return res.json({ ok: true, intent, outcome, needsReview });
}

// POST /webhook/aisensy — inbound WhatsApp.
router.post('/aisensy', async (req, res, next) => {
  try {
    await handleInbound('whatsapp', 'whatsapp', (r) => authorizedSecret(r, 'AISENSY_WEBHOOK_SECRET'), req, res);
  } catch (err) {
    next(err);
  }
});

// POST /webhook/imessage — inbound iMessage (Linq).
router.post('/imessage', async (req, res, next) => {
  try {
    await handleInbound('imessage', 'imessage', verifyLinqSignature, req, res);
  } catch (err) {
    next(err);
  }
});

// Attach the pure helpers to the router (which is itself a function, so
// `app.use('/webhook', offerWebhook)` still works) so they can be unit-tested.
router.parseInbound = parseInbound;
router.verifyLinqSignature = verifyLinqSignature;
router.eventType = eventType;
router.pickMatch = pickMatch;
router.decideInboundAction = decideInboundAction;

module.exports = router;
