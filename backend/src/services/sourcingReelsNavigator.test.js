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
    // enterReelsFeed: one read, then tap the bottom-nav Reels button
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
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

// Reels mode means Instagram's OWN reel feed. Routing through search (or worse,
// Explore) sources creators from a different surface entirely.
test('enters via the bottom-nav Reels button, never through search', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 }, searchTab: { x: 300, y: 2300 } } },
    { screen: 'reels_feed', author: 'mia', caption: 'gym', targets: { like: { x: 9, y: 9 } } },
    { screen: 'home', targets: {} }, // ends the loop
  ];
  const deps = {
    judge: async () => ({ score: 0.9 }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({ driver, config: { pacingMs: 0 }, opts: { keywords: ['homegym'], max: 1 }, read: scriptedRead(views), deps })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 1);
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 540 && o[2] === 2300),
    'tapped the bottom-nav Reels button',
  );
  assert.ok(!driver.ops.some((o) => o[0] === 'type'), 'never typed a search query');
  assert.ok(
    !driver.ops.some((o) => o[0] === 'tap' && o[1] === 300 && o[2] === 2300),
    'never tapped the search tab',
  );
});

test('stops immediately on an action_blocked screen (backoff)', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
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
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
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

// A reel in the feed carries no view count, so judging alone could never answer
// "does this creator clear the floor?" — the reach rules had nothing to measure.
test('opens the creator and scrolls their reels grid for reach', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    // the reel, with a tap target for its author
    { screen: 'reels_feed', author: 'mia', caption: 'gym', targets: { authorProfile: { x: 200, y: 1800 }, like: { x: 9, y: 9 } } },
    // analyseProfile: header -> reels tab -> grid -> scrolled grid
    { screen: 'profile', followers: 84000, fullName: 'Mia', bio: 'coach', targets: { reelsTab: { x: 400, y: 500 }, back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 30000 }, { views: 41000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 52000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 52000 }], targets: { back: { x: 3, y: 3 } } },
    // backTo the feed
    { screen: 'reels_feed', author: 'mia', targets: { back: { x: 3, y: 3 } } },
    { screen: 'home', targets: {} }, // ends the loop
  ];
  const deps = {
    judge: async () => ({ score: 0.9, reason: 'on-brand' }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0, reelsWindow: 12 }, opts: { keywords: ['x'], max: 1 },
    read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 1);
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 200 && o[2] === 1800),
    'opened the creator from the reel',
  );
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 400 && o[2] === 500),
    'switched to the profile Reels tab, where view counts live',
  );
  // Reach the scoring rules can actually measure, collected across a scroll.
  assert.deepStrictEqual(out[0].reels.map((r) => r.views), [30000, 41000, 52000]);
  assert.strictEqual(out[0].followers, 84000);
  assert.strictEqual(out[0].username, 'mia');
  // and the AI verdict is still reused downstream
  assert.ok(out[0]._nicheVerdict);
});

test('a creator with no author target still yields the judged reel', async () => {
  const driver = fakeDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    { screen: 'reels_feed', author: 'mia', caption: 'gym', targets: { like: { x: 9, y: 9 } } },
    { screen: 'home', targets: {} },
  ];
  const deps = {
    judge: async () => ({ score: 0.8 }),
    getClip: async () => null,
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 1, 'profile analysis is enrichment, not a gate');
  assert.strictEqual(out[0].username, 'mia');
});

// One reel whose author the reader could not name used to look identical to
// "the feed is over" — so a feed run ended after a single scroll.
test('an unreadable reel is skipped, not treated as the end of the feed', async () => {
  const driver = fakeDriver();
  const readable = {
    screen: 'reels_feed', author: 'mia', caption: 'gym',
    targets: { authorProfile: { x: 200, y: 1800 }, like: { x: 9, y: 9 } },
  };
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    { screen: 'reels_feed', targets: {} },            // no author -> skip + scroll
    { screen: 'reels_feed', targets: {} },            // still nothing -> skip + scroll
    readable,                                          // now readable
    { screen: 'profile', followers: 5000, targets: { reelsTab: { x: 4, y: 5 }, back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 60000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 60000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_feed', author: 'mia', targets: { back: { x: 3, y: 3 } } },
    { screen: 'home', targets: {} },
  ];
  const deps = {
    judge: async () => ({ score: 0.9 }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 1, 'kept scrolling past the unreadable reels and found a creator');
  assert.ok(
    driver.ops.filter((o) => o[0] === 'swipe').length >= 2,
    'scrolled past each unreadable reel rather than stopping',
  );
});

test('an endless run of unreadable reels eventually stops', async () => {
  const driver = fakeDriver();
  const blank = { screen: 'reels_feed', targets: {} };
  const views = [{ screen: 'home', targets: { reelsNavTab: { x: 1, y: 1 } } }, ...Array(40).fill(blank)];
  const deps = {
    judge: async () => null,
    getClip: async () => null,
    engagement: { policy: { enabled: false }, decide: () => ({ like: false, save: false, share: false }) },
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 5 }, read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 0);
  assert.ok(driver.ops.filter((o) => o[0] === 'swipe').length < 20, 'bounded, not infinite');
});
