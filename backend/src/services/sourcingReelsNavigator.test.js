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
// "does this creator clear the floor?". The profile is now opened DIRECTLY from
// the handle during the batch's handle phase, not tapped through from the reel.
test('opens the creator directly and scrolls their reels grid for reach', async () => {
  const driver = fakeDriver();
  const opened = [];
  driver.openProfile = async (u) => { opened.push(u); };
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    // collect: one reel fills the batch (max=1), so the phase ends here
    { screen: 'reels_feed', author: 'mia', caption: 'gym', targets: { like: { x: 9, y: 9 } } },
    // handle: profile opened by handle
    { screen: 'profile', followers: 84000, fullName: 'Mia', bio: 'coach', targets: { reelsTab: { x: 400, y: 500 }, back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 30000 }, { views: 41000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 52000 }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: 52000 }], targets: { back: { x: 3, y: 3 } } },
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
  assert.deepStrictEqual(opened, ['mia'], 'went straight to the profile by handle');
  assert.ok(
    driver.ops.some((o) => o[0] === 'tap' && o[1] === 400 && o[2] === 500),
    'switched to the profile Reels tab, where view counts live',
  );
  assert.deepStrictEqual(out[0].reels.map((r) => r.views), [30000, 41000, 52000]);
  assert.strictEqual(out[0].followers, 84000);
  assert.strictEqual(out[0].username, 'mia');
  assert.ok(out[0]._nicheVerdict, 'the async verdict was attached');
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

// ── batching: collect, then handle, then return once ────────────────────────

function batchDriver() {
  const d = fakeDriver();
  d.opened = [];
  d.openProfile = async (u) => { d.opened.push(u); d.ops.push(['openProfile', u]); };
  // fakeDriver's recordClip is silent; these tests need it in the op log so the
  // ordering of "record everything, then open profiles" is observable.
  d.recordClip = async (seconds) => {
    d.ops.push(['recordClip', seconds]);
    return { clipId: `clip_${seconds}` };
  };
  return d;
}

function feedReel(author) {
  return { screen: 'reels_feed', author, caption: `${author} caption`, targets: { like: { x: 9, y: 9 } } };
}

function profileViews(followers) {
  return [
    { screen: 'profile', followers, targets: { reelsTab: { x: 400, y: 500 }, back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: followers }], targets: { back: { x: 3, y: 3 } } },
    { screen: 'reels_tab', reels: [{ views: followers }], targets: { back: { x: 3, y: 3 } } },
  ];
}

const quietEngagement = {
  policy: { enabled: false },
  decide: () => ({ like: false, save: false, share: false }),
};

// The whole point of the reorder: the unreliable "find your place in the feed
// again" step happens once per batch, not once per creator.
test('collects the whole batch before opening any profile', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    feedReel('alpha'),
    feedReel('beta'),
    feedReel('gamma'),
    ...profileViews(10000),
    ...profileViews(20000),
    ...profileViews(30000),
  ];
  const deps = {
    judge: async () => ({ score: 0.8 }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: quietEngagement,
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0, batchSize: 3 }, opts: { keywords: ['x'], max: 3 },
    read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(driver.opened, ['alpha', 'beta', 'gamma']);

  // Every recording happens before the first profile is opened.
  const kinds = driver.ops.map((o) => o[0]);
  const lastRecord = kinds.lastIndexOf('recordClip');
  const firstOpen = kinds.indexOf('openProfile');
  assert.ok(lastRecord < firstOpen, 'collected everything first, then handled the batch');
});

test('profiles are opened by handle, never tapped through from a reel', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    feedReel('alpha'),
    ...profileViews(10000),
  ];
  const deps = { judge: async () => null, getClip: async () => null, engagement: quietEngagement };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.deepStrictEqual(driver.opened, ['alpha']);
  assert.strictEqual(out[0].username, 'alpha');
});

// §8 — checked the moment a handle is read, before recording anything.
test('a creator already handled costs one swipe and no recording', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 1, y: 1 } } },
    feedReel('alpha'),
    feedReel('alpha'),   // same creator again
    feedReel('alpha'),
    feedReel('beta'),
    ...profileViews(10000),
    ...profileViews(20000),
  ];
  const deps = { judge: async () => null, getClip: async () => null, engagement: quietEngagement };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0, batchSize: 2 }, opts: { keywords: ['x'], max: 2 },
    read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.deepStrictEqual(out.map((c) => c.username), ['alpha', 'beta']);
  assert.strictEqual(
    driver.ops.filter((o) => o[0] === 'recordClip').length, 2,
    'the repeats were skipped before any recording',
  );
});

// §6's stated test: throughput must not depend on the analysis service.
test('collecting runs at the same speed when analysis never returns', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 1, y: 1 } } },
    feedReel('alpha'),
    feedReel('beta'),
    ...profileViews(10000),
    ...profileViews(20000),
  ];
  const deps = {
    // A judge that never settles — the service is down.
    judge: () => new Promise(() => {}),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: quietEngagement,
  };

  const began = Date.now();
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0, batchSize: 2 }, opts: { keywords: ['x'], max: 2 },
    read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }
  const elapsed = Date.now() - began;

  assert.strictEqual(out.length, 2, 'both creators still sourced');
  assert.ok(elapsed < 4000, `never blocked on the judge, took ${elapsed}ms`);
  assert.strictEqual(out[0]._nicheVerdict, undefined, 'no verdict yet');
  assert.strictEqual(out[0].evidence.analysis, 'incomplete', 'and it says so');
});

// Deterministic on purpose: the judge settles on the first microtask, so it is
// certainly ready by the time the handle phase reaches this creator. Racing a
// real timer here would only test the scheduler.
test('a verdict that landed by handling time is attached', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 1, y: 1 } } },
    feedReel('alpha'),
    ...profileViews(10000),
  ];
  const deps = {
    judge: async () => ({ score: 0.77 }),
    getClip: async () => ({ buf: Buffer.from('X'), mediaType: 'video/mp4' }),
    engagement: quietEngagement,
  };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { keywords: ['x'], max: 1 }, read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  assert.deepStrictEqual(out[0]._nicheVerdict, { score: 0.77 });
  assert.notStrictEqual(out[0].evidence.analysis, 'incomplete');
});

test('the feed is re-entered once per batch, not once per creator', async () => {
  const driver = batchDriver();
  const views = [
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    feedReel('alpha'),
    feedReel('beta'),
    ...profileViews(10000),
    ...profileViews(20000),
    // second batch: re-enter the feed, then nothing left
    { screen: 'home', targets: { reelsNavTab: { x: 540, y: 2300 } } },
    { screen: 'home', targets: {} },
  ];
  const deps = { judge: async () => null, getClip: async () => null, engagement: quietEngagement };
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0, batchSize: 2 }, opts: { keywords: ['x'], max: 10 },
    read: scriptedRead(views), deps,
  })) {
    out.push(c);
  }

  const navTaps = driver.ops.filter((o) => o[0] === 'tap' && o[1] === 540 && o[2] === 2300).length;
  assert.strictEqual(out.length, 2);
  assert.strictEqual(navTaps, 2, 'entered once at the start, re-entered once after the batch');
});

// ── surviving a long run (§9) ───────────────────────────────────────────────

// An ad is a brand buying placement. Recording and judging one spends a clip
// and a Gemini call to discover the account behind it is a competitor.
test('a sponsored reel is skipped before anything is recorded', async () => {
  const driver = fakeDriver();
  driver.recordClip = async (seconds) => {
    driver.ops.push(['recordClip', seconds]);
    return { clipId: `clip_${seconds}` };
  };
  const views = [
    { screen: 'reels_feed', targets: { reelsNavTab: { x: 5, y: 9 } } },
    { screen: 'reels_feed', author: 'somebrand', sponsored: true, targets: {} },
    { screen: 'reels_feed', author: 'realcoach', caption: 'gym', targets: {} },
    { screen: 'profile', followers: 9000, targets: {} },
    { screen: 'reels_tab', reels: [{ views: 5000 }], targets: {} },
    { screen: 'reels_tab', reels: [{ views: 5000 }], targets: {} },
    { screen: 'unknown', targets: {} },
  ];
  const out = [];
  for await (const c of scoutReels({
    driver, config: { pacingMs: 0 }, opts: { max: 1 }, read: scriptedRead(views),
    deps: { getClip: async () => ({ dataBase64: 'AA', mediaType: 'video/mp4' }) },
  })) out.push(c);

  assert.strictEqual(driver.ops.filter((o) => o[0] === 'recordClip').length, 1, 'only the real creator');
  assert.deepStrictEqual(out.map((c) => c.username), ['realcoach']);
});

// targetCount bounds how many creators a run ADDS, not how many it looks at.
test('the profile cap stops a run that keeps finding nothing', async () => {
  const driver = fakeDriver();
  const reel = (author) => ({ screen: 'reels_feed', author, caption: 'x', targets: {} });
  const views = [
    { screen: 'reels_feed', targets: { reelsNavTab: { x: 5, y: 9 } } },
    reel('a'), reel('b'), reel('c'), reel('d'), reel('e'),
    ...Array(20).fill({ screen: 'unknown', targets: {} }),
  ];
  const out = [];
  for await (const c of scoutReels({
    driver,
    config: { pacingMs: 0, maxProfiles: 2 },
    opts: { max: 50 },
    read: scriptedRead(views),
    deps: { getClip: async () => null },
  })) out.push(c);

  assert.ok(out.length <= 2, `stopped at the cap, got ${out.length}`);
});
