'use strict';

// Engagement policy — the risk-critical decision for whether to like/save/share a
// reel to warm Instagram's Reels/Explore algorithm toward the target niche.
//
// Automated engagement is exactly what IG's anti-bot systems target, so this is
// deliberately CONSERVATIVE and pure (no side effects, fully unit-tested):
//   - OFF by default (SOURCING_ENGAGEMENT=on to enable) — "watch only" is the
//     usual mode; engagement is the occasional exception.
//   - only clearly on-brand reels (score >= minScore),
//   - low per-reel probability (very occasional), so the pattern isn't robotic,
//   - hard per-session caps,
//   - a full stop the moment an "action blocked" screen is seen (backoff),
//   - never re-likes an already-liked reel.
//
// Sharing is the riskiest action and is disabled by default (probability 0); the
// navigator performs like/save in v1.
//
// Env (all optional):
//   SOURCING_ENGAGEMENT            'on' to enable any engagement (default off)
//   SOURCING_ENGAGE_MIN_SCORE      niche score gate (default 0.75)
//   SOURCING_ENGAGE_LIKE_PROB      per-eligible-reel like probability (default 0.2)
//   SOURCING_ENGAGE_SAVE_PROB      save probability (default 0.1)
//   SOURCING_ENGAGE_SHARE_PROB     share probability (default 0 — off)
//   SOURCING_ENGAGE_MAX_LIKES      per-session like cap (default 20)
//   SOURCING_ENGAGE_MAX_SAVES      per-session save cap (default 10)
//   SOURCING_ENGAGE_MAX_SHARES     per-session share cap (default 3)

const DEFAULTS = {
  enabled: false,
  minScore: 0.75,
  likeProbability: 0.2,
  saveProbability: 0.1,
  shareProbability: 0,
  maxLikesPerSession: 20,
  maxSavesPerSession: 10,
  maxSharesPerSession: 3,
};

function num(v, fallback) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadPolicy(env = process.env, overrides = {}) {
  const base = {
    enabled: String(env.SOURCING_ENGAGEMENT || '').toLowerCase() === 'on',
    minScore: num(env.SOURCING_ENGAGE_MIN_SCORE, DEFAULTS.minScore),
    likeProbability: num(env.SOURCING_ENGAGE_LIKE_PROB, DEFAULTS.likeProbability),
    saveProbability: num(env.SOURCING_ENGAGE_SAVE_PROB, DEFAULTS.saveProbability),
    shareProbability: num(env.SOURCING_ENGAGE_SHARE_PROB, DEFAULTS.shareProbability),
    maxLikesPerSession: num(env.SOURCING_ENGAGE_MAX_LIKES, DEFAULTS.maxLikesPerSession),
    maxSavesPerSession: num(env.SOURCING_ENGAGE_MAX_SAVES, DEFAULTS.maxSavesPerSession),
    maxSharesPerSession: num(env.SOURCING_ENGAGE_MAX_SHARES, DEFAULTS.maxSharesPerSession),
  };
  return { ...base, ...overrides };
}

function newCounters() {
  return { likes: 0, saves: 0, shares: 0 };
}

// Decide the actions for ONE reel. Pure: returns { like, save, share } booleans.
// The caller applies them (tapping the buttons) and increments `counters`.
function decide({ score = 0, alreadyLiked = false, alreadySaved = false, blocked = false, counters = newCounters(), policy, rng = Math.random } = {}) {
  const p = policy || loadPolicy();
  const out = { like: false, save: false, share: false };

  if (blocked || !p.enabled) return out;          // action-block backoff / disabled
  if (!(score >= p.minScore)) return out;          // only clearly on-brand reels

  if (!alreadyLiked && counters.likes < p.maxLikesPerSession && rng() < p.likeProbability) out.like = true;
  if (!alreadySaved && counters.saves < p.maxSavesPerSession && rng() < p.saveProbability) out.save = true;
  if (counters.shares < p.maxSharesPerSession && rng() < p.shareProbability) out.share = true;

  return out;
}

module.exports = { DEFAULTS, loadPolicy, newCounters, decide };
