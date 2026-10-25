'use strict';

// Warming the feed on a creator we just shortlisted: like their reel.
//
// The account's reel feed only serves the creators we want once Instagram has
// learned what this account likes, and the clearest thing to teach it with is
// the creators we already chose. So every shortlisted creator's reel is liked,
// right after they are shortlisted, on the reel that surfaced them — the phone
// is still standing on it (services/sourcingNavigator.js records that reel
// before it yields the creator). When the phone is somewhere else (a creator
// found through the Accounts list, or opened from the feed by handle), their
// profile is opened and their newest reel is used instead.
//
// Liking only: nothing is shared, saved or commented.
//
// Cap per run (env, optional): SOURCING_WARM_MAX_LIKES (default 40). An "action
// blocked" screen stops all warming for the rest of the run. SOURCING_WARM=off
// turns warming off. The like button is the same one the feed's engagement
// already taps.

const { readView } = require('./sourcingNavigator');
const { jitteredDelay, jitterTap } = require('./humanize');

const DEFAULTS = {
  maxLikes: 40,
  // Watch for a beat before reacting: a like the instant a reel appears is not a person.
  dwellMs: 2000,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (h) => norm(h).replace(/^@/, '');

function num(v, fallback) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The warm-up policy for a run, from env. */
function loadPolicy(env = process.env) {
  return {
    enabled: norm(env.SOURCING_WARM) !== 'off',
    maxLikes: num(env.SOURCING_WARM_MAX_LIKES, DEFAULTS.maxLikes),
    dwellMs: num(env.SOURCING_WARM_DWELL_MS, DEFAULTS.dwellMs),
  };
}

function newCounters() {
  return { likes: 0, blocked: false };
}

async function tapAt(driver, point, jitterPx, pacingMs) {
  const p = jitterTap(point, jitterPx || 0);
  await driver.tap(p.x, p.y);
  await sleep(jitteredDelay(pacingMs));
}

const isThisCreatorsReel = (view, handle) => view && view.screen === 'reels_feed'
  && view.author && clean(view.author) === handle;

/**
 * Get onto one of this creator's reels: where we are, or their profile's newest
 * reel. Returns the reel player's reading, or null with a reason.
 */
async function reachReel({ driver, read, handle, pacingMs, jitterPx }) {
  let view = await read(driver);
  if (isThisCreatorsReel(view, handle)) return { view };

  const onTheirProfile = ['profile', 'reels_tab'].includes(view.screen)
    && (!view.username || clean(view.username) === handle);
  if (!onTheirProfile) {
    if (!driver.openProfile) return { view: null, reason: 'not on their reel, and this phone cannot open a profile' };
    try {
      await driver.openProfile(handle);
      await sleep(jitteredDelay(pacingMs));
    } catch (err) {
      return { view: null, reason: `could not open their profile (${(err && err.message) || err})` };
    }
    view = await read(driver);
    if (!['profile', 'reels_tab'].includes(view.screen)) return { view: null, reason: `their profile did not open (${view.screen})` };
  }

  // The Reels tab carries the reel thumbnails; the Posts grid does not.
  if (!(Array.isArray(view.reels) && view.reels.length) && view.targets && view.targets.reelsTab) {
    await tapAt(driver, view.targets.reelsTab, jitterPx, pacingMs);
    view = await read(driver);
  }
  const first = Array.isArray(view.reels) ? view.reels.find((r) => r && r.point) : null;
  if (!first) return { view: null, reason: 'no reel on their profile to open' };
  await tapAt(driver, first.point, jitterPx, pacingMs);
  view = await read(driver);
  if (!isThisCreatorsReel(view, handle)) return { view: null, reason: `their reel did not open (${view.screen})` };
  return { view };
}

/**
 * Like one shortlisted creator's reel. Never throws.
 *
 * Returns { liked, alreadyLiked?, reason?, blocked? }. `counters` is the run's,
 * shared across calls so the cap holds for the whole run.
 */
async function warmCreator({
  driver, read = readView, handle, policy = loadPolicy(), counters = newCounters(),
  pacingMs = 1500, jitterPx = 0, log = () => {},
}) {
  const who = clean(handle);
  const out = { liked: false };
  if (!who) return { ...out, reason: 'no handle' };
  if (!policy.enabled) return { ...out, reason: 'warming is off' };
  if (counters.blocked) return { ...out, reason: 'Instagram blocked an action earlier this run' };
  if (counters.likes >= policy.maxLikes) return { ...out, reason: 'this run reached its like cap' };

  try {
    const reached = await reachReel({ driver, read, handle: who, pacingMs, jitterPx });
    if (!reached.view) {
      log(`[warm] @${who}: ${reached.reason} — not liked`);
      return { ...out, reason: reached.reason };
    }
    const { view } = reached;

    if (view.alreadyLiked) {
      log(`[warm] @${who}: already liked`);
      return { liked: true, alreadyLiked: true };
    }
    if (!(view.targets && view.targets.like)) {
      log(`[warm] @${who}: no like button on the reel — not liked`);
      return { ...out, reason: 'no like button on the reel' };
    }

    await sleep(jitteredDelay(policy.dwellMs));
    await tapAt(driver, view.targets.like, jitterPx, pacingMs);
    counters.likes += 1;

    const after = await read(driver);
    if (after.screen === 'action_blocked') {
      counters.blocked = true;
      log('[warm] Instagram blocked an action — no more liking this run');
      return { liked: true, blocked: true, reason: 'action blocked' };
    }
    log(`[warm] @${who}: liked (${counters.likes}/${policy.maxLikes} this run)`);
    return { liked: true };
  } catch (err) {
    const reason = (err && err.message) || String(err);
    log(`[warm] @${who}: failed — ${reason}`);
    return { ...out, reason };
  }
}

module.exports = {
  warmCreator, reachReel, loadPolicy, newCounters, DEFAULTS,
};
