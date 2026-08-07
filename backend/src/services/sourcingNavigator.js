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

const IG_ANDROID_PACKAGE = 'com.instagram.android';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function tapTarget({ driver, view, name, pacingMs }) {
  const t = view.targets && view.targets[name];
  if (!t) throw new Error(`no on-screen target for ${name}`);
  await driver.tap(t.x, t.y);
  await sleep(pacingMs);
}

async function* scout({ driver, config = {}, opts = {}, read = readView }) {
  const pacingMs = config.pacingMs ?? 1500;
  const max = opts.max || Infinity;

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(pacingMs);

  const terms = pickSearchTerms(opts);
  let emitted = 0;

  for (const term of terms) {
    if (emitted >= max) return;

    let view = await read(driver);
    await tapTarget({ driver, view, name: 'searchTab', pacingMs });

    view = await read(driver);
    await tapTarget({ driver, view, name: 'searchBox', pacingMs });
    await driver.typeText(term);
    await sleep(pacingMs);

    view = await read(driver);
    const results = Array.isArray(view.results) ? view.results : [];
    for (const handle of results) {
      if (emitted >= max) return;
      const profile = await openAndCaptureProfile({ driver, handle, pacingMs, read });
      if (profile) {
        yield profile;
        emitted += 1;
      }
      await goBack({ driver, pacingMs, read });
    }
    await goBack({ driver, pacingMs, read });
  }
}

async function openAndCaptureProfile({ driver, handle, pacingMs, read = readView }) {
  // Open the profile from the results list.
  const results = await read(driver);
  const link = results.targets && results.targets[`result:${handle}`];
  if (!link) return null;
  await driver.tap(link.x, link.y);
  await sleep(pacingMs);

  // Read the profile header, then open the Reels tab if it's there.
  const header = await read(driver);
  const reelsT = header.targets && header.targets.reelsTab;
  if (reelsT) {
    await driver.tap(reelsT.x, reelsT.y);
    await sleep(pacingMs);
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

async function goBack({ driver, pacingMs, read = readView }) {
  const view = await read(driver);
  const t = view.targets && view.targets.back;
  if (t) {
    await driver.tap(t.x, t.y);
  } else {
    // fallback: swipe from the left edge (Android's system back gesture)
    await driver.swipe({ x1: 5, y1: 400, x2: 200, y2: 400, durationMs: 250 });
  }
  await sleep(pacingMs);
}

module.exports = { scout, readView, IG_ANDROID_PACKAGE };
