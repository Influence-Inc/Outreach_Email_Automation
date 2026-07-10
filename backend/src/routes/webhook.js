'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { markReplied, markFollowupSent } = require('../services/outreach');

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

// Instantly fires an email_sent event for EVERY sequence step it sends — the
// Step 1 outreach and each follow-up. We use these to advance the dashboard
// status from "outreach sent" → "follow up sent" when a follow-up goes out
// (markFollowupSent guards against the Step 1 event flipping the status).
const SENT_EVENTS = new Set([
  'email_sent',
  'email_sent_success',
  'sent',
  'lead_email_sent',
]);

function pickEventType(body) {
  return body.event_type || body.event || body.type || null;
}
// Which sequence step this send is. Instantly is 1-indexed (Step 1 = outreach,
// Step 2+ = follow-ups). Field name varies by version, so read defensively.
function pickStep(body) {
  const raw =
    body.step ??
    body.step_number ??
    body.stepNumber ??
    body.email_seq_number ??
    body.sequence_step ??
    body.sequence_step_number ??
    (body.email && (body.email.step ?? body.email.step_number)) ??
    null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
// The sent message's own id (distinct from a reply's uuid), for the audit trail.
function pickSentMessageId(body) {
  return (
    body.message_id ||
    body.email_id ||
    body.sent_message_id ||
    (body.email && (body.email.message_id || body.email.id)) ||
    null
  );
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
// The connected mailbox that handled this conversation — required as `eaccount`
// when sending a threaded reply back through Instantly's /emails/reply endpoint.
function pickEmailAccount(body) {
  return body.email_account || body.eaccount || null;
}
// Which Instantly campaign the reply came from. Critical when the same address
// is a lead in more than one campaign — it disambiguates which creator row owns
// the reply so we never attribute it to the wrong campaign's conversation.
function pickCampaignId(body) {
  return body.campaign_id || body.campaign || null;
}
// The exact subject of the creator's reply. We echo it verbatim when replying so
// Gmail threads our message into the same conversation (a changed subject splits
// the thread even when In-Reply-To is set).
function pickReplySubject(body) {
  return body.reply_subject || body.subject || null;
}

// Resolve the creator row an Instantly event belongs to. The same address can
// be a lead in multiple campaigns, so prefer the row in the campaign the event
// names; fall back to email-only (most recently emailed) when the campaign is
// unmapped or absent. Shared by the reply and email_sent flows so both
// attribute events to the same row. Returns the creator row or null.
async function resolveCreator(email, campaignId) {
  let creator = null;
  if (campaignId) {
    creator = await db.one(
      `SELECT c.id, c.status FROM creators c
       JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE LOWER(c.email) = LOWER($1)
         AND COALESCE(ca.instantly_campaign_id, $3) = $2
       ORDER BY c.outreach_sent_at DESC NULLS LAST
       LIMIT 1`,
      [email, campaignId, process.env.INSTANTLY_CAMPAIGN_ID || null],
    );
  }
  if (!creator) {
    creator = await db.one(
      `SELECT id, status FROM creators
       WHERE LOWER(email) = LOWER($1)
       ORDER BY outreach_sent_at DESC NULLS LAST
       LIMIT 1`,
      [email],
    );
    if (creator && campaignId) {
      console.warn(
        `[webhook/instantly] no creator mapped to instantly campaign ${campaignId} for ${email}; fell back to email-only attribution (creator ${creator.id})`,
      );
    }
  }
  return creator;
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

    // email_sent events advance outreach_sent → followup_sent when Instantly
    // sends a follow-up step. Handle them before the reply-only guard below.
    if (SENT_EVENTS.has(eventType)) {
      const email = pickEmail(body);
      const campaignId = pickCampaignId(body);
      if (!email) {
        console.warn(
          `[webhook/instantly] email_sent missing email; raw=${JSON.stringify(body).slice(0, 800)}`,
        );
        return;
      }
      const creator = await resolveCreator(email, campaignId);
      if (!creator) {
        console.warn(`[webhook/instantly] email_sent for unknown email: ${email}`);
        return;
      }
      const step = pickStep(body);
      const advanced = await markFollowupSent(creator.id, {
        step,
        messageId: pickSentMessageId(body),
      });
      console.log(
        `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} ` +
          `(instantly campaign ${campaignId || 'n/a'}) → ${advanced ? 'followup_sent' : 'no status change'}`,
      );
      return;
    }

    if (!REPLY_EVENTS.has(eventType)) {
      console.log(`[webhook/instantly] ignoring non-reply event: ${eventType}`);
      return;
    }

    const email = pickEmail(body);
    const reply_text = pickReplyText(body);
    const reply_to_uuid = pickReplyUuid(body);
    const email_account = pickEmailAccount(body);
    const reply_subject = pickReplySubject(body);
    const campaignId = pickCampaignId(body);
    if (!email || !reply_text) {
      console.warn(
        `[webhook/instantly] reply missing fields (email=${!!email} text=${!!reply_text}); raw=${JSON.stringify(body).slice(0, 800)}`,
      );
      return;
    }

    // The same address can be a lead in multiple campaigns. The webhook tells us
    // which Instantly campaign the reply came from, so attribute it to the creator
    // row in THAT campaign — never an arbitrary other one.
    const creator = await resolveCreator(email, campaignId);
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
           instantly_email_account = COALESCE($4, instantly_email_account),
           instantly_reply_subject = COALESCE($5, instantly_reply_subject),
           updated_at = NOW()
       WHERE id = $1`,
      [creator.id, reply_text, reply_to_uuid || null, email_account, reply_subject],
    );

    await markReplied(creator.id);
    console.log(
      `[webhook/instantly] reply_received for creator ${creator.id} (instantly campaign ${campaignId || 'n/a'})`,
    );
  } catch (err) {
    console.error('[webhook/instantly] error:', err.message);
  }
});

// Attach the pure payload helpers to the router (which is itself a function, so
// `app.use('/webhook', webhook)` still works) so they can be unit-tested.
router.pickEventType = pickEventType;
router.pickStep = pickStep;
router.pickSentMessageId = pickSentMessageId;
router.SENT_EVENTS = SENT_EVENTS;
router.REPLY_EVENTS = REPLY_EVENTS;

module.exports = router;
