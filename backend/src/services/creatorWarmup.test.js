'use strict';

const test = require('node:test');
const assert = require('node:assert');
const warmup = require('./creatorWarmup');

const policy = (o = {}) => ({ enabled: true, maxLikes: 10, dwellMs: 0, ...o });

function driver() {
  const ops = [];
  return {
    ops,
    tap: async (x, y) => ops.push(['tap', x, y]),
    back: async () => ops.push(['back']),
    openProfile: async (h) => ops.push(['openProfile', h]),
  };
}
const scripted = (views) => { let i = 0; return async () => views[Math.min(i++, views.length - 1)]; };
const reel = (author, extra = {}) => ({
  screen: 'reels_feed', author, alreadyLiked: false, targets: { like: { x: 1, y: 1 }, share: { x: 2, y: 2 } }, ...extra,
});

test('likes the creator\'s reel the phone is standing on — and nothing else', async () => {
  const drv = driver();
  const counters = warmup.newCounters();
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia')]), handle: '@Mia', policy: policy(), counters, pacingMs: 0,
  });
  assert.deepStrictEqual(out, { liked: true });
  assert.deepStrictEqual(drv.ops, [['tap', 1, 1]], 'one tap, on the like button; never the share button');
  assert.deepStrictEqual(counters, { likes: 1, blocked: false });
});

test('an already-liked reel is not tapped again', async () => {
  const drv = driver();
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia', { alreadyLiked: true })]), handle: 'mia', policy: policy(), pacingMs: 0,
  });
  assert.deepStrictEqual(out, { liked: true, alreadyLiked: true });
  assert.strictEqual(drv.ops.length, 0);
});

test('away from their reel, it opens their profile and likes their newest reel', async () => {
  const drv = driver();
  const read = scripted([
    { screen: 'search_results' },
    { screen: 'profile', username: 'mia', reels: [], targets: { reelsTab: { x: 5, y: 5 } } },
    { screen: 'reels_tab', username: 'mia', reels: [{ views: 10, point: { x: 7, y: 7 } }] },
    reel('mia'),
  ]);
  const out = await warmup.warmCreator({ driver: drv, read, handle: 'mia', policy: policy(), pacingMs: 0 });
  assert.strictEqual(out.liked, true);
  assert.deepStrictEqual(drv.ops, [['openProfile', 'mia'], ['tap', 5, 5], ['tap', 7, 7], ['tap', 1, 1]]);
});

test('someone else\'s reel is never liked', async () => {
  const drv = driver();
  drv.openProfile = undefined;
  const out = await warmup.warmCreator({ driver: drv, read: scripted([reel('other')]), handle: 'mia', policy: policy(), pacingMs: 0 });
  assert.strictEqual(out.liked, false);
  assert.strictEqual(drv.ops.length, 0);
});

test('a reel with no like button is left alone', async () => {
  const drv = driver();
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia', { targets: {} })]), handle: 'mia', policy: policy(), pacingMs: 0,
  });
  assert.strictEqual(out.liked, false);
  assert.match(out.reason, /no like button/);
});

test('an action-blocked screen stops liking for the rest of the run', async () => {
  const counters = warmup.newCounters();
  const read = scripted([reel('mia'), { screen: 'action_blocked' }]);
  const out = await warmup.warmCreator({ driver: driver(), read, handle: 'mia', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(out.blocked, true);
  assert.strictEqual(counters.blocked, true);
  const next = await warmup.warmCreator({ driver: driver(), read: scripted([reel('joe')]), handle: 'joe', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(next.liked, false);
  assert.match(next.reason, /blocked/);
});

test('the run\'s like cap holds across creators', async () => {
  const counters = { likes: 10, blocked: false };
  const out = await warmup.warmCreator({ driver: driver(), read: scripted([reel('mia')]), handle: 'mia', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(out.liked, false);
  assert.match(out.reason, /like cap/);
});

test('policy from env: on by default, SOURCING_WARM=off turns it off', () => {
  assert.deepStrictEqual(warmup.loadPolicy({}), { enabled: true, maxLikes: 40, dwellMs: 2000 });
  assert.strictEqual(warmup.loadPolicy({ SOURCING_WARM: 'off' }).enabled, false);
  assert.strictEqual(warmup.loadPolicy({ SOURCING_WARM_MAX_LIKES: '12' }).maxLikes, 12);
});
