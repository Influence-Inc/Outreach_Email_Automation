'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  clearDialogs, arriveAt, createStallGuard, recoverFromStall, createProfileCap,
} = require('./sourcingResilience');

function fakeDriver() {
  const ops = [];
  return {
    ops,
    tap: async (x, y) => ops.push(['tap', x, y]),
    back: async () => ops.push(['back']),
    openApp: async (pkg) => ops.push(['openApp', pkg]),
    swipe: async () => ops.push(['swipe']),
  };
}

// Views are consumed one per read(), the same contract the navigator tests use.
function scriptedRead(views) {
  let i = 0;
  return async () => views[i++] || { screen: 'unknown', targets: {} };
}

const SHEET = (label = 'not now') => ({
  screen: 'reels_feed',
  dialog: { label, point: { x: 500, y: 1800 } },
  targets: {},
});

// ── clearDialogs ────────────────────────────────────────────────────────────

test('a sheet is dismissed and the clean view handed back', async () => {
  const driver = fakeDriver();
  const clean = { screen: 'reels_feed', author: 'mia', targets: {} };
  const r = await clearDialogs({ driver, read: scriptedRead([clean]), view: SHEET() });

  assert.strictEqual(r.cleared, 1);
  assert.deepStrictEqual(driver.ops, [['tap', 500, 1800]]);
  assert.strictEqual(r.view, clean);
});

// Instagram stacks them: notifications, then login-info, then an update nag.
test('stacked sheets are cleared one after another', async () => {
  const driver = fakeDriver();
  const clean = { screen: 'profile', targets: {} };
  const r = await clearDialogs({
    driver,
    read: scriptedRead([SHEET('skip'), clean]),
    view: SHEET('not now'),
  });

  assert.strictEqual(r.cleared, 2);
  assert.strictEqual(r.view, clean);
});

test('it gives up rather than tapping forever at a sheet that will not go', async () => {
  const driver = fakeDriver();
  const r = await clearDialogs({
    driver,
    read: async () => SHEET(),
    view: SHEET(),
    attempts: 3,
  });

  assert.strictEqual(r.cleared, 3);
  assert.strictEqual(driver.ops.length, 3, 'three taps, then stop');
});

// Calling this on a screen that is fine has to be cheap — it runs everywhere.
test('a screen with no sheet costs nothing', async () => {
  const driver = fakeDriver();
  const clean = { screen: 'profile', targets: {} };
  const r = await clearDialogs({ driver, read: async () => clean, view: clean });

  assert.strictEqual(r.cleared, 0);
  assert.strictEqual(driver.ops.length, 0, 'no taps');
  assert.strictEqual(r.view, clean, 'and the caller keeps the view it had');
});

// ── arriveAt ────────────────────────────────────────────────────────────────

test('an action that lands is not repeated', async () => {
  const driver = fakeDriver();
  let acted = 0;
  const r = await arriveAt({
    driver,
    read: scriptedRead([{ screen: 'profile', targets: {} }]),
    wanted: 'profile',
    act: async () => { acted += 1; },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(acted, 1);
  assert.strictEqual(r.attempts, 1);
});

// A tap that lands on nothing would otherwise leave the navigator tapping
// coordinates that mean something else on the screen it is really looking at.
test('an action that did not land is retried', async () => {
  const driver = fakeDriver();
  let acted = 0;
  const r = await arriveAt({
    driver,
    read: scriptedRead([
      { screen: 'search_results', targets: {} },  // did not land
      { screen: 'search_results', targets: {} },  // still not
      { screen: 'profile', targets: {} },         // landed
    ]),
    wanted: ['profile'],
    act: async () => { acted += 1; },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(acted, 3);
  assert.strictEqual(r.attempts, 3);
});

test('giving up reports failure rather than pretending it worked', async () => {
  const driver = fakeDriver();
  const r = await arriveAt({
    driver,
    read: async () => ({ screen: 'search_results', targets: {} }),
    wanted: 'profile',
    act: async () => {},
    attempts: 2,
  });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.view.screen, 'search_results', 'and says where it actually is');
});

// The action often DID land and a sheet simply arrived on top of it — so
// clearing costs nothing and saves a retry.
test('a sheet over the destination counts as having arrived', async () => {
  const driver = fakeDriver();
  let acted = 0;
  const r = await arriveAt({
    driver,
    read: scriptedRead([
      { screen: 'search', dialog: { label: 'not now', point: { x: 1, y: 2 } }, targets: {} },
      { screen: 'profile', targets: {} }, // what the sheet was covering
    ]),
    wanted: 'profile',
    act: async () => { acted += 1; },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(acted, 1, 'the action was not repeated');
  assert.deepStrictEqual(driver.ops, [['tap', 1, 2]]);
});

// ── the stall guard ─────────────────────────────────────────────────────────

function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('a screen that keeps changing never looks stalled', () => {
  const now = clock();
  const guard = createStallGuard({ timeoutMs: 90_000, now });

  for (let i = 0; i < 20; i += 1) {
    assert.strictEqual(guard.check({ screen: 'reels_feed', author: `creator${i}` }), false);
    now.advance(30_000);
  }
});

test('the same screen for longer than the timeout is a stall', () => {
  const now = clock();
  const guard = createStallGuard({ timeoutMs: 90_000, now });
  const frozen = { screen: 'reels_feed', author: 'mia', caption: 'same reel' };

  assert.strictEqual(guard.check(frozen), false);
  now.advance(89_000);
  assert.strictEqual(guard.check(frozen), false, 'still within the window');
  now.advance(2_000);
  assert.strictEqual(guard.check(frozen), true);
});

// A frozen player and a healthy scroll are both `screen: 'reels_feed'` — only
// the content tells them apart.
test('a frozen feed is caught even though the screen label never changes', () => {
  const now = clock();
  const guard = createStallGuard({ timeoutMs: 1000, now });

  guard.check({ screen: 'reels_feed', author: 'a' });
  now.advance(2000);
  assert.strictEqual(guard.check({ screen: 'reels_feed', author: 'a' }), true, 'same reel');

  guard.reset();
  guard.check({ screen: 'reels_feed', author: 'a' });
  now.advance(2000);
  assert.strictEqual(guard.check({ screen: 'reels_feed', author: 'b' }), false, 'moved on');
});

test('a reset clears the clock so recovery is not instantly re-flagged', () => {
  const now = clock();
  const guard = createStallGuard({ timeoutMs: 1000, now });
  const frozen = { screen: 'profile', username: 'mia' };

  guard.check(frozen);
  now.advance(5000);
  assert.strictEqual(guard.check(frozen), true);

  guard.reset();
  assert.strictEqual(guard.check(frozen), false);
});

// ── recovery ────────────────────────────────────────────────────────────────

test('recovery clears a sheet and stops there when that was the problem', async () => {
  const driver = fakeDriver();
  const guard = createStallGuard({ timeoutMs: 1, now: clock() });
  await recoverFromStall({
    driver,
    read: scriptedRead([SHEET(), { screen: 'reels_feed', targets: {} }]),
    guard,
    pkg: 'com.instagram.android',
  });

  assert.deepStrictEqual(driver.ops.map((o) => o[0]), ['tap'], 'no back, no relaunch');
});

test('recovery presses back when there is no sheet to blame', async () => {
  const driver = fakeDriver();
  await recoverFromStall({
    driver,
    read: scriptedRead([
      { screen: 'reels_feed', targets: {} },
      { screen: 'profile', targets: {} },
    ]),
    pkg: 'com.instagram.android',
  });

  assert.deepStrictEqual(driver.ops.map((o) => o[0]), ['back']);
});

test('recovery relaunches Instagram when back left us nowhere readable', async () => {
  const driver = fakeDriver();
  await recoverFromStall({
    driver,
    read: scriptedRead([
      { screen: 'unknown', targets: {} },
      { screen: 'unknown', targets: {} },
      { screen: 'search', targets: {} },
    ]),
    pkg: 'com.instagram.android',
  });

  assert.deepStrictEqual(driver.ops.map((o) => o[0]), ['back', 'openApp']);
});

// ── the profile cap ─────────────────────────────────────────────────────────

// targetCount bounds how many creators a run ADDS. Nothing bounded how many it
// looks at, so a run whose keywords match nothing scrolled forever.
test('a run stops opening profiles once the cap is spent', () => {
  const cap = createProfileCap({ max: 3 });
  assert.strictEqual(cap.take(), true);
  assert.strictEqual(cap.take(), true);
  assert.strictEqual(cap.take(), true);
  assert.strictEqual(cap.take(), false);
  assert.strictEqual(cap.opened(), 3);
  assert.strictEqual(cap.spent(), true);
});

test('the cap can be turned off', () => {
  const cap = createProfileCap({ max: 0 });
  for (let i = 0; i < 1000; i += 1) assert.strictEqual(cap.take(), true);
  assert.strictEqual(cap.spent(), false);
});
