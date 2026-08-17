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
    back: async () => ops.push(['back']),
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
    // The grid, with the reel's own tap point — what the reader now supplies.
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 150, y: 700 } }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 150, y: 700 } }], targets: { back: BACK } },
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 150, y: 700 } }], targets: { back: BACK } },
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
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1, 'the candidate survives a recording failure');
  assert.strictEqual(out[0].clip, undefined);
  assert.strictEqual(out[0].evidence.clipCaptured, false);
});

// ── back navigation ─────────────────────────────────────────────────────────

// Counting back presses is what walked the agent out of Instagram: a capture
// that bails early pushes fewer screens than a fixed "go back twice" assumes,
// so the extra presses kept going past the results page and out of the app.
test('a bailed-out capture does not press back past the results page', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    // reels grid with one card
    { screen: 'search_results', reelResults: [{ index: 0, author: 'Coach' }], targets: { 'reelResult:0': { x: 9, y: 9 }, back: BACK } },
    { screen: 'search_results', targets: { 'reelResult:0': { x: 9, y: 9 }, back: BACK } },
    // the reel opens but the author target never resolves -> captureViaReel bails
    { screen: 'reels_feed', targets: { back: BACK } },
    // still on the feed: exactly one back press should return us to the SERP
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0, 'nothing captured — the author never resolved');
  const backTaps = driver.ops.filter((o) => o[0] === 'tap' && o[1] === BACK.x && o[2] === BACK.y).length;
  assert.strictEqual(backTaps, 1, 'one back press, not a blind two');
});

test('already on the results page means no back press at all', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', reelResults: [{ index: 0, author: 'C' }], targets: { 'reelResult:0': { x: 9, y: 9 }, back: BACK } },
    { screen: 'search_results', targets: {} },      // reelResult target gone -> bail
    { screen: 'search_results', targets: { back: BACK } }, // backTo sees SERP: no press
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  const backTaps = driver.ops.filter((o) => o[0] === 'tap' && o[1] === BACK.x && o[2] === BACK.y).length;
  assert.strictEqual(backTaps, 0, 'no back press when already where we want to be');
});

// Backing out too far used to leave every later tap landing on the launcher.
test('an unreadable screen relaunches Instagram instead of tapping blindly', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'unknown', targets: {} },   // end-of-term check: not in IG any more
    { screen: 'search', targets: {} },    // after the relaunch
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  // Launched once at the start, then relaunched whenever a read came back
  // unreadable. The exact count depends on how many visits the keyword gets
  // before it is retired; what matters is that recovery happened and that no tap
  // was fired at a screen offering no targets.
  const opens = driver.ops.filter((o) => o[0] === 'openApp').length;
  assert.ok(opens >= 2, `relaunched on recovery (openApp x${opens})`);
  assert.strictEqual(
    driver.ops.filter((o) => o[0] === 'tap' && (o[1] === 0 || o[2] === 0)).length, 0,
    'never tapped a coordinate it did not read',
  );
});

// ── feed-scroll discovery ───────────────────────────────────────────────────

// When the Reels/Explore chip lands on a full-screen player there are no cards
// to tap by index — creators are found by scrolling reel to reel.
test('scrolls a reels feed, opening each creator and returning to the feed', async () => {
  const driver = driverWithSearch();
  const feedReel = (author) => ({
    screen: 'reels_feed', author, targets: { authorProfile: { x: 300, y: 1500 }, back: BACK },
  });
  const profileOf = (followers) => [
    { screen: 'profile', followers, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: followers }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: followers }], targets: { back: BACK } },
    { screen: 'reels_feed', author: 'x', targets: { back: BACK } }, // backTo lands here
  ];
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 600, y: 150 }, back: BACK } },
    feedReel('Alpha Coach'),        // after tapping the chip
    feedReel('Alpha Coach'),        // feed read inside the scroll loop
    ...profileOf(1000),
    feedReel('Beta Lifts'),
    ...profileOf(2000),
    { screen: 'unknown', targets: {} },
  ];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 2 }, read: scriptedRead(views),
  });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 2, 'sourced two creators from the feed');
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 300 && o[2] === 1500),
    'opened the creator from the reel',
  );
  // A big vertical swipe is the move to the next reel.
  assert.ok(
    driver.ops.some((o) => o[0] === 'swipe' && o[1].y1 > o[1].y2 && o[1].y1 >= 1900),
    'swiped up to the next reel',
  );
  assert.strictEqual(out[0].evidence.source, 'backend-navigator:feed-scroll');
});

// A feed re-surfaces popular accounts; analysing one twice would spend a slot
// against N on a creator already sourced.
test('the same creator is not analysed twice while scrolling', async () => {
  const driver = driverWithSearch();
  const feedReel = { screen: 'reels_feed', author: 'Same Person', targets: { authorProfile: { x: 3, y: 4 }, back: BACK } };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 6, y: 1 }, back: BACK } },
    feedReel,
    feedReel,
    { screen: 'profile', followers: 10, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 1 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 1 }], targets: { back: BACK } },
    feedReel,   // backTo lands on the feed
    feedReel,   // next loop: same author -> skipped
    feedReel,
    { screen: 'unknown', targets: {} },
  ];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 5 }, read: scriptedRead(views),
  });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1, 'the repeated creator was skipped');
});

test('scrolling out of the feed ends feed discovery cleanly', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 6, y: 1 }, back: BACK } },
    { screen: 'reels_feed', author: 'A', targets: { back: BACK } }, // no authorProfile -> skip
    { screen: 'profile', targets: { back: BACK } },                 // no longer a feed -> stop
    { screen: 'search', targets: {} },
  ];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 3 }, read: scriptedRead(views),
  });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0);
  assert.ok(driver.ops.length > 0, 'ran without throwing');
});

// ── cost of a run ───────────────────────────────────────────────────────────

// Every screen read used to fetch the window size alongside the UI tree, so each
// navigation step cost two round-trips to the phone instead of one. There are
// dozens of steps per creator, and the screen does not resize mid-run.
test('the device size is fetched once, not on every screen read', async () => {
  const { readView } = require('./sourcingNavigator');
  let sizeCalls = 0;
  let dumpCalls = 0;
  const driver = {
    dumpUi: async () => { dumpCalls += 1; return []; },
    getWindowSize: async () => { sizeCalls += 1; return { width: 1080, height: 2400 }; },
  };

  await readView(driver);
  await readView(driver);
  await readView(driver);

  assert.strictEqual(dumpCalls, 3, 'the UI tree is re-read every time, as it must be');
  assert.strictEqual(sizeCalls, 1, 'the screen size is asked for once per driver');
});

test('a driver that cannot report its size still reads screens', async () => {
  const { readView } = require('./sourcingNavigator');
  const driver = {
    dumpUi: async () => [],
    getWindowSize: async () => { throw new Error('unsupported'); },
  };
  const view = await readView(driver);
  assert.ok(view, 'degrades instead of throwing');
});

// Reels mode records and judges the feed reel before opening the profile; a
// second recording there costs another ~12s on the phone and a second Gemini
// call for a verdict already in hand.
test('analyseProfile can skip recording when the caller already judged a clip', async () => {
  const { analyseProfile } = require('./sourcingNavigator');
  const driver = driverWithSearch();
  const views = [
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { 'reelCell:0': { x: 1, y: 1 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
  ];
  const profile = await analyseProfile({
    driver,
    pacingMs: 0,
    read: scriptedRead(views),
    screen: { width: 1080, height: 2400 },
    recordClip: false,
  });

  assert.ok(!driver.ops.some((o) => o[0] === 'recordClip'), 'no second recording');
  assert.deepStrictEqual(profile.reels.map((r) => r.views), [7], 'reach still collected');
  assert.strictEqual(profile.evidence.clipCaptured, false);
});

// ── back navigation must not page the tabs ──────────────────────────────────

// Instagram's search results are horizontally paged. The old fallback swiped in
// from the left edge — the system back GESTURE — which landed as "next tab" and
// walked the scout through Accounts and Audio instead of going back.
test('back uses a real key press, never an edge swipe, when the driver has one', async () => {
  const driver = driverWithSearch();
  const backs = [];
  driver.back = async () => { backs.push(true); };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', reelResults: [{ index: 0, author: 'C' }], targets: { 'reelResult:0': { x: 9, y: 9 } } },
    { screen: 'search_results', targets: { 'reelResult:0': { x: 9, y: 9 } } },
    { screen: 'reels_feed', targets: {} },   // no back target, no author -> bail
    { screen: 'reels_feed', targets: {} },   // backTo: press back
    { screen: 'search_results', targets: {} },
    { screen: 'search_results', targets: {} },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  assert.ok(backs.length >= 1, 'pressed BACK');
  const edgeSwipes = driver.ops.filter(
    (o) => o[0] === 'swipe' && o[1].x1 < 50 && o[1].x2 > o[1].x1 && o[1].y1 === o[1].y2,
  );
  assert.strictEqual(edgeSwipes.length, 0, 'no left-edge gesture that IG would read as a tab swipe');
});

// Current IG's results strip is `For you | Accounts | Audio | Tags` — there is no
// "Reels" tab to find. Paging sideways looking for one is what walked live runs
// into Accounts and then Audio, where a "creator" is a song.
test('never pages the results tab strip sideways', async () => {
  const driver = driverWithSearch();
  const empty = { screen: 'search_results', targets: {} };
  const views = [...OPEN_SEARCH, empty, empty, empty, empty, empty, empty];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  const sideways = driver.ops.filter((o) => o[0] === 'swipe' && o[1].y1 === o[1].y2);
  assert.strictEqual(sideways.length, 0, 'no horizontal swipes — Audio is never a source');
});

// "For you" IS the content tab on current IG, and it is the default — so when the
// reader does surface it, that is the one to tap.
test('taps the For you content tab when the page has nothing yet', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 120, y: 300 } } },
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: {} },   // openAndCaptureProfile: link gone -> bail
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 120 && o[2] === 300),
    'tapped the content tab',
  );
});

test('a results page that already has content is not paged looking for tabs', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: {} },   // openAndCaptureProfile: link gone -> bail
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  const strip = driver.ops.filter((o) => o[0] === 'swipe' && o[1].y1 === o[1].y2);
  assert.strictEqual(strip.length, 0, 'accounts were already there — no swipes spent hunting tabs');
});

// clipStore hands back { buf, mediaType }; reelJudge reads { dataBase64,
// mimeType }. Attaching the store record verbatim meant the video was recorded,
// uploaded, and then silently never judged.
test('a recorded clip is attached in the shape the judge reads', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'reels_feed', targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7, point: { x: 1, y: 1 } }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({
    driver,
    config: { pacingMs: 0 },
    opts: { keywords: ['coach'], max: 1 },
    read: scriptedRead(views),
    // exactly what clipStore.take returns
    deps: { getClip: async () => ({ buf: Buffer.from('MP4'), mediaType: 'video/mp4', hostId: 3 }) },
  });
  const out = [];
  for await (const c of gen) out.push(c);

  assert.strictEqual(out[0].clip.dataBase64, Buffer.from('MP4').toString('base64'));
  assert.strictEqual(out[0].clip.mimeType, 'video/mp4');
});

// ── which reels get watched (§5) ─────────────────────────────────────────────

const { pickClipTargets } = require('./sourcingNavigator');

// One clip tells you what a creator's best day looks like and nothing about the
// other days. Two best plus one typical is what makes the gap visible.
test('picks the two best reels and one typical one', () => {
  const reels = [
    { views: 100 }, { views: 90000 }, { views: 5000 },
    { views: 80000 }, { views: 4000 }, { views: 6000 },
  ];
  const picked = pickClipTargets(reels, 3).map((r) => r.views);

  assert.deepStrictEqual(picked.slice(0, 2), [90000, 80000], 'the two best');
  assert.ok(picked[2] < 80000, 'and one that is not a top performer');
  assert.strictEqual(new Set(picked).size, 3, 'three distinct reels');
});

// Sampling only top performers would watch exactly the reels that mislead.
test('the typical pick is not just the third-best reel', () => {
  const reels = [
    { views: 100000 }, { views: 99000 }, { views: 98000 },
    { views: 500 }, { views: 600 }, { views: 700 },
  ];
  const picked = pickClipTargets(reels, 3).map((r) => r.views);
  assert.deepStrictEqual(picked.slice(0, 2), [100000, 99000]);
  assert.ok(picked[2] < 98000, 'reached past the cluster at the top');
});

test('fewer reels than clips wanted takes them all', () => {
  assert.strictEqual(pickClipTargets([{ views: 10 }, { views: 20 }], 3).length, 2);
  assert.deepStrictEqual(pickClipTargets([], 3), []);
  assert.deepStrictEqual(pickClipTargets([{ caption: 'no views' }], 3), []);
});

// Recording all three costs three stretches on the phone, so a run can ask for
// fewer without touching anything else.
test('the number of clips is configurable', () => {
  const reels = [{ views: 1 }, { views: 2 }, { views: 3 }, { views: 4 }];
  assert.strictEqual(pickClipTargets(reels, 1).length, 1);
  assert.strictEqual(pickClipTargets(reels, 2).length, 2);
  assert.strictEqual(pickClipTargets(reels, 0).length, 0);
});

// The whole point of reading the window before recording: which reels are worth
// watching is a question about the window as a whole.
test('records the best and typical reels, not merely the first one', async () => {
  const driver = driverWithSearch();
  let clipNo = 0;
  driver.recordClip = async (s) => { clipNo += 1; driver.ops.push(['recordClip', s]); return { clipId: `c${clipNo}` }; };

  const top = { views: 90000, point: { x: 100, y: 300 } };
  const mid = { views: 5000, point: { x: 300, y: 300 } };
  const low = { views: 1000, point: { x: 500, y: 300 } };
  const gridTop = { screen: 'reels_tab', reels: [top, mid], targets: { back: BACK } };
  const gridLow = { screen: 'reels_tab', reels: [low], targets: { back: BACK } };

  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    gridTop,                                        // collectReels: first screen
    gridLow,                                        // collectReels: after one scroll
    gridLow,                                        // collectReels: nothing new -> stop
    // capture pass, starting from the bottom of the grid
    { screen: 'reels_feed', targets: { back: BACK } }, gridLow,  // recorded `low`
    gridTop,                                        // scrolled back up
    { screen: 'reels_feed', targets: { back: BACK } }, gridTop,  // recorded `top`
    { screen: 'reels_feed', targets: { back: BACK } }, gridTop,  // recorded `mid`
    { screen: 'search_results', targets: { back: BACK } },
  ];

  const out = [];
  const gen = scout({
    driver,
    config: { pacingMs: 0, clipSeconds: 5 },
    opts: { keywords: ['coach'], max: 1 },
    read: scriptedRead(views),
    deps: { getClip: async (id) => ({ dataBase64: id, mimeType: 'video/mp4' }) },
  });
  for await (const c of gen) out.push(c);

  const taps = driver.ops.filter((o) => o[0] === 'tap').map((o) => `${o[1]},${o[2]}`);
  assert.ok(taps.includes('100,300'), 'opened the best reel');
  assert.ok(taps.includes('500,300'), 'and the typical one');
  assert.strictEqual(driver.ops.filter((o) => o[0] === 'recordClip').length, 3);

  assert.strictEqual(out[0].clips.length, 3);
  assert.deepStrictEqual(out[0].clips.map((c) => c.views), [90000, 5000, 1000], 'best first');
  assert.strictEqual(out[0].clip, out[0].clips[0], 'the single clip field is the best one');
  assert.strictEqual(out[0].evidence.clipsCaptured, 3);
});

// A screen coordinate stops meaning anything the moment the grid scrolls, so it
// must never reach the database.
test('tap points do not survive onto the candidate', async () => {
  const driver = driverWithSearch();
  const grid = {
    screen: 'reels_tab',
    reels: [{ views: 7, point: { x: 1, y: 1 } }],
    targets: { back: BACK },
  };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    grid, grid,
    { screen: 'reels_feed', targets: { back: BACK } }, grid,
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 },
    read: scriptedRead(views),
    deps: { getClip: async () => ({ dataBase64: 'AA', mimeType: 'video/mp4' }) },
  });
  for await (const c of gen) out.push(c);

  assert.deepStrictEqual(out[0].reels, [{ views: 7 }]);
});

// A build whose grid gives no tap points cannot be made to give them by
// swiping at it.
test('a grid with no tap points is not scrolled hunting for one', async () => {
  const driver = driverWithSearch();
  const grid = { screen: 'reels_tab', reels: [{ views: 7 }, { views: 8 }], targets: { back: BACK } };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    grid, grid,
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(driver.ops.filter((o) => o[0] === 'recordClip').length, 0);
  assert.strictEqual(driver.ops.filter((o) => o[0] === 'swipe').length, 1, 'only the collection scroll');
  assert.deepStrictEqual(out[0].reels.map((r) => r.views), [7, 8], 'the reach window survives');
});

// ── surviving a long run (§9) ───────────────────────────────────────────────

const FEED_TARGETS = { authorProfile: { x: 900, y: 1200 }, back: BACK };

// A sheet swallows every tap after it appears, so a run that does not clear one
// spends the rest of its life tapping at a dialog it cannot see.
test('a sheet on the way in is dismissed before the search starts', async () => {
  const driver = driverWithSearch();
  const views = [
    {
      screen: 'search',
      dialog: { label: 'not now', point: { x: 540, y: 1900 } },
      targets: { searchTab: { x: 1, y: 1 } },
    },
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const gen = scout({ driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'] }, read: scriptedRead(views) });
  for await (const _c of gen) { /* drain */ }

  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 540 && o[2] === 1900),
    'tapped the dismiss control',
  );
});

// An ad is a brand buying placement — opening the account behind it sources a
// competitor.
test('a sponsored reel in the feed is skipped without opening the account', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 6, y: 1 }, back: BACK } },
    { screen: 'reels_feed', author: 'somebrand', sponsored: true, targets: FEED_TARGETS },
    { screen: 'reels_feed', author: 'somebrand', sponsored: true, targets: FEED_TARGETS },
    { screen: 'search', targets: {} },
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0, 'nothing sourced from an ad');
  assert.ok(
    !driver.ops.some((o) => o[0] === 'tap' && o[1] === 900 && o[2] === 1200),
    'never tapped through to the advertiser',
  );
});

// A tap that lands during a re-layout does nothing, and the analysis that
// followed used to read the screen we were still on as the creator's profile.
test('a profile hop that did not land is retried rather than analysed', async () => {
  const driver = driverWithSearch();
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } }, // tap did nothing
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  const opens = driver.ops.filter((o) => o[0] === 'tap' && o[1] === 5 && o[2] === 5);
  assert.strictEqual(opens.length, 2, 'the hop was repeated');
  assert.strictEqual(out.length, 1, 'and the creator was captured on the retry');
});

test('a profile that never opens is dropped rather than mis-read', async () => {
  const driver = driverWithSearch();
  const serp = { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    serp, serp, serp, serp,   // every attempt lands nowhere
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 1 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0, 'nothing was invented from the wrong screen');
});

// targetCount bounds how many creators a run ADDS. Without a cap, a run whose
// keywords match nothing looks at profiles until something else stops it.
test('a run stops opening profiles once the cap is spent', async () => {
  const driver = driverWithSearch();
  const feed = (author) => ({ screen: 'reels_feed', author, targets: FEED_TARGETS });
  const profileHop = (author) => [
    feed(author),
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_feed', targets: FEED_TARGETS },
  ];
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 6, y: 1 }, back: BACK } },
    feed('one'), // after tapping the chip; the scroll loop reads again below
    ...profileHop('one'),
    ...profileHop('two'),
    ...profileHop('three'),
    { screen: 'search', targets: {} },
  ];
  const out = [];
  const gen = scout({
    driver,
    config: { pacingMs: 0, maxProfiles: 2 },
    opts: { keywords: ['coach'], max: 10 },
    read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 2, 'stopped at the cap, not at the target of 10');
});

// A frozen player and a healthy scroll are both `screen: 'reels_feed'`.
test('a frozen feed is recovered rather than scrolled at forever', async () => {
  const driver = driverWithSearch();
  let t = 0;
  const frozen = { screen: 'reels_feed', author: null, caption: 'stuck', targets: {} };
  const views = [
    ...OPEN_SEARCH,
    { screen: 'search_results', targets: { searchReelsTab: { x: 6, y: 1 }, back: BACK } },
    frozen, frozen, frozen, frozen, frozen,
    { screen: 'search', targets: {} },
  ];
  const gen = scout({
    driver,
    config: { pacingMs: 0, stallMs: 90_000 },
    opts: { keywords: ['coach'], max: 1 },
    read: scriptedRead(views),
    // A clock that jumps a minute per look: the feed has shown the same reel
    // for well over the stall window.
    deps: { now: () => { t += 60_000; return t; } },
  });
  for await (const _c of gen) { /* drain */ }

  assert.ok(driver.ops.some((o) => o[0] === 'back'), 'tried to get unstuck');
});

// ── a run keeps going until the target or the cap (§bug 4) ──────────────────

// One pass over the keywords used to BE the whole run, so a run targeting 6
// reported "done" having added 1 — it had run out of keywords, not out of
// creators, and not out of its profile budget.
test('keywords are re-run until the target is met, not abandoned after one pass', async () => {
  const driver = driverWithSearch();
  const profileHop = (handle) => [
    { screen: 'search_results', results: [handle], targets: { back: BACK } },
    { screen: 'search_results', targets: { [`result:${handle}`]: { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
  ];
  const views = [
    // pass 1 — one keyword, one creator
    ...OPEN_SEARCH, ...profileHop('alpha'),
    // pass 2 — same keyword, but it scrolls deeper first (that scroll costs one
    // read; landing on a screen with no results leaves the page we had intact)
    ...OPEN_SEARCH,
    { screen: 'search_results', results: ['bravo'], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },   // the deeper-scroll read
    { screen: 'search_results', targets: { 'result:bravo': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    // pass 3 — nothing new, so the run ends here
    ...Array(12).fill({ screen: 'search_results', targets: { back: BACK } }),
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 6 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 2, 'a second pass found a creator the first never reached');
  assert.deepStrictEqual(out.map((c) => c.username), ['alpha', 'bravo']);
});

// Without this the pass loop would spin forever on a keyword that yields nobody.
test('a pass that finds nobody new ends the run', async () => {
  const driver = driverWithSearch();
  const empty = { screen: 'search_results', targets: { back: BACK } };
  const views = [...OPEN_SEARCH, empty, empty, empty, ...Array(40).fill(empty)];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 50 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0);
  // Two passes at most: one that finds nothing, and the guard that notices.
  const searches = driver.ops.filter((o) => o[0] === 'submitSearch').length;
  assert.ok(searches <= 2, `stopped promptly, ran ${searches} searches`);
});

// A control momentarily missing used to throw straight out of the generator and
// end the entire run — including every keyword after it.
test('a missing search control skips that keyword instead of killing the run', async () => {
  const driver = driverWithSearch();
  const views = [
    { screen: 'unknown', targets: {} },        // no searchTab -> skip "one"
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } }, // ensureInInstagram
    // "two" proceeds normally
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: ['coach'], targets: { back: BACK } },
    { screen: 'search_results', targets: { 'result:coach': { x: 5, y: 5 } } },
    { screen: 'profile', followers: 9000, targets: { reelsTab: { x: 4, y: 5 }, back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'reels_tab', reels: [{ views: 7 }], targets: { back: BACK } },
    { screen: 'search_results', targets: { back: BACK } },
    ...Array(20).fill({ screen: 'search_results', targets: { back: BACK } }),
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['one', 'two'], max: 5 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 1, 'the second keyword still ran');
  assert.strictEqual(out[0].username, 'coach');
});

// ── running out of keywords means scroll deeper, not stop ────────────────────

// "Nothing new at this depth" is not "this keyword is finished". The top of a
// results page is the same creators every time, so a barren visit usually just
// means we already worked that depth — scrolling further is what finds different
// creators.
test('a keyword that gave nobody new is scrolled deeper rather than retired', async () => {
  const driver = driverWithSearch();
  // Every look shows the SAME creator, already analysed on the first visit — so
  // every later visit is barren. But the page keeps moving (a new filler handle
  // each read), so the keyword must stay live and keep going deeper.
  // Every read offers the search controls AND a results list, so any pass can
  // proceed. The listed handle differs every read, so the page always "moves" and
  // `atEnd` is never reached — the keyword can only be retired for being barren,
  // which is precisely what must NOT happen. No `result:*` target, so each hop
  // bails and no creator is ever sourced.
  let n = 0;
  const read = async () => {
    n += 1;
    return {
      screen: 'search_results',
      results: [`filler${n}`],
      targets: { searchTab: { x: 1, y: 1 }, searchBox: { x: 1, y: 1 }, back: BACK },
    };
  };

  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0, maxProfiles: 4 }, opts: { keywords: ['coach'], max: 6 }, read,
  });
  for await (const c of gen) out.push(c);

  // The run did not stop at the first barren visit: it searched again and went
  // deeper each time, until the profile budget — not a barren pass — stopped it.
  const searches = driver.ops.filter((o) => o[0] === 'submitSearch').length;
  assert.ok(searches >= 2, `kept re-running the keyword (${searches} searches)`);
  const scrolls = driver.ops.filter((o) => o[0] === 'swipe' && o[1].y1 > o[1].y2).length;
  assert.ok(scrolls >= 1, 'scrolled deeper into the results rather than giving up');
});

// The other half of the rule: a page that will not scroll any further AND gave
// nobody new is genuinely finished, so the keyword retires and the run ends.
test('a keyword is retired once its results stop scrolling', async () => {
  const driver = driverWithSearch();
  const same = { screen: 'search_results', results: ['alpha'], targets: { back: BACK } };
  const views = [
    ...OPEN_SEARCH, same,
    { screen: 'search_results', targets: {} },   // the hop bails, nobody sourced
    ...Array(60).fill(same),                     // every deeper look is identical
  ];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 6 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0);
  const searches = driver.ops.filter((o) => o[0] === 'submitSearch').length;
  assert.ok(searches <= 4, `retired the keyword promptly, ran ${searches} searches`);
});

// A keyword whose results fit on ONE screen must still retire — the at-end check
// compares against the page being scrolled away from, not only against a
// previous scroll, or a short results page loops forever.
test('a single-screen results page still retires', async () => {
  const driver = driverWithSearch();
  const one = { screen: 'search_results', results: [], targets: { back: BACK } };
  const views = [...OPEN_SEARCH, ...Array(60).fill(one)];
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 6 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0, 'terminated instead of spinning');
});

// A control permanently missing must not spin the pass loop forever — the skip
// path used to bypass the retirement bookkeeping entirely.
test('a keyword that can never be typed is retired, not retried forever', async () => {
  const driver = driverWithSearch();
  const views = Array(80).fill({ screen: 'unknown', targets: {} });
  const out = [];
  const gen = scout({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['coach'], max: 6 }, read: scriptedRead(views),
  });
  for await (const c of gen) out.push(c);

  assert.strictEqual(out.length, 0);
  const opens = driver.ops.filter((o) => o[0] === 'openApp').length;
  assert.ok(opens <= 6, `bounded recovery attempts, saw ${opens} launches`);
});
