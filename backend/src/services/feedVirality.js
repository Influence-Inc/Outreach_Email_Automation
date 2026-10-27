'use strict';

// How many views a reel on our feed has, from its likes and comments — step 1 of
// scouting the feed, before anything is spent on the creator.
//
// The reel player shows likes and comments but usually not views. Views are
// estimated from them with the engagement rate of the creators creator-list has
// indexed, (likes + comments) / views:
//
//   median 3.2%   → the estimate
//   25th pct 2.3% → the high end (a creator with less engagement per view)
//   75th pct 5.6% → the low end
//
// (25 creators in creator-list's real index, services/enrichment/results/real/index.)
// When the player does show views, those are used as they are.
//
// The reel passes when it could plausibly have reached the viral bar — its HIGH
// estimate is at the bar — so a creator is only skipped when even a generous
// reading of their reel falls short. A reel whose likes and comments are hidden
// cannot be judged here and goes on to the next step. Skipped creators are not
// marked handled: their next reel on the feed gets its own chance.
//
//   SOURCING_FEED_ENGAGEMENT_RATE   override the median (e.g. 0.04)

const MEDIAN = 0.032;
const HIGH_VIEWS_RATE = 0.0234;
const LOW_VIEWS_RATE = 0.056;

function rate(env = process.env) {
  const r = Number(env.SOURCING_FEED_ENGAGEMENT_RATE);
  return Number.isFinite(r) && r > 0 && r < 1 ? r : MEDIAN;
}

const n = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/**
 * The reel's views: { views, low, high, from: 'views' | 'likes' } or null when
 * neither views nor likes/comments are readable.
 */
function estimate({ likes, comments, views } = {}, { env = process.env } = {}) {
  const v = n(views);
  if (v != null && v > 0) return { views: v, low: v, high: v, from: 'views' };
  const reactions = (n(likes) || 0) + (n(comments) || 0);
  if (n(likes) == null && n(comments) == null) return null;
  const median = rate(env);
  // The spread around a custom median keeps the index's proportions.
  const scale = median / MEDIAN;
  return {
    views: Math.round(reactions / median),
    low: Math.round(reactions / (LOW_VIEWS_RATE * scale)),
    high: Math.round(reactions / (HIGH_VIEWS_RATE * scale)),
    from: 'likes',
  };
}

const fmt = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x));

/**
 * Whether the feed reel looks viral enough to look into its creator.
 * Returns { pass, estimate, reason }; pass is true when it cannot be told.
 */
function check(reel, { viralViews = 100000, env = process.env } = {}) {
  const est = estimate(reel, { env });
  if (!est) return { pass: true, estimate: null, reason: 'likes and comments hidden — cannot estimate its views' };
  const bar = Number(viralViews) || 100000;
  const said = est.from === 'views'
    ? `${fmt(est.views)} views`
    : `about ${fmt(est.views)} views (${fmt(est.low)}–${fmt(est.high)}) from ${fmt((n(reel.likes) || 0))} likes and ${fmt((n(reel.comments) || 0))} comments`;
  const pass = est.high >= bar;
  return {
    pass,
    estimate: est,
    reason: pass ? `${said}` : `${said} — below the ${fmt(bar)} viral bar`,
  };
}

module.exports = { estimate, check, MEDIAN, HIGH_VIEWS_RATE, LOW_VIEWS_RATE };
