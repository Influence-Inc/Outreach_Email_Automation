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

const { readView, pickSearchTerms, IG_ANDROID_PACKAGE } = require('./sourcingNavigator');
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

// Search a term and drop into content (best-effort). The main loop only proceeds
// once it actually sees the full-screen reel player.
async function enterReelsFeed({ driver, read, term, pacingMs }) {
  if (!term) return;
  let view = await read(driver);
  await softTap({ driver, view, name: 'searchTab', pacingMs });
  view = await read(driver);
  await softTap({ driver, view, name: 'searchBox', pacingMs });
  await driver.typeText(term);
  await sleep(jitteredDelay(pacingMs));
  view = await read(driver);
  const first = (view.results || [])[0];
  if (first && view.targets && view.targets[`result:${first}`]) {
    const t = view.targets[`result:${first}`];
    await driver.tap(t.x, t.y);
    await sleep(jitteredDelay(pacingMs));
  }
}

async function* scoutReels({ driver, config = {}, opts = {}, read = readView, deps = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;
  const clipSeconds = config.clipSeconds || 12;
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
  await enterReelsFeed({ driver, read, term: pickSearchTerms(opts)[0], pacingMs });

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
