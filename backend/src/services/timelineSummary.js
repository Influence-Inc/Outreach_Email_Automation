'use strict';

// Turn a raw email body (inbound reply or an outbound reply we sent) into a
// super-short, single-line gist for the activity timeline. The dashboard's Rate
// column shows one line per event, so instead of a content-free label like
// "Creator replied" we surface WHAT the message actually said.
//
// Two summarizers live here:
//   • summarizeMessage()  — pure + deterministic (no LLM). Strips the quoted
//     reply history and a leading salutation, collapses whitespace, and keeps
//     the first sentence (or a character-capped snippet). Cheap, synchronous,
//     always available — used as the immediate render and the fallback when
//     Claude is unavailable.
//   • summarizeEmail()    — an LLM recap (via Claude) that condenses the WHOLE
//     email into one short line of the key points ("$1,600 per video, available
//     early August, 50% upfront with approval before publishing") instead of
//     just echoing the opening sentence. Generated once and cached on
//     email_messages.summary (see routes/creators.js), so the LLM runs at most
//     once per message, never on every dashboard read.

const db = require('../db');
const { stripQuotedHistory } = require('./replyLearning');
const { parseRateOptionsFromText } = require('./negotiation');
const { callClaudeText } = require('./claudeClient');

function summarizeMessage(body, { maxLen = 90 } = {}) {
  if (body == null) return '';
  let s = stripQuotedHistory(String(body)) || String(body);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Drop a leading salutation ("Hi Jennifer,", "Hey there —", "Good morning")
  // so the gist leads instead of a greeting that carries no information.
  s = s
    .replace(/^(?:hi+|hey+|hello|hiya|dear|yo|good (?:morning|afternoon|evening))\b[^,.!?\n]{0,40}[,!.—–-]*\s*/i, '')
    .trim();
  if (!s) return '';
  // Prefer the first sentence when it fits; otherwise fall back to a snippet.
  const sentence = s.match(/^.*?[.!?](?=\s|$)/);
  let out = sentence && sentence[0].length <= maxLen ? sentence[0] : s;
  if (out.length > maxLen) {
    out = out.slice(0, maxLen);
    const sp = out.lastIndexOf(' ');
    if (sp > maxLen * 0.6) out = out.slice(0, sp);
    out = out.replace(/[\s,;:–—-]+$/, '') + '…';
  }
  return out.trim();
}

// Condense a whole email into a SHORT timeline label, using Claude. Unlike
// summarizeMessage (which only surfaces the opening sentence), this reads the
// ENTIRE message — but the goal is a glanceable one-liner, like a text-message
// preview, not an exhaustive recap. We ask for the single most important point
// under a hard word cap; the length ceiling below is a backstop, not the target.
//
// Returns '' when there's nothing to summarize, and null when Claude is
// unavailable or the call fails — so the caller keeps the deterministic gist as
// a fallback and can retry generation later.
const SUMMARY_SYSTEM =
  'You write a SHORT timeline label summarizing one email from an influencer/creator negotiation, for a CRM the reader skims at a glance. ' +
  'Give only the single most important takeaway — their rate, their answer, or their main ask — in at most 12 words. ' +
  'Lead with the number when they quoted one (e.g. "$9,000 for a 45-sec Reel with ManyChat automation"). ' +
  'Write in third person about the sender. ' +
  'Do NOT list every detail or stack clauses with semicolons — pick the one thing that matters and drop the rest. ' +
  'No preamble, no greeting, no quotes, no trailing punctuation, no line breaks. ' +
  'If the email has no substantive content (just a greeting or pleasantry), reply with a dash "-".';

async function summarizeEmail(body, { maxLen = 100 } = {}) {
  if (body == null) return '';
  const clean = stripQuotedHistory(String(body)) || String(body);
  const trimmed = clean.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const out = await callClaudeText(SUMMARY_SYSTEM, `Email:\n"""\n${clean.trim()}\n"""\n\nOne-line summary:`, 200);
  if (out == null) return null; // Claude unavailable — caller falls back
  let s = out.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!s || s === '-') return '';
  s = s.replace(/[.\s]+$/, '');
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    const sp = s.lastIndexOf(' ');
    if (sp > maxLen * 0.6) s = s.slice(0, sp);
    s = s.replace(/[\s,;:–—-]+$/, '') + '…';
  }
  return s;
}

// Strip the $-amount token(s) and any leading filler out of a rate label,
// leaving just the deliverable the money covers. "$3,500 for 300,000 combined
// views" -> "for 300,000 combined views"; "I can do $900 per reel" -> "per
// reel". Returns '' when the label is only a bare amount.
const AMOUNT_RE = /\$\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?/;
const AMOUNT_RE_G = /\$\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?/g;

function deliverableFromLabel(label, _amount) {
  const full = String(label || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  // The deliverable normally follows the amount ("$3,500 for 300k views"), so
  // keep the text AFTER the first amount and drop the preamble before it
  // ("Thanks! My rate is"). When nothing follows (the amount trails, e.g.
  // "300k views for $3,500"), fall back to the text before it.
  const m = AMOUNT_RE.exec(full);
  let s = m ? full.slice(m.index + m[0].length).trim() : full;
  if (!s && m) s = full.slice(0, m.index).trim();
  // Remove any remaining amount tokens (inline alternatives) and tidy edges.
  s = s.replace(AMOUNT_RE_G, ' ').replace(/\s+/g, ' ').trim();
  s = s
    .replace(/^(?:my\s+rate\s+is|rate\s+is|price\s+is|cost\s+is|i\s+(?:usually\s+)?charge)\b[\s:,–—-]*/i, '')
    .replace(/\b(?:for|at|is|of)\s*$/i, '')
    .replace(/^[\s:,;.–—-]+|[\s:,;.–—-]+$/g, '')
    .trim();
  if (!s) return '';
  // Read as a phrase: prefix a bare deliverable ("300k views") with "for".
  if (!/^(?:for|per|covering|includes?|to|total|each|across|on)\b/i.test(s)) s = `for ${s}`;
  return s.slice(0, 80).trim();
}

// The deliverable a specific quoted amount covers, mined from the reply text
// that named it. Used to turn "Creator quoted $3,500" into "Creator quoted
// $3,500 for 300,000 combined views". '' when the reply doesn't spell it out.
function deliverableForAmount(text, amount) {
  if (!text || amount == null) return '';
  const opts = parseRateOptionsFromText(text);
  if (!opts.length) return '';
  const match =
    opts.find((o) => Number(o.amount) === Number(amount)) ||
    (opts.length === 1 ? opts[0] : null);
  if (!match) return '';
  return deliverableFromLabel(match.label, amount);
}

// Generate the Claude summary for one email_messages row and cache it on the
// row's `summary` column, so the timeline reads it back instead of re-running
// the LLM. Called on receipt (thread.recordMessage) as the primary path, and
// again from the dashboard read as a safety net for legacy rows or receipt-time
// failures. Deduped by message id via a shared in-flight set so the receipt
// call and an overlapping dashboard load never summarize the same row twice.
//
// Best-effort by contract: returns null (and writes nothing) when there's no id
// or when Claude is unavailable/failed — leaving `summary` NULL so a later pass
// retries. Stores '' when the email has no substance, so we stop re-asking.
const _summariesInFlight = new Set();

async function summarizeAndStore(id, body) {
  if (id == null || _summariesInFlight.has(id)) return null;
  _summariesInFlight.add(id);
  try {
    const summary = await summarizeEmail(body);
    if (summary == null) return null; // Claude unavailable/failed — retry later
    await db.query('UPDATE email_messages SET summary = $2 WHERE id = $1', [id, summary]);
    return summary;
  } finally {
    _summariesInFlight.delete(id);
  }
}

module.exports = {
  summarizeMessage,
  summarizeEmail,
  summarizeAndStore,
  deliverableFromLabel,
  deliverableForAmount,
};
