'use strict';

// Exercises the runner main loop end-to-end without a phone: MockDriver +
// MockScreenReader feed the navigator, a stub backend collects the batches, and
// we assert the loop respects target reached / stopped / daily cap.

const test = require('node:test');
const assert = require('node:assert');
const { MockDriver } = require('./driver/mock');
const { MockScreenReader } = require('./navigator/screenReader');
const { runOnce, runForever } = require('./main');

function twoProfileFixture() {
  const screens = [
    { name: 'home', advanceOn: 'tap' },
    { name: 'search-empty', advanceOn: 'tap' },
    { name: 'search-focused', advanceOn: 'type' },
    { name: 'search-typed', advanceOn: 'tap' },
    { name: 'profile-A', advanceOn: 'tap' },
    { name: 'reels-A', advanceOn: 'tap' },
    { name: 'back-from-A', advanceOn: 'tap' },
    { name: 'profile-B', advanceOn: 'tap' },
    { name: 'reels-B', advanceOn: 'tap' },
    { name: 'back-from-B', advanceOn: 'tap' },
    { name: 'home-again' },
  ];
  const readings = {
    home: { targets: { searchTab: { x: 100, y: 900 } } },
    'search-empty': { targets: { searchBox: { x: 200, y: 80 } } },
    'search-focused': { targets: { searchBox: { x: 200, y: 80 } } },
    'search-typed': {
      results: ['coach.a', 'coach.b'],
      targets: {
        'result:coach.a': { x: 200, y: 200 },
        'result:coach.b': { x: 200, y: 300 },
        back: { x: 30, y: 90 },
      },
    },
    'profile-A': { fullName: 'A', followers: 84000, targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } } },
    'reels-A': { reels: Array(12).fill({ views: 120000, caption: 'gym' }), targets: { back: { x: 30, y: 90 } } },
    'back-from-A': {
      results: ['coach.a', 'coach.b'],
      targets: {
        'result:coach.a': { x: 200, y: 200 },
        'result:coach.b': { x: 200, y: 300 },
        back: { x: 30, y: 90 },
      },
    },
    'profile-B': { fullName: 'B', followers: 41000, targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } } },
    'reels-B': { reels: Array(12).fill({ views: 60000, caption: 'gym' }), targets: { back: { x: 30, y: 90 } } },
    'back-from-B': { results: [], targets: { back: { x: 30, y: 90 } } },
    'home-again': { targets: { searchTab: { x: 100, y: 900 } } },
  };
  return { screens, readings };
}

function stubBackend({ initial }) {
  const posted = [];
  let latest = { ...initial };
  return {
    posted,
    async getRun(_id) { return { run: latest, candidates: [] }; },
    async postCandidates(_id, batch) {
      posted.push(batch);
      latest = { ...latest, found_count: (latest.found_count || 0) + batch.length };
      return { run: latest, results: batch.map((c) => ({ username: c.username, added: true })) };
    },
  };
}

test('runOnce captures via navigator, batches, and posts to backend', async () => {
  const { screens, readings } = twoProfileFixture();
  const driver = new MockDriver({ screens });
  const reader = new MockScreenReader(readings);
  const backend = stubBackend({ initial: { id: 42, status: 'running', target_count: 5, found_count: 0, config: { keywords: ['gym'] } } });
  const { capturedToday } = await runOnce({
    driver, reader, backend,
    config: { runId: 42, batchSize: 1, pacingMs: 0, dailyCap: 100 },
  });
  assert.strictEqual(capturedToday, 2);
  // One-per-batch => two POSTs.
  assert.strictEqual(backend.posted.length, 2);
  assert.strictEqual(backend.posted[0][0].username, 'coach.a');
  assert.strictEqual(backend.posted[1][0].username, 'coach.b');
});

test('runOnce in auto mode pulls the next queued run', async () => {
  const { screens, readings } = twoProfileFixture();
  const driver = new MockDriver({ screens });
  const reader = new MockScreenReader(readings);
  const backend = stubBackend({ initial: { id: 77, status: 'running', target_count: 1, found_count: 0, config: { keywords: ['gym'] } } });
  // In auto mode the runner never calls getRun by id — it asks for the next
  // queued run instead.
  backend.getRun = async () => { throw new Error('should not be called in auto mode'); };
  backend.getNextRun = async () => ({ run: { id: 77, status: 'running', target_count: 1, found_count: 0, config: { keywords: ['gym'] } } });
  const { capturedToday, run } = await runOnce({
    driver, reader, backend,
    config: { runMode: 'auto', batchSize: 1, pacingMs: 0, dailyCap: 100 },
  });
  assert.strictEqual(run.id, 77);
  assert.ok(capturedToday >= 1);
});

test('runOnce in auto mode idles when nothing is queued', async () => {
  const backend = { getNextRun: async () => null };
  const out = await runOnce({
    driver: {}, reader: {}, backend,
    config: { runMode: 'auto', batchSize: 1, pacingMs: 0, dailyCap: 100 },
  });
  assert.strictEqual(out.idle, true);
  assert.strictEqual(out.run, null);
});

test('runOnce stops early when backend flips run to done', async () => {
  const { screens, readings } = twoProfileFixture();
  const driver = new MockDriver({ screens });
  const reader = new MockScreenReader(readings);
  const backend = stubBackend({ initial: { id: 43, status: 'running', target_count: 1, found_count: 0, config: { keywords: ['gym'] } } });
  const origPost = backend.postCandidates;
  backend.postCandidates = async (id, batch) => {
    const r = await origPost(id, batch);
    r.run = { ...r.run, status: 'done' };
    return r;
  };
  const { capturedToday } = await runOnce({
    driver, reader, backend,
    config: { runId: 43, batchSize: 1, pacingMs: 0, dailyCap: 100 },
  });
  assert.strictEqual(capturedToday, 1, 'stops after first captured candidate once run flips done');
});

// runForever is what makes RUNNER_RUN_ID=auto a one-time setup instead of a
// per-run command. It's tested against an injected runOnceFn (not the real
// navigator/driver) so each scenario controls exactly what runOnce "returns"
// without needing a screen fixture — runOnce itself is already covered above.

test('runForever loops through queued runs back-to-back with no idle sleep between them', async () => {
  const results = [
    { run: { id: 1, status: 'done' }, capturedToday: 2 },
    { run: { id: 2, status: 'done' }, capturedToday: 1 },
  ];
  let call = 0;
  const runOnceFn = async () => results[call++];
  const sleeps = [];
  await runForever({
    driver: {}, reader: {}, backend: {}, config: { idlePollMs: 9999 },
    runOnceFn,
    sleepFn: async (ms) => sleeps.push(ms),
    shouldStop: () => call >= 2,
  });
  assert.strictEqual(call, 2);
  assert.deepStrictEqual(sleeps, [], 'never idled, so never slept');
});

test('runForever sleeps between idle polls, then stops once work shows up', async () => {
  let call = 0;
  const runOnceFn = async () => {
    call += 1;
    if (call < 3) return { run: null, capturedToday: 0, idle: true };
    return { run: { id: 5, status: 'done' }, capturedToday: 1 };
  };
  const sleeps = [];
  await runForever({
    driver: {}, reader: {}, backend: {}, config: { idlePollMs: 5000 },
    runOnceFn,
    sleepFn: async (ms) => sleeps.push(ms),
    shouldStop: () => call >= 3,
  });
  assert.strictEqual(call, 3);
  assert.deepStrictEqual(sleeps, [5000, 5000]);
});

test('runForever survives an unexpected runOnce error and keeps polling', async () => {
  let call = 0;
  const runOnceFn = async () => {
    call += 1;
    if (call === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    return { run: { id: 9, status: 'done' }, capturedToday: 0 };
  };
  const lines = [];
  const logger = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const sleeps = [];
  await runForever({
    driver: {}, reader: {}, backend: {}, config: { idlePollMs: 1500 },
    runOnceFn,
    logger,
    sleepFn: async (ms) => sleeps.push(ms),
    shouldStop: () => call >= 2,
  });
  assert.strictEqual(call, 2, 'the loop continues past the thrown error instead of crashing');
  assert.deepStrictEqual(sleeps, [1500]);
  assert.ok(lines.some((l) => /FATAL/.test(l)), 'the error is diagnosed via printDiagnostic');
});

test('runForever never calls runOnce when already told to stop', async () => {
  let call = 0;
  const runOnceFn = async () => { call += 1; return { run: null, idle: true, capturedToday: 0 }; };
  await runForever({
    driver: {}, reader: {}, backend: {}, config: {},
    runOnceFn,
    shouldStop: () => true,
  });
  assert.strictEqual(call, 0);
});
