'use strict';

// The creator's email conversation, persisted message-by-message as each email
// is sent or received (see the email_messages table in schema.sql). This exists
// so the contract extractor can read the FULL back-and-forth — the messages
// where the creator says which platforms they'll actually post on, the
// deliverables they agreed to, the timeline — rather than only the single most
// recent inbound reply (creators.latest_inbound_text, which the webhook
// overwrites on every reply).
//
// Depends only on ../db, so both the writers (routes/webhook, services/
// negotiation) and the reader (services/contracts) can use it without any
// circular require.

const db = require('../db');
const { stripQuotedReply } = require('./emailQuote');

// Messages that get a free-text row in the dashboard's Rate-column timeline:
// the creator's inbound replies, the manual / delegate replies we send, and our
// conversational auto-replies (reply1 / reply_qa / reply — the emails Claude
// sends to acknowledge a reply, answer a question, or ask for details). These
// are the ones worth an LLM summary so the timeline can quote what was said;
// templated sends (outreach, follow-up, offer, contract) get their own
// descriptive labels and are skipped.
const GIST_WORTHY_OUTBOUND_KINDS = new Set([
  'manual_reply',
  'delegate_reply',
  'composed_offer',
  'composed_reply',
  'reply1',
  'reply_qa',
  'reply',
]);
function isGistWorthy(dir, kind) {
  return dir === 'inbound' || GIST_WORTHY_OUTBOUND_KINDS.has(kind);
}

// Outbound kinds a person on our team wrote themselves (as opposed to Claude or
// a template): the hand-off reply box, the "Write your own email" composer, and
// replies sent straight from the mailbox. renderTranscript can flag these so
// Claude treats what the account manager personally said as binding context.
const HUMAN_WRITTEN_KINDS = new Set(['manual_reply', 'delegate_reply', 'composed_offer', 'composed_reply']);

// Persist one message of the conversation. Best-effort: callers wrap this so a
// logging failure can never abort actually sending or receiving the email.
// Returns null (a no-op) for a blank body rather than storing an empty row.
//
// For gist-worthy messages we ALSO generate the timeline summary here, on
// receipt, and cache it on the row — so the dashboard shows the full-email
// recap on first load with no LLM call on the read path. This is best-effort
// and isolated: a summary failure never affects the stored message, and every
// current call site records the message AFTER the webhook has already 200'd (or
// off the send hot path), so the extra LLM call adds no user-facing latency.
// The timelineSummary require is deferred to call time to break the
// thread → timelineSummary → negotiation → thread require cycle.
async function recordMessage(creatorId, { direction, kind = null, subject = null, body, html = null } = {}) {
  if (!creatorId || body == null || !String(body).trim()) return null;
  const dir = direction === 'inbound' ? 'inbound' : 'outbound';
  // `html` is only set for composer emails (already sanitised by emailHtml);
  // the column is left out otherwise so plain sends write exactly as before.
  const row = html
    ? await db.one(
        `INSERT INTO email_messages (creator_id, direction, kind, subject, body, body_html)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [creatorId, dir, kind, subject, String(body), String(html)],
      )
    : await db.one(
        `INSERT INTO email_messages (creator_id, direction, kind, subject, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [creatorId, dir, kind, subject, String(body)],
      );
  if (row && isGistWorthy(dir, kind)) {
    try {
      await require('./timelineSummary').summarizeAndStore(row.id, String(body));
    } catch (e) {
      console.warn(`[thread] summary generation failed for message ${row.id}: ${e.message}`);
    }
  }
  return row;
}

// The full stored conversation for a creator, oldest first.
async function loadThread(creatorId) {
  if (!creatorId) return [];
  return db.many(
    `SELECT direction, kind, subject, body, created_at
     FROM email_messages WHERE creator_id = $1
     ORDER BY created_at ASC, id ASC`,
    [creatorId],
  );
}

// Render the thread as a compact transcript for an LLM prompt. Labels each turn
// by who spoke (CREATOR vs MANAGER) so the model can tell the creator's stated
// terms from our proposals. Capped to a character budget — when the thread runs
// long we keep the MOST RECENT messages, since the tail carries the final
// agreed terms (earlier turns are superseded).
//
// Each message is de-quoted first. Bodies are stored exactly as received, so a
// reply carries a copy of everything before it — which, under a [CREATOR]
// label, presents OUR proposals as the creator's own words, and burns the
// character budget re-reading the same thread once per turn.
//
// `markHumanWritten` labels the turns an account manager wrote personally
// ("[MANAGER — written personally by our account manager]") so a reply-writing
// prompt can give them the weight of a team decision. Off by default: the
// contract extractor's prompt keeps the plain labels it was tuned on.
function renderTranscript(messages, { maxChars = 8000, markHumanWritten = false } = {}) {
  const turns = (messages || [])
    .map((m) => {
      const who =
        m.direction === 'inbound'
          ? 'CREATOR'
          : markHumanWritten && HUMAN_WRITTEN_KINDS.has(m.kind)
            ? 'MANAGER — written personally by our account manager'
            : 'MANAGER';
      const body = stripQuotedReply(String(m.body || '').replace(/\r/g, ''));
      return body ? `[${who}]\n${body}` : '';
    })
    .filter(Boolean);
  let out = turns.join('\n\n');
  if (out.length > maxChars) {
    // Drop from the front (oldest) and note the elision so the model knows the
    // transcript is a tail, not the whole thing.
    out = `… [earlier messages omitted] …\n\n${out.slice(out.length - maxChars)}`;
  }
  return out;
}

module.exports = { recordMessage, loadThread, renderTranscript, HUMAN_WRITTEN_KINDS };
