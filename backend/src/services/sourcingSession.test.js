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

// A run's freshness is measured by updated_at, which only moves when a candidate
// is YIELDED — and a re-run of a mature campaign legitimately yields nothing for
// a long stretch, because dedupe skips everyone it already scouted. A few
// hundred cheap skips is fifteen minutes of correct work with no writes, which
// is exactly sourcingSweep's definition of a dead run.
test('the navigator can prove a run is alive while it is only skipping', async () => {
  const touched = [];
  let heartbeat;
  const deps = {
    ...baseDeps(),
    touchRun: async (id) => { touched.push(id); },
    scout: (args) => { heartbeat = args.deps.heartbeat; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 12, campaign_id: 'c', config: {} }, deps }).promise;

  assert.strictEqual(typeof heartbeat, 'function', 'the navigator is given one');
  await heartbeat();
  assert.deepStrictEqual(touched, [12], 'the run row is touched');
});

test('heartbeats are throttled, not one write per creator considered', async () => {
  const touched = [];
  let heartbeat;
  const deps = {
    ...baseDeps(),
    touchRun: async (id) => { touched.push(id); },
    scout: (args) => { heartbeat = args.deps.heartbeat; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 13, campaign_id: 'c', config: {} }, deps }).promise;

  for (let i = 0; i < 50; i += 1) await heartbeat();
  assert.strictEqual(touched.length, 1, '50 skips in a row cost one write');
});

test('a failed heartbeat does not take the run down with it', async () => {
  let heartbeat;
  const deps = {
    ...baseDeps(),
    touchRun: async () => { throw new Error('db down'); },
    scout: (args) => { heartbeat = args.deps.heartbeat; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 14, campaign_id: 'c', config: {} }, deps }).promise;
  await heartbeat(); // must not throw
});

test('keyword depth is loaded for the campaign and handed to the navigator', async () => {
  let opts = null;
  const deps = {
    ...baseDeps(),
    keywordDepths: async ({ campaignId }) => {
      assert.strictEqual(campaignId, 'camp-7');
      return { homegym: 3, protein: 1 };
    },
    scout: (args) => { opts = args.opts; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 15, campaign_id: 'camp-7', config: {} }, deps }).promise;
  assert.deepStrictEqual(opts.keywordDepth, { homegym: 3, protein: 1 });
});

test('advancing a keyword persists its depth for the NEXT run', async () => {
  const saved = [];
  let saveDepth;
  const deps = {
    ...baseDeps(),
    saveKeywordDepth: async (row) => { saved.push(row); },
    scout: (args) => { saveDepth = args.deps.saveDepth; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 16, campaign_id: 'camp-7', config: {} }, deps }).promise;
  await saveDepth('homegym', 4);
  assert.deepStrictEqual(saved, [{ campaignId: 'camp-7', term: 'homegym', depth: 4 }]);
});

test('a campaign with no depth history behaves exactly as before', async () => {
  let opts = null;
  const deps = {
    ...baseDeps(),
    keywordDepths: async () => ({}),
    scout: (args) => { opts = args.opts; return (async function* () {})(); },
  };
  await session.start({ hostId: 1, run: { id: 17, campaign_id: 'c', config: {} }, deps }).promise;
  assert.strictEqual(opts.keywordDepth, undefined, 'no seed means start at the top');
});

// ── the navigator gets the whole campaign, not just the pacing knobs ─────────
//
// Profiles mode used to forward seven mechanical values and nothing else, on the
// reasoning that the orchestrator does the judging. But the navigator grew gates
// of its own that all read config, and every one of them was reading undefined:
// the on-device prefilter (no floor/ceiling/risk, so it rejected nobody and a
// clip was recorded for creators about to be rejected on reach a moment later),
// the screenshot prescreen (never switched on), and the early reach reject.
test('profiles mode forwards the campaign config to the navigator', async () => {
  let got = null;
  const deps = {
    ...baseDeps(),
    scout: (args) => { got = args.config; return (async function* () {})(); },
  };
  await session.start({
    hostId: 1,
    run: {
      id: 5,
      campaign_id: 'c',
      config: {
        floor: 15000, ceiling: 400000, risk: 'low', niche: 'fitness',
        keywords: ['gym'], prescreenNiche: true, floorTolerance: 0,
      },
    },
    deps,
  }).promise;

  assert.strictEqual(got.floor, 15000, 'the on-device reach gate can see the floor');
  assert.strictEqual(got.ceiling, 400000);
  assert.strictEqual(got.risk, 'low');
  assert.strictEqual(got.niche, 'fitness');
  assert.strictEqual(got.prescreenNiche, true, 'the prescreen actually switches on');
});

// Mechanical values are still resolved by the session, so spreading the campaign
// config must not let a stale saved value win over them. tapJitterPx is the
// clean test: the session takes it from deps/env and never from the campaign, so
// a saved one must lose. (pacingMs deliberately DOES read the campaign first.)
test('session-resolved knobs still beat the spread campaign config', async () => {
  let got = null;
  const deps = {
    ...baseDeps(),
    tapJitterPx: 5,
    scout: (args) => { got = args.config; return (async function* () {})(); },
  };
  await session.start({
    hostId: 1,
    run: { id: 6, campaign_id: 'c', config: { tapJitterPx: 999, clipSeconds: 30 } },
    deps,
  }).promise;

  assert.strictEqual(got.tapJitterPx, 5, 'the session resolves jitter, not the saved config');
  assert.strictEqual(got.clipSeconds, 30, 'a real clip length still comes through');
});
