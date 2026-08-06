'use strict';

// Instagram Navigator: drives the IG app on the phone via the DeviceDriver +
// ScreenReader, yielding CAPTURED CANDIDATES to the runner. The runner then
// forwards them to the backend, which applies the scouting rules.
//
// The strategy is intentionally simple + linear so it's easy to reason about:
//   1. openApp('instagram') -> home
//   2. for each keyword: open search -> type -> tap 'Tags'/'Accounts' -> for each
//      result tap into profile -> capture handle/bio/followers -> open Reels tab
//      -> read the recent-N view overlays -> back to search
//
// Every screen decision goes through screenReader.read(); the navigator NEVER
// hardcodes coordinates. That keeps the code driver-agnostic (mock/Android/iOS
// all work) and lets the vision layer swap without touching the flow.
//
// Pacing: after every mutating action we sleep pacingMs so we look human.

const IG_ANDROID_PACKAGE = 'com.instagram.android';
const IG_IOS_BUNDLE = 'com.burbn.instagram';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Yield captured candidates one at a time. `opts.strategy` selects the discovery
// path (keyword/hashtag/similar). `opts.max` caps how many to emit; caller can
// break out early via the returned generator.
async function* scoutCandidates({ driver, reader, config, opts = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const max = opts.max || Infinity;
  const platform = (opts.platform || 'android').toLowerCase();
  const appId = platform === 'ios' ? IG_IOS_BUNDLE : IG_ANDROID_PACKAGE;

  await driver.openApp(appId);
  await sleep(pacingMs);

  const terms = pickSearchTerms(opts);
  let emitted = 0;

  for (const term of terms) {
    if (emitted >= max) return;
    await gotoSearchTab({ driver, reader, pacingMs });
    await typeSearch({ driver, reader, term, pacingMs });

    const results = await readResults({ driver, reader });
    for (const handle of results) {
      if (emitted >= max) return;
      const profile = await openAndCaptureProfile({ driver, reader, handle, pacingMs });
      if (profile) {
        yield profile;
        emitted += 1;
      }
      await goBack({ driver, reader, pacingMs });
    }
    await goBack({ driver, reader, pacingMs });
  }
}

function pickSearchTerms(opts) {
  const raw = [
    ...(opts.hashtags || []),
    ...(opts.keywords || []),
    ...(opts.seedAccounts || []),
  ];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

async function tapTarget({ driver, targets, name, pacingMs }) {
  const t = targets && targets[name];
  if (!t) throw new Error(`no on-screen target for ${name}`);
  await driver.tap(t.x, t.y);
  await sleep(pacingMs);
}

async function gotoSearchTab({ driver, reader, pacingMs }) {
  const shot = await driver.screenshot();
  const view = await reader.read(shot);
  await tapTarget({ driver, targets: view.targets, name: 'searchTab', pacingMs });
}

async function typeSearch({ driver, reader, term, pacingMs }) {
  const shot = await driver.screenshot();
  const view = await reader.read(shot);
  await tapTarget({ driver, targets: view.targets, name: 'searchBox', pacingMs });
  await driver.typeText(term);
  await sleep(pacingMs);
}

async function readResults({ driver, reader }) {
  const shot = await driver.screenshot();
  const view = await reader.read(shot);
  return Array.isArray(view.results) ? view.results : [];
}

async function openAndCaptureProfile({ driver, reader, handle, pacingMs }) {
  // Open the profile from the results list.
  {
    const shot = await driver.screenshot();
    const view = await reader.read(shot);
    const link = view.targets && view.targets[`result:${handle}`];
    if (!link) return null;
    await driver.tap(link.x, link.y);
    await sleep(pacingMs);
  }

  // Read the profile header (handle, followers, bio) + tap the Reels tab.
  const header = await reader.read(await driver.screenshot());
  await tapTarget({ driver, targets: header.targets, name: 'reelsTab', pacingMs });

  // Capture the recent-N reel view overlays.
  const reelsView = await reader.read(await driver.screenshot());
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
    },
  };
}

async function goBack({ driver, reader, pacingMs }) {
  const view = await reader.read(await driver.screenshot());
  const t = view.targets && view.targets.back;
  if (t) {
    await driver.tap(t.x, t.y);
  } else {
    // fallback: swipe from the left edge (Android/iOS back gesture)
    await driver.swipe({ x1: 5, y1: 400, x2: 200, y2: 400, durationMs: 250 });
  }
  await sleep(pacingMs);
}

module.exports = { scoutCandidates, IG_ANDROID_PACKAGE, IG_IOS_BUNDLE };
