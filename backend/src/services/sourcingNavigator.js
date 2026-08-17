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
const {
  clearDialogs, arriveAt, createStallGuard, recoverFromStall, createProfileCap,
} = require('./sourcingResilience');

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

/**
 * Tap a named target if it is there, and say whether it was.
 *
 * The throwing version killed an entire run when one control was momentarily
 * missing — a keyword we cannot start is a keyword to skip, not a reason to
 * abandon every keyword after it.
 */
async function tapTargetSoft({ driver, view, name, pacingMs, jitterPx = 0 }) {
  const t = view.targets && view.targets[name];
  if (!t) return false;
  await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
  return true;
}

// Screens a keyword loop can continue from — where the next result is reachable.
const SERP_SCREENS = ['search_results', 'search'];

// Default number of reels to read off a creator's grid. Overridden per run by
// `reelsWindow` — the dashboard's "Recent reels to check" — because that is the
// same window the scoring rules measure against.
const REELS_PER_PROFILE = 12;

// How many reels to actually WATCH per creator. One clip tells you what a
// creator's best day looks like and nothing about the other days; three is the
// smallest sample that distinguishes a consistent creator from a lucky one, and
// each costs a recording plus a Gemini call, so it does not grow past that.
const CLIPS_PER_PROFILE = 3;

// Safety bound on the scroll loop — a grid that stops yielding new reels exits
// earlier, this only caps a creator with a very long back catalogue.
const MAX_REEL_SCROLLS = 6;

// Safety bound on scrolling a reels FEED for creators. Generous, because the
// feed repeats accounts and dead reels (no author target) burn iterations
// without producing a candidate; the run's own target count stops it first.
const MAX_FEED_SCROLLS = 60;

// The results strip is `For you | Accounts | Audio | Tags`. Only the first is
// reel content; the rest are songs, hashtags and handle-string matches.
const FOR_YOU_TABS = ['for you', 'top'];

/**
 * Force the results page onto its "For you" content tab.
 *
 * Instagram REMEMBERS the last-used search tab, so a fresh keyword search
 * regularly opens on Audio (a page of songs) rather than For you. "For you is the
 * default" was wrong — landing on Audio is normal, and it must be corrected every
 * time, not accepted because the page happens to have rows on it.
 *
 * The tab is the leftmost chip on the strip and effectively always on screen, so
 * the switch is a single tap. Returns { view, onForYou } — the caller must NOT
 * scout results when onForYou is false, or it sources songs and hashtags.
 */
async function openResultsReelsChip({ driver, view, read, pacingMs, jitterPx = 0, log = () => {} }) {
  const forYouTab = (v) => v && v.targets && v.targets.forYouTab;
  const onForYou = (v) => v && FOR_YOU_TABS.includes(v.activeTab);

  // Already on For you (the reader could read the selected tab and it is ours).
  if (onForYou(view)) return { view, onForYou: true };

  // Not on For you — or the reader could not tell. Tap the tab and re-read. A
  // redundant tap on an already-selected For you tab is a harmless no-op, so
  // "could not tell" is treated the same as "on the wrong tab": switch anyway.
  const tab = forYouTab(view);
  if (tab) {
    log(`[sourcing] results landed on "${view.activeTab || 'an unknown tab'}" — switching to For you`);
    await humanTap(driver, tab, jitterPx, pacingMs);
    const after = await read(driver);
    // Trust the switch even if the reader still cannot name the active tab: what
    // matters is that we tapped For you and did not stay on Audio. But if it CAN
    // name it and it is still not ours, say so and refuse to scout it.
    if (after.activeTab && !FOR_YOU_TABS.includes(after.activeTab)) {
      log(`[sourcing] still on "${after.activeTab}" after switching — not scouting it`);
      return { view: after, onForYou: false };
    }
    return { view: after, onForYou: true };
  }

  // No tab to tap. If the reader knows we are on a non-For-you tab, do not scout
  // it; otherwise assume For you (a full-screen reels player has no strip at all).
  if (view && view.activeTab && !FOR_YOU_TABS.includes(view.activeTab)) {
    log(`[sourcing] on "${view.activeTab}" with no For you tab in reach — skipping this keyword`);
    return { view, onForYou: false };
  }
  return { view, onForYou: true };
}

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
  const clipsWanted = config.clipsPerProfile != null ? config.clipsPerProfile : CLIPS_PER_PROFILE;
  const getClip = deps.getClip || (async () => null);
  const log = deps.log || (() => {});

  // A long run against a real app gets interrupted, stuck, and occasionally lost.
  // See services/sourcingResilience.js — these are shared with the reels-feed
  // navigator so both modes survive the same things.
  const stall = createStallGuard({ timeoutMs: config.stallMs, now: deps.now });
  const cap = createProfileCap({ max: config.maxProfiles, log });

  await driver.openApp(IG_ANDROID_PACKAGE);
  await sleep(jitteredDelay(pacingMs));

  const screen = await deviceSize(driver);
  const terms = pickSearchTerms(opts);
  let emitted = 0;
  // Creators already analysed, across every keyword AND every pass — a results
  // page re-surfaces the same popular accounts, and re-opening one burns a slot
  // against N.
  const seenCreators = new Set();

  // One pass over the keywords used to be the whole run, so a run whose target
  // was 6 reported "done" after finding 1 — it had simply run out of keywords,
  // never out of creators or out of its profile budget.
  //
  // Keywords now repeat, and each visit goes DEEPER into that keyword's results
  // than the last one did. "Nothing new at this depth" is not the same as "this
  // keyword is finished": the top of a results page is the same creators every
  // time, so a barren visit usually just means we have already worked that depth
  // — scrolling further is exactly what finds different creators and reels.
  //
  // A keyword is only retired once its results will not scroll any further AND
  // that deepest look produced nobody new. The run ends when the target is met,
  // the profile cap is spent, or every keyword has been retired.
  const depthOf = new Map(terms.map((t) => [t, 0]));
  const exhausted = new Set();
  // Consecutive times a keyword could not even be typed. A transient missing
  // control must not retire a keyword, but a permanent one must not spin the
  // pass loop forever either — which is exactly what an unbounded skip did.
  const failuresOf = new Map(terms.map((t) => [t, 0]));
  const MAX_TERM_FAILURES = 3;

  const skipTerm = (term, why) => {
    const n = (failuresOf.get(term) || 0) + 1;
    failuresOf.set(term, n);
    if (n >= MAX_TERM_FAILURES) {
      exhausted.add(term);
      log(`[sourcing] "${term}": ${why} ${n}x — retiring it`);
    } else {
      log(`[sourcing] "${term}": ${why} — skipping this visit`);
    }
  };

  for (let pass = 0; ; pass += 1) {
    if (emitted >= max || cap.spent()) return;
    if (exhausted.size >= terms.length) {
      log(`[sourcing] every keyword is scrolled out — ${emitted} sourced`);
      return;
    }

  for (const term of terms) {
    if (emitted >= max || cap.spent()) break;
    if (exhausted.has(term)) continue;
    const emittedAtTermStart = emitted;
    const depth = depthOf.get(term) || 0;

    // Stamp every creator with the keyword that surfaced them, so a passing
    // creator carries which search found them all the way into the creators
    // table — that is what makes one keyword's yield comparable to another's.
    const tag = (p) => (p ? { ...p, sourceTerm: term, discovery: 'search' } : p);

    let view = await read(driver);
    // Instagram interrupts a session with sheets — "Turn on notifications", an
    // update nag — and every tap after one appears lands on the sheet instead of
    // the app. Checked off the read we were doing anyway, so a clean screen
    // costs nothing.
    if (view.dialog) view = (await clearDialogs({ driver, read, view, pacingMs, jitterPx, log })).view;
    if (stall.check(view)) {
      view = await recoverFromStall({
        driver, read, pacingMs, jitterPx, guard: stall, log, pkg: IG_ANDROID_PACKAGE,
      });
    }
    // A missing control here used to throw and take the whole run down with it.
    // Get back into a known place and move to the next keyword instead — the
    // pass-progress guard below ends the run if nothing works anywhere.
    if (!await tapTargetSoft({ driver, view, name: 'searchTab', pacingMs, jitterPx })) {
      skipTerm(term, 'no search tab on screen');
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }

    view = await read(driver);
    if (!await tapTargetSoft({ driver, view, name: 'searchBox', pacingMs, jitterPx })) {
      skipTerm(term, 'no search box on screen');
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }
    failuresOf.set(term, 0); // the search started, so earlier misses were transient
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

    // Force the results onto the "For you" content tab. IG remembers the
    // last-used tab, so a fresh search can open on Audio (songs) — sourcing from
    // there is meaningless, so if we cannot get onto For you we skip the keyword
    // rather than scout the wrong tab.
    view = await read(driver);
    const onFor = await openResultsReelsChip({ driver, view, read, pacingMs, jitterPx, log });
    view = onFor.view;
    if (!onFor.onForYou) {
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }

    // The chip can land on either of two surfaces, so handle both.
    //
    // SURFACE A — a full-screen scrollable feed. There are no cards to tap by
    // index; creators are found by scrolling reel to reel, opening each one's
    // profile, and coming back to carry on scrolling.
    if (view.screen === 'reels_feed') {
      for await (const profile of scoutReelFeed({
        driver, read, pacingMs, jitterPx, screen, clipSeconds, getClip, reelsWindow, clipsWanted,
        remaining: max - emitted, seen: seenCreators, stall, cap, log,
      })) {
        yield tag(profile);
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
    //
    // Go as deep into this keyword's results as we have already worked, so this
    // visit starts where the last one stopped rather than re-tapping the same
    // cards. Strictly additive: a scroll landing somewhere with no content must
    // not cost us the page we already had.
    let atEnd = false;
    if (depth > 0) {
      const deeper = await scrollResults({ driver, read, pacingMs, screen, screens: depth });
      atEnd = deeper.atEnd;
      if (hasResults(deeper.view)) view = deeper.view;
    }

    const reelResults = Array.isArray(view.reelResults) ? view.reelResults : [];
    for (const rr of reelResults) {
      if (emitted >= max) return;
      if (!cap.take()) return; // the run has looked at enough profiles
      const profile = await captureViaReel({
        driver, reelIndex: rr.index, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
        reelsWindow, clipsWanted, log,
      });
      // A grid card gives no handle until the reel is open, so the duplicate
      // check has to happen here rather than before the hop.
      const handle = profile && profile.username && String(profile.username).toLowerCase();
      if (profile && handle && !seenCreators.has(handle)) {
        seenCreators.add(handle);
        yield tag(profile);
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
        // Here the handle is known before we move, so a creator already analysed
        // costs nothing at all to skip.
        if (seenCreators.has(String(handle).toLowerCase())) continue;
        if (!cap.take()) return;
        seenCreators.add(String(handle).toLowerCase());
        const profile = await openAndCaptureProfile({
          driver, handle, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
          clipsWanted, log,
        });
        if (profile) {
          yield tag(profile);
          emitted += 1;
        }
        await backTo({ driver, read, pacingMs, jitterPx, wanted: SERP_SCREENS, maxHops: 4 });
      }
    }

    // Next time this keyword comes round, start one screen deeper.
    depthOf.set(term, depth + 1);

    // Retire the keyword only when BOTH are true: its results would not scroll
    // any further, and that deepest look found nobody new. Either alone is not
    // enough — a barren depth with more page below it just means scroll on.
    if (atEnd && emitted === emittedAtTermStart) {
      exhausted.add(term);
      log(`[sourcing] "${term}" is scrolled out and gave nobody new — retiring it`);
    }

    // Next keyword starts by tapping the search tab, which is reachable from any
    // in-app screen — so rather than pressing back again (the press that used to
    // exit Instagram), just make sure we are still inside the app.
    await ensureInInstagram({ driver, read, pacingMs, jitterPx });
  }

    log(`[sourcing] pass ${pass + 1}: ${emitted} sourced, ${cap.opened()} profiles opened, `
      + `${terms.length - exhausted.size}/${terms.length} keywords still live`);
  }
}

/** Does this reading carry anything a scout can work with? */
function hasResults(v) {
  return !!v && (
    (Array.isArray(v.reelResults) && v.reelResults.length > 0)
    || (Array.isArray(v.results) && v.results.length > 0)
  );
}

/**
 * Scroll a results page down by whole screens, to reach cards an earlier visit
 * already worked through.
 *
 * `atEnd` reports that the page stopped moving — the same content came back
 * after a swipe, so there is nothing below this. That is what tells the caller a
 * keyword is genuinely finished rather than merely barren at this depth, and it
 * stops the run scrolling at the bottom of a short results page forever.
 *
 * @returns {Promise<{view:(object|null), atEnd:boolean}>}
 */
async function scrollResults({ driver, read, pacingMs, screen, screens = 1 }) {
  const size = screen || { width: 1080, height: 2400 };
  const fingerprint = (v) => [
    (v && v.results) ? v.results.join(',') : '',
    (v && v.reelResults) ? v.reelResults.map((r) => r && r.label).join(',') : '',
  ].join('|');

  let view = null;
  let atEnd = false;
  for (let i = 0; i < screens; i += 1) {
    const before = fingerprint(view);
    // eslint-disable-next-line no-await-in-loop
    await driver.swipe({
      x1: Math.round(size.width / 2),
      y1: Math.round(size.height * 0.8),
      x2: Math.round(size.width / 2),
      y2: Math.round(size.height * 0.2),
      durationMs: 320,
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(jitteredDelay(pacingMs));
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);

    // Only meaningful from the second swipe on, when there is a previous
    // reading to compare against.
    if (i > 0 && fingerprint(view) === before) {
      atEnd = true;
      break;
    }
  }
  return { view, atEnd };
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
  reelsWindow = REELS_PER_PROFILE, clipsWanted = CLIPS_PER_PROFILE,
  stall = null, cap = null, log = () => {},
}) {
  const size = screen || { width: 1080, height: 2400 };
  let produced = 0;

  for (let i = 0; i < MAX_FEED_SCROLLS && produced < remaining; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    let feed = await read(driver);

    // Frozen player, unresolved spinner, a tap that opened nothing — the screen
    // has stopped changing, so get back somewhere workable and carry on.
    if (stall && stall.check(feed)) {
      // eslint-disable-next-line no-await-in-loop
      feed = await recoverFromStall({
        driver, read, pacingMs, jitterPx, guard: stall, log, pkg: IG_ANDROID_PACKAGE,
      });
    } else if (feed.dialog) {
      // eslint-disable-next-line no-await-in-loop
      feed = (await clearDialogs({ driver, read, view: feed, pacingMs, jitterPx, log })).view;
    }

    if (feed.screen !== 'reels_feed') return; // scrolled out of the feed

    const author = feed.author ? String(feed.author).toLowerCase() : null;
    const link = feed.targets && feed.targets.authorProfile;

    // An ad, not a creator. The account behind a sponsored reel is a brand
    // buying placement — opening it spends a profile visit to source a
    // competitor.
    const skip = feed.sponsored || (cap && cap.spent());
    if (feed.sponsored) log(`[sourcing] skipping a sponsored reel${author ? ` by @${author}` : ''}`);

    if (!skip && link && !(author && seen.has(author))) {
      if (author) seen.add(author);
      if (!cap || cap.take()) {
        // Verify we actually reached the profile. A tap that lands during a
        // re-layout silently does nothing, and the analysis that followed used
        // to read the reel player as though it were a profile header.
        // eslint-disable-next-line no-await-in-loop
        const arrived = await arriveAt({
          driver, read, pacingMs, jitterPx, log, what: 'creator profile',
          wanted: ['profile', 'reels_tab'],
          act: () => humanTap(driver, link, jitterPx, pacingMs),
        });

        if (arrived.ok) {
          // eslint-disable-next-line no-await-in-loop
          const profile = await analyseProfile({
            driver, pacingMs, jitterPx, read, screen: size, clipSeconds, getClip, reelsWindow, clipsWanted,
            fallbackUsername: feed.author || null,
            source: 'backend-navigator:feed-scroll',
            screens: ['reels_feed', 'profile', 'reels_tab'],
            view: arrived.view,
          });
          if (profile) {
            yield profile;
            produced += 1;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await backTo({ driver, read, pacingMs, jitterPx, wanted: ['reels_feed'], maxHops: 4 });
      }
    }

    if (cap && cap.spent()) return;

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
  clipsWanted = CLIPS_PER_PROFILE, log = () => {},
}) {
  const serp = await read(driver);
  const card = serp.targets && serp.targets[`reelResult:${reelIndex}`];
  if (!card) return null;
  await humanTap(driver, { x: card.x, y: card.y }, jitterPx, pacingMs);

  const feed = await read(driver);
  if (!feed.author || !feed.targets || !feed.targets.authorProfile) return null;
  // A brand's ad tells us nothing about a creator, and the account behind it is
  // not one we want in the campaign.
  if (feed.sponsored) {
    log('[sourcing] skipping a sponsored reel card');
    return null;
  }

  const arrived = await arriveAt({
    driver, read, pacingMs, jitterPx, log, what: `@${feed.author}`,
    wanted: ['profile', 'reels_tab'],
    act: () => humanTap(driver, feed.targets.authorProfile, jitterPx, pacingMs),
  });
  if (!arrived.ok) return null;

  return analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow, clipsWanted,
    fallbackUsername: feed.author,
    source: 'backend-navigator:reels-first',
    screens: ['reels_feed', 'profile', 'reels_tab'],
    view: arrived.view,
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
  reelsWindow = REELS_PER_PROFILE, recordClip = true, clipsWanted = CLIPS_PER_PROFILE,
  view: arrivedOn = null,
}) {
  // The caller that verified we reached this profile already read the screen;
  // reading it again is a round-trip to the phone for a picture we have.
  const header = arrivedOn || await read(driver);

  // Switch to Reels unless we are already there (IG sometimes opens a profile
  // on the Reels sub-tab, in which case reel overlays are already present).
  let view = header;
  const onReels = Array.isArray(header.reels) && header.reels.length;
  if (!onReels && header.targets && header.targets.reelsTab) {
    await humanTap(driver, header.targets.reelsTab, jitterPx, pacingMs);
    view = await read(driver);
  }

  // Read the whole reach window FIRST. Which reels are worth watching is a
  // question about the window as a whole — the best performer and the typical
  // one are only knowable once every view count is in — so recording has to come
  // after the scroll, not before it.
  const { reels, view: gridView } = await collectReels({
    driver, read, view, pacingMs, jitterPx, screen, want: reelsWindow,
  });

  // Then walk back UP the grid recording the chosen reels. Skipped entirely when
  // the caller already has a judged clip: reels mode records and judges the feed
  // reel before it ever opens the profile, and re-recording would spend another
  // stretch on the phone plus more Gemini calls to answer a settled question.
  const clips = recordClip
    ? await captureReelClips({
      driver, read, pacingMs, jitterPx, screen, clipSeconds, getClip,
      reels, want: clipsWanted, view: gridView,
    })
    : [];

  return {
    username: header.username || fallbackUsername,
    full_name: header.fullName || null,
    followers: header.followers ?? null,
    bio: header.bio || null,
    // `point` is a screen coordinate that stops meaning anything the moment we
    // scroll, so it never leaves this function.
    reels: reels.map(({ point, ...r }) => r), // eslint-disable-line no-unused-vars
    // The judge scores creative style and niche from the actual video + audio;
    // reelJudge picks these up automatically when present (services/reelJudge.js).
    // `clip` stays the single best one, because everything downstream that
    // predates multi-clip capture reads that field.
    clip: clips[0] || undefined,
    clips: clips.length ? clips : undefined,
    evidence: {
      capturedAt: new Date().toISOString(),
      screens,
      reelsRead: reels.length,
      clipCaptured: !!clips.length,
      clipsCaptured: clips.length,
      source,
    },
  };
}

/**
 * Which reels are worth watching: the two best performers plus one typical one.
 *
 * The best reels show what the creator can do; the typical one shows what they
 * usually do, and the gap between them is the whole "consistently performs vs
 * got one lucky hit" question. Picking only top performers would sample exactly
 * the reels that mislead.
 */
function pickClipTargets(reels, want = CLIPS_PER_PROFILE) {
  const withViews = (reels || []).filter((r) => r && Number.isFinite(Number(r.views)));
  if (!withViews.length || want < 1) return [];
  if (withViews.length <= want) return withViews.slice();

  const byViews = [...withViews].sort((a, b) => b.views - a.views);
  // Only room for top performers when fewer than two clips are wanted — there is
  // no gap to show with a single sample.
  if (want < 2) return byViews.slice(0, want);

  const best = byViews.slice(0, want - 1);

  // The median reel, by position in what is LEFT — not the reel closest to the
  // median VALUE, which on a skewed distribution is often another top performer.
  const chosen = new Set(best);
  const rest = byViews.filter((r) => !chosen.has(r));
  const typical = rest[Math.floor(rest.length / 2)];
  return typical ? [...best, typical] : best;
}

// Identity of a reel across screens. Deliberately NOT the tap point: the same
// reel sits at a different coordinate after every scroll, which is exactly why
// a reel has to be recognised by what it says rather than where it is.
function reelKey(r) {
  return `${r && r.views}|${(r && r.caption) || ''}`;
}

// Read reels off the grid, scrolling until we have REELS_PER_PROFILE or the
// grid stops producing new ones. De-duped on views+caption because a scroll
// overlaps the previous screen.
async function collectReels({ driver, read, view, pacingMs, jitterPx = 0, screen, want = REELS_PER_PROFILE }) {
  const size = screen || { width: 1080, height: 2400 };
  const target = Math.max(1, Number(want) || REELS_PER_PROFILE);
  const seen = new Map();
  let last = view;
  const absorb = (v) => {
    last = v;
    for (const r of Array.isArray(v && v.reels) ? v.reels : []) {
      const key = reelKey(r);
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
  // `view` is the grid as it stands now, handed on so the recording pass does
  // not pay for a screen read it already has.
  return { reels: Array.from(seen.values()).slice(0, target), view: last };
}

// Record ONE reel already on screen at `point` (video + audio), and come back to
// the grid. Best-effort throughout: a host without recordClip or a failed
// recording must never cost the reach data we already have.
async function recordAt({
  driver, point, pacingMs, jitterPx = 0, read = readView, clipSeconds = 12, getClip,
}) {
  if (!driver.recordClip || !point) return { clip: null, view: null };

  await humanTap(driver, point, jitterPx, pacingMs);
  let clip = null;
  try {
    const rec = await driver.recordClip(clipSeconds);
    const clipId = rec && (rec.clipId || rec);
    const stored = clipId ? await getClip(clipId) : null;
    // clipStore hands back { buf, mediaType }; reelJudge reads
    // { dataBase64, mimeType }. Attaching the store's record verbatim meant
    // classifyWithGemini saw no dataBase64, returned null, and every candidate
    // from this flow quietly fell through to the bio-text tier — the video was
    // recorded and uploaded, and then never judged.
    if (stored && stored.buf) {
      clip = {
        dataBase64: stored.buf.toString('base64'),
        mimeType: stored.mediaType || 'video/mp4',
      };
    } else if (stored && stored.dataBase64) {
      clip = stored;
    }
  } catch (_) {
    /* recording is enrichment, never a reason to drop the candidate */
  }
  // Back to the grid — but only as far as the grid, so a recording that never
  // opened the player does not press back out of the profile. The view it lands
  // on is handed back: it is the grid re-rendered, which is what the next reel
  // has to be located on.
  const view = await backTo({
    driver, read, pacingMs, jitterPx,
    wanted: ['reels_tab', 'profile'],
    maxHops: 2,
  });
  return { clip, view };
}

/**
 * Record the two best reels and one typical one.
 *
 * `collectReels` has just walked DOWN the grid, so this walks back UP it: a
 * reel's tap point stops meaning anything the moment the grid scrolls, so each
 * one is re-found by its view count on the screen it is currently on rather than
 * by a coordinate remembered from earlier. Reels already on screen when we
 * arrive are recorded before any scrolling happens.
 *
 * Every step is best-effort. Two clips, or one, or none still leaves the reach
 * window — which is the data the scoring rules actually gate on.
 */
async function captureReelClips({
  driver, read = readView, pacingMs, jitterPx = 0, screen, view: startView = null,
  clipSeconds = 12, getClip, reels = [], want = CLIPS_PER_PROFILE,
}) {
  if (!driver.recordClip) return [];
  const wanted = new Map(pickClipTargets(reels, want).map((r) => [reelKey(r), r]));
  if (!wanted.size) return [];

  const size = screen || { width: 1080, height: 2400 };
  const clips = [];
  let view = startView || await read(driver);

  // A reader that gives no tap points on a populated grid will not start giving
  // them out after a swipe, so scrolling to hunt for one is pure waste.
  const hasPoints = (v) => (Array.isArray(v && v.reels) ? v.reels : []).some((r) => r && r.point);
  if (!hasPoints(view)) return [];

  let lastSeen = '';
  for (let i = 0; i <= MAX_REEL_SCROLLS && wanted.size; i += 1) {
    // Record whatever we are looking for that is on screen right now. The grid
    // re-renders after each recording, so the view comes from coming BACK to the
    // grid rather than from a snapshot taken before we left it.
    for (let guard = 0; guard < want && wanted.size; guard += 1) {
      const onScreen = (Array.isArray(view.reels) ? view.reels : [])
        .find((r) => r && r.point && wanted.has(reelKey(r)));
      if (!onScreen) break;

      wanted.delete(reelKey(onScreen)); // consumed whether or not it records
      // eslint-disable-next-line no-await-in-loop
      const rec = await recordAt({
        driver, point: onScreen.point, pacingMs, jitterPx, read, clipSeconds, getClip,
      });
      if (rec.clip) clips.push({ ...rec.clip, views: onScreen.views });
      if (rec.view) view = rec.view;
    }
    if (!wanted.size) break;

    // Scroll back up towards the top of the grid, the reverse of the swipe
    // collectReels used to get here.
    // eslint-disable-next-line no-await-in-loop
    await driver.swipe({
      x1: Math.round(size.width / 2),
      y1: Math.round(size.height * 0.28),
      x2: Math.round(size.width / 2),
      y2: Math.round(size.height * 0.72),
      durationMs: 320,
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(jitteredDelay(pacingMs));
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);

    // Already at the top: the grid did not move, so another swipe will not
    // surface anything we have not already looked at.
    const fingerprint = (Array.isArray(view.reels) ? view.reels : []).map(reelKey).join(',');
    if (fingerprint === lastSeen) break;
    lastSeen = fingerprint;
  }

  // Best first, so `clip` (what everything predating multi-clip capture reads)
  // is the creator at their strongest.
  return clips.sort((a, b) => (b.views || 0) - (a.views || 0));
}

async function openAndCaptureProfile({
  driver, handle, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip, reelsWindow = REELS_PER_PROFILE,
  clipsWanted = CLIPS_PER_PROFILE, log = () => {},
}) {
  // Open the profile from the results list.
  const results = await read(driver);
  const link = results.targets && results.targets[`result:${handle}`];
  if (!link) return null;

  // Verify we arrived. A tap that lands on a sheet, or during a re-layout, does
  // nothing — and the analysis that followed used to read whatever screen we
  // were still on as though it were this creator's profile.
  const arrived = await arriveAt({
    driver, read, pacingMs, jitterPx, log, what: `@${handle}`,
    wanted: ['profile', 'reels_tab'],
    act: () => humanTap(driver, { x: link.x, y: link.y }, jitterPx, pacingMs),
  });
  if (!arrived.ok) return null;

  const profile = await analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow, clipsWanted,
    fallbackUsername: handle,
    source: 'backend-navigator',
    screens: ['profile', 'reels_tab'],
    view: arrived.view,
  });
  return { ...profile, username: handle };
}

/**
 * One back press.
 *
 * Order matters. The left-edge swipe used to be the fallback whenever the reader
 * found no on-screen Back affordance — but that swipe IS the system back
 * *gesture*, and Instagram's search results are horizontally paged, so it landed
 * as "next tab" and walked the scout through Accounts and Audio instead of going
 * back. A real BACK keypress is unambiguous, so it is preferred over the gesture
 * everywhere; the gesture survives only for a driver too old to have the op.
 */
async function pressBack({ driver, view, pacingMs, jitterPx = 0 }) {
  const t = view && view.targets && view.targets.back;
  if (t) {
    await humanTap(driver, { x: t.x, y: t.y }, jitterPx, pacingMs);
    return;
  }
  if (driver.back) {
    await driver.back();
    await sleep(jitteredDelay(pacingMs));
    return;
  }
  await driver.swipe({ x1: 5, y1: 400, x2: 200, y2: 400, durationMs: 250 });
  await sleep(jitteredDelay(pacingMs));
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
  // creator the same way (Reels tab -> scroll the grid -> record the reels
  // worth watching).
  analyseProfile,
  backTo,
  pickClipTargets,
  REELS_PER_PROFILE,
  CLIPS_PER_PROFILE,
};
