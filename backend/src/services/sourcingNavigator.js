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
const { normalizeTerms } = require('./searchTerms');

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

// One search term per search, always a single word — see services/searchTerms.js
// for why (multi-word phrases returned far less, and leftover text in the search
// box compounded terms into queries like "fitnesshomegym").
function pickSearchTerms(opts) {
  return normalizeTerms(opts);
}

async function tapTarget({ driver, view, name, pacingMs, jitterPx = 0 }) {
  const t = view.targets && view.targets[name];
  if (!t) throw new Error(`no on-screen target for ${name}`);
  await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
}

// Screens a keyword loop can continue from — where the next result is reachable.
const SERP_SCREENS = ['search_results', 'search'];

// How many reels to read off a creator's grid before scoring them. One screen of
// the grid shows about six, so this needs a scroll or two.
const REELS_PER_PROFILE = 12;

// Safety bound on the scroll loop — a grid that stops yielding new reels exits
// earlier, this only caps a creator with a very long back catalogue.
const MAX_REEL_SCROLLS = 6;

// Real device pixels, for scroll geometry. Falls back to a common phone size so
// a driver without getWindowSize still scrolls sensibly.
async function deviceSize(driver) {
  try {
    const s = driver.getWindowSize ? await driver.getWindowSize() : null;
    if (s && s.width && s.height) return { width: s.width, height: s.height };
  } catch (_) {
    /* best effort */
  }
  return { width: 1080, height: 2400 };
}

async function* scout({ driver, config = {}, opts = {}, read = readView, deps = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;
  const clipSeconds = config.clipSeconds || 12;
  const getClip = deps.getClip || (async () => null);

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));

  const screen = await deviceSize(driver);
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

    // COMMIT THE QUERY. Typing alone leaves Instagram on its as-you-type
    // suggestions, which match the raw string against ACCOUNT NAMES — that is
    // why keyword scouting kept returning profiles whose handle contained the
    // word rather than creators posting about it. Pressing Search is what loads
    // the real results page.
    if (driver.submitSearch) {
      await driver.submitSearch();
      await sleep(jitteredDelay(pacingMs));
    }

    // Then move to that page's REELS chip — the keyword's actual content.
    view = await read(driver);
    const reelsChip = view.targets && view.targets.searchReelsTab;
    if (reelsChip) {
      await humanTap(driver, reelsChip, jitterPx, pacingMs);
      view = await read(driver);
    }

    // REELS FIRST. Current IG (2024+) answers a keyword with a "For you" reels
    // grid, and that is the surface worth scouting: a reel proves the creator is
    // actively posting the content we searched for, where an Accounts row only
    // proves the handle matched the string. Tap a card → the reels_feed player
    // exposes the real @handle + an authorProfile tap target → open the profile
    // → read header + reels. Go back TWICE to return to the SERP
    // (profile -> reels_feed -> SERP).
    // For each reel the keyword surfaced: open it, hop to its creator, analyse
    // the creator, then come back and do the next one — until Nth creator.
    const reelResults = Array.isArray(view.reelResults) ? view.reelResults : [];
    for (const rr of reelResults) {
      if (emitted >= max) return;
      const profile = await captureViaReel({
        driver, reelIndex: rr.index, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
      });
      if (profile) {
        yield profile;
        emitted += 1;
      }
      // However deep this creator took us (reel player -> profile -> feed), come
      // back to the results page — and no further.
      await backTo({ driver, read, pacingMs, jitterPx, wanted: SERP_SCREENS, maxHops: 4 });
    }

    // Fallback: an "Accounts" list of @handle rows, on builds (or with the
    // Accounts chip active) where no reels grid came back. Only used when the
    // reels path found nothing, so a single keyword is never scouted twice.
    if (!reelResults.length) {
      const results = Array.isArray(view.results) ? view.results : [];
      for (const handle of results) {
        if (emitted >= max) return;
        const profile = await openAndCaptureProfile({
          driver, handle, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
        });
        if (profile) {
          yield profile;
          emitted += 1;
        }
        await backTo({ driver, read, pacingMs, jitterPx, wanted: SERP_SCREENS, maxHops: 4 });
      }
    }

    // Next keyword starts by tapping the search tab, which is reachable from any
    // in-app screen — so rather than pressing back again (the press that used to
    // exit Instagram), just make sure we are still inside the app.
    await ensureInInstagram({ driver, read, pacingMs, jitterPx });
  }
}

// Reels-first capture: tap a reel card on the SERP -> read @handle from the
// reels_feed -> tap the author to open their profile -> read header + reels.
// Returns null if any hop lost its tap target (search UI drift); the outer loop
// then just moves on to the next reel card.
async function captureViaReel({
  driver, reelIndex, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip,
}) {
  const serp = await read(driver);
  const card = serp.targets && serp.targets[`reelResult:${reelIndex}`];
  if (!card) return null;
  await humanTap(driver, { x: card.x, y: card.y }, jitterPx, pacingMs);

  const feed = await read(driver);
  if (!feed.author || !feed.targets || !feed.targets.authorProfile) return null;
  await humanTap(driver, feed.targets.authorProfile, jitterPx, pacingMs);

  return analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
    fallbackUsername: feed.author,
    source: 'backend-navigator:reels-first',
    screens: ['reels_feed', 'profile', 'reels_tab'],
  });
}

// Everything the scoring rules need about one creator, read off their profile.
//
// The Reels tab matters specifically: the default grid shows POSTS, and a post
// thumbnail carries no view count. Reach — the number this whole pipeline is
// built to filter on — only exists on the Reels grid, which is why this always
// switches tabs rather than scoring whatever the profile happened to open on.
async function analyseProfile({
  driver, pacingMs, jitterPx = 0, read = readView, screen,
  clipSeconds = 12, getClip = async () => null,
  fallbackUsername = null, source = 'backend-navigator', screens = ['profile'],
}) {
  const header = await read(driver);

  // Switch to Reels unless we are already there (IG sometimes opens a profile
  // on the Reels sub-tab, in which case reel overlays are already present).
  let view = header;
  const onReels = Array.isArray(header.reels) && header.reels.length;
  if (!onReels && header.targets && header.targets.reelsTab) {
    await humanTap(driver, header.targets.reelsTab, jitterPx, pacingMs);
    view = await read(driver);
  }

  // Record one reel BEFORE scrolling, while the most recent is still on screen.
  const clip = await captureReelClip({
    driver, view, pacingMs, jitterPx, read, clipSeconds, getClip,
  });

  // Then scroll the grid for the rest of the reach data.
  const reels = await collectReels({ driver, read, view, pacingMs, jitterPx, screen });

  return {
    username: header.username || fallbackUsername,
    full_name: header.fullName || null,
    followers: header.followers ?? null,
    bio: header.bio || null,
    reels,
    // The judge scores creative style and niche from the actual video + audio;
    // reelJudge picks this up automatically when present (services/reelJudge.js).
    clip: clip || undefined,
    evidence: {
      capturedAt: new Date().toISOString(),
      screens,
      reelsRead: reels.length,
      clipCaptured: !!clip,
      source,
    },
  };
}

// Read reels off the grid, scrolling until we have REELS_PER_PROFILE or the
// grid stops producing new ones. De-duped on views+caption because a scroll
// overlaps the previous screen.
async function collectReels({ driver, read, view, pacingMs, jitterPx = 0, screen }) {
  const size = screen || { width: 1080, height: 2400 };
  const seen = new Map();
  const absorb = (v) => {
    for (const r of Array.isArray(v && v.reels) ? v.reels : []) {
      const key = `${r.views}|${r.caption || ''}`;
      if (!seen.has(key)) seen.set(key, r);
    }
  };
  absorb(view);

  for (let i = 0; i < MAX_REEL_SCROLLS && seen.size < REELS_PER_PROFILE; i += 1) {
    const before = seen.size;
    await driver.swipe({
      x1: Math.round(size.width / 2),
      y1: Math.round(size.height * 0.72),
      x2: Math.round(size.width / 2),
      y2: Math.round(size.height * 0.28),
      durationMs: 320,
    });
    await sleep(jitteredDelay(pacingMs));
    // eslint-disable-next-line no-await-in-loop
    absorb(await read(driver));
    if (seen.size === before) break; // grid exhausted — stop scrolling an empty page
  }
  return Array.from(seen.values()).slice(0, REELS_PER_PROFILE);
}

// Open the creator's most recent reel, record it (video + audio), and come back.
// Best-effort throughout: a host without recordClip, a grid with no tappable
// cell, or a failed recording must cost the reach data we already have.
async function captureReelClip({
  driver, view, pacingMs, jitterPx = 0, read = readView, clipSeconds = 12, getClip,
}) {
  if (!driver.recordClip) return null;
  const cell = view && view.targets && view.targets['reelCell:0'];
  if (!cell) return null;

  await humanTap(driver, cell, jitterPx, pacingMs);
  let clip = null;
  try {
    const rec = await driver.recordClip(clipSeconds);
    const clipId = rec && (rec.clipId || rec);
    clip = clipId ? await getClip(clipId) : null;
  } catch (_) {
    /* recording is enrichment, never a reason to drop the candidate */
  }
  // Back to the grid — but only as far as the grid, so a recording that never
  // opened the player does not press back out of the profile.
  await backTo({
    driver, read, pacingMs, jitterPx,
    wanted: ['reels_tab', 'profile'],
    maxHops: 2,
  });
  return clip;
}

async function openAndCaptureProfile({
  driver, handle, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip,
}) {
  // Open the profile from the results list.
  const results = await read(driver);
  const link = results.targets && results.targets[`result:${handle}`];
  if (!link) return null;
  await humanTap(driver, { x: link.x, y: link.y }, jitterPx, pacingMs);

  const profile = await analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
    fallbackUsername: handle,
    source: 'backend-navigator',
    screens: ['profile', 'reels_tab'],
  });
  return { ...profile, username: handle };
}

// One back press, using the on-screen affordance when the reader found one and
// the system back gesture otherwise.
async function pressBack({ driver, view, pacingMs, jitterPx = 0 }) {
  const t = view && view.targets && view.targets.back;
  if (t) {
    await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
  } else {
    // fallback: swipe from the left edge (Android's system back gesture)
    await driver.swipe({ x1: 5, y1: 400, x2: 200, y2: 400, durationMs: 250 });
    await sleep(jitteredDelay(pacingMs));
  }
}

async function goBack({ driver, pacingMs, jitterPx = 0, read = readView }) {
  await pressBack({ driver, view: await read(driver), pacingMs, jitterPx });
}

/**
 * Back out until the current screen is one of `wanted`.
 *
 * Counting back presses was what walked the agent out of Instagram entirely. A
 * capture that bails early — a reel card whose author never resolved, a profile
 * link that moved — pushes fewer screens than the caller assumed, so a fixed
 * "go back twice" kept pressing past the results page and out of the app.
 * Reading between hops makes the number of presses follow what is actually on
 * screen, and costs nothing when we are already where we want to be.
 */
async function backTo({ driver, read = readView, pacingMs, jitterPx = 0, wanted, maxHops = 4 }) {
  let view = await read(driver);
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (wanted.includes(view.screen)) return view;
    // eslint-disable-next-line no-await-in-loop
    await pressBack({ driver, view, pacingMs, jitterPx });
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);
  }
  return view;
}

/**
 * Recover if we are no longer anywhere readable inside Instagram.
 *
 * Backing out too far, or IG dropping to the launcher, used to leave every
 * subsequent tap landing on whatever happened to be under the coordinates.
 * Relaunching is always safe: openApp on an already-foreground IG is a no-op.
 */
async function ensureInInstagram({ driver, read = readView, pacingMs, jitterPx = 0 }) {
  const view = await read(driver);
  if (view && view.screen && view.screen !== 'unknown') return view;
  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));
  return read(driver);
}

module.exports = { scout, readView, pickSearchTerms, IG_ANDROID_PACKAGE };
