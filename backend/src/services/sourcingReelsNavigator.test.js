'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scoutReels } = require('./sourcingReelsNavigator');

function fakeDriver() {
  const ops = [];
  return {
    ops,
    openApp: async (p) => ops.push(['openApp', p]),
    tap: async (x, y) => ops.push(['tap', x, y]),
    typeText: async (t) => ops.push(['type', t]),
    swipe: async (o) => ops.push(['swipe', o]),
    getWindowSize: async () => ({ width: 1080, height: 2400 }),
    recordClip: async (seconds) => ({ clipId: `clip_${seconds}` }),
  };
}

function scriptedRead(views) {
  let i = 0;
  return async () => views[i++] || { screen: 'unknown', targets: {} };
}

test('scrolls the feed, records + judges each reel, engages strong matches only', async () => {
  const driver = fakeDriver();
  const views = [
    // enterReelsFeed: search tab, search box, results
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: ['tag'], targets: { 'result:tag': { x: 2, y: 2 } } },
    // reel 1 (strong match) then reel 2 (weak), then off the feed
    { screen: 'reels_feed', author: 'mia', caption: 'gym', alreadyLiked: false, alreadySaved: false, targets: { like: { x: 9, y: 9 }, save: { x: 9, y: 10 } } },
    { screen: 'reels_feed', author: 'joe', caption: 'travel', alreadyLiked: false, alreadySaved: false, targets: { like: { x: 9, y: 9 } } },
  ];
  const clips = { clip_12: { buf: Buffer.from('MP4'), mediaType: 'video/mp4' } };
  const judged = [];
  const deps = {
    judge: async (c) => { judged.push(c.username); return { score: c.username === 'mia' ? 0.9 : 0.2, reason: 'g', source: 'gemini-video' }; },
    getClip: async (id) => clips[id] || null,
    engagement: { policy: { enabled: true }, decide: ({ score }) => ({ like: score >= 0.75, save: false, share: false }) },
    rng: () => 0,
  };
  const out = [];
  for await (const c of scoutReels({ driver, config: { pacingMs: 0, clipSeconds: 12 }, opts: { keywords: ['x'], max: 2 }, read: scriptedRead(views), deps })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(judged, ['mia', 'joe']);
  assert.strictEqual(out[0].username, 'mia');
  assert.strictEqual(out[0].clip.dataBase64, Buffer.from('MP4').toString('base64'));
  assert.ok(out[0]._nicheVerdict, 'verdict stashed for reuse downstream');

  // liked mia (0.9) but not joe (0.2)
  const likeTaps = driver.ops.filter((o) => o[0] === 'tap' && o[1] === 9 && o[2] === 9);
  assert.strictEqual(likeTaps.length, 1);
  // scrolled between reels
  assert.ok(driver.ops.some((o) => o[0] === 'swipe'));
});

test('stops immediately on an action_blocked screen (backoff)', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: [], targets: {} },
    { screen: 'action_blocked', targets: {} },
  ];
  const deps = {
    judge: async () => null,
    getClip: async () => null,
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({ driver, config: { pacingMs: 0 }, opts: { keywords: ['x'] }, read: scriptedRead(views), deps })) {
    out.push(c);
  }
  assert.strictEqual(out.length, 0);
});

test('does not engage when the policy is disabled (watch-only)', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'search', targets: { searchTab: { x: 1, y: 1 } } },
    { screen: 'search', targets: { searchBox: { x: 1, y: 1 } } },
    { screen: 'search_results', results: ['t'], targets: { 'result:t': { x: 2, y: 2 } } },
    { screen: 'reels_feed', author: 'mia', caption: 'gym', targets: { like: { x: 9, y: 9 } } },
  ];
  const deps = {
    judge: async () => ({ score: 1, reason: 'g' }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({ driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views), deps })) {
    out.push(c);
  }
  assert.strictEqual(out.length, 1);
  assert.ok(!driver.ops.some((o) => o[0] === 'tap' && o[1] === 9 && o[2] === 9), 'no like tap when disabled');
});
