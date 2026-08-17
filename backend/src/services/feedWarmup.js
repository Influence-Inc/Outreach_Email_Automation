'use strict';

// Feed warm-up — teach Instagram's reels feed what we want to be shown, so that
// reels-mode sourcing has better raw material to work with.
//
// Deliberately NOT part of a sourcing run. A session that likes and scouts in the
// same pass looks nothing like a human: sourcing has a distinctive cadence (open
// profile, scroll a grid, back out, repeat) and adding likes to it makes the
// whole pattern more conspicuous, not less. This is a short standalone pass —
// likes only, no profile visits, no recording, no model calls.
//
// The rule that makes it worth doing at all: only like a reel by a creator who
// already PASSED the deterministic gate. Liking on a raw niche score teaches the
// feed our keywords; liking on a gate-passed creator teaches it our taste. That
// difference is the difference between being shown more running content and being
// shown better running content.
//
// Risk posture, because this is the highest-risk thing the system does:
//   - off unless explicitly asked for
//   - a hard like cap per pass, and a hard reel cap
//   - a per-reel probability, so the pattern is not "like everything approved"
//   - never re-likes an already-liked reel
//   - stops dead on an `action_blocked` screen, and reports it
//   - likes only. A share opens a send-sheet, needs a recipient, and is several
//     taps deep with a real chance of sending something to an actual person; the
//     ranking signal is not worth that.
//
// Every dependency is injected, so the whole pass is testable with no phone.

const { readView, IG_ANDROID_PACKAGE } = require('./sourcingNavigator');
const { jitteredDelay, jitterTap } = require('./humanize');
const { clearDialogs, createStallGuard, recoverFromStall } = require('./sourcingResilience');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const DEFAULTS = {
  // A short pass. Long sessions of nothing but likes are the shape that gets
  // accounts flagged.
  maxLikes: 12,
  maxReels: 60,
  // Not every approved creator's reel gets liked — "likes every single one" is
  // itself a pattern.
  likeProbability: 0.6,
  // Watch a reel for a beat before deciding. Liking a reel 200ms after it
  // appears is not something a person does.
  dwellMs: 2500,
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Run one warm-up pass over the account's own reels feed.
 *
 * @param {object}   o
 * @param {object}   o.driver     remote driver (tap / swipe / openApp)
 * @param {Set|Array} o.approved  handles that passed the gate — the ONLY reels
 *                                this will like. Lowercased internally.
 * @returns {Promise<{liked:number, seen:number, skipped:object, blocked:boolean}>}
 */
async function warmFeed({
  driver, config = {}, approved = [], read = readView, deps = {},
} = {}) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const maxLikes = num(config.maxLikes, DEFAULTS.maxLikes);
  const maxReels = num(config.maxReels, DEFAULTS.maxReels);
  const likeProbability = num(config.likeProbability, DEFAULTS.likeProbability);
  const dwellMs = num(config.dwellMs, DEFAULTS.dwellMs);
  const rng = deps.rng || Math.random;
  const log = deps.log || (() => {});

  const wanted = new Set(
    (approved instanceof Set ? [...approved] : approved || [])
      .map((h) => String(h || '').replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean),
  );

  const stats = {
    liked: 0,
    seen: 0,
    blocked: false,
    skipped: { notApproved: 0, alreadyLiked: 0, unreadable: 0, dice: 0 },
  };

  // Nothing approved means nothing to teach the feed. Bailing here rather than
  // scrolling for ten minutes to like nothing.
  if (!wanted.size) {
    log('[warmup] no gate-passed creators to warm on — nothing to do');
    return stats;
  }

  const stall = createStallGuard({ timeoutMs: config.stallMs, now: deps.now });

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));

  // Into the account's OWN reels feed — the one the algorithm ranks for us, which
  // is the only feed worth warming.
  let view = await read(driver);
  if (view.dialog) view = (await clearDialogs({ driver, read, view, pacingMs, jitterPx, log })).view;
  const navTab = (view.targets && (view.targets.reelsNavTab || view.targets.reelsTab)) || null;
  if (!navTab) {
    log('[warmup] could not find the Reels tab — leaving the feed alone');
    return stats;
  }
  await tap(driver, navTab, jitterPx, pacingMs);

  let size = { width: 1080, height: 2400 };
  try {
    if (driver.getWindowSize) {
      const s = await driver.getWindowSize();
      if (s && s.width) size = s;
    }
  } catch (_) { /* the default is fine */ }

  for (let i = 0; i < maxReels && stats.liked < maxLikes; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);

    if (view.screen === 'action_blocked') {
      // The one signal that means stop immediately. Warming the feed is never
      // worth spending the account's standing.
      log('[warmup] action blocked — stopping the pass');
      stats.blocked = true;
      return stats;
    }

    if (stall.check(view)) {
      // eslint-disable-next-line no-await-in-loop
      view = await recoverFromStall({
        driver, read, pacingMs, jitterPx, guard: stall, log, pkg: IG_ANDROID_PACKAGE,
      });
    } else if (view.dialog) {
      // eslint-disable-next-line no-await-in-loop
      view = (await clearDialogs({ driver, read, view, pacingMs, jitterPx, log })).view;
    }

    if (view.screen !== 'reels_feed') {
      log(`[warmup] no longer in the reels feed (${view.screen}) — ending the pass`);
      return stats;
    }

    stats.seen += 1;
    const handle = view.author ? String(view.author).toLowerCase() : null;

    // Sponsored reels are ads. Liking one teaches the feed to show more ads.
    const skip = !handle || view.sponsored || !wanted.has(handle);
    if (skip) {
      if (!handle) stats.skipped.unreadable += 1;
      else stats.skipped.notApproved += 1;
    } else if (view.alreadyLiked) {
      stats.skipped.alreadyLiked += 1;
    } else if (rng() > likeProbability) {
      // Deliberately passing on some approved reels — always liking every one is
      // its own recognisable pattern.
      stats.skipped.dice += 1;
    } else if (view.targets && view.targets.like) {
      // Watch it first. A like fired the instant a reel appears is not a person.
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredDelay(dwellMs));
      // eslint-disable-next-line no-await-in-loop
      await tap(driver, view.targets.like, jitterPx, pacingMs);
      stats.liked += 1;
      log(`[warmup] liked @${handle} (${stats.liked}/${maxLikes})`);
    }

    // eslint-disable-next-line no-await-in-loop
    await scrollToNextReel({ driver, size, jitterPx, pacingMs });
  }

  log(`[warmup] pass done: liked ${stats.liked} of ${stats.seen} reels seen`);
  return stats;
}

async function tap(driver, point, jitterPx, pacingMs) {
  const p = jitterTap(point, jitterPx || 0);
  await driver.tap(p.x, p.y);
  await sleep(jitteredDelay(pacingMs));
}

async function scrollToNextReel({ driver, size, jitterPx, pacingMs }) {
  const jx = jitterTap({ x: Math.round(size.width / 2), y: 0 }, jitterPx).x;
  await driver.swipe({
    x1: jx,
    y1: Math.round(size.height * 0.8),
    x2: jx,
    y2: Math.round(size.height * 0.2),
    durationMs: 300,
  });
  await sleep(jitteredDelay(pacingMs));
}

module.exports = { warmFeed, DEFAULTS };
