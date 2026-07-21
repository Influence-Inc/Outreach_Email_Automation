'use strict';

// Inbound offer-portal webhooks + reply bot. AiSensy (WhatsApp) and Linq (the
// iMessage gateway) POST each creator reply here; we:
//   1. match the sender to a creator by their WhatsApp / iMessage number
//   2. classify the body (accept / decline / other)
//   3. accept/decline with a pending offer → call respondToOffer — the SAME
//      backend path the web Accept button uses (a WhatsApp "yes" and a web
//      Accept can never drift apart)
//   4. anything else → send the deflection reply and flag needs_review so it
//      surfaces for a human in the dashboard.
// Ported from Influence-CDB-portal (api/webhooks/aisensy/route.ts), generalised
// to both channels. Linq nests the reply differently from AiSensy (its content
// lives in message.parts[].value and the sender in sender_handle, under an
// event envelope), so parseInbound handles both shapes.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const offers = require('../services/offers');
const { classifyReply, DEFLECTION_MESSAGE } = require('../services/offerPortal/replies');
const { normalizePhone, sendWhatsAppText } = require('../services/offerPortal/whatsapp');
const { sendIMessageText } = require('../services/offerPortal/imessage');

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
function eventType(payload) {
  return (
    getString(payload, 'event_type') || getString(payload, 'event') || getString(payload, 'type') || null
  );
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

  // Skip non-message events (reactions, receipts, typing, participant, call).
  const evt = eventType(payload);
  if (evt && !/^message/i.test(evt)) return { ignore: `event:${evt}` };

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
async function matchCreator(contactColumn, fromDigits) {
  const rows = await db.many(
    `SELECT id, whatsapp, imessage, ${contactColumn} AS contact
     FROM creators WHERE ${contactColumn} IS NOT NULL`,
  );
  const tail = (s) => s.slice(-10);
  let exact = null;
  let suffix = null;
  for (const r of rows) {
    const digits = normalizePhone(r.contact);
    if (!digits) continue;
    if (digits === fromDigits) {
      exact = r;
      break;
    }
    if (tail(digits) && tail(digits) === tail(fromDigits)) suffix = suffix || r;
  }
  return exact || suffix;
}

async function sendDeflection(channel, creator, offerId) {
  const to = channel === 'imessage' ? creator.imessage : creator.whatsapp;
  if (!to) return;
  try {
    const send = channel === 'imessage' ? sendIMessageText : sendWhatsAppText;
    const result = await send({ to, body: DEFLECTION_MESSAGE });
    if (result.sent) {
      await db.query(
        `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body)
         VALUES ($1, $2, 'outbound', $3, $4)`,
        [creator.id, offerId, channel, DEFLECTION_MESSAGE],
      );
    }
  } catch (err) {
    console.error(`[offer-webhook] ${channel} deflection send failed`, err.message);
  }
}

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

  const parsed = parseInbound(req.body);
  if (!parsed) return res.json({ ok: true, ignored: 'unparseable' });
  if (parsed.ignore) return res.json({ ok: true, ignored: parsed.ignore });

  const matched = await matchCreator(contactColumn, parsed.from);
  if (!matched) {
    console.warn(`[offer-webhook] inbound ${channel} from unknown number ${parsed.from}`);
    return res.json({ ok: true, ignored: 'unknown_sender' });
  }

  const pendingOffer = await db.one(
    `SELECT id, token FROM offers WHERE creator_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [matched.id],
  );
  const fallbackOffer = pendingOffer
    ? null
    : await db.one(
        `SELECT id FROM offers WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [matched.id],
      );
  const attachedOfferId = (pendingOffer && pendingOffer.id) || (fallbackOffer && fallbackOffer.id) || null;

  const intent = classifyReply(parsed.body);
  let needsReview = false;
  let shouldDeflect = false;
  let outcome = 'deflected';

  if ((intent === 'accept' || intent === 'decline') && pendingOffer) {
    const result = await offers.respondToOffer({
      token: pendingOffer.token,
      response: intent === 'accept' ? 'accepted' : 'declined',
      channel,
    });
    if (result.ok) {
      outcome = 'responded'; // respondToOffer already sent the follow-up
    } else {
      needsReview = true;
      shouldDeflect = true;
    }
  } else {
    // Unrecognised intent, OR accept/decline with no pending offer.
    needsReview = true;
    shouldDeflect = true;
  }

  // Persist the raw payload alongside the parsed body so the exact provider
  // schema stays inspectable (verification, and any future parser tightening).
  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, needs_review, raw_payload)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6::jsonb)`,
    [matched.id, attachedOfferId, channel, parsed.body, needsReview, JSON.stringify(req.body ?? null)],
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

module.exports = router;
