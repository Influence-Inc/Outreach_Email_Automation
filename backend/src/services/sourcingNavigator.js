'use strict';

// Server-side Instagram navigator — the brain, now on the backend.
//
// Same linear scout flow as the runner's navigator/instagram.js, but it runs
// HERE, driving a RemoteDriver (services/remoteDriver.js) over the command
// channel, and reads each screen via services/screenVision.readScreen in-process
// (no HTTP round-trip). Yields captured candidates the orchestrator scores.
//
//   openApp -> for each keyword: search tab -> type -> read results ->
//   for each reel result: open the reel -> (a) views from its likes and comments
//   -> (b) niche from the creator's own latest Reels -> (c) open the profile ->
//   read header -> open Reels -> read reels -> yield candidate -> back
//
// (a) and (b) come before the profile, the same order the feed phase uses
// (sourcingReelsNavigator.js): a creator whose reel is nowhere near viral, or
// whose Reels are off target, is never opened. See checkBeforeProfile.
//
// Every screen decision goes through `read(driver)` (default readView), so the
// navigator never hard-codes coordinates — taps come from the reader's targets.
// `read` is injectable so the flow is unit-testable without crafting UI trees.

const { readScreen } = require('./screenVision');
const { jitteredDelay, jitterTap } = require('./humanize');
const { normalizeTerms } = require('./searchTerms');
const { prefilter, reelViews } = require('./sourcingFilters');
const feedVirality = require('./feedVirality');
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

/**
 * Tap a target, then verify the screen actually changed the way it should have
 * — retrying once before giving up.
 *
 * Most of the navigator's state-changing taps already get this for free from
 * arriveAt (services/sourcingResilience.js), which checks the resulting
 * `screen` label. That check doesn't fit every case, though: switching a
 * profile onto its Reels sub-tab does not reliably change `screen` at all
 * (classifyScreen in screenVision.js keeps a header-bearing page classified as
 * 'profile' whichever sub-tab is active), so "did it work" has to be answered
 * from the content of the reading instead — this is that version of the same
 * idea, taking an arbitrary `expect(view)` predicate rather than a fixed list
 * of screen names.
 *
 * Never fatal: a tap that still doesn't verify after a retry returns
 * `ok:false` with whatever is actually on screen, so the caller can log it and
 * carry on with the real reading rather than one more way a run can throw.
 */
async function tapAndVerify({
  driver, target, expect, read, pacingMs, jitterPx = 0, log = () => {}, what = 'tap', attempts = 2,
}) {
  let view = null;
  for (let i = 1; i <= attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await humanTap(driver, target, jitterPx, pacingMs);
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);
    if (view.dialog) {
      // eslint-disable-next-line no-await-in-loop
      view = (await clearDialogs({ driver, read, view, pacingMs, jitterPx, log })).view;
    }
    if (expect(view)) return { ok: true, view };
    if (i < attempts) log(`[sourcing] ${what}: did not land as expected — retrying`);
  }
  log(`[sourcing] ${what}: still not as expected after ${attempts} taps — continuing with what's on screen`);
  return { ok: false, view };
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

// Most search terms one run may hold: the typed keywords and Gemini's
// suggestions together (services/searchTerms.js).
const MAX_RUN_TERMS = 40;

// How far a keyword's stored depth may grow.
//
// Depth persists per (campaign, keyword) so a re-run resumes instead of
// re-reading the top of a results page it has already worked. Unbounded, that
// compounds: the number grows on EVERY visit of every run, so run 20 opens by
// swiping twenty screens per keyword before it scouts anybody, and eventually a
// whole run is spent scrolling. Past this many screens a results page has
// nothing more to give a campaign anyway — start again from the top, where
// Instagram has since put fresh content.
const MAX_KEYWORD_DEPTH = 8;

// Extra reads of an empty results page while its grid loads.
const RESULTS_WAITS = 2;

// Safety bound on the scroll loop — a grid that stops yielding new reels exits
// earlier, this only caps a creator with a very long back catalogue.
const MAX_REEL_SCROLLS = 6;

// Safety bound on scrolling a reels FEED for creators. Generous, because the
// feed repeats accounts and dead reels (no author target) burn iterations
// without producing a candidate; the run's own target count stops it first.
const MAX_FEED_SCROLLS = 60;

// The results strip has been `All | Reels | Accounts | Audio | Tags | Places`,
// `For you | Accounts | Audio | Tags` and `Top | …` across builds. Reels, All,
// For you and Top lead with reels; the rest are songs, hashtags, places and
// handle-string matches.
const FOR_YOU_TABS = ['reels', 'all', 'for you', 'top'];

// Times the strip is dragged back toward its start looking for a content tab.
const MAX_STRIP_DRAGS = 2;

/**
 * Drag the results strip toward its START (finger left → right), where the
 * content tabs sit. Selecting Audio scrolls the strip so Audio is in view, which
 * can leave All and Reels off the left edge. This only ever moves toward the
 * content tabs — paging the other way is what once walked the scout from For you
 * into Accounts and Audio. Starts away from the edge, so it is never read as Back.
 */
async function dragStripToStart({ driver, view, screen, pacingMs }) {
  const at = view && view.targets && view.targets.serpTabStrip;
  if (!at || !driver.swipe) return false;
  const width = (screen && screen.width) || 1080;
  await driver.swipe({
    x1: Math.round(width * 0.2), y1: at.y, x2: Math.round(width * 0.9), y2: at.y, durationMs: 300,
  });
  await sleep(jitteredDelay(pacingMs));
  return true;
}

/**
 * Force the results page onto a reel-content tab (Reels, else All / For you /
 * Top) before anything is scouted.
 *
 * Instagram REMEMBERS the last-used search tab, so a fresh keyword search
 * regularly opens on Audio (a page of songs). Landing on Audio is normal, and it
 * must be corrected every time, not accepted because the page happens to have
 * rows on it.
 *
 *   1. already on a content tab → done
 *   2. a content tab in reach → tap it, re-read, tap once more if it didn't take
 *   3. none in reach → drag the strip back to its start and look again
 *
 * Returns { view, onForYou } — the caller must NOT scout results when onForYou
 * is false, or it sources songs and hashtags.
 */
async function openResultsReelsChip({
  driver, view, read, pacingMs, jitterPx = 0, screen = null, log = () => {},
}) {
  const forYouTab = (v) => v && v.targets && v.targets.forYouTab;
  const onForYou = (v) => v && FOR_YOU_TABS.includes(v.activeTab);
  const offTab = (v) => v && v.activeTab && !FOR_YOU_TABS.includes(v.activeTab);

  // Already on a content tab (the reader could read the selected tab and it is ours).
  if (onForYou(view)) return { view, onForYou: true };

  let current = view;
  for (let drags = 0; ; drags += 1) {
    const tab = forYouTab(current);
    if (tab) {
      log(`[sourcing] results landed on "${current.activeTab || 'an unknown tab'}" — switching to the reels tab`);
      let after = current;
      // A tap during the strip's own animation can miss; one retry.
      for (let tries = 0; tries < 2; tries += 1) {
        const target = forYouTab(after) || tab;
        // eslint-disable-next-line no-await-in-loop
        await humanTap(driver, target, jitterPx, pacingMs);
        // eslint-disable-next-line no-await-in-loop
        after = await read(driver);
        // Trust the switch when the reader cannot name the active tab: what
        // matters is that we tapped the content tab and did not stay on Audio.
        if (!offTab(after)) return { view: after, onForYou: true };
      }
      log(`[sourcing] still on "${after.activeTab}" after switching — not scouting it`);
      return { view: after, onForYou: false };
    }

    // No content tab to tap. A full-screen reels player has no strip at all, and
    // a reader that cannot tell the tab is given the benefit of the doubt.
    if (!offTab(current)) return { view: current, onForYou: true };

    // On Audio/Accounts/Tags with the content tabs scrolled out of reach.
    // eslint-disable-next-line no-await-in-loop
    if (drags >= MAX_STRIP_DRAGS || !await dragStripToStart({ driver, view: current, screen, pacingMs })) {
      log(`[sourcing] on "${current.activeTab}" with no reels tab in reach — skipping this keyword`);
      return { view: current, onForYou: false };
    }
    log(`[sourcing] on "${current.activeTab}" — dragging the tab strip back to find Reels / All`);
    // eslint-disable-next-line no-await-in-loop
    current = await read(driver);
    if (onForYou(current)) return { view: current, onForYou: true };
  }
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
  // Say "still working" even when nothing is being produced.
  //
  // The run's freshness is measured by updated_at, which only moves when a
  // candidate is YIELDED — and a re-run of a mature campaign legitimately yields
  // nothing for a long stretch, because cross-run dedupe skips everyone it has
  // already scouted. Each skip is only a few seconds, so a few hundred of them
  // in a row is fifteen minutes of correct work with no yields, which is exactly
  // the sweeper's definition of a dead run. Without this a healthy run gets
  // reaped for doing its job well.
  const heartbeat = deps.heartbeat || (() => {});
  // The niche judge run on a creator's latest Reels BEFORE their profile is
  // opened (checkBeforeProfile). Without one, only the views check runs there
  // and the orchestrator judges after the visit, as before.
  const judge = deps.judge || null;
  // The caller hands the previous creator's result back through `yield`: a
  // shortlisted creator is warmed right there, on the reel that surfaced them,
  // where the phone is still standing (services/creatorWarmup.js), and a result
  // carrying `stop` ends the scout — services/phoneFarm.js moving the account
  // to its next phase.
  const settle = async (outcome, handle) => {
    if (outcome && outcome.added && handle && deps.warmCreator) {
      await deps.warmCreator({ driver, read, handle, pacingMs, jitterPx, log });
    }
    return !!(outcome && outcome.stop);
  };

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
  //
  // Seeded with everyone this CAMPAIGN has scouted before (opts.alreadyScouted),
  // so the memory outlives the run. Without that seed a second run over the same
  // keywords re-walks the same top-of-page creators from scratch.
  const seenCreators = new Set(
    (opts.alreadyScouted || []).map((u) => String(u).toLowerCase()).filter(Boolean),
  );
  if (seenCreators.size) log(`[sourcing] starting with ${seenCreators.size} creators already scouted for this campaign`);

  // Results CARDS this run has already opened, across every keyword and pass.
  // Distinct from seenCreators: that is who we have scouted, this is which grid
  // tiles we have been into — the only thing knowable about a card before it is
  // tapped, and what lets a revisit scroll past a screenful it has already
  // worked through instead of re-opening every tile to rediscover the same
  // creators. Run-scoped, because a card's label is only meaningful against the
  // page as it stands today.
  const openedCards = new Set();

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
  // Seeded from what this CAMPAIGN has already read, not from zero. A results
  // page opens on the same popular accounts every time and dedupe now skips all
  // of them, so starting at 0 spent the opening minutes of every re-run
  // re-walking ground already covered before reaching anyone new.
  const startDepth = opts.keywordDepth || {};
  const depthOf = new Map(terms.map((t) => {
    // Clamp on the way IN as well: a campaign that ran before the ceiling
    // existed can have a stored depth of 30 sitting in the table.
    const stored = Number(startDepth[t]) || 0;
    return [t, Math.min(Math.max(0, stored), MAX_KEYWORD_DEPTH)];
  }));
  const saveDepth = deps.saveDepth || (async () => {});
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

    // Force the results onto a reels tab (Reels, else All / For you). IG remembers
    // the last-used tab, so a fresh search can open on Audio (songs) — sourcing from
    // there is meaningless, so if we cannot get onto a reels tab we skip the keyword
    // rather than scout the wrong tab.
    view = await read(driver);
    const onFor = await openResultsReelsChip({ driver, view, read, pacingMs, jitterPx, screen, log });
    view = onFor.view;
    if (!onFor.onForYou) {
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }

    // The grid loads after the tab does: a read straight after the search or the
    // tab tap can find an empty page (a spinner), and acting on it ended the
    // keyword with nothing tapped. Give it a moment and look again.
    for (let waits = 0; waits < RESULTS_WAITS && view.screen === 'search_results' && !hasResults(view); waits += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredDelay(pacingMs));
      // eslint-disable-next-line no-await-in-loop
      view = await read(driver);
    }
    if (view.screen !== 'reels_feed' && !hasResults(view)) {
      log(`[sourcing] "${term}": no reels to open — the results page read as "${view.screen}"`
        + `${view.activeTab ? ` on the "${view.activeTab}" tab` : ''}, with no reel cards or accounts on it`);
    }

    // The chip can land on either of two surfaces, so handle both.
    //
    // SURFACE A — a full-screen scrollable feed. There are no cards to tap by
    // index; creators are found by scrolling reel to reel, opening each one's
    // profile, and coming back to carry on scrolling.
    if (view.screen === 'reels_feed') {
      for await (const profile of scoutReelFeed({
        driver, read, pacingMs, jitterPx, screen, clipSeconds, getClip, reelsWindow, clipsWanted,
        remaining: max - emitted, seen: seenCreators, stall, cap, log, config,
        judge, term,
      })) {
        const outcome = yield tag(profile);
        if (await settle(outcome, profile && profile.username)) return;
        emitted += 1;
        if (emitted >= max) return;
      }
      await ensureInInstagram({ driver, read, pacingMs, jitterPx });
      continue;
    }

    // SURFACE B — a reels GRID (the Reels / All / For you tab). A reel proves the creator is actively
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

    // The top of a results page is the same cards on every visit. Opening one
    // costs a tap, a screen read, a hop into the player and a press back — and
    // when it turns out to be a creator this campaign already scouted, all of
    // that bought nothing. A grid card carries no handle, so "have we been here
    // before" can only be asked of the CARD; when every card in reach is one we
    // have already opened, there is provably nothing new on this screen, so
    // scroll past it instead of tapping through it.
    //
    // Bounded, and it stops the moment a scroll stops producing new cards — a
    // short results page must not turn this into a scrolling loop.
    for (let skips = 0; skips < MAX_SKIP_SCROLLS && everyCardOpened(view, openedCards); skips += 1) {
      log(`[sourcing] "${term}": every reel in reach was already opened — scrolling for new ones`);
      // eslint-disable-next-line no-await-in-loop
      const past = await scrollResults({ driver, read, pacingMs, screen, screens: 1 });
      if (!hasResults(past.view)) break;
      view = past.view;
    }

    const reelResults = Array.isArray(view.reelResults) ? view.reelResults : [];
    for (const rr of reelResults) {
      await heartbeat();
      if (emitted >= max) return;
      if (cap.spent()) return; // the run has looked at enough profiles
      const key = cardKey(rr);
      if (key) openedCards.add(key);
      const profile = await captureViaReel({
        driver, reelIndex: rr.index, pacingMs, jitterPx, read, screen, clipSeconds, getClip,
        reelsWindow, clipsWanted, log, config, seen: seenCreators, cap, term, judge,
      });
      // A grid card gives no handle until the reel is open — but once it IS open
      // the handle is known, and captureViaReel drops a creator we have already
      // scouted before it records or opens anything.
      const handle = profile && profile.username && String(profile.username).toLowerCase();
      if (profile && handle && !seenCreators.has(handle)) {
        seenCreators.add(handle);
        const outcome = yield tag(profile);
        if (await settle(outcome, handle)) return;
        emitted += 1;
      }
      // However deep this creator took us (reel player -> profile -> feed, and
      // their newest reel if warming had to open one), come back to the results
      // page — and no further.
      await backTo({ driver, read, pacingMs, jitterPx, wanted: SERP_SCREENS, maxHops: 5 });
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
        if (seenCreators.has(String(handle).toLowerCase())) { await heartbeat(); continue; }
        if (!cap.take()) return;
        seenCreators.add(String(handle).toLowerCase());
        const profile = await openAndCaptureProfile({
          driver, handle, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
          clipsWanted, log, config,
        });
        if (profile) {
          const outcome = yield tag(profile);
          if (await settle(outcome, profile.username || handle)) return;
          emitted += 1;
        }
        await backTo({ driver, read, pacingMs, jitterPx, wanted: SERP_SCREENS, maxHops: 5 });
      }
    }

    // Next time this keyword comes round, start one screen deeper — but wrap
    // back to the top rather than growing forever.
    //
    // `atEnd` means the page stopped moving: there is nothing below this, so a
    // deeper start next run would scroll to the same bottom and find the same
    // nobody. Both that and the ceiling reset to 0, because the top of a results
    // page a week later is genuinely different content.
    const nextDepth = (atEnd || depth + 1 >= MAX_KEYWORD_DEPTH) ? 0 : depth + 1;
    if (nextDepth === 0 && depth > 0) {
      log(`[sourcing] "${term}" reached ${atEnd ? 'the end of its results' : `the depth ceiling (${MAX_KEYWORD_DEPTH})`} — next run starts from the top`);
    }
    depthOf.set(term, nextDepth);
    // Persisted per keyword so the NEXT run starts here too, not just the next
    // pass of this one. Best-effort: a failed write only costs re-reading a
    // screen we have already read.
    try { await saveDepth(term, nextDepth); } catch (_) { /* depth is an optimisation */ }

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

// What a visible card SAYS, not where it sits — the UI tree carries no thumbnail
// pixels to hash, so this is a content fingerprint rather than a true image
// perceptual hash, but it plays the same role: recognising "I have seen this
// screen before" even when the exact page-level string does not repeat, because
// a swipe that only reshuffles the same handful of cards is still nowhere new.
function cardSignatures(v) {
  const reel = Array.isArray(v && v.reelResults) ? v.reelResults : [];
  if (reel.length) {
    return reel.map((r) => String((r && r.label) || '').trim().toLowerCase()).filter(Boolean);
  }
  const acc = Array.isArray(v && v.results) ? v.results : [];
  return acc.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
}

// How much two screens' cards overlap, 0-1, order-blind — a scroll that
// reshuffles the same cards into a new order is still the same screen for our
// purposes. Two screens with nothing listed on either (a genuinely empty
// results page) count as a full match: that is the same "stuck" signal an exact
// string match would have caught, and there is no card content left to compare.
function overlapRatio(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((x) => setB.has(x)).length;
  return shared / Math.max(a.length, b.length);
}

// This much of a screen's cards already seen counts as "going nowhere".
const LOOP_OVERLAP = 0.75;

// How many times a visit may scroll past a screenful of already-opened cards
// before it just works with what is in front of it.
const MAX_SKIP_SCROLLS = 3;

// What a results CARD says, as its identity. A grid card exposes no handle
// until it is opened, so this is the only way to recognise one we have already
// been into.
function cardKey(rr) {
  return String((rr && rr.label) || '').trim().toLowerCase();
}

/**
 * Is every card currently in reach one we have already opened?
 *
 * Deliberately ALL, not "the first couple": a page whose first two cards are
 * spent but whose third is new still has something worth having, and scrolling
 * past it would skip a creator we have never seen. An unlabelled card counts as
 * unknown — and therefore as not-yet-opened — so a reading the parser could not
 * make sense of never triggers a skip.
 */
function everyCardOpened(view, openedCards) {
  const cards = Array.isArray(view && view.reelResults) ? view.reelResults : [];
  if (!cards.length) return false;
  return cards.every((rr) => {
    const key = cardKey(rr);
    return key && openedCards.has(key);
  });
}

/**
 * Scroll a results page down by whole screens, to reach cards an earlier visit
 * already worked through.
 *
 * `atEnd` reports that the page stopped moving — the same cards came back after
 * a swipe, so there is nothing below this. That is what tells the caller a
 * keyword is genuinely finished rather than merely barren at this depth, and it
 * stops the run scrolling at the bottom of a short results page forever.
 *
 * A near-match (mostly the same cards, reshuffled) gets ONE bigger swipe before
 * that verdict — trying something different rather than repeating the exact
 * gesture that produced no progress, instead of settling for the first sign of
 * a loop.
 *
 * @returns {Promise<{view:(object|null), atEnd:boolean}>}
 */
async function scrollResults({ driver, read, pacingMs, screen, screens = 1 }) {
  const size = screen || { width: 1080, height: 2400 };
  const swipeOnce = async (fromFrac) => {
    await driver.swipe({
      x1: Math.round(size.width / 2),
      y1: Math.round(size.height * fromFrac),
      x2: Math.round(size.width / 2),
      y2: Math.round(size.height * 0.2),
      durationMs: 320,
    });
    await sleep(jitteredDelay(pacingMs));
    return read(driver);
  };

  let view = null;
  let atEnd = false;
  let prevCards = [];
  for (let i = 0; i < screens; i += 1) {
    const before = prevCards;
    // eslint-disable-next-line no-await-in-loop
    view = await swipeOnce(0.8);
    let cards = cardSignatures(view);

    // Only meaningful from the second swipe on, when there is a previous
    // reading to compare against.
    if (i > 0 && overlapRatio(cards, before) >= LOOP_OVERLAP) {
      // eslint-disable-next-line no-await-in-loop
      view = await swipeOnce(0.95);
      cards = cardSignatures(view);
      if (overlapRatio(cards, before) >= LOOP_OVERLAP) {
        atEnd = true;
        break;
      }
    }
    prevCards = cards;
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
  stall = null, cap = null, log = () => {}, config = {},
  judge = null, term = null,
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

    // (a) views from likes and comments, then (b) niche — before the profile.
    // eslint-disable-next-line no-await-in-loop
    const pre = !skip && link && feed.author && !(author && seen.has(author))
      ? await checkBeforeProfile({
        feed, judge, config, log, term, source: 'backend-navigator:feed-scroll', driver, getClip, clipSeconds,
      })
      : null;
    if (pre && pre.rejected) {
      seen.add(author);
      yield pre.rejected;
      produced += 1;
    } else if (pre && pre.go) {
      seen.add(author);
      if (!cap || cap.take()) {
        // Recording waits until the profile has been read — see captureViaReel
        // for why the cheapest place to reach a reel is the worst place to decide
        // it is worth recording.
        //
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
          const profile = withPreChecks(await analyseThenRecordSource({
            driver, pacingMs, jitterPx, read, screen: size, clipSeconds, getClip, reelsWindow, clipsWanted,
            fallbackUsername: feed.author || null,
            source: 'backend-navigator:feed-scroll',
            screens: ['reels_feed', 'profile', 'reels_tab'],
            view: arrived.view,
            config, log,
            caption: feed.caption || null,
            recorded: pre.clip || null,
          }), pre);
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

/**
 * What is decided on a creator's reel BEFORE their profile is opened — the same order,
 * and the same checks, as the feed phase (sourcingReelsNavigator.js):
 *
 *   (a) VIRALITY  the reel's views, estimated from the likes and comments the player
 *                 shows (services/feedVirality.js). A reel nowhere near the viral bar is
 *                 passed over; the creator is not marked as scouted, so another of their
 *                 reels gets its own chance.
 *   (b) THE REEL  recorded right here in the player (12 s, with sound), then heard
 *                 (Whisper), seen (GPT-6 Luna) and labelled (Jev) for topic, niche, genre
 *                 and format (jevJudge.judgeReel). A reel Jev places off target ends the
 *                 creator here: the profile is never opened.
 *
 * Returns { go: true, verdict, feedViews, clip } to open the profile; { go: false } to
 * pass over this reel; or { go: false, rejected } with a candidate to hand on, so the
 * rejection is recorded like any other.
 */
async function checkBeforeProfile({
  feed, judge = null, config = {}, log = () => {}, term = null, source,
  driver = null, getClip = async () => null, clipSeconds = 12,
}) {
  const fv = feedVirality.check(
    { likes: feed.likes, comments: feed.comments, views: feed.views },
    { viralViews: config.viralViews },
  );
  if (!fv.pass) {
    log(`[sourcing] skipping @${feed.author}: their reel has ${fv.reason}`);
    return { go: false };
  }
  const feedViews = fv.estimate ? { ...fv.estimate, reason: fv.reason } : null;

  // Record the reel the phone is standing on: the video that led to this creator.
  let clip = null;
  if (driver && driver.recordClip) {
    try {
      const rec = await driver.recordClip(clipSeconds);
      const resolved = await resolveClip(rec, getClip);
      clip = resolved.clip ? { ...resolved.clip, origin: 'keyword-match' } : null;
      if (!clip) log(`[sourcing] @${feed.author}: recording failed — judging the reel from its caption: ${resolved.reason}`);
    } catch (err) {
      log(`[sourcing] @${feed.author}: recording failed — judging the reel from its caption: ${err.message}`);
    }
  }
  if (!judge) return { go: true, verdict: null, feedViews, clip };

  let verdict = null;
  try {
    verdict = await judge({
      username: feed.author,
      caption: feed.caption || null,
      discovery: 'search',
      ...(clip ? { clip } : {}),
      ...(term ? { sourceTerm: term } : {}),
    }, config);
  } catch (err) {
    // A check that could not run is not a rejection: open the profile, and the
    // orchestrator judges them as it always has.
    log(`[sourcing] @${feed.author}: the reel could not be judged (${err.message}) — opening the profile anyway`);
  }
  const jev = verdict && verdict.source === 'jev' ? verdict : null;
  if (jev && jev.evidence && jev.evidence.jev && jev.evidence.jev.decision === 'reject') {
    log(`[sourcing] @${feed.author}: the reel that surfaced them is off target — profile not opened`);
    return {
      go: false,
      rejected: {
        username: feed.author,
        reels: feed.caption ? [{ caption: feed.caption }] : [],
        engagement: (feed.likes != null || feed.comments != null || feed.views != null)
          ? { likes: feed.likes ?? null, comments: feed.comments ?? null, views: feed.views ?? null }
          : undefined,
        ...(clip ? { clip } : {}),
        evidence: {
          capturedAt: new Date().toISOString(),
          source,
          profileVisit: 'skipped',
          clipCaptured: !!clip,
          ...(feedViews ? { feedViews } : {}),
        },
        // "Already judged — do not judge again" (jevJudge.makeClassifier).
        _nicheVerdict: jev,
      },
    };
  }
  return { go: true, verdict: jev, feedViews, clip };
}

/** Carry what was learnt before the profile visit onto its result. */
function withPreChecks(profile, pre) {
  if (!profile) return profile;
  // The verdict on the reel that surfaced them: the creator-level judgement after the
  // profile (jevJudge.judge) builds on it rather than labelling that reel again.
  if (pre.verdict) profile.sourceReelVerdict = pre.verdict;
  if (pre.clip) {
    profile.clip = profile.clip || pre.clip;
    profile.clips = profile.clips && profile.clips.length ? profile.clips : [pre.clip];
    // Recorded before the profile, whatever the profile visit then found.
    profile.evidence = {
      ...profile.evidence, clipCaptured: true, clipsCaptured: 1, clipSource: 'keyword-match',
    };
  }
  if (pre.feedViews) profile.evidence = { ...profile.evidence, feedViews: pre.feedViews };
  return profile;
}

// Reels-first capture: tap a reel card on the SERP -> read @handle from the
// reels_feed -> tap the author to open their profile -> read header + reels.
// Returns null if any hop lost its tap target (search UI drift); the outer loop
// then just moves on to the next reel card.
async function captureViaReel({
  driver, reelIndex, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip, reelsWindow = REELS_PER_PROFILE,
  clipsWanted = CLIPS_PER_PROFILE, log = () => {}, config = {},
  seen = null, cap = null, term = null, judge = null,
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

  // The handle is knowable HERE — one tap and one screen read in — and everything
  // after this point is expensive: a 12-second recording, the hop to the profile,
  // scrolling the grid, and a multimodal judgement. This check used to happen on
  // the way out instead, so a creator we had already scouted cost the entire
  // capture before being thrown away. Overlapping keywords hit this constantly:
  // the same popular accounts head the results for every one of them.
  if (seen && seen.has(String(feed.author).toLowerCase())) {
    log(`[sourcing] @${feed.author} already scouted${term ? ` (surfaced again by "${term}")` : ''} — skipping before the recording`);
    return null;
  }

  // (a) views from likes and comments, then (b) niche — before the profile.
  const pre = await checkBeforeProfile({
    feed, judge, config, log, term, source: 'backend-navigator:reels-first', driver, getClip, clipSeconds,
  });
  if (pre.rejected) return { ...pre.rejected, sourceTerm: term };
  if (!pre.go) return null;

  // Opening a profile is what the run's profile budget actually counts, so it is
  // spent here rather than on every card we merely glance at.
  if (cap && !cap.take()) return null;

  // Deliberately NOT recording yet.
  //
  // This reel IS the one we record — the one the keyword surfaced, which is what
  // Jev labels — but not before the creator's views have been read. Their view
  // counts are one screen away and most creators fail on them, so the profile is
  // read first and the recording only happens, back in this player, for a
  // creator who cleared the views benchmark. See analyseThenRecordSource.

  const arrived = await arriveAt({
    driver, read, pacingMs, jitterPx, log, what: `@${feed.author}`,
    wanted: ['profile', 'reels_tab'],
    act: () => humanTap(driver, feed.targets.authorProfile, jitterPx, pacingMs),
  });
  if (!arrived.ok) return null;

  return withPreChecks(await analyseThenRecordSource({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow, clipsWanted,
    fallbackUsername: feed.author,
    source: 'backend-navigator:reels-first',
    screens: ['reels_feed', 'profile', 'reels_tab'],
    view: arrived.view,
    config, log,
    sourceTerm: term,
    caption: feed.caption || null,
    recorded: pre.clip || null,
  }), pre);
}

/**
 * Read the creator's profile, and — only if their views cleared the benchmark —
 * go back to the reel that surfaced them and record THAT reel.
 *
 * The scouting flow is: search a keyword, open a reel, check the creator's views,
 * reject below the benchmark, and otherwise record the reel we found them
 * through. Its audio goes to Groq and its frames are read for on-screen text,
 * and Jev labels the topic, genre and format from them (services/jevJudge.js).
 * Nothing from the creator's own grid is recorded any more: one reel, the one
 * the search matched, is what gets judged.
 */
async function analyseThenRecordSource({ caption = null, recorded = null, ...opts }) {
  const profile = await analyseProfile({ ...opts, recordClip: false });
  if (!profile) return profile;
  profile.sourceReel = { caption: caption || null };
  if (caption && !profile.caption) profile.caption = caption;
  // Below the views benchmark: nothing to record.
  if (profile.evidence && profile.evidence.notRecorded) return profile;

  const handle = String(profile.username || opts.fallbackUsername || '').toLowerCase();
  // Recorded already, before the profile (checkBeforeProfile): go back to the reel for its
  // likes and comments — and so a shortlisted creator's like lands on it — but do not
  // record it again.
  const { recordClip: _again, ...noRecorder } = opts.driver || {};
  const rec = await recordSourceReel({
    driver: recorded ? noRecorder : opts.driver,
    read: opts.read || readView,
    pacingMs: opts.pacingMs,
    jitterPx: opts.jitterPx || 0,
    clipSeconds: opts.clipSeconds,
    getClip: opts.getClip || (async () => null),
    log: opts.log || (() => {}),
    author: handle,
  });
  const got = rec.clip || recorded;
  if (got) {
    const clip = { ...got, views: rec.engagement ? rec.engagement.views : (got.views ?? null), origin: 'keyword-match' };
    profile.clip = clip;
    profile.clips = [clip];
  }
  if (rec.engagement && !profile.engagement) {
    profile.engagement = totalEngagement([rec.engagement]) || undefined;
  }
  profile.evidence = {
    ...profile.evidence,
    clipCaptured: !!got,
    clipsCaptured: got ? 1 : 0,
    clipSource: got ? 'keyword-match' : null,
    notRecorded: got ? undefined : rec.reason,
  };
  return profile;
}

/**
 * Back from the profile to the reel player we came from, check it is still this
 * creator's reel, read its likes and comments, and — when `driver` can record —
 * record it. Returns { clip, engagement, reason }.
 *
 * The warm-up records the reel BEFORE the profile (checkBeforeProfile) and calls
 * this with a driver that cannot record: the phone still goes back to the reel,
 * for its likes and comments and so that a shortlisted creator's like lands on
 * the reel that surfaced them.
 */
async function recordSourceReel({
  driver, read = readView, pacingMs, jitterPx = 0, clipSeconds = 12, getClip, log = () => {}, author,
}) {
  const view = await backTo({ driver, read, pacingMs, jitterPx, wanted: ['reels_feed'], maxHops: 3 });
  if (!view || view.screen !== 'reels_feed') {
    log(`[sourcing] @${author}: could not get back to the reel that surfaced them`);
    return { clip: null, engagement: null, reason: 'could not get back to the source reel' };
  }
  if (view.author && author && String(view.author).toLowerCase() !== author) {
    log(`[sourcing] @${author}: the player now shows @${view.author} — not their reel`);
    return { clip: null, engagement: null, reason: 'the source reel was no longer on screen' };
  }
  // The player is the only screen with likes and comments; read them while here.
  const engagement = (view.likes != null || view.comments != null || view.views != null)
    ? { likes: view.likes ?? null, comments: view.comments ?? null, views: view.views ?? null }
    : null;
  if (!driver.recordClip) return { clip: null, engagement, reason: 'not recorded — judged from their Reels' };
  try {
    const resolved = await resolveClip(await driver.recordClip(clipSeconds), getClip);
    if (!resolved.clip) log(`[sourcing] recording failed — judging without video: ${resolved.reason}`);
    return { clip: resolved.clip, engagement, reason: resolved.clip ? null : resolved.reason };
  } catch (err) {
    const why = (err && err.message) || String(err);
    log(`[sourcing] recording failed — judging without video: ${why}`);
    return { clip: null, engagement, reason: `recording failed: ${why}` };
  }
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
  view: arrivedOn = null, sourceClip = null, sourceTerm = null,
  // Open one reel purely to read its like/comment counts when nothing else on
  // this visit will. Off by default because the search flow already gets them
  // free from the reels it records; feed mode turns it on, since it records on
  // the feed and would otherwise collect none at all.
  sampleEngagement = false,
  // `log` is not optional in practice. Every call site used to leave it
  // defaulted, so analyseProfile's logging — "not recording", and the recording
  // failures that explain a run judging everyone on bio text — went to a no-op
  // and profiles mode looked silent no matter what went wrong on the phone.
  config = {}, log = () => {},
}) {
  // The caller that verified we reached this profile already read the screen;
  // reading it again is a round-trip to the phone for a picture we have.
  const header = arrivedOn || await read(driver);

  // Switch to Reels unless we are already there (IG sometimes opens a profile
  // on the Reels sub-tab, in which case reel overlays are already present).
  //
  // Verified, not just trusted: a tap that lands on a sheet or during a
  // re-layout used to be assumed to have worked, and the grid read that
  // followed could silently still be the Posts tab — no view counts, the exact
  // shape of the bug that used to slip creators past the reach gate on stale
  // data. One retry covers the common case (a sheet arriving on top of the
  // tap); giving up after that still leaves `view` as whatever is really on
  // screen, so nothing downstream is fed a stale reading.
  let view = header;
  const onReels = Array.isArray(header.reels) && header.reels.length;
  if (!onReels && header.targets && header.targets.reelsTab) {
    const switched = await tapAndVerify({
      driver, read, pacingMs, jitterPx, log,
      target: header.targets.reelsTab,
      expect: (v) => Array.isArray(v.reels) && v.reels.length > 0,
      what: `@${header.username || fallbackUsername || '?'}: reels tab`,
    });
    view = switched.view;
  }

  // The grid at its top — the creator's most recent work, as a picture. Taken
  // before the scroll, so it frames what they post now rather than wherever the
  // reach window happened to stop.
  //
  // The VIEWS come first, and everything else waits on them. A creator's reach
  // is the one thing on this screen that is free to read and fatal to fail, so
  // it is read and judged before a single further round-trip is spent.
  const gridShot = await grabShot({ driver, kind: 'reels_grid' });

  // ── the first look at reach, on what is visible right now ─────────────────
  //
  // The floor is normally absolute (floorTolerance 0), which means ONE reel
  // below it disqualifies the creator — and if a reel on the very first screen
  // is already under, no amount of scrolling can rescue them. Checking here
  // skips the rest of the grid scroll, the bio screenshot,
  // the recording and the judgement, for a creator who was never eligible.
  //
  // Deliberately only when the floor really is absolute: a campaign that set a
  // tolerance is saying some reels MAY sit below, and that question can only be
  // answered once the whole window is in.
  const topReels = (Array.isArray(view.reels) ? view.reels : [])
    .map(({ point, ...r }) => r); // eslint-disable-line no-unused-vars
  const earlyReason = earlyFloorReject(topReels, config);

  // What the bio actually looks like. Taken AFTER the reach check, so a creator
  // whose views already disqualified them never costs this round-trip — the
  // grid is still at its top here, where the profile header is on screen.
  const bioShot = earlyReason ? null : await grabShot({ driver, kind: 'bio' });

  // Read the whole reach window. Which reels are worth watching is a question
  // about the window as a whole — the best performer and the typical one are
  // only knowable once every view count is in — so recording has to come after
  // the scroll, not before it. Skipped entirely when the first screen already
  // settled it.
  const collected = earlyReason
    ? { reels: topReels, view }
    : await collectReels({
      driver, read, view, pacingMs, jitterPx, screen, want: reelsWindow,
    });
  const { reels, view: gridView } = collected;

  // ── the gate, before anything expensive ───────────────────────────────────
  //
  // Everything above this line is free: the view counts, follower count and bio
  // came out of the accessibility tree we were reading anyway. Everything below
  // costs real money and real seconds on the phone — a recording, an upload, a
  // multimodal model call.
  //
  // The same deterministic prefilter the backend runs, run HERE instead, so a
  // creator whose reach disqualifies them is dropped before a single frame is
  // recorded. The backend still re-runs it and does the bookkeeping; this just
  // means it reaches that point with nothing costly attached.
  const window = reels.map(({ point, ...r }) => r); // eslint-disable-line no-unused-vars
  let skipReason = earlyReason;
  if (!skipReason) {
    const pre = prefilter({ reels: window, followers: header.followers }, config);
    skipReason = pre.pass ? null : pre.rejectReason;
  }

  if (skipReason) {
    log(`[sourcing] @${header.username || fallbackUsername || '?'}: ${skipReason} — not recording`);
  }

  // The reel that surfaced this creator is already the most keyword-relevant
  // sample there is, so when we have it we do NOT go back down the grid
  // recording three more. That was three extra recordings and three extra Gemini
  // calls per creator to answer a question the search itself already answered,
  // and every one of them was another stretch of the phone being driven.
  let clips;
  let engagements = [];
  if (sourceClip) {
    // A clip the caller already recorded. The gate exists to avoid SPENDING, not
    // to discard what has already been spent — throwing this away would lose the
    // judge its best evidence and save nothing.
    clips = [sourceClip];
  } else if (skipReason) {
    clips = [];
  } else if (recordClip) {
    const captured = await captureReelClips({
      driver, read, pacingMs, jitterPx, screen, clipSeconds, getClip,
      reels, want: clipsWanted, view: gridView, log,
    });
    clips = captured.clips;
    engagements = captured.engagements;
  } else {
    clips = [];
  }

  // FEED MODE'S ONLY WAY TO GET THE RATIO.
  //
  // There the reel is recorded on the feed, so nothing above ever opened one
  // from the grid and no counts were collected — which left the bought-views
  // check with a view count and no reactions to weigh it against, i.e. inert on
  // exactly the discovery mode that most needs it. Opening one representative
  // reel costs a tap, a read and a back press, and only happens when we have
  // nothing already and the creator is still in the running.
  if (sampleEngagement && !engagements.length && !skipReason) {
    const target = pickEngagementSample(reels);
    if (target) {
      const sampled = await sampleEngagementAt({
        driver, read, point: target.point, gridViews: target.views, pacingMs, jitterPx,
      });
      if (sampled) engagements.push(sampled);
      else log(`[sourcing] @${header.username || fallbackUsername || '?'}: no engagement counts on the reel player`);
    }
  }

  const shots = [bioShot, gridShot].filter(Boolean);

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
    // Pixels of the bio and the reels grid. The judge reads these alongside the
    // captions and the example reel (services/reelJudge.js).
    shots: shots.length ? shots : undefined,
    // Likes, comments and views totalled across the reels we actually opened —
    // the numbers creatorScore compares to catch bought reach. Search mode never
    // carried these before, so every engagement check was inert on the default
    // discovery path.
    engagement: totalEngagement(engagements) || undefined,
    evidence: {
      capturedAt: new Date().toISOString(),
      screens,
      reelsRead: reels.length,
      clipCaptured: !!clips.length,
      clipsCaptured: clips.length,
      shotsCaptured: shots.map((s) => s.kind),
      // Which reel the video actually is: the one the keyword surfaced, or a
      // sample picked off the creator's own grid.
      clipSource: sourceClip ? 'keyword-match' : (clips.length ? 'profile-grid' : null),
      // Why nothing was recorded, when nothing was. Reaches the dashboard as
      // part of the candidate's evidence.
      notRecorded: skipReason || undefined,
      sourceTerm: sourceTerm || undefined,
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

// clipStore hands back { buf, mediaType }; the judge reads { dataBase64,
// mimeType }. Attaching the store's record verbatim meant classifyWithGemini saw
// no dataBase64 and every candidate quietly fell through to the bio-text tier —
// recorded and uploaded, then never judged.
function toClip(stored) {
  if (!stored) return null;
  if (stored.buf) return { dataBase64: stored.buf.toString('base64'), mimeType: stored.mediaType || 'video/mp4' };
  if (stored.dataBase64) return stored;
  return null;
}

/**
 * A picture of the screen as it stands, labelled.
 *
 * The UI tree says what text is on a profile; it cannot say what the profile
 * LOOKS like — whether the grid is a person on camera or a wall of reposted
 * memes, whether the bio reads as a real creator. That judgement needs pixels,
 * so the judge gets two of them per creator. Best-effort: a host too old to have
 * the op, or a failed capture, just means the judge works from text and video.
 */
// Sourcing screenshots are asked for as downscaled JPEG, not the full-resolution
// PNG the op returns by default.
//
// A q100 PNG of a 1080x2400 screen runs to megabytes, and two ride along with
// every creator — comparable to the reel video itself. The judge is answering
// "is this person a runner or a chef", which 720px settles as well as 1080p, so
// the extra pixels were pure upload. An agent too old to understand the request
// simply returns the PNG and everything still works.
const SHOT_ARGS = { format: 'jpeg', maxWidth: 720, quality: 70 };

/** The shots taken so far, for a gate that runs before the final list is built. */
function shotsSoFar(...shots) {
  return shots.filter(Boolean);
}

/**
 * Total the per-reel engagement readings into one set of counts.
 *
 * Summing rather than averaging, because the ratio taken from the totals is
 * naturally weighted by reach — the reels with the most views dominate it, and
 * those are exactly the ones bought views show up on. Averaging per-reel ratios
 * would let a healthy 400-view reel cancel out a bought 500,000-view one.
 *
 * Only reels whose VIEW count was actually read contribute: a reel with likes
 * but no view count cannot take part in a views-based ratio, and letting its
 * likes into the numerator while its views stayed out of the denominator would
 * invent engagement that is not there. Returns null when nothing qualified, so
 * the checks downstream see "unmeasured" rather than a zero.
 */
function totalEngagement(readings) {
  const usable = (readings || []).filter((e) => {
    const v = Number(e && e.views);
    return Number.isFinite(v) && v > 0;
  });
  if (!usable.length) return null;

  let views = 0;
  let likes = null;
  let comments = null;
  for (const e of usable) {
    views += Number(e.views);
    if (e.likes != null && Number.isFinite(Number(e.likes))) likes = (likes || 0) + Number(e.likes);
    if (e.comments != null && Number.isFinite(Number(e.comments))) {
      comments = (comments || 0) + Number(e.comments);
    }
  }
  // Views alone prove nothing about authenticity — the reactions are the signal.
  if (likes == null && comments == null) return null;
  return { likes, comments, views };
}

/**
 * Can this creator already be ruled out from the reels visible right now?
 *
 * The view floor is normally ABSOLUTE — `floorTolerance` defaults to 0, so one
 * reel below the floor disqualifies the creator outright. When that is the
 * rule, a below-floor reel on the very first screen of the grid is already the
 * whole answer, and scrolling the rest of the window, screenshotting the bio,
 * and recording a clip are all spent proving something
 * settled several round-trips ago.
 *
 * Returns a reject reason, or null to carry on reading the full window.
 *
 * Deliberately narrow. It only fires when:
 *   - a floor is actually configured, and
 *   - the campaign did NOT buy itself slack with a floorTolerance (any
 *     tolerance means some reels are allowed under, which cannot be judged
 *     until the whole window is in), and
 *   - at least one view count was actually read (an empty or unreadable first
 *     screen is not evidence of anything).
 */
function earlyFloorReject(reels, config = {}) {
  const floor = Number(config.floor);
  if (!Number.isFinite(floor) || floor <= 0) return null;
  if (Number(config.floorTolerance) > 0) return null;

  const views = reelViews(reels);
  if (!views.length) return null;

  const below = views.filter((v) => v < floor).length;
  if (!below) return null;
  return `${below} of the first ${views.length} reels below floor ${floor}`;
}

async function grabShot({ driver, kind }) {
  if (!driver.screenshot) return null;
  try {
    const shot = await driver.screenshot(SHOT_ARGS);
    if (!shot || !shot.dataBase64) return null;
    return { kind, mimeType: shot.mediaType || 'image/png', dataBase64: shot.dataBase64 };
  } catch (_) {
    return null; // enrichment, never a reason to drop a candidate
  }
}

/**
 * Record the reel that is already playing.
 *
 * This is THE reel that matched the keyword — the one whose presence in the
 * results is the reason we are looking at this creator at all — so it is the
 * most relevant possible sample of their work for the search we ran. Recording
 * it here, in the player we already stand in, also costs nothing extra to reach.
 */
// Record ONE reel already on screen at `point` (video + audio), and come back to
// the grid. Best-effort throughout: a host without recordClip or a failed
// recording must never cost the reach data we already have.
async function recordAt({
  driver, point, pacingMs, jitterPx = 0, read = readView, clipSeconds = 12, getClip,
  log = () => {},
}) {
  if (!driver.recordClip || !point) return { clip: null, view: null };

  await humanTap(driver, point, jitterPx, pacingMs);

  // The player is open, which is the ONLY screen carrying likes and comments —
  // the grid has view counts and nothing else. Reading it here is what gives
  // search mode an engagement signal at all; before this, candidate.engagement
  // was never set outside reels mode, so every fraud check that depends on it
  // was silently inert on the default discovery path.
  //
  // One extra screen read per recorded reel, on a screen we are standing on
  // anyway, and entirely best-effort: a failed read leaves the counts null,
  // which every downstream check reads as "unmeasured" rather than as zero.
  let engagement = null;
  try {
    const player = await read(driver);
    if (player && (player.likes != null || player.comments != null || player.views != null)) {
      engagement = {
        likes: player.likes ?? null,
        comments: player.comments ?? null,
        views: player.views ?? null,
      };
    }
  } catch (_) {
    /* enrichment only — never a reason to lose the recording */
  }

  let clip = null;
  try {
    const rec = await driver.recordClip(clipSeconds);
    // clipStore hands back { buf, mediaType }; reelJudge reads
    // { dataBase64, mimeType }. Attaching the store's record verbatim meant
    // classifyWithGemini saw no dataBase64, returned null, and every candidate
    // from this flow quietly fell through to the bio-text tier — the video was
    // recorded and uploaded, and then never judged.
    const resolved = await resolveClip(rec, getClip);
    clip = resolved.clip;
    // A recording that came back with nothing usable is the same outcome as one
    // that threw, and it used to be the quiet one. Same wording, so one grep
    // finds every creator judged without video whatever the cause.
    if (!clip) log(`[sourcing] recording failed — judging without video: ${resolved.reason}`);
  } catch (err) {
    // Still not fatal — but no longer silent. A recorder that fails EVERY time
    // (screen capture not granted on the phone is the usual cause) is
    // indistinguishable, from the outside, from a scout that simply never
    // watches anything: the candidate is judged on bio text and the reel appears
    // to have been skipped. Say so, once per attempt.
    log(`[sourcing] recording failed — judging without video: ${(err && err.message) || err}`);
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
  return { clip, view, engagement };
}

/**
 * Turn a `recordClip` result into bytes the judge can actually read.
 *
 * Returns `{ clip, reason }` with exactly one of them set. `reason` is why there
 * is no video, IN WORDS, because until now every way of ending up without one
 * was silent: the phone recorded, the upload succeeded, and the backend then
 * quietly judged on bio text with nothing written to the log. Two paths did it.
 *
 *   - The agent's `uploadClip` ends in `json.optString("clipId", "")`, so a
 *     response missing the id hands back an EMPTY STRING. That is falsy, so the
 *     old `rec.clipId || rec` fell through to the whole result object, which is
 *     not a key in the clip store, so the lookup missed and returned null.
 *   - A clip genuinely not in the store — expired, evicted, or the backend
 *     restarted between the upload and the take.
 *
 * Neither threw, so neither reached the catch that does the logging. "Screen
 * capture is not granted" was therefore never the only explanation for a run
 * that watches reels and judges everyone on text — it was just the only one
 * that said anything.
 */
async function resolveClip(rec, getClip) {
  if (!rec) return { clip: null, reason: 'the agent returned nothing for the recording' };
  const clipId = typeof rec === 'string' ? rec : rec.clipId;
  if (!clipId) {
    return { clip: null, reason: 'the agent recorded but returned no clip id — the upload to /clip most likely failed' };
  }
  const stored = await getClip(clipId);
  if (!stored) {
    return { clip: null, reason: `${clipId} was not in the clip store (expired, evicted, or the backend restarted mid-recording)` };
  }
  if (stored.buf) {
    return {
      clip: { dataBase64: stored.buf.toString('base64'), mimeType: stored.mediaType || 'video/mp4' },
      reason: null,
    };
  }
  if (stored.dataBase64) return { clip: stored, reason: null };
  return { clip: null, reason: `${clipId} was in the store but held no bytes` };
}

/**
 * Which reel to open when all we want is its like and comment counts.
 *
 * The TYPICAL reel by view count, deliberately — not the best one. A genuinely
 * viral reel reaches far past the creator's own audience, picking up a mass of
 * passive viewers who never react, so its like-to-view ratio is naturally the
 * WORST one they have. Sampling it would systematically read real hits as
 * bought reach, which is the exact false positive this whole check has to avoid.
 * The median reel is what the creator normally does, and a creator who buys
 * reach systematically shows it there too.
 *
 * Only reels we can both tap and price qualify — a tap point with no view count
 * gives half a ratio, which is no ratio at all.
 */
function pickEngagementSample(reels) {
  const usable = (reels || []).filter(
    (r) => r && r.point && Number.isFinite(Number(r.views)),
  );
  if (!usable.length) return null;
  const byViews = [...usable].sort((a, b) => Number(a.views) - Number(b.views));
  return byViews[Math.floor(byViews.length / 2)];
}

/**
 * Open ONE reel purely to read its like and comment counts, then come straight
 * back to the grid. No recording.
 *
 * This is what makes the bought-views check work in FEED mode. There, the reel
 * is recorded on the feed and the profile visit never opens anything from the
 * grid — so the counts and the view numbers stayed on separate screens and the
 * ratio between them could never be taken. One tap, one read and one back press
 * per creator buys the whole signal.
 *
 * `gridViews` is the view count the grid already gave for THIS reel, used when
 * the player does not carry one of its own (which, on every build captured so
 * far, it does not). That pairing is the entire point: same reel, both halves.
 */
async function sampleEngagementAt({
  driver, read = readView, point, gridViews = null, pacingMs, jitterPx = 0,
}) {
  if (!point) return null;
  await humanTap(driver, point, jitterPx, pacingMs);

  let sampled = null;
  try {
    const player = await read(driver);
    // Reactions are the signal; a player read that produced neither tells us
    // nothing, and pairing "no likes" with a real view count would invent
    // fraud rather than measure it.
    if (player && (player.likes != null || player.comments != null)) {
      sampled = {
        likes: player.likes ?? null,
        comments: player.comments ?? null,
        views: player.views ?? gridViews ?? null,
      };
    }
  } catch (_) {
    /* enrichment only — never a reason to lose the creator */
  }

  await backTo({
    driver, read, pacingMs, jitterPx, wanted: ['reels_tab', 'profile'], maxHops: 2,
  });
  return sampled;
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
  clipSeconds = 12, getClip, reels = [], want = CLIPS_PER_PROFILE, log = () => {},
}) {
  const nothing = { clips: [], engagements: [] };
  if (!driver.recordClip) return nothing;
  const wanted = new Map(pickClipTargets(reels, want).map((r) => [reelKey(r), r]));
  if (!wanted.size) return nothing;

  const size = screen || { width: 1080, height: 2400 };
  const clips = [];
  // The like / comment / view counts each opened player showed, one per reel we
  // went into. Collected here because the player is the only screen that has
  // them and we are already standing on it.
  const engagements = [];
  let view = startView || await read(driver);

  // A reader that gives no tap points on a populated grid will not start giving
  // them out after a swipe, so scrolling to hunt for one is pure waste.
  const hasPoints = (v) => (Array.isArray(v && v.reels) ? v.reels : []).some((r) => r && r.point);
  if (!hasPoints(view)) return nothing;

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
        driver, point: onScreen.point, pacingMs, jitterPx, read, clipSeconds, getClip, log,
      });
      // `origin` tells the judge where this video truly came from — the
      // creator's own grid, not the search result that surfaced them.
      if (rec.clip) clips.push({ ...rec.clip, views: onScreen.views, origin: 'grid' });
      // Whatever the player showed for this reel. Kept even when the recording
      // itself failed: the counts are the fraud signal and they cost nothing
      // extra, so losing them because the recorder was unavailable would throw
      // away the cheaper half of the evidence.
      //
      // The grid's OWN view count wins when the player did not report one —
      // that is the same reel either way, and it is the number the reach gates
      // already ran on.
      if (rec.engagement) {
        engagements.push({
          ...rec.engagement,
          views: rec.engagement.views ?? onScreen.views ?? null,
        });
      }
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
  return {
    clips: clips.sort((a, b) => (b.views || 0) - (a.views || 0)),
    engagements,
  };
}

async function openAndCaptureProfile({
  driver, handle, pacingMs, jitterPx = 0, read = readView,
  screen, clipSeconds = 12, getClip, reelsWindow = REELS_PER_PROFILE,
  clipsWanted = CLIPS_PER_PROFILE, log = () => {}, config = {},
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

  // An Accounts row has no reel behind it, so the one reel judged is a typical
  // one off the creator's own grid — still ONE, the same as the reels path.
  const profile = await analyseProfile({
    driver, pacingMs, jitterPx, read, screen, clipSeconds, getClip, reelsWindow,
    clipsWanted: Math.min(1, clipsWanted),
    fallbackUsername: handle,
    source: 'backend-navigator',
    screens: ['profile', 'reels_tab'],
    view: arrived.view,
    config, log,
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
  analyseThenRecordSource,
  recordSourceReel,
  readView,
  pickSearchTerms,
  IG_ANDROID_PACKAGE,
  // Shared with the reels-feed navigator so both discovery modes analyse a
  // creator the same way (Reels tab -> scroll the grid -> record the reels
  // worth watching).
  analyseProfile,
  checkBeforeProfile,
  backTo,
  pickClipTargets,
  scrollResults,
  openResultsReelsChip,
  REELS_PER_PROFILE,
  CLIPS_PER_PROFILE,
  MAX_KEYWORD_DEPTH,
  resolveClip,
};
