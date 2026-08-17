'use strict';

// The decision on a creator — deterministic, and NOT the model's.
//
// `fit_score` is one input among several. Everything here is a pure function of
// numbers already gathered (the model's per-clip and per-creator analyses, the
// creator's view counts, their follower band), so the same inputs always produce
// the same answer, and the bar can be retuned from config without touching a
// prompt or re-running any analysis.
//
// Two layers, in order:
//
//   1. HARD REJECTS — things no amount of good scoring should rescue. A repost
//      page, an unsafe brand context, a follower count outside the band we are
//      buying, or an explicit reject_reason from the analysis.
//   2. A WEIGHTED SCORE — fit, niche consistency, how steady their reach is,
//      and the creativity/hook of their actual reels.
//
// Reach steadiness is what separates "consistently performs" from "got one
// lucky hit", which a single reel off a feed can never tell you.

const { reelViews, median, stability, round3, clamp01 } = require('./sourcingFilters');

// Weights sum to 1. Fit carries the most, but never a majority — a creator the
// model loves who posts wildly inconsistent reels should not sail through.
//
// Craft (creativity + hook) is 40% between them, up from 25%. At 25% it could
// always be outvoted: `viewSteadiness` is nearly free to max out — any creator
// with a consistent audience scores ~0.98 on it — so fit + consistency +
// steadiness alone reached 0.82 with craft at half marks. Craft was being priced
// as a tiebreaker when it is the thing we are actually buying.
//
// Note this still cannot make craft MANDATORY — that is arithmetic, not tuning:
// a creator who is excellent everywhere else clears any threshold low enough to
// admit good creators. That is what minCreativity below is for.
const DEFAULT_WEIGHTS = Object.freeze({
  fit: 0.30,
  nicheConsistency: 0.15,
  viewSteadiness: 0.15,
  creativity: 0.25,
  hook: 0.15,
});

// Raised from 0.6: at 0.6 a creator with strong topical fit but mediocre craft
// still cleared, because fit + niche consistency + steadiness alone add up past
// the bar without creativity or hook contributing much. 0.72 requires the craft
// components to actually carry weight.
const DEFAULT_PASS_THRESHOLD = 0.72;

// A creator whose best reel is this far above their typical one is carried by a
// single outlier rather than a real audience.
const DEFAULT_MAX_SPIKE = 12;

// Craft has a floor, checked separately from the weighted score.
//
// Creativity and hook together carry only 25% of the weighting, so a creator the
// model rates highly on FIT but poorly on craft still clears the threshold on
// fit + consistency + steadiness alone — which is exactly the "right keywords,
// low-quality content" case that kept getting through. A weighted average cannot
// express "no amount of topical fit rescues bad content"; a floor can.
//
// 0 disables it, for a run that would rather judge on the blend alone.
const DEFAULT_MIN_CREATIVITY = 5;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Mean of the finite values of `field` across the clip analyses. */
function meanOf(clips, field) {
  const values = (clips || []).map((c) => num(c && c[field])).filter((v) => v != null);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Lowest, highest and typical reach, plus how spiky and how steady it is.
 *
 * `typical` is the median rather than the mean precisely because one viral reel
 * should not drag the number it is being compared against.
 */
function reelStats(reels) {
  const views = reelViews(reels);
  if (!views.length) {
    return { count: 0, min: null, max: null, typical: null, spike: null, steadiness: null };
  }
  const min = Math.min(...views);
  const max = Math.max(...views);
  const typical = median(views);
  return {
    count: views.length,
    min,
    max,
    typical,
    // How far the best reel sits above the typical one.
    spike: typical > 0 ? round3(max / typical) : null,
    // 1 = perfectly steady. Scale-free, so a 10k creator and a 10M creator are
    // measured the same way.
    steadiness: stability(views),
  };
}

/**
 * Decide a creator.
 *
 * @returns {{pass:boolean, score:number, rejectReason:(string|null),
 *            components:object, stats:object}}
 *          `score` is 0–1 and is only meaningful when nothing hard-rejected.
 */
function scoreCreator({ creator = {}, clips = [], reels = [], followers = null } = {}, config = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(config.creatorWeights || {}) };
  const threshold = config.creatorPassThreshold != null
    ? config.creatorPassThreshold
    : DEFAULT_PASS_THRESHOLD;
  const maxSpike = config.maxViewSpike != null ? config.maxViewSpike : DEFAULT_MAX_SPIKE;
  const minCreativity = config.minCreativity != null
    ? config.minCreativity
    : DEFAULT_MIN_CREATIVITY;

  const stats = reelStats(reels);
  const clipList = Array.isArray(clips) ? clips.filter(Boolean) : [];

  const components = {
    fit: clamp01((num(creator.fit_score) ?? 0) / 100),
    nicheConsistency: clamp01((num(creator.consistency_of_niche) ?? 0) / 10),
    viewSteadiness: stats.steadiness == null ? 0 : clamp01(stats.steadiness),
    creativity: clamp01((meanOf(clipList, 'creativity') ?? 0) / 10),
    hook: clamp01((meanOf(clipList, 'hook_strength') ?? 0) / 10),
  };

  // ── hard rejects ──────────────────────────────────────────────────────────

  const reject = (reason) => ({ pass: false, score: 0, rejectReason: reason, components, stats });

  if (creator.reject_reason) return reject(String(creator.reject_reason));

  // Repost pages, meme aggregators and clip farms. One flag kills most of the
  // junk, so it is a reject rather than a scoring penalty — but only when the
  // analysis actually looked, which is why an absent flag is not a vote.
  const judged = clipList.filter((c) => typeof c.is_original_creator === 'boolean');
  if (judged.length) {
    const original = judged.filter((c) => c.is_original_creator);
    if (original.length * 2 <= judged.length) return reject('not an original creator');
  }

  if (clipList.some((c) => c.brand_safety === 'unsafe')) return reject('brand unsafe');

  // A craft floor, independent of the blend. Only applied when the analysis
  // actually scored creativity — an unjudged creator is not accused of being
  // uncreative, same principle as the originality flag above.
  const creativity = meanOf(clipList, 'creativity');
  if (minCreativity > 0 && creativity != null && creativity < minCreativity) {
    return reject(`creativity ${round3(creativity)} below ${minCreativity}`);
  }

  const followerCount = num(followers);
  const minFollowers = num(config.minFollowers);
  const maxFollowers = num(config.maxFollowers);
  if (followerCount != null) {
    if (minFollowers != null && followerCount < minFollowers) return reject('below the follower band');
    if (maxFollowers != null && followerCount > maxFollowers) return reject('above the follower band');
  }

  // Carried by one outlier rather than a real audience.
  if (stats.spike != null && maxSpike > 0 && stats.spike > maxSpike) {
    return reject('reach driven by a single outlier');
  }

  // ── weighted score ────────────────────────────────────────────────────────

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const weighted = Object.entries(weights)
    .reduce((sum, [key, w]) => sum + (components[key] ?? 0) * w, 0);
  const score = round3(weighted / totalWeight);

  return {
    pass: score >= threshold,
    score,
    rejectReason: score >= threshold ? null : 'below the fit threshold',
    components,
    stats,
  };
}

module.exports = {
  scoreCreator,
  reelStats,
  DEFAULT_WEIGHTS,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_MAX_SPIKE,
  DEFAULT_MIN_CREATIVITY,
};
