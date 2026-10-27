'use strict';

// What the admin's review notes teach the scout.
//
// In the Pending review queue an admin can say WHY they shortlist or reject a
// creator ("only memes, no real tutorials", "great — explains every step"). Jev
// itself is a fixed classifier and cannot be taught in words, so the notes are
// turned into rules the decision applies on top of Jev's labels:
//
//   1. the reviewed creators with a note, newest first, each with what Jev saw
//      (their top topic / niche / genre / format, as shares of their Reels);
//   2. Claude reads them and names the labels the admin keeps passing on, in the
//      taxonomy's own terms — { dim: 'genre', value: 'comedy', why: 'only memes,
//      no real tutorials' }. It may only use labels from the taxonomy, and only
//      what the notes say; a label the admin also shortlists is not a rule;
//   3. a creator whose Reels are MOSTLY one of those (half or more) is held or
//      rejected with the admin's own reason (creatorLabels.decideFromCreator).
//
// Loaded once per run (services/sourcingSession.js), and re-asked only when the
// notes change. Never throws: no notes, no ANTHROPIC_API_KEY or a failed call
// means no rules, which is how every run worked before this existed.

const claude = require('./claudeClient');
const TAXONOMY = require('./cpmReference/content_taxonomy.json');

const DIMENSIONS = ['topic', 'niche', 'genre', 'format'];
// Notes read per run: plenty for months of review, and a bounded prompt.
const HISTORY_LIMIT = 80;
// Rules kept, at most.
const MAX_RULES = 10;
// A creator matches a rule when at least this share of their Reels carries it.
const MOSTLY = 0.5;

const optionsOf = (dim) => (TAXONOMY.questions[dim] && TAXONOMY.questions[dim].options) || {};

/** A reviewed creator as the prompt shows it: the decision, the note, and what Jev saw. */
function exampleOf(row) {
  const jev = row.jev || {};
  const shares = (jev.creator && jev.creator.shares) || null;
  const labels = {};
  for (const dim of DIMENSIONS) {
    if (shares && shares[dim]) {
      labels[dim] = Object.entries(shares[dim]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`);
    } else if (jev.labels && jev.labels[dim] && jev.labels[dim].value) {
      labels[dim] = [jev.labels[dim].value];
    }
  }
  return {
    decision: row.decision === 'added' ? 'shortlisted' : 'rejected',
    note: String(row.review_note || '').trim().slice(0, 300),
    labels,
  };
}

const SYSTEM = [
  'You help an influencer-marketing team teach their Instagram creator scout.',
  'The scout labels each creator\'s Reels with a topic, niche, genre and format from a fixed taxonomy.',
  'Admins review creators and write short notes saying why they shortlisted or rejected them.',
  'Your job: find the labels the admins keep REJECTING creators for, in the taxonomy\'s own terms.',
  'Rules:',
  '- Use only the exact option keys given for each dimension.',
  '- Only make a rule the notes themselves support: the note must say why, and the creator\'s labels must show that label.',
  '- Never make a rule for a label the admins also shortlist creators for.',
  '- "why" is a short paraphrase of the admins\' own words (under 80 characters).',
  '- "notes" is how many notes support the rule.',
  `- At most ${MAX_RULES} rules. No rule is better than a guess.`,
  'Answer with JSON only: {"avoid":[{"dim":"genre","value":"<option key>","why":"...","notes":2}]}',
].join('\n');

function promptOf(examples) {
  const options = Object.fromEntries(DIMENSIONS.map((d) => [d, Object.keys(optionsOf(d))]));
  return JSON.stringify({ options, reviewed: examples });
}

/** Keep only well-formed rules on real taxonomy labels. Pure. */
function validRules(parsed) {
  const out = [];
  const seen = new Set();
  for (const r of (parsed && Array.isArray(parsed.avoid) ? parsed.avoid : [])) {
    if (!r || !DIMENSIONS.includes(r.dim)) continue;
    const value = String(r.value || '').trim();
    if (!Object.prototype.hasOwnProperty.call(optionsOf(r.dim), value)) continue;
    const key = `${r.dim}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const why = String(r.why || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!why) continue;
    out.push({ dim: r.dim, value, why, notes: Math.max(1, Number(r.notes) || 1) });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

let cache = { key: null, lessons: null };

/**
 * The rules from reviewed creators with notes. `ask(system, user)` returns Claude's
 * text (or null). Re-asks only when the notes changed since the last call.
 */
async function learn(rows = [], { ask = claude.callClaudeText } = {}) {
  const withNotes = rows.filter((r) => r && String(r.review_note || '').trim() && ['added', 'rejected'].includes(r.decision));
  const basis = withNotes.length;
  if (!basis) return { rules: [], basis: 0 };
  const key = withNotes.map((r) => `${r.id}:${r.decision}:${r.review_note}`).join('|');
  if (cache.key === key && cache.lessons) return cache.lessons;
  // Rules only come from rejections; with none there is nothing to avoid yet.
  if (!withNotes.some((r) => r.decision === 'rejected')) return { rules: [], basis };

  const text = await ask(SYSTEM, promptOf(withNotes.map(exampleOf)), 800).catch(() => null);
  if (text == null) return { rules: [], basis, error: 'Claude is not available (ANTHROPIC_API_KEY)' };
  const lessons = { rules: validRules(claude.parseJsonLoose(text)), basis };
  cache = { key, lessons };
  return lessons;
}

/** Read the notes and learn. Never throws. */
async function load({ db, logger = console, ask } = {}) {
  try {
    const rows = await db.many(
      `SELECT id, decision, review_note, evidence->'niche'->'jev' AS jev
         FROM sourced_candidates
        WHERE decided_by = 'human'
          AND decision IN ('added', 'rejected')
          AND COALESCE(review_note, '') <> ''
        ORDER BY id DESC
        LIMIT ${HISTORY_LIMIT}`,
    );
    return await learn(rows, ask ? { ask } : {});
  } catch (err) {
    const warn = logger.warn || logger.log || (() => {});
    warn.call(logger, '[review-lessons] could not learn from review notes -', (err && err.message) || err);
    return { rules: [], basis: 0 };
  }
}

/**
 * The rules this creator falls under: a label the admin passes on that at least
 * half their Reels carry. Returns [{ rule, share }], strongest first.
 */
function matches(lessons, shares) {
  const out = [];
  for (const rule of (lessons && lessons.rules) || []) {
    const share = ((shares || {})[rule.dim] || {})[rule.value] || 0;
    if (share + 1e-9 >= MOSTLY) out.push({ rule, share });
  }
  return out.sort((a, b) => b.share - a.share);
}

/** One line for the Scout page and the run log. */
function describe(lessons, labelOf = (dim, k) => k) {
  const rules = (lessons && lessons.rules) || [];
  if (!rules.length) {
    const n = (lessons && lessons.basis) || 0;
    if (lessons && lessons.error && n) return `Your review notes (${n}) are saved, but could not be learned from: ${lessons.error}`;
    return n
      ? `Learning from your review notes: ${n} so far, no clear pattern yet`
      : 'Add a reason when you shortlist or reject — Jev learns what to pass on from them';
  }
  return `Learned from ${lessons.basis} review note${lessons.basis === 1 ? '' : 's'} — passing on creators mostly making: `
    + rules.map((r) => `${labelOf(r.dim, r.value)} ("${r.why}")`).join('; ');
}

function _resetCache() { cache = { key: null, lessons: null }; }

module.exports = {
  learn, load, matches, describe, validRules, exampleOf, MOSTLY, MAX_RULES, _resetCache,
};
