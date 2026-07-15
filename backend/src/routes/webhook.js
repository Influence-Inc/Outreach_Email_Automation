'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { markReplied, markOutreachSent, markFollowupSent, markOpened, markManualReplySent } = require('../services/outreach');
const thread = require('../services/thread');

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

// Instantly email_opened webhook aliases — a read receipt for one of the emails
// we sent (outreach or a follow-up). Drives the "seen" (double-green) outreach
// tick in Deal Studio; never changes the funnel status.
const OPEN_EVENTS = new Set([
  'email_opened',
  'lead_opened',
  'email_open',
  'opened',
  'open',
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
// Instantly's "is this the first email_sent event we've ever fired for this
// lead" flag, when present. Unlike `step` (which turned out to be an
// unreliable/unverified signal in production — the initial outreach send was
// still getting mislabeled a follow-up after we started trusting an explicit
// step outright), is_first is unambiguous: true means this webhook is
// necessarily reporting the very first send, i.e. our outreach. Read
// defensively since the field name isn't confirmed across Instantly versions.
function pickIsFirst(body) {
  const raw = body.is_first ?? body.isFirst ?? (body.email && (body.email.is_first ?? body.email.isFirst)) ?? null;
  return raw === true;
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
// The plain-text body of an outbound send (email_sent event). Instantly's
// payload names vary by version — a manual reply typed from the unibox may
// arrive under any of these aliases. Used to record the manual reply on the
// creator's thread so subsequent auto-replies see what the human already said.
function pickSentBody(body) {
  const email = body.email || {};
  return (
    body.body_text ||
    body.body ||
    body.text ||
    body.email_body ||
    body.sent_text ||
    (email && (email.body_text || email.text || email.body)) ||
    null
  );
}
function pickSentSubject(body) {
  return body.subject || body.email_subject || (body.email && body.email.subject) || null;
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

// Has this creator's outreach already gone out — so a subsequent non-sequence
// send is a human's manual reply (e.g. emailing the creator directly from Gmail
// / the connected mailbox)? True once the outreach has been sent (outreach_sent,
// followup_sent, replied) or a negotiation is in flight; false while still
// 'outreach_queued' (nothing sent yet) or in a terminal non-send state
// (suppressed / invalid_email / failed).
//
// The initial outreach send itself never reaches the manual-reply branch: the
// first outreach email_sent is consumed by the outreach_queued → outreach_sent
// transition. Its later ECHOES, while the creator sits at 'outreach_sent', are
// filtered downstream — the caller requires a real body (echoes are bodyless),
// and markManualReplySent dedupes on message_id (the outreach send's id is
// recorded, so a re-fire of it is recognized as a duplicate, not a new reply).
function isCreatorPastInitialOutreach(creator) {
  if (!creator) return false;
  if (['outreach_sent', 'followup_sent', 'replied'].includes(creator.status)) return true;
  if (creator.negotiation_status) return true;
  return false;
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
      `SELECT c.id, c.status, c.negotiation_status FROM creators c
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
      `SELECT id, status, negotiation_status FROM creators
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

    // email_opened events are read receipts — the creator opened one of our
    // emails. Bumps open_count / last_open_at so the Deal Studio outreach ticks
    // can flip to double-green. Never changes the funnel status. Handled before
    // the reply-only guard below.
    if (OPEN_EVENTS.has(eventType)) {
      const email = pickEmail(body);
      const campaignId = pickCampaignId(body);
      if (!email) {
        console.warn(
          `[webhook/instantly] email_opened missing email; raw=${JSON.stringify(body).slice(0, 400)}`,
        );
        return;
      }
      const creator = await resolveCreator(email, campaignId);
      if (!creator) {
        console.warn(`[webhook/instantly] email_opened for unknown email: ${email}`);
        return;
      }
      await markOpened(creator.id);
      console.log(`[webhook/instantly] email_opened for creator ${creator.id}`);
      return;
    }

    // email_sent events cover both Instantly's automated sequence steps AND
    // manual sends typed from Instantly's unibox / a connected mailbox.
    //   • Sequence follow-up (Step 2+) → advance outreach_sent → followup_sent.
    //   • Manual reply sent after the creator has already engaged
    //     (status='replied' or a negotiation stage is in flight) → log a
    //     'sent_manual_reply' event so the timeline shows we responded, and
    //     record the outbound body on the thread so the automated flow keeps
    //     the manual reply as context on the next inbound.
    // Handled before the reply-only guard below.
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
      const isFirst = pickIsFirst(body);
      const messageId = pickSentMessageId(body);

      // A creator still sitting in 'outreach_queued' means we enrolled the lead
      // but Instantly hadn't yet reported sending the outreach email. This
      // email_sent event IS that confirmation — advance queued → outreach_sent
      // (stamping the real send time) so the dashboard flips to "Outreach sent"
      // only now. Because Instantly can't have sent a later step before Step 1,
      // the queued status alone tells us this is the initial outreach; we don't
      // need to trust `step`/`is_first` here.
      if (creator.status === 'outreach_queued') {
        const sent = await markOutreachSent(creator.id, { messageId });
        if (sent) {
          console.log(
            `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} is_first=${isFirst} ` +
              `(instantly campaign ${campaignId || 'n/a'}) → outreach_sent (send confirmed)`,
          );
          return;
        }
      }

      const advanced = await markFollowupSent(creator.id, { step, messageId, isFirst });
      if (advanced) {
        console.log(
          `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} is_first=${isFirst} ` +
            `(instantly campaign ${campaignId || 'n/a'}) → followup_sent`,
        );
        return;
      }
      // Not a follow-up advance. markFollowupSent also owns SUBSEQUENT automated
      // follow-ups (Step 3+ in a multi-step campaign, and redelivered follow-up
      // webhooks) — it returns true for those too, so reaching here means the
      // send is NOT any automated sequence step. Once the creator is past the
      // initial outreach, a send with a real body is a human's manual reply
      // (typed from Gmail / the connected mailbox) — log it on the timeline WITH
      // the body so the "Sent: …" summary generates, and add it to the thread so
      // the next auto-reply has the human's answer as context.
      const isManualReply = isCreatorPastInitialOutreach(creator);
      if (isManualReply) {
        // An is_first send is, by definition, the very first send for this lead —
        // the outreach itself (or a re-fire of it), never a human's manual reply.
        // This guards the outreach_sent stage against the initial send's own
        // echo even when it arrives with a body but no message_id to dedupe on.
        if (isFirst === true) {
          console.log(
            `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} is_first=true ` +
              `(instantly campaign ${campaignId || 'n/a'}) → outreach echo, not a manual reply`,
          );
          return;
        }
        const sentBody = pickSentBody(body);
        const sentSubject = pickSentSubject(body);
        // A manual reply MUST carry a body. A bodyless email_sent for a
        // past-outreach creator is not a human send — it's the echo of a send we
        // already made (a duplicate/tracking event Instantly re-fires with no
        // content). Logging it produced a contentless "Manual reply sent" on the
        // timeline for creators who never got a manual reply at all — the false
        // positive. A genuine Gmail/unibox send always has the typed body.
        if (!sentBody || !String(sentBody).trim()) {
          console.log(
            `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} ` +
              `(instantly campaign ${campaignId || 'n/a'}) → bodyless send, treated as an echo, not a manual reply`,
          );
          return;
        }
        const logged = await markManualReplySent(creator.id, {
          messageId,
          subject: sentSubject,
          body: sentBody,
          source: 'instantly_unibox',
        });
        if (logged) {
          try {
            await thread.recordMessage(creator.id, {
              direction: 'outbound',
              kind: 'manual_reply',
              subject: sentSubject || null,
              body: sentBody,
            });
          } catch (e) {
            console.warn(
              `[webhook/instantly] thread record (manual reply) failed for creator ${creator.id}: ${e.message}`,
            );
          }
        }
        console.log(
          `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} ` +
            `(instantly campaign ${campaignId || 'n/a'}) → ${logged ? 'manual reply logged' : 'manual reply already logged'}`,
        );
        return;
      }
      // Log the raw body too (truncated) on this path — it's exactly the case
      // (webhook fired, but we decided NOT to advance) we need visibility into
      // to confirm what Instantly actually sent, since trusting `step` alone
      // previously failed to stop the initial send from being mislabeled.
      console.log(
        `[webhook/instantly] email_sent for creator ${creator.id} step=${step ?? 'n/a'} is_first=${isFirst} ` +
          `(instantly campaign ${campaignId || 'n/a'}) → no status change; raw=${JSON.stringify(body).slice(0, 500)}`,
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

    // Persist this inbound message to the full conversation thread (used later
    // by the contract extractor). latest_inbound_text above only ever holds the
    // MOST RECENT reply; this keeps every one. Best-effort — never let a logging
    // failure drop the reply we just received.
    try {
      await thread.recordMessage(creator.id, {
        direction: 'inbound',
        subject: reply_subject || null,
        body: reply_text,
      });
    } catch (e) {
      console.warn(`[webhook/instantly] thread record (inbound) failed for creator ${creator.id}: ${e.message}`);
    }

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
router.pickIsFirst = pickIsFirst;
router.pickSentMessageId = pickSentMessageId;
router.pickSentBody = pickSentBody;
router.pickSentSubject = pickSentSubject;
router.isCreatorPastInitialOutreach = isCreatorPastInitialOutreach;
router.SENT_EVENTS = SENT_EVENTS;
router.OPEN_EVENTS = OPEN_EVENTS;
router.REPLY_EVENTS = REPLY_EVENTS;

module.exports = router;
