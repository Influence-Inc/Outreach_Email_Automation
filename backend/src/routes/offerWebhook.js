'use strict';

// Inbound offer-portal webhooks + reply bot. AiSensy (WhatsApp) and the iMessage
// gateway POST each creator reply here; we:
//   1. match the sender to a creator by their WhatsApp / iMessage number
//   2. classify the body (accept / decline / other)
//   3. accept/decline with a pending offer → call respondToOffer — the SAME
//      backend path the web Accept button uses (a WhatsApp "yes" and a web
//      Accept can never drift apart)
//   4. anything else → send the deflection reply and flag needs_review so it
//      surfaces for a human in the dashboard.
// Ported from Influence-CDB-portal (api/webhooks/aisensy/route.ts), generalised
// to both channels.

const express = require('express');
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

// AiSensy / gateways don't share a stable webhook schema — pull `from` + body
// defensively so we don't break on configuration drift.
function parseInbound(payload) {
  const from =
    getString(payload, 'from') ||
    getString(payload, 'phoneNumber') ||
    getString(payload, 'phone_number') ||
    getString(payload, 'wa_id') ||
    getString(payload, 'mobile') ||
    getString(payload, 'sender') ||
    null;
  if (!from) return null;

  const textField = payload && typeof payload === 'object' ? payload.text : null;
  let body =
    getString(payload, 'message') ||
    getString(payload, 'body') ||
    getString(payload, 'content') ||
    getString(textField, 'body') ||
    (typeof textField === 'string' ? textField : null);

  if (!body) {
    const type = getString(payload, 'type') || 'unknown';
    body = `[non-text message: ${type}]`;
  }
  return { from: normalizePhone(from), body };
}

function authorized(req, secretEnv) {
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

// Shared handler for both channels.
async function handleInbound(channel, contactColumn, secretEnv, req, res) {
  if (!authorized(req, secretEnv)) return res.status(401).json({ ok: false });

  const parsed = parseInbound(req.body);
  if (!parsed) return res.json({ ok: true, ignored: 'unparseable' });

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

  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, needs_review)
     VALUES ($1, $2, 'inbound', $3, $4, $5)`,
    [matched.id, attachedOfferId, channel, parsed.body, needsReview],
  );

  if (shouldDeflect) await sendDeflection(channel, matched, attachedOfferId);

  return res.json({ ok: true, intent, outcome, needsReview });
}

// POST /webhook/aisensy — inbound WhatsApp.
router.post('/aisensy', async (req, res, next) => {
  try {
    await handleInbound('whatsapp', 'whatsapp', 'AISENSY_WEBHOOK_SECRET', req, res);
  } catch (err) {
    next(err);
  }
});

// POST /webhook/imessage — inbound iMessage.
router.post('/imessage', async (req, res, next) => {
  try {
    await handleInbound('imessage', 'imessage', 'IMESSAGE_WEBHOOK_SECRET', req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
