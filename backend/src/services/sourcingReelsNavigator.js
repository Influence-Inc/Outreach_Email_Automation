'use strict';

// Reels-feed navigator — scroll the account's own warmed feed, collect creators,
// then work through them.
//
// Three phases per batch, and the order is the point:
//
//   1. COLLECT  stay on the feed. Read each reel, skip anyone already handled in
//               a single swipe, record a short clip, hand it off for analysis,
//               scroll on. Around a dozen creators.
//   2. HANDLE   the feed is out of the picture. Each profile is opened DIRECTLY
//               from its handle, so nothing has to navigate back through a reel.
//   3. RETURN   once, at the end of the batch.
//
// Getting back into the feed and finding a place is the least reliable thing
// this does, and the old per-creator order made it happen once per creator.
// Now it happens once per dozen, and landing slightly off costs almost nothing
// because already-handled creators are skipped in one swipe.
//
// Analysis is submitted, never awaited (services/analysisQueue.js): a slow or
// briefly-down model must not change how fast the phone scrolls.
//
// Runs server-side against a RemoteDriver (agent executes taps/records). Every
// dependency (screen read, judge, clip fetch, engagement policy, rng) is injected
// so the whole flow is unit-testable with no phone, no Gemini, no network.
//
// Safety: engagement is OFF by default and, when on, gated by engagementPolicy
// (strong-match only, low probability, per-session caps). An 'action_blocked'
// screen stops the run immediately.

const {
  readView, IG_ANDROID_PACKAGE, analyseProfile, REELS_PER_PROFILE,
} = require('./sourcingNavigator');
const engagementPolicy = require('./engagementPolicy');
const { jitteredDelay, jitterTap } = require('./humanize');
const { createAnalysisQueue } = require('./analysisQueue');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Best-effort tap of a named target — skips silently if it isn't on screen (the
// entry path tolerates missing affordances; the main loop gates on reels_feed).
async function softTap({ driver, view, name, pacingMs }) {
  const t = view.targets && view.targets[name];
  if (!t) return false;
  await driver.tap(t.x, t.y);
  await sleep(jitteredDelay(pacingMs));
  return true;
}

/**
 * Drop into Instagram's OWN reel feed — the Reels button in the bottom nav.
 *
 * This used to route through search: tap the search tab, type the keyword, then
 * tap the first result. That is a different surface. It lands on the search
 * results page (or, worse, Explore), and sourcing creators from there is not
 * what this mode is for — the feed under the Reels label is, and its algorithmic
 * ranking is the thing the engagement warm-up is meant to steer.
 *
 * Best-effort, as before: the main loop only proceeds once it actually sees the
 * full-screen reel player, so a missed tap costs a run rather than corrupting one.
 */
async function enterReelsFeed({ driver, read, pacingMs }) {
  const view = await read(driver);
  if (await softTap({ driver, view, name: 'reelsNavTab', pacingMs })) return;

  // Older builds put the reel feed behind the same bottom-bar slot the reader
  // reports as reelsTab when nothing more specific matched.
  await softTap({ driver, view, name: 'reelsTab', pacingMs });
}

// How many consecutive reels may be unreadable before we accept the feed is not
// giving us anything and stop.
const MAX_UNREADABLE_REELS = 8;

// Creators gathered before the scout leaves the feed to work through them.
const DEFAULT_BATCH_SIZE = 12;

// Only waited for when engagement is enabled — see collectBatch.
const ENGAGEMENT_VERDICT_WAIT_MS = 8_000;

// Swipe up to the next reel (jittered endpoints so the gesture isn't identical).
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

/**
 * Collect a batch of creators WITHOUT leaving the feed.
 *
 * Nothing here opens a profile. The scout reads each reel, skips anyone already
 * handled in a single swipe, records a short clip, hands the clip off for
 * analysis, and scrolls on. Judging is submitted, never awaited — a slow or
 * down analysis service must not change how fast the phone scrolls.
 */
async function collectBatch({
  driver, read, size, pacingMs, jitterPx, clipSeconds, batchSize,
  handled, queue, judge, getClip, engagement, counters, rng, config, warn,
}) {
  const batch = [];
  let unreadable = 0;

  while (batch.length < batchSize && unreadable <= MAX_UNREADABLE_REELS) {
    // eslint-disable-next-line no-await-in-loop
    const view = await read(driver);
    if (view.screen === 'action_blocked') {
      warn('[reels] action blocked — stopping');
      return { batch, blocked: true };
    }
    if (view.screen !== 'reels_feed') return { batch, blocked: false };

    if (!view.author) {
      unreadable += 1;
      // eslint-disable-next-line no-await-in-loop
      await scrollToNextReel({ driver, size, jitterPx, pacingMs });
      continue;
    }
    unreadable = 0;

    // Already handled — the cheapest possible outcome, one swipe. On a warmed
    // feed the same creators come round constantly, which is where most of the
    // wasted time was going.
    const key = String(view.author).toLowerCase();
    if (handled.has(key)) {
      // eslint-disable-next-line no-await-in-loop
      await scrollToNextReel({ driver, size, jitterPx, pacingMs });
      continue;
    }
    handled.add(key);

    // Recording is a device action, so it is awaited. Judging the recording is
    // not, so it is not.
    let clip = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const rec = await driver.recordClip(clipSeconds);
      const clipId = rec && (rec.clipId || rec);
      // eslint-disable-next-line no-await-in-loop
      const stored = clipId ? await getClip(clipId) : null;
      if (stored && stored.buf) {
        clip = { dataBase64: stored.buf.toString('base64'), mimeType: stored.mediaType || 'video/mp4' };
      } else if (stored && stored.dataBase64) {
        clip = stored;
      }
    } catch (err) {
      warn('[reels] recordClip failed:', err.message);
    }

    const entry = { username: view.author, caption: view.caption || null, clip };
    if (clip) {
      queue.submit(key, () => judge({ username: entry.username, caption: entry.caption, clip }, config));
    }

    // Engagement stays on the feed, where the like/save affordances are — and it
    // needs a score, which means waiting for the judge. Engagement is OFF by
    // default, so the default path never waits at all; a run that turns it on
    // accepts a short wait, because liking an off-brand reel actively mis-trains
    // the very feed this mode depends on.
    let score = 0;
    if (engagement.policy && engagement.policy.enabled && clip) {
      // eslint-disable-next-line no-await-in-loop
      const early = await queue.take(key, { timeoutMs: ENGAGEMENT_VERDICT_WAIT_MS });
      if (early) {
        entry.verdict = early;
        score = typeof early.score === 'number' ? early.score : 0;
      }
    }

    const acts = engagement.decide({
      score,
      alreadyLiked: view.alreadyLiked,
      alreadySaved: view.alreadySaved,
      blocked: false,
      counters,
      policy: engagement.policy,
      rng,
    });
    if (acts.like && view.targets && view.targets.like) {
      const p = jitterTap(view.targets.like, jitterPx);
      // eslint-disable-next-line no-await-in-loop
      await driver.tap(p.x, p.y);
      counters.likes += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredDelay(pacingMs));
    }
    if (acts.save && view.targets && view.targets.save) {
      const p = jitterTap(view.targets.save, jitterPx);
      // eslint-disable-next-line no-await-in-loop
      await driver.tap(p.x, p.y);
      counters.saves += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredDelay(pacingMs));
    }

    batch.push(entry);

    // eslint-disable-next-line no-await-in-loop
    await scrollToNextReel({ driver, size, jitterPx, pacingMs });
  }
  return { batch, blocked: false };
}

/**
 * Work one collected creator, with the feed out of the picture entirely.
 *
 * The profile is opened DIRECTLY from the handle rather than tapped through
 * from a reel, so nothing has to find its place in the feed again afterwards —
 * that happens once per batch instead of once per creator.
 */
async function handleCreator({
  driver, read, entry, queue, size, pacingMs, jitterPx, reelsWindow, warn,
}) {
  const candidate = {
    username: entry.username,
    reels: entry.caption ? [{ caption: entry.caption }] : [],
    evidence: { capturedAt: new Date().toISOString(), source: 'reels-feed' },
  };
  if (entry.clip) candidate.clip = entry.clip;

  if (driver.openProfile) {
    try {
      await driver.openProfile(entry.username);
      await sleep(jitteredDelay(pacingMs));
      const profile = await analyseProfile({
        driver,
        pacingMs,
        jitterPx,
        read,
        screen: size,
        clipSeconds: 0,
        reelsWindow,
        fallbackUsername: entry.username,
        source: 'reels-feed',
        screens: ['profile', 'reels_tab'],
        // The feed reel is already recorded and in the analysis queue; a second
        // recording would cost another stretch on the phone for a verdict we
        // are already waiting on.
        recordClip: false,
      });
      if (profile) {
        candidate.username = profile.username || candidate.username;
        candidate.full_name = profile.full_name;
        candidate.followers = profile.followers;
        candidate.bio = profile.bio;
        if (Array.isArray(profile.reels) && profile.reels.length) candidate.reels = profile.reels;
        candidate.evidence = { ...candidate.evidence, ...profile.evidence, source: 'reels-feed' };
      }
    } catch (err) {
      warn('[reels] profile analysis failed:', err.message);
    }
  }

  // Collect the verdict if it has landed. A creator whose analysis is still in
  // flight is kept and marked incomplete rather than stalling the run.
  const verdict = entry.verdict || await queue.take(String(entry.username).toLowerCase());
  if (verdict) {
    candidate._nicheVerdict = verdict;
  } else if (entry.clip) {
    candidate.evidence = { ...candidate.evidence, analysis: 'incomplete' };
  }
  return candidate;
}

async function* scoutReels({ driver, config = {}, opts = {}, read = readView, deps = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;
  const clipSeconds = config.clipSeconds || 12;
  const reelsWindow = config.reelsWindow || REELS_PER_PROFILE;
  const batchSize = Math.max(1, Number(config.batchSize) || DEFAULT_BATCH_SIZE);
  const judge = deps.judge || (async () => null);
  const getClip = deps.getClip || (async () => null);
  const engagement = deps.engagement || {
    policy: engagementPolicy.loadPolicy(),
    decide: engagementPolicy.decide,
  };
  const rng = deps.rng || Math.random;
  const warn = (deps.logger && (deps.logger.warn || deps.logger.log)) || (() => {});
  const counters = engagementPolicy.newCounters();
  const queue = deps.analysisQueue || createAnalysisQueue({ logger: deps.logger || console });

  // Creators already handled, for the life of the run. Checked the moment a
  // handle is read off a reel — before recording, before opening anything.
  const handled = new Set();

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));
  await enterReelsFeed({ driver, read, pacingMs });

  let size = { width: 1080, height: 2400 };
  try {
    if (driver.getWindowSize) { const s = await driver.getWindowSize(); if (s && s.width) size = s; }
  } catch (_) { /* keep default */ }

  let emitted = 0;
  while (emitted < max) {
    // 1. COLLECT — stay on the feed, gather a batch.
    const { batch, blocked } = await collectBatch({
      driver, read, size, pacingMs, jitterPx, clipSeconds,
      batchSize: Math.min(batchSize, max - emitted),
      handled, queue, judge, getClip, engagement, counters, rng, config, warn,
    });
    if (!batch.length) break;

    // 2. HANDLE — one creator at a time, opened directly by handle.
    for (const entry of batch) {
      if (emitted >= max) break;
      // eslint-disable-next-line no-await-in-loop
      const candidate = await handleCreator({
        driver, read, entry, queue, size, pacingMs, jitterPx, reelsWindow, warn,
      });
      // No keyword here — this mode takes whoever the warmed feed serves, so the
      // mode itself IS the provenance worth recording.
      yield { ...candidate, discovery: 'reels' };
      emitted += 1;
    }

    if (blocked || emitted >= max) break;

    // 3. RETURN — once per batch, not once per creator. Anything already
    // handled is skipped in a single swipe, so landing slightly off costs
    // almost nothing.
    await enterReelsFeed({ driver, read, pacingMs });
  }
}

module.exports = { scoutReels, enterReelsFeed, collectBatch, handleCreator };
