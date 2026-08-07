'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scout } = require('./sourcingNavigator');

function fakeDriver() {
  const ops = [];
  return {
    ops,
    openApp: async (pkg) => ops.push(['openApp', pkg]),
    tap: async (x, y) => ops.push(['tap', x, y]),
    typeText: async (t) => ops.push(['type', t]),
    swipe: async (o) => ops.push(['swipe', o]),
    getWindowSize: async () => ({ width: 1080, height: 2400 }),
    dumpUi: async () => [],
  };
}

// A scripted reader: returns each canned view in order (the flow reads the
// screen once per navigation step). `read` is injected so the flow is tested
// without crafting real UI-element trees (screenVision has its own tests).
function scriptedRead(views) {
  let i = 0;
  return async () => views[i++] || { screen: 'unknown', targets: {} };
}

test('drives search -> profile -> reels and yields one captured candidate', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'search', targets: { searchTab: { x: 100, y: 900 } } },
    { screen: 'search', targets: { searchBox: { x: 200, y: 80 } } },
    { screen: 'search_results', results: ['mock.coach'], targets: { 'result:mock.coach': { x: 200, y: 220 }, back: { x: 30, y: 90 } } },
    { screen: 'search_results', targets: { 'result:mock.coach': { x: 200, y: 220 } } },
    { screen: 'profile', fullName: 'Mock Coach', followers: 84000, bio: 'coach', targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } } },
    { screen: 'reels_tab', reels: [{ views: 120000 }, { views: 98000 }], targets: { back: { x: 30, y: 90 } } },
    { screen: 'reels_tab', targets: { back: { x: 30, y: 90 } } },
    { screen: 'search_results', targets: { back: { x: 30, y: 90 } } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['homegym'] }, read: scriptedRead(views) });

  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'mock.coach');
  assert.strictEqual(out[0].followers, 84000);
  assert.strictEqual(out[0].bio, 'coach');
  assert.deepStrictEqual(out[0].reels, [{ views: 120000 }, { views: 98000 }]);
  assert.strictEqual(out[0].evidence.source, 'backend-navigator');

  // Opened IG, tapped search tab + box, typed the term, tapped the result + reels tab.
  assert.deepStrictEqual(driver.ops[0], ['openApp', 'com.instagram.android']);
  assert.ok(driver.ops.some((o) => o[0] === 'type' && o[1] === 'homegym'));
  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 200 && o[2] === 220), 'tapped the result row');
  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 400 && o[2] === 500), 'tapped the reels tab');
});

test('stops at opts.max without over-capturing', async () => {
  const driver = fakeDriver();
  const profileViews = (h) => [
    { screen: 'search_results', targets: { [`result:${h}`]: { x: 1, y: 1 } } },
    { screen: 'profile', followers: 1000, targets: { reelsTab: { x: 2, y: 2 }, back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 1 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', targets: { back: { x: 3, y: 3 } } },
  ];
  const views = [
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: ['a', 'b', 'c'], targets: { back: { x: 3, y: 3 } } },
    ...profileViews('a'),
    ...profileViews('b'),
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'a');
});

test('skips a results row whose tap target is missing (no crash)', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: ['ghost'], targets: { back: { x: 3, y: 3 } } },
    { screen: 'search_results', targets: { back: { x: 3, y: 3 } } }, // openAndCapture: no result:ghost target
    { screen: 'search_results', targets: { back: { x: 3, y: 3 } } }, // goBack after the (skipped) row
    { screen: 'search_results', targets: { back: { x: 3, y: 3 } } }, // goBack after the term
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['x'] }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);
  assert.strictEqual(out.length, 0);
});
