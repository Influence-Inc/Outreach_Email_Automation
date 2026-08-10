'use strict';

// Server-side Instagram navigator — the brain, now on the backend.
//
// Same linear scout flow as the runner's navigator/instagram.js, but it runs
// HERE, driving a RemoteDriver (services/remoteDriver.js) over the command
// channel, and reads each screen via services/screenVision.readScreen in-process
// (no HTTP round-trip). Yields captured candidates the orchestrator scores.
//
//   openApp -> for each keyword: search tab -> type -> read results ->
//   for each result: open profile -> read header -> open Reels -> read reels ->
//   yield candidate -> back
//
// Every screen decision goes through `read(driver)` (default readView), so the
// navigator never hard-codes coordinates — taps come from the reader's targets.
// `read` is injectable so the flow is unit-testable without crafting UI trees.

const { readScreen } = require('./screenVision');
const { jitteredDelay, jitterTap } = require('./humanize');

const IG_ANDROID_PACKAGE = 'com.instagram.android';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Tap a point with a small coordinate jitter, then pace with a randomized delay —
// so actions aren't pixel-perfect or metronome-timed. jitterPx<=0 / pacingMs=0
// (unit tests) => exact + instant.
async function humanTap(driver, point, jitterPx, pacingMs) {
  const p = jitterTap(point, jitterPx || 0);
  await driver.tap(p.x, p.y);
  await sleep(jitteredDelay(pacingMs));
}

// Capture the current screen: dump the UI tree + device size, interpret it.
async function readView(driver) {
  const elements = await driver.dumpUi();
  let width = null;
  let height = null;
  try {
    const s = driver.getWindowSize ? await driver.getWindowSize() : null;
    if (s) { width = s.width; height = s.height; }
  } catch (_) {
    /* size is best-effort */
  }
  return readScreen({ elements, width, height });
}

function pickSearchTerms(opts) {
  const raw = [
    ...(opts.hashtags || []),
    ...(opts.keywords || []),
    ...(opts.seedAccounts || []),
  ];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

async function tapTarget({ driver, view, name, pacingMs, jitterPx = 0 }) {
  const t = view.targets && view.targets[name];
  if (!t) throw new Error(`no on-screen target for ${name}`);
  await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
}

async function* scout({ driver, config = {}, opts = {}, read = readView }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));

  const terms = pickSearchTerms(opts);
  let emitted = 0;

  for (const term of terms) {
    if (emitted >= max) return;

    let view = await read(driver);
    await tapTarget({ driver, view, name: 'searchTab', pacingMs, jitterPx });

    view = await read(driver);
    await tapTarget({ driver, view, name: 'searchBox', pacingMs, jitterPx });
    await driver.typeText(term);
    await sleep(jitteredDelay(pacingMs));

    view = await read(driver);

    // Classic path: IG returned an "Accounts" list of @handle rows (still on
    // some builds / when the Accounts chip is active).
    const results = Array.isArray(view.results) ? view.results : [];
    for (const handle of results) {
      if (emitted >= max) return;
      const profile = await openAndCaptureProfile({ driver, handle, pacingMs, jitterPx, read });
      if (profile) {
        yield profile;
        emitted += 1;
      }
      await goBack({ driver, pacingMs, jitterPx, read });
    }

    // Reels-first path: current IG (2024+) shows a "For you" REELS GRID after
    // typing a keyword — each card's author is only in content-desc. Tap a card
    // → the reels_feed player exposes the real @handle + an authorProfile tap
    // target → open the profile → read header + reels. Go back TWICE to return
    // to the SERP (profile -> reels_feed -> SERP).
    const reelResults = Array.isArray(view.reelResults) ? view.reelResults : [];
    for (const rr of reelResults) {
      if (emitted >= max) return;
      const profile = await captureViaReel({ driver, reelIndex: rr.index, pacingMs, jitterPx, read });
      if (profile) {
        yield profile;
        emitted += 1;
      }
      await goBack({ driver, pacingMs, jitterPx, read }); // profile -> reels_feed
      await goBack({ driver, pacingMs, jitterPx, read }); // reels_feed -> SERP
    }

    await goBack({ driver, pacingMs, jitterPx, read });
  }
}

// Reels-first capture: tap a reel card on the SERP -> read @handle from the
// reels_feed -> tap the author to open their profile -> read header + reels.
// Returns null if any hop lost its tap target (search UI drift); the outer loop
// then just moves on to the next reel card.
async function captureViaReel({ driver, reelIndex, pacingMs, jitterPx = 0, read = readView }) {
  const serp = await read(driver);
  const card = serp.targets && serp.targets[`reelResult:${reelIndex}`];
  if (!card) return null;
  await humanTap(driver, { x: card.x, y: card.y }, jitterPx, pacingMs);

  const feed = await read(driver);
  if (!feed.author || !feed.targets || !feed.targets.authorProfile) return null;
  await humanTap(driver, feed.targets.authorProfile, jitterPx, pacingMs);

  // Read the profile. On current IG the profile often opens with the Reels
  // sub-tab already selected, in which case screenVision already surfaces reels
  // alongside the header — no extra tap. If not, open the Reels tab.
  let header = await read(driver);
  if (!(Array.isArray(header.reels) && header.reels.length) && header.targets && header.targets.reelsTab) {
    await humanTap(driver, header.targets.reelsTab, jitterPx, pacingMs);
    header = await read(driver);
  }

  return {
    username: header.username || feed.author,
    full_name: header.fullName || null,
    followers: header.followers ?? null,
    bio: header.bio || null,
    reels: Array.isArray(header.reels) ? header.reels : [],
    evidence: {
      capturedAt: new Date().toISOString(),
      screens: ['reels_feed', 'profile'],
      source: 'backend-navigator:reels-first',
    },
  };
}

async function openAndCaptureProfile({ driver, handle, pacingMs, jitterPx = 0, read = readView }) {
  // Open the profile from the results list.
  const results = await read(driver);
  const link = results.targets && results.targets[`result:${handle}`];
  if (!link) return null;
  await humanTap(driver, { x: link.x, y: link.y }, jitterPx, pacingMs);

  // Read the profile header, then open the Reels tab if it's there.
  const header = await read(driver);
  const reelsT = header.targets && header.targets.reelsTab;
  if (reelsT) {
    await humanTap(driver, { x: reelsT.x, y: reelsT.y }, jitterPx, pacingMs);
  }

  const reelsView = await read(driver);
  const reels = Array.isArray(reelsView.reels) ? reelsView.reels : [];

  return {
    username: handle,
    full_name: header.fullName || null,
    followers: header.followers ?? null,
    bio: header.bio || null,
    reels,
    evidence: {
      capturedAt: new Date().toISOString(),
      screens: ['profile', 'reels_tab'],
      source: 'backend-navigator',
    },
  };
}

async function goBack({ driver, pacingMs, jitterPx = 0, read = readView }) {
  const view = await read(driver);
  const t = view.targets && view.targets.back;
  if (t) {
    await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
  } else {
    // fallback: swipe from the left edge (Android's system back gesture)
    await driver.swipe({ x1: 5, y1: 400, x2: 200, y2: 400, durationMs: 250 });
    await sleep(jitteredDelay(pacingMs));
  }
}

module.exports = { scout, readView, pickSearchTerms, IG_ANDROID_PACKAGE };
