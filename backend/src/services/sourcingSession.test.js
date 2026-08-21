'use strict';

const test = require('node:test');
const assert = require('node:assert');
const session = require('./sourcingSession');

test.afterEach(() => session._reset());

function fakeChannel(events) {
  return {
    beginSession: (h) => events.push(['begin', h]),
    endSession: (h) => events.push(['end', h]),
    enqueue: () => ({ id: 1, promise: Promise.resolve(null) }),
  };
}

const fakeDriver = () => ({
  keepAwake: async () => {},
  wake: async () => {},
});

function baseDeps({ events = [], runWithSource, getRun } = {}) {
  return {
    commands: fakeChannel(events),
    makeDriver: () => fakeDriver(),
    scout: async function* scout() { yield { username: 'a' }; },
    makeDeps: () => ({}),
    getRun: getRun || (async (id) => ({ id, status: 'running' })),
    runWithSource: runWithSource || (async () => ({ status: 'done', stats: {} })),
    // Injected so the tests never reach for a database. Production loads the
    // campaign's scouting history here (services/sourcingStore.scoutedHandles).
    scoutedHandles: async () => [],
  };
}

test('runs the navigator through runWithSource and brackets a channel session', async () => {
  const events = [];
  let sourced = null;
  const deps = baseDeps({
    events,
    runWithSource: async (run, config, source) => {
      sourced = await source.next(); // drains the navigator generator
      return { status: 'done', stats: {} };
    },
  });
  const run = { id: 5, config: { keywords: ['x'], pacingMs: 0 } };
  const entry = session.start({ hostId: 9, run, deps });
  await entry.promise;

  assert.deepStrictEqual(events, [['begin', 9], ['end', 9]]);
  assert.deepStrictEqual(sourced, { username: 'a' });
  assert.strictEqual(session.isActive(9), false, 'active entry cleared when done');
});

test('discovery:reels routes to the reels-feed navigator', async () => {
  let usedReels = false;
  const deps = baseDeps({
    runWithSource: async (run, config, source) => { await source.next(); return { status: 'done' }; },
  });
  deps.scoutReels = async function* scoutReels() { usedReels = true; yield { username: 'r' }; };
  const run = { id: 9, config: { discovery: 'reels', keywords: ['x'], pacingMs: 0 } };
  const entry = session.start({ hostId: 11, run, deps });
  await entry.promise;
  assert.strictEqual(usedReels, true);
});

test('does not start a competing session for a busy host', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = baseDeps({ runWithSource: async () => { await gate; return { status: 'done' }; } });
  const run = { id: 1, config: {} };

  const first = session.start({ hostId: 3, run, deps });
  const second = session.start({ hostId: 3, run, deps });
  assert.strictEqual(first, second, 'second start returns the live entry');
  assert.strictEqual(session._activeCount(), 1);

  release();
  await first.promise;
  assert.strictEqual(session.isActive(3), false);
});

test('shouldStop reflects the run status (a stopped run halts the session)', async () => {
  let sawShouldStop = null;
  const deps = baseDeps({
    getRun: async (id) => ({ id, status: 'stopped' }),
    runWithSource: async (run, config, source, orch) => {
      sawShouldStop = await orch.shouldStop();
      return { status: 'stopped' };
    },
  });
  const entry = session.start({ hostId: 2, run: { id: 7, config: {} }, deps });
  await entry.promise;
  assert.strictEqual(sawShouldStop, true);
});

test('ends the channel session even when the run throws', async () => {
  const events = [];
  const deps = baseDeps({ events, runWithSource: async () => { throw new Error('boom'); } });
  const entry = session.start({ hostId: 4, run: { id: 8, config: {} }, deps, logger: { error() {} } });
  await entry.promise;
  assert.deepStrictEqual(events, [['begin', 4], ['end', 4]]);
  assert.strictEqual(session.isActive(4), false);
});

// The scout's memory has to outlive the run, or every run re-walks the same
// results pages and re-opens the same popular accounts — paying for the profile
// hop, the recording and the judgement each time, only for the unique index to
// drop the candidate at the very last step.
test('the campaign scouting history is handed to the navigator', async () => {
  let opts = null;
  const deps = {
    ...baseDeps(),
    scoutedHandles: async ({ campaignId }) => {
      assert.strictEqual(campaignId, 'camp-9', 'scoped to this campaign');
      return ['oldcreator', 'anotherone'];
    },
    scout: (args) => { opts = args.opts; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 3, campaign_id: 'camp-9', config: {} }, deps }).promise;
  assert.deepStrictEqual(opts.alreadyScouted, ['oldcreator', 'anotherone']);
});

test('a failed history read still lets the run go ahead', async () => {
  let opts = null;
  const deps = {
    ...baseDeps(),
    scoutedHandles: async () => { throw new Error('db down'); },
    scout: (args) => { opts = args.opts; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 4, campaign_id: 'c', config: {} }, deps }).promise;
  assert.strictEqual(opts.alreadyScouted, undefined, 'dedupes within the run as it always did');
});
