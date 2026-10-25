'use strict';

const test = require('node:test');
const assert = require('node:assert');
const warmup = require('./creatorWarmup');

const policy = (o = {}) => ({ enabled: true, maxLikes: 10, maxShares: 10, shareTo: null, dwellMs: 0, ...o });
const box = (x, y) => ({ x, y, w: 10, h: 10 });

function driver(dumps = []) {
  const ops = [];
  let d = 0;
  return {
    ops,
    tap: async (x, y) => ops.push(['tap', x, y]),
    typeText: async (t) => ops.push(['type', t]),
    back: async () => ops.push(['back']),
    swipe: async () => ops.push(['swipe']),
    openProfile: async (h) => ops.push(['openProfile', h]),
    dumpUi: async () => dumps[d++] || [],
  };
}
const scripted = (views) => { let i = 0; return async () => views[Math.min(i++, views.length - 1)]; };
const reel = (author, extra = {}) => ({
  screen: 'reels_feed', author, alreadyLiked: false, targets: { like: { x: 1, y: 1 }, share: { x: 2, y: 2 } }, ...extra,
});

test('likes and shares the creator\'s reel the phone is standing on (copy link without a recipient)', async () => {
  const drv = driver([[{ text: 'Copy link', bounds: box(100, 100) }]]);
  const counters = warmup.newCounters();
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia')]), handle: '@Mia', policy: policy(), counters, pacingMs: 0,
  });
  assert.strictEqual(out.liked, true);
  assert.strictEqual(out.shared, true);
  assert.strictEqual(out.how, 'copy link');
  assert.deepStrictEqual(drv.ops.slice(0, 3), [['tap', 1, 1], ['tap', 2, 2], ['tap', 105, 105]]);
  assert.deepStrictEqual(counters, { likes: 1, shares: 1, blocked: false });
});

test('shares to the team account in a DM when SOURCING_SHARE_TO is set — exact handle only', async () => {
  const drv = driver([
    [{ cls: 'android.widget.EditText', text: 'Search', bounds: box(0, 0) }],
    [{ text: 'influence.team.share', bounds: box(0, 50) }, { text: 'influence.team.shared.fan', bounds: box(0, 80) }],
    [{ desc: 'Send', bounds: box(0, 200) }],
  ]);
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia')]), handle: 'mia', policy: policy({ shareTo: 'influence.team.share' }), pacingMs: 0,
  });
  assert.strictEqual(out.shared, true);
  assert.strictEqual(out.how, 'sent to @influence.team.share');
  assert.ok(drv.ops.some((o) => o[0] === 'type' && o[1] === 'influence.team.share'));
  assert.ok(drv.ops.some((o) => o[0] === 'tap' && o[2] === 55), 'tapped the exact recipient');
  assert.ok(!drv.ops.some((o) => o[0] === 'tap' && o[2] === 85), 'never a look-alike');
});

test('a share sheet without the recipient backs out and keeps the like', async () => {
  const drv = driver([
    [{ cls: 'EditText', bounds: box(0, 0) }],
    [{ text: 'someone.else', bounds: box(0, 50) }],
  ]);
  const read = scripted([reel('mia'), reel('mia'), { screen: 'share_sheet' }, reel('mia')]);
  const out = await warmup.warmCreator({
    driver: drv, read, handle: 'mia', policy: policy({ shareTo: 'team' }), pacingMs: 0,
  });
  assert.strictEqual(out.liked, true);
  assert.strictEqual(out.shared, false);
  assert.match(out.reason, /@team not found/);
  assert.ok(drv.ops.some((o) => o[0] === 'back'), 'closed the sheet');
});

test('an already-liked reel is not tapped again', async () => {
  const drv = driver([[]]);
  const out = await warmup.warmCreator({
    driver: drv, read: scripted([reel('mia', { alreadyLiked: true })]), handle: 'mia', policy: policy({ maxShares: 0 }), pacingMs: 0,
  });
  assert.strictEqual(out.liked, true);
  assert.strictEqual(out.alreadyLiked, true);
  assert.strictEqual(drv.ops.filter((o) => o[0] === 'tap').length, 0);
});

test('away from their reel, it opens their profile and their newest reel', async () => {
  const drv = driver([[{ text: 'Copy link', bounds: box(9, 9) }]]);
  const read = scripted([
    { screen: 'search_results' },
    { screen: 'profile', username: 'mia', reels: [], targets: { reelsTab: { x: 5, y: 5 } } },
    { screen: 'reels_tab', username: 'mia', reels: [{ views: 10, point: { x: 7, y: 7 } }] },
    reel('mia'),
  ]);
  const out = await warmup.warmCreator({ driver: drv, read, handle: 'mia', policy: policy(), pacingMs: 0 });
  assert.strictEqual(out.liked, true);
  assert.deepStrictEqual(drv.ops.slice(0, 3), [['openProfile', 'mia'], ['tap', 5, 5], ['tap', 7, 7]]);
});

test('someone else\'s reel is never liked', async () => {
  const drv = driver();
  drv.openProfile = undefined;
  const out = await warmup.warmCreator({ driver: drv, read: scripted([reel('other')]), handle: 'mia', policy: policy(), pacingMs: 0 });
  assert.strictEqual(out.liked, false);
  assert.strictEqual(drv.ops.length, 0);
});

test('an action-blocked screen stops warming for the rest of the run', async () => {
  const counters = warmup.newCounters();
  const read = scripted([reel('mia'), { screen: 'action_blocked' }]);
  const out = await warmup.warmCreator({ driver: driver(), read, handle: 'mia', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(out.blocked, true);
  assert.strictEqual(counters.blocked, true);
  const next = await warmup.warmCreator({ driver: driver(), read: scripted([reel('joe')]), handle: 'joe', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(next.liked, false);
  assert.match(next.reason, /blocked/);
});

test('the run\'s caps hold across creators', async () => {
  const counters = { likes: 10, shares: 10, blocked: false };
  const out = await warmup.warmCreator({ driver: driver(), read: scripted([reel('mia')]), handle: 'mia', policy: policy(), counters, pacingMs: 0 });
  assert.strictEqual(out.liked, false);
  assert.match(out.reason, /caps/);
});

test('policy from env: on by default, SOURCING_WARM=off turns it off', () => {
  assert.strictEqual(warmup.loadPolicy({}).enabled, true);
  assert.strictEqual(warmup.loadPolicy({ SOURCING_WARM: 'off' }).enabled, false);
  assert.strictEqual(warmup.loadPolicy({ SOURCING_SHARE_TO: ' @Team.Account ' }).shareTo, 'team.account');
  assert.strictEqual(warmup.loadPolicy({}).shareTo, null);
});
