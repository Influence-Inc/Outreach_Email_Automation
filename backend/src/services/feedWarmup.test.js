'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { warmFeed } = require('./feedWarmup');

function fakeDriver() {
  const ops = [];
  return {
    ops,
    openApp: async (p) => ops.push(['openApp', p]),
    tap: async (x, y) => ops.push(['tap', x, y]),
    swipe: async () => ops.push(['swipe']),
    back: async () => ops.push(['back']),
    getWindowSize: async () => ({ width: 1080, height: 2400 }),
  };
}

const LIKE = { x: 1000, y: 1200 };
const NAV = { screen: 'reels_feed', targets: { reelsNavTab: { x: 500, y: 2300 } } };

// A reel in the feed by `author`.
const reel = (author, over = {}) => ({
  screen: 'reels_feed',
  author,
  targets: { like: LIKE },
  ...over,
});

function scriptedRead(views) {
  let i = 0;
  return async () => views[i++] || { screen: 'unknown', targets: {} };
}

const always = { rng: () => 0 };   // every dice roll passes
const never = { rng: () => 1 };    // every dice roll fails

// ── the rule that makes warming worth doing ─────────────────────────────────

// Liking on a raw niche score teaches the feed our KEYWORDS. Liking a creator who
// passed the gate teaches it our TASTE.
test('only gate-passed creators are liked', async () => {
  const driver = fakeDriver();
  const views = [NAV, reel('goodcoach'), reel('randomstranger'), reel('goodcoach2')];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });

  assert.strictEqual(stats.liked, 1);
  assert.strictEqual(stats.skipped.notApproved, 2);
  assert.strictEqual(driver.ops.filter((o) => o[0] === 'tap' && o[1] === LIKE.x).length, 1);
});

test('handles are matched regardless of case or a leading @', async () => {
  const driver = fakeDriver();
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['@GoodCoach'],
    read: scriptedRead([NAV, reel('goodcoach')]),
    deps: always,
  });
  assert.strictEqual(stats.liked, 1);
});

test('an approved set can be a Set as well as an array', async () => {
  const driver = fakeDriver();
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: new Set(['goodcoach']),
    read: scriptedRead([NAV, reel('goodcoach')]),
    deps: always,
  });
  assert.strictEqual(stats.liked, 1);
});

// Nothing approved means there is nothing to teach the feed, so this must not
// spend ten minutes scrolling to like nobody.
test('no gate-passed creators means the pass does nothing at all', async () => {
  const driver = fakeDriver();
  const stats = await warmFeed({
    driver, config: { pacingMs: 0 }, approved: [], read: scriptedRead([NAV, reel('x')]),
  });
  assert.strictEqual(stats.liked, 0);
  assert.strictEqual(driver.ops.length, 0, 'never even opened the app');
});

// ── risk posture ────────────────────────────────────────────────────────────

// The one signal that means stop immediately.
test('an action-blocked screen stops the pass dead', async () => {
  const driver = fakeDriver();
  const views = [NAV, reel('goodcoach'), { screen: 'action_blocked', targets: {} }, reel('goodcoach')];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });

  assert.strictEqual(stats.blocked, true);
  assert.strictEqual(stats.liked, 1, 'stopped at the block rather than carrying on');
});

test('the like cap is hard', async () => {
  const driver = fakeDriver();
  const views = [NAV, ...Array(20).fill(reel('goodcoach'))];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0, maxLikes: 3 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });
  assert.strictEqual(stats.liked, 3);
});

test('the reel cap bounds the pass even when nothing is likeable', async () => {
  const driver = fakeDriver();
  const views = [NAV, ...Array(200).fill(reel('stranger'))];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0, maxReels: 5 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });
  assert.strictEqual(stats.seen, 5);
  assert.strictEqual(stats.liked, 0);
});

// "Likes every approved reel" is itself a recognisable pattern.
test('not every approved reel is liked', async () => {
  const driver = fakeDriver();
  const views = [NAV, ...Array(6).fill(reel('goodcoach'))];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: never,
  });
  assert.strictEqual(stats.liked, 0);
  assert.strictEqual(stats.skipped.dice, 6);
});

test('an already-liked reel is never re-liked', async () => {
  const driver = fakeDriver();
  const views = [NAV, reel('goodcoach', { alreadyLiked: true })];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });
  assert.strictEqual(stats.liked, 0);
  assert.strictEqual(stats.skipped.alreadyLiked, 1);
});

// Liking an ad teaches the feed to show more ads.
test('a sponsored reel is never liked, even by an approved creator', async () => {
  const driver = fakeDriver();
  const views = [NAV, reel('goodcoach', { sponsored: true })];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });
  assert.strictEqual(stats.liked, 0);
});

// Likes only. A share needs a recipient and can send something to a real person.
test('the pass never shares or saves', async () => {
  const driver = fakeDriver();
  const views = [NAV, ...Array(4).fill(reel('goodcoach', {
    targets: { like: LIKE, save: { x: 1, y: 2 }, share: { x: 3, y: 4 } },
  }))];
  await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });

  const taps = driver.ops.filter((o) => o[0] === 'tap').map((o) => `${o[1]},${o[2]}`);
  assert.ok(!taps.includes('1,2'), 'never saved');
  assert.ok(!taps.includes('3,4'), 'never shared');
});

// ── staying where it belongs ─────────────────────────────────────────────────

test('leaving the reels feed ends the pass', async () => {
  const driver = fakeDriver();
  const views = [NAV, reel('goodcoach'), { screen: 'profile', targets: {} }, reel('goodcoach')];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });
  assert.strictEqual(stats.liked, 1, 'did not carry on after falling out of the feed');
});

test('no Reels tab means the feed is left alone', async () => {
  const driver = fakeDriver();
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead([{ screen: 'search', targets: {} }]),
    deps: always,
  });
  assert.strictEqual(stats.liked, 0);
  assert.strictEqual(driver.ops.filter((o) => o[0] === 'tap').length, 0);
});

// A sheet over the feed swallows the like tap.
test('a sheet on the way in is cleared first', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'reels_feed', dialog: { label: 'not now', point: { x: 540, y: 1900 } }, targets: {} },
    NAV,
    reel('goodcoach'),
  ];
  const stats = await warmFeed({
    driver,
    config: { pacingMs: 0, dwellMs: 0 },
    approved: ['goodcoach'],
    read: scriptedRead(views),
    deps: always,
  });

  assert.ok(driver.ops.some((o) => o[0] === 'tap' && o[1] === 540 && o[2] === 1900), 'dismissed it');
  assert.strictEqual(stats.liked, 1);
});

// A reel is watched before it is liked — a like fired the instant one appears is
// not something a person does.
test('a reel is dwelled on before being liked', async () => {
  const driver = fakeDriver();
  const waits = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    await warmFeed({
      driver,
      config: { pacingMs: 0, dwellMs: 4000 },
      approved: ['goodcoach'],
      read: scriptedRead([NAV, reel('goodcoach')]),
      deps: always,
    });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(waits.some((ms) => ms > 1000), `dwelled before liking (waits: ${waits.join(',')})`);
});
