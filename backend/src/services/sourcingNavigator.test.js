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

test('reels-first: no @handle rows -> taps a reel card, reads @handle from reels_feed, opens author profile', async () => {
  const driver = fakeDriver();
  // The SERP has NO results[] (current IG behavior) — only reelResults[]. The
  // navigator taps the reel card, reads the reel-feed for the @handle + author
  // tap target, opens the profile, captures the header + reels, and goes back
  // twice to the SERP.
  const views = [
    { screen: 'search', targets: { searchTab: { x: 10, y: 10 } } },
    { screen: 'search', targets: { searchBox: { x: 20, y: 20 } } },
    // SERP after typing keyword — reel grid only.
    { screen: 'search_results', reelResults: [{ index: 0, author: 'Amar Mujkanovic' }], targets: { 'reelResult:0': { x: 181, y: 320 }, back: { x: 56, y: 136 } } },
    // captureViaReel: 1st read is the SERP (find the card).
    { screen: 'search_results', targets: { 'reelResult:0': { x: 181, y: 320 } } },
    // 2nd read: reels_feed after tapping the card.
    { screen: 'reels_feed', author: 'amarmujkanovicc', caption: 'gym day', targets: { authorProfile: { x: 205, y: 1275 }, back: { x: 48, y: 136 } } },
    // 3rd read: profile after tapping authorProfile — reels already surfaced (Reels sub-tab active).
    { screen: 'profile', username: 'amarmujkanovicc', fullName: 'Amar Mujkanovic', followers: 19500, bio: 'coach', reels: [{ views: 8706 }, { views: 17000 }], targets: { back: { x: 48, y: 136 }, reelsTab: { x: 120, y: 692 } } },
    // goBack: profile -> reels_feed
    { screen: 'reels_feed', targets: { back: { x: 48, y: 136 } } },
    // goBack: reels_feed -> SERP
    { screen: 'search_results', targets: { back: { x: 56, y: 136 } } },
    // outer goBack after the term
    { screen: 'search', targets: { back: { x: 56, y: 136 } } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['homegym'] }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'amarmujkanovicc');
  assert.strictEqual(out[0].full_name, 'Amar Mujkanovic');
  assert.strictEqual(out[0].followers, 19500);
  assert.deepStrictEqual(out[0].reels.map((r) => r.views), [8706, 17000]);
  assert.strictEqual(out[0].evidence.source, 'backend-navigator:reels-first');
  // Tapped the reel card, then the author tap target, then a back or two.
  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 181 && o[2] === 320), 'tapped the reel card');
  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 205 && o[2] === 1275), 'tapped authorProfile');
});

test('reels-first: skips a card whose reels_feed hop is missing the author target', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', reelResults: [{ index: 0, author: 'X' }], targets: { 'reelResult:0': { x: 1, y: 1 }, back: { x: 3, y: 3 } } },
    { screen: 'search_results', targets: { 'reelResult:0': { x: 1, y: 1 } } },
    { screen: 'reels_feed', targets: { back: { x: 3, y: 3 } } },      // no author, no authorProfile
    { screen: 'reels_feed', targets: { back: { x: 3, y: 3 } } },      // goBack (profile -> reels_feed skipped)
    { screen: 'search_results', targets: { back: { x: 3, y: 3 } } },  // goBack -> SERP
    { screen: 'search', targets: { back: { x: 3, y: 3 } } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['x'] }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);
  assert.strictEqual(out.length, 0, 'nothing captured, no crash');
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

// ── keyword search flow ─────────────────────────────────────────────────────

function driverWithSearch() {
  const ops = [];
  return {
    ops,
    openApp: async (pkg) => ops.push(['openApp', pkg]),
    tap: async (x, y) => ops.push(['tap', x, y]),
    typeText: async (t) => ops.push(['type', t]),
    submitSearch: async () => ops.push(['submitSearch']),
    swipe: async (o) => ops.push(['swipe', o]),
    getWindowSize: async () => ({ width: 1080, height: 2400 }),
    dumpUi: async () => [],
    recordClip: async (s) => { ops.push(['recordClip', s]); return { clipId: 'clip_1' }; },
  };
}

// Views are consumed one per read(), so these sequences mirror the exact hops:
// searchTab -> searchBox -> (submit) SERP -> profile link -> header -> reels grid.
const OPEN_SEARCH = [
  { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
  { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
];
const BACK = { x: 3, y: 3 };

// Typing alone leaves IG on its as-you-type ACCOUNT suggestions, which match the
// raw string against handles — the reason keyword scouting surfaced profiles
// whose NAME contained the keyword instead of creators posting about it.
test('commits the query and moves to the search page reels chip', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 640, y: 180 }, back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['homegym'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  const order = driver.ops.map((o) => o[0]);
  assert.ok(order.includes('submitSearch'), 'pressed the keyboard Search key');
  assert.ok(order.indexOf('type') < order.indexOf('submitSearch'), 'typed before submitting');
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 640 && o[2] === 180),
    'tapped the reels chip on the results page',
  );
});

// The default profile grid shows POSTS, whose thumbnails carry no view count.
// Reach only exists on the Reels grid, so the tab switch is not optional.
test('opens the reels tab and scrolls the grid for more reels', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 50000, targets: { reelsTab: { x: 400, y: 500 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 1 }, { views: 2 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 3 }, { views: 4 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 3 }, { views: 4 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 400 && o[2] === 500),
    'tapped the profile reels tab',
  );
  assert.ok(driver.ops.some((o) => o[0] === 'swipe'), 'scrolled the reels grid');
  assert.deepStrictEqual(out[0].reels.map((r) => r.views), [1, 2, 3, 4]);
  assert.strictEqual(out[0].evidence.reelsRead, 4);
});

test('scrolling stops as soon as the grid yields nothing new', async () => {
  const driver = driverWithSearch();
  const same = { screen: 'reels_tab', reels: [{ views: 1 }], targets: { back: BACK } };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 10, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    same, same, same, same, same, same, same, same,
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  assert.strictEqual(
    driver.ops.filter((o) => o[0] === 'swipe').length, 1,
    'one scroll, then stop — the grid was exhausted',
  );
});

// Without clip bytes reelJudge falls straight through to the bio-text tier, so
// the creative-style judgement the pipeline is built on never happens.
test('records a reel and attaches the clip for the Gemini judge', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { 'reelCell:0': { x: 150, y: 700 }, back: BACK } },
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({
    driver,
    config: { pacingMs: 0, clipSeconds: 9 },
    opts: { keywords: ['coach'], max: 1 },
    read: scriptedRead(views),
    deps: { getClip: async (id) => ({ dataBase64: 'AAAA', mimeType: 'video/mp4', id }) },
  });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.ok(driver.ops.some((o) => o[0] === 'recordClip' && o[1] === 9), 'recorded at the configured length');
  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 150 && o[2] === 700), 'opened the first reel');
  assert.strictEqual(out[0].clip.dataBase64, 'AAAA');
  assert.strictEqual(out[0].evidence.clipCaptured, true);
});

test('a failed recording still yields the creator', async () => {
  const driver = driverWithSearch();
  driver.recordClip = async () => { throw new Error('recorder unavailable'); };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { 'reelCell:0': { x: 1, y: 1 }, back: BACK } },
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1, 'the candidate survives a recording failure');
  assert.strictEqual(out[0].clip, undefined);
  assert.strictEqual(out[0].evidence.clipCaptured, false);
});
