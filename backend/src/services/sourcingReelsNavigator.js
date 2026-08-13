'use strict';

// Reels-feed navigator — the "explore + scroll + evaluate + (occasionally) engage"
// flow. Instead of searching profiles, it drops into Instagram's full-screen reel
// player for a keyword and scrolls, judging each reel with the multimodal model
// (video + audio) and — very occasionally, when enabled — liking/saving the
// clearly on-brand ones to warm the Explore/Reels algorithm toward the niche.
//
// Runs server-side against a RemoteDriver (agent executes taps/records). Every
// dependency (screen read, judge, clip fetch, engagement policy, rng) is injected
// so the whole flow is unit-testable with no phone, no Gemini, no network.
//
// Safety: engagement is OFF by default and, when on, gated by engagementPolicy
// (strong-match only, low probability, per-session caps). An 'action_blocked'
// screen stops the run immediately.

const {
  readView, IG_ANDROID_PACKAGE, analyseProfile, backTo, REELS_PER_PROFILE,
} = require('./sourcingNavigator');
const engagementPolicy = require('./engagementPolicy');
const { jitteredDelay, jitterTap } = require('./humanize');

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

async function* scoutReels({ driver, config = {}, opts = {}, read = readView, deps = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;
  const clipSeconds = config.clipSeconds || 12;
  const reelsWindow = config.reelsWindow || REELS_PER_PROFILE;
  const judge = deps.judge || (async () => null);
  const getClip = deps.getClip || (async () => null);
  const engagement = deps.engagement || {
    policy: engagementPolicy.loadPolicy(),
    decide: engagementPolicy.decide,
  };
  const rng = deps.rng || Math.random;
  const warn = (deps.logger && (deps.logger.warn || deps.logger.log)) || (() => {});
  const counters = engagementPolicy.newCounters();

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));
  await enterReelsFeed({ driver, read, pacingMs });

  let size = { width: 1080, height: 2400 };
  try {
    if (driver.getWindowSize) { const s = await driver.getWindowSize(); if (s && s.width) size = s; }
  } catch (_) { /* keep default */ }

  let emitted = 0;
  while (emitted < max) {
    const view = await read(driver);
    if (view.screen === 'action_blocked') { warn('[reels] action blocked — stopping'); break; }
    if (view.screen !== 'reels_feed' || !view.author) break;

    const candidate = {
      username: view.author,
      reels: view.caption ? [{ caption: view.caption }] : [],
      evidence: { capturedAt: new Date().toISOString(), source: 'reels-feed' },
    };

    // Record the reel (video + audio) and attach the clip bytes for the judge.
    try {
      const rec = await driver.recordClip(clipSeconds);
      const clipId = rec && (rec.clipId || rec);
      const clip = clipId ? await getClip(clipId) : null;
      if (clip && clip.buf) {
        candidate.clip = { dataBase64: clip.buf.toString('base64'), mimeType: clip.mediaType || 'video/mp4' };
      }
    } catch (err) {
      warn('[reels] recordClip failed:', err.message);
    }

    // Judge once here; stash the verdict so the orchestrator reuses it (no double cost).
    let verdict = null;
    try { verdict = await judge(candidate, config); } catch (_) { /* fall through */ }
    if (verdict) candidate._nicheVerdict = verdict;
    const score = verdict && typeof verdict.score === 'number' ? verdict.score : 0;

    // Engagement — very occasional, capped, strong-match only. like/save in v1
    // (share is multi-step + highest risk, deferred).
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
      await driver.tap(p.x, p.y);
      counters.likes += 1;
      await sleep(jitteredDelay(pacingMs));
    }
    if (acts.save && view.targets && view.targets.save) {
      const p = jitterTap(view.targets.save, jitterPx);
      await driver.tap(p.x, p.y);
      counters.saves += 1;
      await sleep(jitteredDelay(pacingMs));
    }

    // Open the creator and read their Reels grid.
    //
    // A reel in the feed shows no view count, so judging alone could never
    // answer "does this creator clear the floor?" — the reach rules had nothing
    // to measure and every reels-mode candidate went to review on the AI verdict
    // by itself. Visiting the profile and scrolling `reelsWindow` reels gives
    // those rules the numbers they need, then we come back to the feed.
    if (view.targets && view.targets.authorProfile) {
      const p = jitterTap(view.targets.authorProfile, jitterPx);
      await driver.tap(p.x, p.y);
      await sleep(jitteredDelay(pacingMs));
      try {
        const profile = await analyseProfile({
          driver,
          pacingMs,
          jitterPx,
          read,
          screen: size,
          clipSeconds,
          getClip,
          reelsWindow,
          fallbackUsername: view.author,
          source: 'reels-feed',
          screens: ['reels_feed', 'profile', 'reels_tab'],
          // The feed reel was already recorded and judged above; a second
          // recording here would cost another ~12s on the phone and a second
          // Gemini call for the same verdict.
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
      // Back to the feed we were scrolling, however deep the profile went.
      await backTo({ driver, read, pacingMs, jitterPx, wanted: ['reels_feed'], maxHops: 4 });
    }

    yield candidate;
    emitted += 1;

    // Swipe up to the next reel (jittered endpoints so the gesture isn't identical).
    const jx = jitterTap({ x: Math.round(size.width / 2), y: 0 }, jitterPx).x;
    await driver.swipe({
      x1: jx, y1: Math.round(size.height * 0.8),
      x2: jx, y2: Math.round(size.height * 0.2),
      durationMs: 300,
    });
    await sleep(jitteredDelay(pacingMs));
  }
}

module.exports = { scoutReels, enterReelsFeed };
