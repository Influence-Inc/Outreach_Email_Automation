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

// Persist one message of the conversation. Best-effort: callers wrap this so a
// logging failure can never abort actually sending or receiving the email.
// Returns null (a no-op) for a blank body rather than storing an empty row.
async function recordMessage(creatorId, { direction, kind = null, subject = null, body } = {}) {
  if (!creatorId || body == null || !String(body).trim()) return null;
  const dir = direction === 'inbound' ? 'inbound' : 'outbound';
  return db.query(
    `INSERT INTO email_messages (creator_id, direction, kind, subject, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [creatorId, dir, kind, subject, String(body)],
  );
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
function renderTranscript(messages, { maxChars = 8000 } = {}) {
  const turns = (messages || [])
    .map((m) => {
      const who = m.direction === 'inbound' ? 'CREATOR' : 'MANAGER';
      const body = String(m.body || '').replace(/\r/g, '').trim();
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

module.exports = { recordMessage, loadThread, renderTranscript };
