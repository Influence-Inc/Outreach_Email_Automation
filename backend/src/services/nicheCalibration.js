'use strict';

// Teach the judge YOUR taste, from decisions you already made.
//
// The model knows what "creative" means in general. What it cannot know is what
// this brand means by it — which reels in this niche are worth paying for and
// which are competent and forgettable. That judgement only exists in one place:
// the calls an admin made in the review queue.
//
// So every human approve/reject becomes a labelled example, and a compact
// summary of those examples rides along in the per-creator prompt. This is
// few-shot calibration, not training: nothing is fine-tuned, no video is
// re-uploaded, and a campaign's taste can change the moment the admin's does.
//
// Two things this deliberately does NOT do:
//
//   RULE DECISIONS ARE NOT EXAMPLES. A candidate rejected for "5 of 12 reels
//   below floor" was rejected by arithmetic the gate already enforces. Feeding
//   that back would spend tokens teaching the model a rule it never gets to
//   apply, and worse, would drown the handful of real taste signals in noise.
//   Only `decided_by = 'human'` rows count.
//
//   IT DOES NOT RE-SEND VIDEO. Each example is the ANALYSIS of a reel — the
//   structured JSON the judge already produced and stored — not the clip. A
//   video costs megabytes and a fresh multimodal call every time; its analysis
//   costs a few hundred bytes and can be reused forever.

// Enough examples to show a pattern, few enough to stay cheap. These ride on
// every per-creator call, so each example is paid for on every creator.
const DEFAULT_PER_SIDE = 6;

// Beyond this the prompt is carrying more calibration than candidate.
const MAX_PER_SIDE = 12;

function clampCount(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(MAX_PER_SIDE, Math.round(v));
}

// Number(null) and Number('') are both 0, so an unknown follower count would
// otherwise reach the model as "0 followers" — a fact about the creator that is
// not true, in an example the model is being told to learn from.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce one stored candidate row to the smallest thing that still carries the
 * judgement: what the reels were like, how they performed, and the verdict.
 *
 * Handles are deliberately left OUT. The model should learn "this KIND of
 * creator", not "this account" — naming them invites matching on the handle,
 * and the examples would go stale the moment those creators change what they
 * post.
 */
function summarise(row) {
  const evidence = row.evidence || {};
  const clips = Array.isArray(evidence.clipAnalyses) && evidence.clipAnalyses.length
    ? evidence.clipAnalyses
    : [evidence.clip].filter(Boolean);
  const stats = (evidence.creatorScore && evidence.creatorScore.stats) || {};

  const formats = [...new Set(clips.map((c) => c && c.content_format).filter(Boolean))];
  const niches = [...new Set(clips.map((c) => c && (c.sub_niche || c.niche)).filter(Boolean))];
  const avg = (field) => {
    const vals = clips.map((c) => num(c && c[field])).filter((v) => v != null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  };

  const out = {
    niche: niches.join(', ') || (evidence.niche && evidence.niche.genre) || null,
    format: formats.join(', ') || null,
    creativity: avg('creativity'),
    hook: avg('hook_strength'),
    production: avg('production_quality'),
    followers: num(row.followers),
    typical_views: num(stats.typical),
    reach_steadiness: num(stats.steadiness),
  };

  // A human's typed reason is the single most valuable field here — it is the
  // only place the WHY is written down in their own words.
  const reason = String(row.reject_reason || '').trim();
  if (reason && reason !== 'rejected in review') out.reason = reason;

  // Drop empty fields rather than shipping a wall of nulls to the model.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== ''));
}

/**
 * Pull the admin's own decisions for a campaign, newest first.
 *
 * `db` is injected so this is testable without a database.
 *
 * @returns {Promise<{approved:object[], rejected:object[]}>} summarised examples
 */
async function collectExamples({ db, campaignId = null, perSide = DEFAULT_PER_SIDE } = {}) {
  if (!db) return { approved: [], rejected: [] };
  const limit = clampCount(perSide, DEFAULT_PER_SIDE);

  const pull = async (decision) => {
    const rows = await db.many(
      `SELECT username, followers, reject_reason, evidence
         FROM sourced_candidates
        WHERE decided_by = 'human'
          AND decision = $1
          AND evidence IS NOT NULL
          AND ($2::text IS NULL OR campaign_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [decision, campaignId, limit],
    );
    return (rows || []).map(summarise).filter((e) => Object.keys(e).length > 1);
  };

  const [approved, rejected] = await Promise.all([pull('added'), pull('rejected')]);
  return { approved, rejected };
}

/**
 * Render examples as a prompt block, or '' when there is nothing useful to say.
 *
 * Returns '' unless BOTH sides have examples: one-sided calibration is worse
 * than none — a list of only-approved creators reads as "score everything
 * highly", and only-rejected as the reverse. The contrast is the lesson.
 */
function renderCalibration({ approved = [], rejected = [] } = {}) {
  if (!approved.length || !rejected.length) return '';

  return [
    '',
    'CALIBRATION — this brand\'s own past decisions on creators in this niche.',
    'These are the standard to judge against. Where your general sense of a good',
    'creator differs from what these show, follow these.',
    '',
    'ACCEPTED by the brand:',
    JSON.stringify(approved, null, 2),
    '',
    'REJECTED by the brand (often for craft, not topic — a creator can be exactly',
    'on-niche and still be rejected for making forgettable reels):',
    JSON.stringify(rejected, null, 2),
    '',
  ].join('\n');
}

/**
 * Load a campaign's calibration once, for a whole run.
 *
 * Best-effort: calibration is enrichment. A failure here must not stop a run,
 * it just means this run judges without it, exactly as every run did before.
 */
async function loadCalibration({ db, campaignId, perSide, logger = console } = {}) {
  try {
    const examples = await collectExamples({ db, campaignId, perSide });
    const text = renderCalibration(examples);
    if (!text) return null;
    return {
      text,
      counts: { approved: examples.approved.length, rejected: examples.rejected.length },
    };
  } catch (err) {
    const warn = logger.warn || logger.log || (() => {});
    warn.call(logger, '[calibration] could not load examples -', (err && err.message) || err);
    return null;
  }
}

module.exports = {
  collectExamples,
  renderCalibration,
  loadCalibration,
  summarise,
  DEFAULT_PER_SIDE,
  MAX_PER_SIDE,
};
