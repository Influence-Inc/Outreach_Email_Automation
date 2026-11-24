'use strict';

// Reply pacing — automated replies wait a human-looking gap before they go out.
//
// An AI reply that lands thirty seconds after the creator hit send reads as a
// bot, and creators stop answering. So the scheduler no longer sends the
// automated reply inline: negotiation.processReply / handleAcceptedReply still
// read, classify and draft it right away (so a hand-off reaches the team
// immediately — only the creator-facing send is held), then park the drafted
// reply in `scheduled_replies` with a random send_at between 5 and 60 minutes
// after the creator's message. negotiation.dispatchDueReplies sends the rows
// that are due.
//
// The firm bounds: never sooner than 5 minutes, never later than 60 minutes
// after the inbound message. The random draw tops out DISPATCH_SLACK_MS short
// of the hour so the dispatcher's own cadence (every 30s by default) can't push
// a reply past it. The only way past 60 minutes is the server being down when a
// reply falls due; it then goes out on the first dispatch after boot (late
// beats never — the row is persisted, so a restart never loses or doubles it).
//
// A reply is never sent stale. Before send_at:
//   • a NEWER inbound supersedes the pending reply — the new message is read
//     with the whole thread and answered once (see computeSendAt for timing);
//   • any email we send in the meantime (a team member's delegate reply, an
//     offer, a contract), a stage change, a hand-off to a human or a stopped
//     creator cancels it (see staleReason).
// Manual sends from the dashboard are never delayed: a person chose to send
// them, at a human pace, and they don't go through this module at all.

const db = require('../db');

const MINUTE = 60 * 1000;
const MIN_DELAY_MS = 5 * MINUTE;
const MAX_DELAY_MS = 60 * MINUTE;
// Headroom under the hour for dispatch cadence + the send itself.
const DISPATCH_SLACK_MS = 2 * MINUTE;
const LATEST_DRAW_MS = MAX_DELAY_MS - DISPATCH_SLACK_MS;
// A send that throws (Instantly down) is retried this many times, a couple of
// minutes apart, before it's handed to a human.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2 * MINUTE;

const toDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

// A random delay in [MIN_DELAY_MS, LATEST_DRAW_MS]. `rand` is injectable for
// tests and must return [0, 1) like Math.random.
function pickDelayMs(rand = Math.random) {
  const r = Math.min(Math.max(Number(rand()) || 0, 0), 1);
  return Math.round(MIN_DELAY_MS + r * (LATEST_DRAW_MS - MIN_DELAY_MS));
}

// When should the reply to a message that arrived at `inboundAt` go out?
//
// Normally inboundAt + a random delay. When this message superseded a pending
// reply (the creator wrote again before we answered), we keep the earlier
// send time if it still sits inside the new message's window — at least 5 min
// after it — so a quick "oh, and…" doesn't drag the reply out; otherwise we
// redraw from the new message. Either way the result is 5–58 min after the
// NEWEST message, which is the one the reply answers.
//
// inboundAt falls back to `now` when unknown (rows that predate the stamp).
function computeSendAt({ inboundAt = null, now = new Date(), previousSendAt = null, rand = Math.random } = {}) {
  const base = toDate(inboundAt) || toDate(now) || new Date();
  const floor = base.getTime() + MIN_DELAY_MS;
  const ceil = base.getTime() + LATEST_DRAW_MS;
  const prev = toDate(previousSendAt);
  if (prev && prev.getTime() >= floor && prev.getTime() <= ceil) return prev;
  return new Date(base.getTime() + pickDelayMs(rand));
}

// Mark the creator's pending reply (if any) superseded. Returns its send_at so
// the replacement can keep the same timing (computeSendAt), or null.
async function supersedePending(creatorId, reason = 'new_inbound') {
  const res = await db.query(
    `UPDATE scheduled_replies
        SET status = 'superseded', cancel_reason = $2, updated_at = NOW()
      WHERE creator_id = $1 AND status = 'pending'
      RETURNING send_at`,
    [creatorId, reason],
  );
  const rows = (res && res.rows) || [];
  const times = rows.map((r) => toDate(r.send_at)).filter(Boolean);
  if (!times.length) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

async function cancelPending(creatorId, reason) {
  await db.query(
    `UPDATE scheduled_replies
        SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
      WHERE creator_id = $1 AND status = 'pending'`,
    [creatorId, reason],
  );
}

// Park a decided reply. `result` must already carry the final email (the
// dispatcher sends it verbatim — it never re-drafts). Returns the stored row.
async function scheduleReply({
  creatorId,
  source,
  kind = null,
  result,
  stage = null,
  inboundText = null,
  inboundAt = null,
  previousSendAt = null,
  now = new Date(),
  rand = Math.random,
}) {
  if (!result || !result.email) throw new Error('scheduleReply needs a result with a resolved email');
  // Defensive: one pending reply per creator (also a unique index). The caller
  // normally superseded already and passes that send time in.
  const stillPending = await supersedePending(creatorId);
  const sendAt = computeSendAt({ inboundAt, now, previousSendAt: previousSendAt || stillPending, rand });
  const row = await db.one(
    `INSERT INTO scheduled_replies
       (creator_id, source, kind, result, stage, inbound_text, inbound_at, send_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [creatorId, source, kind, result, stage, inboundText, toDate(inboundAt), sendAt],
  );
  return row || { creator_id: creatorId, source, kind, result, stage, send_at: sendAt, status: 'pending' };
}

// Atomically claim the due replies (pending → sending) so two dispatchers —
// overlapping ticks or two instances — never both send one. A row whose
// creator has an unprocessed inbound is left pending: the negotiation poll is
// about to supersede it with a reply that answers the newer message.
// A row stuck in 'sending' (the process died mid-dispatch) is reclaimed after
// STUCK_SENDING_MINUTES; if its email did go out, sendNegotiationEmail already
// bumped last_negotiation_email_at and staleReason drops it as already_replied.
const STUCK_SENDING_MINUTES = 10;
async function claimDue(limit = 25) {
  return db.many(
    `UPDATE scheduled_replies sr
        SET status = 'sending', attempts = sr.attempts + 1, updated_at = NOW()
      WHERE sr.id IN (
              SELECT id FROM scheduled_replies
               WHERE (status = 'pending' AND send_at <= NOW())
                  OR (status = 'sending' AND updated_at < NOW() - make_interval(mins => $2))
               ORDER BY send_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
        AND NOT EXISTS (
              SELECT 1 FROM creators c
               WHERE c.id = sr.creator_id AND c.latest_inbound_text IS NOT NULL)
      RETURNING sr.*`,
    [limit, STUCK_SENDING_MINUTES],
  );
}

// Why a claimed reply must NOT go out anymore (null = send it). Pure, so the
// guard rules are unit-tested directly.
function staleReason(row, creator) {
  if (!creator) return 'creator_missing';
  if (creator.status === 'stopped') return 'stopped';
  if (creator.latest_inbound_text) return 'new_inbound';
  if ((creator.negotiation_status || null) !== (row.stage || null)) return 'stage_changed';
  const decidedAt = toDate(row.created_at);
  if (decidedAt) {
    const lastSent = toDate(creator.last_negotiation_email_at);
    if (lastSent && lastSent > decidedAt) return 'already_replied';
    const delegatedAt = toDate(creator.delegated_at);
    if (delegatedAt && delegatedAt > decidedAt) return 'handed_to_human';
  }
  return null;
}

async function markSent(id) {
  await db.query(
    `UPDATE scheduled_replies SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

async function markCancelled(id, reason, status = 'cancelled') {
  await db.query(
    `UPDATE scheduled_replies SET status = $2, cancel_reason = $3, updated_at = NOW() WHERE id = $1`,
    [id, status, reason],
  );
}

// After a send threw: back to pending a little later, or 'failed' once
// MAX_ATTEMPTS is used up. Returns true when it will be retried.
async function markFailedAttempt(row, err) {
  const msg = String((err && err.message) || err || 'send failed').slice(0, 500);
  const retry = Number(row.attempts || 0) < MAX_ATTEMPTS;
  await db.query(
    `UPDATE scheduled_replies
        SET status = $2, last_error = $3,
            send_at = CASE WHEN $2 = 'pending' THEN NOW() + make_interval(secs => $4) ELSE send_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, retry ? 'pending' : 'failed', msg, RETRY_DELAY_MS / 1000],
  );
  return retry;
}

// Dashboard: attach `scheduled_reply` ({ send_at, kind, action }) to each
// creator row with a reply waiting to go out, else null.
async function attachScheduledReplies(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const ids = rows.map((r) => r.id).filter((id) => id != null);
  let pending = [];
  try {
    pending = await db.many(
      `SELECT creator_id, send_at, kind, result->>'action' AS action
         FROM scheduled_replies
        WHERE status IN ('pending', 'sending') AND creator_id = ANY($1::int[])`,
      [ids],
    );
  } catch (err) {
    // The table is created by the migration; never let a missing table (or a
    // transient error) break the creators list.
    console.warn('[reply-pacing] could not load scheduled replies:', err.message);
  }
  const byCreator = new Map((pending || []).map((p) => [p.creator_id, p]));
  for (const r of rows) {
    const p = byCreator.get(r.id);
    r.scheduled_reply = p ? { send_at: p.send_at, kind: p.kind || null, action: p.action || null } : null;
  }
  return rows;
}

module.exports = {
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  DISPATCH_SLACK_MS,
  MAX_ATTEMPTS,
  pickDelayMs,
  computeSendAt,
  supersedePending,
  cancelPending,
  scheduleReply,
  claimDue,
  staleReason,
  markSent,
  markCancelled,
  markFailedAttempt,
  attachScheduledReplies,
};
