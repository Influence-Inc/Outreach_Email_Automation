'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { markReplied } = require('../services/outreach');

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!secret) return true; // verification disabled if secret not set
  // HMAC the raw request bytes (captured in server.js), not a re-serialized
  // copy of the parsed body — key order/whitespace differences would never match.
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  // Instantly sends the signature as "sha256=<hex>" — strip the prefix before comparing.
  let sigStr = String(req.headers['x-instantly-signature'] || '');
  if (sigStr.startsWith('sha256=')) sigStr = sigStr.slice(7);
  const sig = Buffer.from(sigStr);
  const exp = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — treat as failed verification.
  if (sig.length !== exp.length) return false;
  return crypto.timingSafeEqual(sig, exp);
}

// Instantly reply webhook. Instantly's payload field names vary by version and
// event, so we extract defensively from the known aliases and log the raw shape
// to make any future mismatch obvious in the Railway logs instead of a silent drop.
const REPLY_EVENTS = new Set(['reply_received', 'email_reply', 'lead_replied', 'reply']);

function pickEventType(body) {
  return body.event_type || body.event || body.type || null;
}
function pickEmail(body) {
  return (
    (body.lead && body.lead.email) ||
    body.lead_email ||
    body.email ||
    body.from_email ||
    null
  );
}
function pickReplyText(body) {
  return (
    body.reply_text ||
    body.reply_text_snippet ||
    body.reply_body ||
    body.text ||
    (body.reply && (body.reply.text || body.reply.body)) ||
    null
  );
}
function pickReplyUuid(body) {
  return (
    body.reply_to_uuid ||
    body.reply_email_id ||
    body.email_id ||
    body.message_id ||
    body.thread_id ||
    null
  );
}

router.post('/instantly', async (req, res) => {
  // Respond 200 immediately — Instantly retries on non-2xx and gives only 30s.
  res.json({ ok: true });

  try {
    const body = req.body || {};
    // Always log that SOMETHING arrived + the event type + payload keys, so a
    // delivered-but-dropped webhook is visible instead of silent.
    const eventType = pickEventType(body);
    console.log(
      `[webhook/instantly] received: event=${eventType} keys=[${Object.keys(body).join(',')}]`,
    );

    if (!verifySignature(req)) {
      console.warn('[webhook/instantly] signature mismatch — ignoring');
      return;
    }

    if (!REPLY_EVENTS.has(eventType)) {
      console.log(`[webhook/instantly] ignoring non-reply event: ${eventType}`);
      return;
    }

    const email = pickEmail(body);
    const reply_text = pickReplyText(body);
    const reply_to_uuid = pickReplyUuid(body);
    if (!email || !reply_text) {
      console.warn(
        `[webhook/instantly] reply missing fields (email=${!!email} text=${!!reply_text}); raw=${JSON.stringify(body).slice(0, 800)}`,
      );
      return;
    }

    // The same email can exist across campaigns; attribute the reply to the
    // creator we most recently emailed (deterministic, not arbitrary).
    // db.one in this codebase returns null on no row (it is not pg-promise's
    // throwing variant), so this is the right helper for an optional match.
    const creator = await db.one(
      `SELECT id, status FROM creators
       WHERE LOWER(email) = LOWER($1)
       ORDER BY outreach_sent_at DESC NULLS LAST
       LIMIT 1`,
      [email],
    );
    if (!creator) {
      console.warn(`[webhook/instantly] reply from unknown email: ${email}`);
      return;
    }

    // Store the plain-text reply and Instantly's thread handle so that
    // negotiation.processReply() can read the text and send a threaded reply.
    await db.query(
      `UPDATE creators
       SET latest_inbound_text = $2,
           instantly_reply_uuid = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [creator.id, reply_text, reply_to_uuid || null],
    );

    await markReplied(creator.id);
    console.log(`[webhook/instantly] reply_received for creator ${creator.id}`);
  } catch (err) {
    console.error('[webhook/instantly] error:', err.message);
  }
});

module.exports = router;
