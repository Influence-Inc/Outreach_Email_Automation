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

// Device pixel size, asked for once per driver.
//
// Every screen read used to fetch this alongside the UI tree, which meant two
// round-trips to the phone for every single navigation step — and there are
// dozens per creator. The screen does not resize mid-run (the phone sits on a
// shelf in one orientation), so one call is enough and the rest of the run reads
// it for free.
const SIZE_CACHE = new WeakMap();

async function windowSizeOf(driver) {
  const cached = SIZE_CACHE.get(driver);
  if (cached) return cached;
  let size = { width: null, height: null };
  try {
    const s = driver.getWindowSize ? await driver.getWindowSize() : null;
    if (s) size = { width: s.width, height: s.height };
  } catch (_) {
    /* size is best-effort */
  }
  SIZE_CACHE.set(driver, size);
  return size;
}

// Capture the current screen: dump the UI tree + device size, interpret it.
async function readView(driver) {
  // Issued together so the first read pays one round-trip's latency, not two.
  const [elements, size] = await Promise.all([driver.dumpUi(), windowSizeOf(driver)]);
  return readScreen({ elements, width: size.width, height: size.height });
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

// Default number of reels to read off a creator's grid. Overridden per run by
// `reelsWindow` — the dashboard's "Recent reels to check" — because that is the
// same window the scoring rules measure against.
const REELS_PER_PROFILE = 12;

// Safety bound on the scroll loop — a grid that stops yielding new reels exits
// earlier, this only caps a creator with a very long back catalogue.
const MAX_REEL_SCROLLS = 6;

// Safety bound on scrolling a reels FEED for creators. Generous, because the
// feed repeats accounts and dead reels (no author target) burn iterations
// without producing a candidate; the run's own target count stops it first.
const MAX_FEED_SCROLLS = 60;

// Real device pixels, for scroll geometry. Shares the per-driver cache with
// readView, so this costs nothing after the first screen read. Falls back to a
// common phone size for a driver that cannot report one.
async function deviceSize(driver) {
  const s = await windowSizeOf(driver);
  if (s && s.width && s.height) return { width: s.width, height: s.height };
  return { width: 1080, height: 2400 };
}

async function* scout({ driver, config = {}, opts = {}, read = readView, deps = {} }) {
  const pacingMs = config.pacingMs ?? 1500;
  const jitterPx = config.tapJitterPx || 0;
  const max = opts.max || Infinity;
  const clipSeconds = config.clipSeconds || 12;
  const reelsWindow = config.reelsWindow || REELS_PER_PROFILE;
  const getClip = deps.getClip || (async () => null);

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));

  const screen = await deviceSize(driver);
  const terms = pickSearchTerms(opts);
  let emitted = 0;
  // Creators already analysed, across every keyword — a feed surfaces the same
  // popular accounts repeatedly, and re-opening one burns a slot against N.
  const seenCreators = new Set();

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
    // Explore is the fallback when a build's results page has no Reels chip:
    // still the query's surface, unlike the bottom-nav Explore feed.
    view = await read(driver);
    const chip = view.targets && (view.targets.searchReelsTab || view.targets.exploreTab);
    if (chip) {
      await humanTap(driver, chip, jitterPx, pacingMs);
      view = await read(driver);
    }

    // The chip can land on either of two surfaces, so handle both.
    //
    // SURFACE A — a full-screen scrollable feed. There are no cards to tap by
    // index; creators are found by scrolling reel to reel, opening each one's
    // profile, and coming back to carry on scrolling.
    if (view.screen === 'reels_feed') {
      for await (const profile of scoutReelFeed({
        driver, read, pacingMs, jitterPx, screen, clipSeconds, getClip, reelsWindow,
        remaining: max - emitted, seen: seenCreators,
      })) {
        yield profile;
        emitted += 1;
        if (emitted >= max) return;
      }
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }

    // SURFACE B — a "For you" reels GRID. A reel proves the creator is actively
    // posting the content we searched for, where an Accounts row only proves the
    // handle matched the string. Tap a card → the reels_feed player exposes the
    // real @handle + an authorProfile target → open the profile → analyse.
    const reelResults = Array.isArray(view.reelResults) ? view.reelResults : [];
    for (const rr of reelResults) {
      if (emitted >= max) return;
      const profile = await captureViaReel({
        driver, reelIndex: rr.index, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
        reelsWindow,
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
          driver, handle, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
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

/**
 * Scroll a reels feed, opening each distinct creator's profile for analysis.
 *
 * This is what the results page's Reels / Explore chip lands on when Instagram
 * answers a keyword with a full-screen player rather than a grid of cards.
 * There is nothing to tap by index, so the loop is: read the reel on screen →
 * open its creator → analyse → back to the feed → swipe to the next reel, until
 * the Nth creator is sourced.
 *
 * `seen` is shared across keywords: a feed re-surfaces popular accounts, and
 * analysing one twice would spend a slot against N for a creator already added.
 */
async function* scoutReelFeed({
  driver, read = readView, pacingMs, jitterPx = 0, screen,
  clipSeconds = 12, getClip, remaining = Infinity, seen = new Set(),
  reelsWindow = REELS_PER_PROFILE,
}) {
  const size = screen || { width: 1080, height: 2400 };
  let produced = 0;

  for (let i = 0; i < MAX_FEED_SCROLLS && produced < remaining; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const feed = await read(driver);
    if (feed.screen !== 'reels_feed') return; // scrolled out of the feed

    const author = feed.author ? String(feed.author).toLowerCase() : null;
    const link = feed.targets && feed.targets.authorProfile;

    if (link && !(author && seen.has(author))) {
      if (author) seen.add(author);
      // eslint-disable-next-line no-await-in-loop
      await humanTap(driver, link, jitterPx, pacingMs);
      // eslint-disable-next-line no-await-in-loop
      const profile = await analyseProfile({
        driver, pacingMs, jitterPx, read, screen: size, clipSeconds, getClip, reelsWindow,
        fallbackUsername: feed.author || null,
        source: 'backend-navigator:feed-scroll',
        screens: ['reels_feed', 'profile', 'reels_tab'],
      });
      if (profile) {
        yield profile;
        produced += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await backTo({ driver, read, pacingMs, jitterPx, wanted: ['reels_feed'], maxHops: 4 });
    }

    // Swipe up to the next reel (jittered endpoints so the gesture isn't identical).
    const jx = jitterTap({ x: Math.round(size.width / 2), y: 0 }, jitterPx).x;
    // eslint-disable-next-line no-await-in-loop
    await driver.swipe({
      x1: jx,
      y1: Math.round(size.height * 0.8),
      x2: jx,
      y2: Math.round(size.height * 0.2),
      durationMs: 300,
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(jitteredDelay(pacingMs));
  }
}

// Reels-first capture: tap a reel card on the SERP -> read @handle from the
// reels_feed -> tap the author to open their profile -> read header + reels.
// Returns null if any hop lost its tap target (search UI drift); the outer loop
// then just moves on to the next reel card.
async function captureViaReel({
  driver, reelIndex, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip, reelsWindow = REELS_PER_PROFILE,
}) {
  const serp = await read(driver);
  const card = serp.targets && serp.targets[`reelResult:${reelIndex}`];
  if (!card) return null;
  await humanTap(driver, { x: card.x, y: card.y }, jitterPx, pacingMs);

  const feed = await read(driver);
  if (!feed.author || !feed.targets || !feed.targets.authorProfile) return null;
  await humanTap(driver, feed.targets.authorProfile, jitterPx, pacingMs);

  return analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
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
  reelsWindow = REELS_PER_PROFILE, recordClip = true,
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
  //
  // Skipped when the caller already has a judged clip for this creator — reels
  // mode records and judges the feed reel before it ever opens the profile, and
  // recording a second one would spend another ~12s on the phone plus a second
  // Gemini call to answer a question already answered.
  const clip = recordClip
    ? await captureReelClip({ driver, view, pacingMs, jitterPx, read, clipSeconds, getClip })
    : null;

  // Then scroll the grid for the rest of the reach data.
  const reels = await collectReels({
    driver, read, view, pacingMs, jitterPx, screen, want: reelsWindow,
  });

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
async function collectReels({ driver, read, view, pacingMs, jitterPx = 0, screen, want = REELS_PER_PROFILE }) {
  const size = screen || { width: 1080, height: 2400 };
  const target = Math.max(1, Number(want) || REELS_PER_PROFILE);
  const seen = new Map();
  const absorb = (v) => {
    for (const r of Array.isArray(v && v.reels) ? v.reels : []) {
      const key = `${r.views}|${r.caption || ''}`;
      if (!seen.has(key)) seen.set(key, r);
    }
  };
  absorb(view);

  for (let i = 0; i < MAX_REEL_SCROLLS && seen.size < target; i += 1) {
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
  return Array.from(seen.values()).slice(0, target);
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
  screen, clipSeconds = 12, getClip, reelsWindow = REELS_PER_PROFILE,
}) {
  // Open the profile from the results list.
  const results = await read(driver);
  const link = results.targets && results.targets[`result:${handle}`];
  if (!link) return null;
  await humanTap(driver, { x: link.x, y: link.y }, jitterPx, pacingMs);

  const profile = await analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
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

module.exports = {
  scout,
  readView,
  pickSearchTerms,
  IG_ANDROID_PACKAGE,
  // Shared with the reels-feed navigator so both discovery modes analyse a
  // creator the same way (Reels tab -> scroll the grid -> record one reel).
  analyseProfile,
  backTo,
  REELS_PER_PROFILE,
};
