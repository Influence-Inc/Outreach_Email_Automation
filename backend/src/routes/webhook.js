'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { markReplied } = require('../services/outreach');

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!secret) return true; // verification disabled if secret not set
  const sig = req.headers['x-instantly-signature'] || '';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Instantly reply_received webhook. Payload shape (v2):
// { event_type, lead: { email }, reply_text, reply_to_uuid, ... }
router.post('/instantly', async (req, res) => {
  // Respond 200 immediately — Instantly retries on non-2xx and gives only 30s.
  res.json({ ok: true });

  try {
    if (!verifySignature(req)) {
      console.warn('[webhook/instantly] signature mismatch — ignoring');
      return;
    }

    const { event_type, lead, reply_text, reply_to_uuid } = req.body || {};
    if (event_type !== 'reply_received') return;

    const email = lead && lead.email;
    if (!email || !reply_text) return;

    const creator = await db.one(
      `SELECT id, status FROM creators WHERE LOWER(email) = LOWER($1) LIMIT 1`,
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
