'use strict';

// Keeping a long run alive without anyone watching it.
//
// A sourcing run drives a real phone for hours. Instagram interrupts it with
// modal sheets, a tap occasionally lands nowhere, the app freezes on a spinner,
// and a run that keeps rejecting can scroll until the battery dies. None of
// these are bugs in the navigator's logic — they are what running against a real
// app for hours looks like — so they are handled here, once, rather than being
// re-invented at each of the dozen places that touch the phone.
//
// Four pieces:
//
//   clearDialogs   dismiss a modal sheet, up to N attempts
//   arriveAt       do a thing, then VERIFY it landed, and retry if it did not
//   createStallGuard   notice when the screen has stopped changing
//   createProfileCap   bound how much work a single run may do
//
// Everything takes its clock and its driver by injection, so the whole module is
// testable without a phone or a timer.

const { jitteredDelay, jitterTap } = require('./humanize');

// How many times to try dismissing sheets before giving up and carrying on
// anyway. Instagram stacks them (notifications, then login-info, then an update
// nag), so one attempt is regularly not enough.
const DEFAULT_DIALOG_ATTEMPTS = 3;

// How many times to repeat an action that did not land where it should.
const DEFAULT_ARRIVE_ATTEMPTS = 3;

// Nothing on screen has changed for this long: not slow, stuck.
const DEFAULT_STALL_MS = 90_000;

// Profiles a run may open before it stops, whatever its target count. A run
// whose keywords match nothing would otherwise scroll until something else
// killed it.
const DEFAULT_MAX_PROFILES = 200;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function noop() {}

/**
 * Clear any modal sheet sitting over the app.
 *
 * Returns the number of dialogs actually dismissed, and the view to carry on
 * with — which is the caller's own view untouched when there was nothing to
 * clear, so this is cheap to call on a screen that is fine.
 */
async function clearDialogs({
  driver, read, view = null, pacingMs = 0, jitterPx = 0,
  attempts = DEFAULT_DIALOG_ATTEMPTS, log = noop,
}) {
  let current = view || await read(driver);
  let cleared = 0;

  for (let i = 0; i < attempts; i += 1) {
    const dialog = current && current.dialog;
    if (!dialog || !dialog.point) break;

    log(`[sourcing] dismissing dialog via "${dialog.label}"`);
    const p = jitterTap(dialog.point, jitterPx);
    // eslint-disable-next-line no-await-in-loop
    await driver.tap(p.x, p.y);
    // eslint-disable-next-line no-await-in-loop
    await sleep(jitteredDelay(pacingMs));
    cleared += 1;
    // eslint-disable-next-line no-await-in-loop
    current = await read(driver);
  }

  return { cleared, view: current };
}

/**
 * Perform a state change, then verify it actually happened.
 *
 * A tap that lands on a sheet, or during a re-layout, silently does nothing —
 * and the navigator would carry on as though it had worked, tapping coordinates
 * that mean something else entirely on the screen it is really looking at. This
 * is the difference between "we asked" and "we arrived".
 *
 * Between attempts it clears any dialog, because a sheet is by far the most
 * common reason the first attempt did nothing.
 *
 * @param {object}   o
 * @param {string[]} o.wanted    screens that count as having arrived
 * @param {Function} o.act       performs the state change; re-run on each retry
 * @returns {Promise<{ok:boolean, view:object, attempts:number}>}
 *          `ok` false means every attempt failed — the caller decides whether
 *          that is fatal, because for some hops it is not.
 */
async function arriveAt({
  driver, read, wanted, act, attempts = DEFAULT_ARRIVE_ATTEMPTS,
  pacingMs = 0, jitterPx = 0, log = noop, what = 'screen',
}) {
  const want = Array.isArray(wanted) ? wanted : [wanted];
  let view = null;

  for (let i = 1; i <= attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act();
    // eslint-disable-next-line no-await-in-loop
    await sleep(jitteredDelay(pacingMs));
    // eslint-disable-next-line no-await-in-loop
    view = await read(driver);

    if (want.includes(view.screen)) return { ok: true, view, attempts: i };

    // A sheet is the usual reason a tap did nothing. Clear it and look again
    // BEFORE spending a retry — often the action did land and the sheet simply
    // arrived on top of it.
    if (view.dialog) {
      // eslint-disable-next-line no-await-in-loop
      const cleared = await clearDialogs({ driver, read, view, pacingMs, jitterPx, log });
      view = cleared.view;
      if (want.includes(view.screen)) return { ok: true, view, attempts: i };
    }

    if (i < attempts) log(`[sourcing] ${what}: expected ${want.join('|')}, got ${view.screen} — retrying`);
  }

  log(`[sourcing] ${what}: gave up after ${attempts} attempts, on ${view && view.screen}`);
  return { ok: false, view, attempts };
}

/**
 * Notice when the phone has stopped responding.
 *
 * Feed it every screen read. It fingerprints what is on screen; when the
 * fingerprint has not changed for `timeoutMs`, the run is not slow, it is stuck
 * — a spinner that never resolved, a frozen player, a tap that opened nothing.
 *
 * Deliberately fingerprints CONTENT rather than the screen label: a reels feed
 * that is scrolling normally shows a different author every few seconds, while
 * one that is frozen shows the same reel for a minute and a half, and both are
 * `screen: 'reels_feed'`.
 */
function createStallGuard({ timeoutMs = DEFAULT_STALL_MS, now = Date.now } = {}) {
  let fingerprint = null;
  let since = now();

  function fingerprintOf(view) {
    if (!view) return 'null';
    return [
      view.screen,
      view.username || view.author || '',
      view.caption || '',
      (view.results || []).join(','),
      (view.reels || []).map((r) => r && r.views).join(','),
    ].join('|');
  }

  return {
    /** @returns {boolean} true when the screen has been frozen for too long. */
    check(view) {
      const fp = fingerprintOf(view);
      if (fp !== fingerprint) {
        fingerprint = fp;
        since = now();
        return false;
      }
      return now() - since >= timeoutMs;
    },
    /** Call after a recovery so the next identical read is not instantly stale. */
    reset() {
      fingerprint = null;
      since = now();
    },
    stalledMs() {
      return now() - since;
    },
  };
}

/**
 * Get a stuck phone back to somewhere the navigator can work from.
 *
 * Escalating, because the cheap fix usually works: clear any sheet, press back,
 * and only relaunch Instagram if the screen is still frozen. Relaunching is
 * always safe — openApp on a foreground app is a no-op — but it costs the run
 * its place in whatever it was scrolling.
 */
async function recoverFromStall({
  driver, read, pacingMs = 0, jitterPx = 0, guard = null, log = noop, pkg,
}) {
  log('[sourcing] screen has not changed in a long time — recovering');

  const cleared = await clearDialogs({ driver, read, pacingMs, jitterPx, log });
  let view = cleared.view;
  if (cleared.cleared) {
    if (guard) guard.reset();
    return view;
  }

  const canBack = typeof driver.back === 'function';
  if (canBack) {
    await driver.back();
    await sleep(jitteredDelay(pacingMs));
    view = await read(driver);
  }

  // Relaunching is the last tool, and the only one left for a driver too old to
  // have a back op. It costs the run its place in whatever it was scrolling,
  // which is why it is not the first thing tried.
  if (!canBack || !view || view.screen === 'unknown') {
    await driver.openApp(pkg);
    await sleep(jitteredDelay(pacingMs));
    view = await read(driver);
  }

  if (guard) guard.reset();
  return view;
}

/**
 * Bound the work one run may do.
 *
 * The target count bounds how many creators a run ADDS; nothing bounded how many
 * it looks at. A run whose keywords match nothing rejects every creator, never
 * reaches its target, and scrolls until something else stops it.
 */
function createProfileCap({ max = DEFAULT_MAX_PROFILES, log = noop } = {}) {
  const limit = Number(max) > 0 ? Number(max) : Infinity;
  let opened = 0;
  return {
    /** @returns {boolean} false once the cap is spent. */
    take() {
      if (opened >= limit) return false;
      opened += 1;
      if (opened === limit) log(`[sourcing] profile cap reached (${limit}) — winding the run down`);
      return true;
    },
    opened() { return opened; },
    spent() { return opened >= limit; },
  };
}

module.exports = {
  clearDialogs,
  arriveAt,
  createStallGuard,
  recoverFromStall,
  createProfileCap,
  DEFAULT_DIALOG_ATTEMPTS,
  DEFAULT_ARRIVE_ATTEMPTS,
  DEFAULT_STALL_MS,
  DEFAULT_MAX_PROFILES,
};
