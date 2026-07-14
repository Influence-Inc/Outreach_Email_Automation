'use strict';

// Turn a raw email body (inbound reply or an outbound reply we sent) into a
// super-short, single-line gist for the activity timeline. The dashboard's Rate
// column shows one line per event, so instead of a content-free label like
// "Creator replied" we surface WHAT the message actually said.
//
// Pure + deterministic (no LLM): strips the quoted reply history and a leading
// salutation, collapses whitespace, and packs as many WHOLE sentences as fit in
// the length budget — so a multi-point message (price + availability + terms)
// is summarized rather than clipped to its opening line. This runs at read time
// over the stored conversation, so it applies to every creator — past and
// future — without any backfill. Returns '' when there's nothing to show.

const { stripQuotedHistory } = require('./replyLearning');
const { parseRateOptionsFromText } = require('./negotiation');

function summarizeMessage(body, { maxLen = 200 } = {}) {
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
  // Pack complete sentences into the budget so the gist covers the whole
  // message, not just its first line. Stop before a sentence that would
  // overflow and mark the tail with an ellipsis so it's clear more was said.
  const sentences = s.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [s];
  let out = '';
  let dropped = false;
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;
    const candidate = out ? `${out} ${piece}` : piece;
    if (candidate.length <= maxLen) {
      out = candidate;
    } else {
      dropped = true;
      break;
    }
  }
  // The opening sentence alone can already blow the budget — fall back to a
  // word-boundary snippet of the text in that case.
  if (!out) {
    out = s.slice(0, maxLen);
    const sp = out.lastIndexOf(' ');
    if (sp > maxLen * 0.6) out = out.slice(0, sp);
    out = out.replace(/[\s,;:–—-]+$/, '');
    dropped = out.length < s.length;
  }
  if (dropped) out = out.replace(/[.!?…\s]+$/, '') + '…';
  return out.trim();
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

module.exports = { summarizeMessage, deliverableFromLabel, deliverableForAmount };
