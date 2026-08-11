'use strict';

// Backend session executor — the piece that makes "the backend drives the phone"
// real. Given a claimed run + a paired host, it:
//   1. opens a command-channel session to the host (hostCommands.beginSession)
//   2. builds a RemoteDriver bound to that host
//   3. runs the server-side navigator (sourcingNavigator.scout) as the candidate
//      source for sourcingOrchestrator.runWithSource — so ALL the existing
//      scoring / dedupe / add-to-campaign logic is reused unchanged
//   4. ends the channel session so the agent stops pulling
//
// One active session per host (mirrors the single-frame live mirror). Everything
// side-effecting is injectable via `deps`, so the whole executor is unit-testable
// with fakes — no DB, no phone, no network.

const { runWithSource } = require('./sourcingOrchestrator');
const { makeRemoteDriver } = require('./remoteDriver');
const { scout } = require('./sourcingNavigator');
const commands = require('./hostCommands');
const store = require('./sourcingStore');

const DEFAULT_PACING_MS = 1800; // human-like pacing between IG actions (anti-flag)
const DEFAULT_CAPTURE_CAP = 500; // safety cap on captures per run

const active = new Map(); // hostId -> { runId, promise }

function generatorSource(gen) {
  return {
    async next() {
      const r = await gen.next();
      return r.done ? null : r.value;
    },
  };
}

// Production orchestrator deps + a shouldStop that watches the run's DB status so
// an admin "Stop" (or a sweeper 'error') halts the backend session promptly.
function buildOrchestratorDeps(run, deps) {
  const base = deps.makeDeps(run);
  return {
    ...base,
    shouldStop: async () => {
      try {
        const r = await deps.getRun(run.id);
        return !r || r.status === 'stopped' || r.status === 'error' || r.status === 'done';
      } catch (_) {
        return false; // a transient read failure shouldn't kill an in-flight run
      }
    },
  };
}

async function runSession({ hostId, run, deps }) {
  const chan = deps.commands || commands;
  const runWith = deps.runWithSource || runWithSource;
  const scoutFn = deps.scout || scout;
  const makeDriver = deps.makeDriver || makeRemoteDriver;
  const pacingMs = Number(
    (run.config && run.config.pacingMs) || deps.pacingMs || process.env.SOURCING_PACING_MS || DEFAULT_PACING_MS,
  );
  const captureCap = Number(deps.captureCap || process.env.SOURCING_CAPTURE_CAP || DEFAULT_CAPTURE_CAP);
  // Small tap-coordinate jitter so taps aren't pixel-perfect (anti-flag).
  const tapJitterPx = Number(deps.tapJitterPx != null ? deps.tapJitterPx : process.env.SOURCING_TAP_JITTER_PX || 5);
  const log = (deps.logger && deps.logger.log) ? deps.logger.log.bind(deps.logger) : console.log;
  log(
    `[sourcing-session] run #${run.id} host ${hostId}: starting ` +
    `(discovery=${(run.config && run.config.discovery) || 'profiles'}, ` +
    `keywords=[${((run.config && run.config.keywords) || []).join(', ')}])`,
  );

  chan.beginSession(hostId);
  const driver = makeDriver({ hostId, channel: chan });
  // Ready the phone (agent maps these to adb). Best-effort — but surface a
  // failure instead of swallowing it: a keepAwake/wake timeout here is the
  // earliest sign the command channel isn't round-tripping (the agent executes
  // the op but its result never settles the backend's await), which otherwise
  // only shows up later as the first non-best-effort op (openApp) timing out.
  try { await driver.keepAwake(); } catch (err) { log(`[sourcing-session] keepAwake failed: ${(err && err.message) || err}`); }
  try { await driver.wake(); } catch (err) { log(`[sourcing-session] wake failed: ${(err && err.message) || err}`); }

  const config = run.config || {};
  const opts = {
    keywords: config.keywords || [],
    hashtags: config.hashtags || [],
    seedAccounts: config.seedAccounts || [],
    max: captureCap,
  };

  // `discovery: 'reels'` drives the explore/scroll reel-feed flow (watch + hear +
  // judge + occasionally engage); otherwise the search->profile flow.
  let gen;
  if (String(config.discovery || '').toLowerCase() === 'reels') {
    const { scoutReels } = require('./sourcingReelsNavigator');
    const engagementPolicy = require('./engagementPolicy');
    const reelJudge = require('./reelJudge');
    const clipStore = require('./clipStore');
    gen = (deps.scoutReels || scoutReels)({
      driver,
      config: { pacingMs, clipSeconds: config.clipSeconds, tapJitterPx },
      opts,
      deps: {
        judge: deps.judge || reelJudge.makeClassifier(),
        getClip: deps.getClip || clipStore.take,
        engagement: deps.engagement || { policy: engagementPolicy.loadPolicy(), decide: engagementPolicy.decide },
        rng: deps.rng,
      },
    });
  } else {
    gen = scoutFn({ driver, config: { pacingMs, tapJitterPx }, opts });
  }

  try {
    const result = await runWith(run, config, generatorSource(gen), buildOrchestratorDeps(run, deps));
    const stats = (result && result.stats) || {};
    log(
      `[sourcing-session] run #${run.id} host ${hostId}: ended status=${result && result.status} ` +
      `scanned=${stats.scanned || 0} added=${stats.added || 0} review=${stats.review || 0} rejected=${stats.rejected || 0}`,
    );
  } finally {
    try { if (gen.return) await gen.return(); } catch (_) { /* generator already done */ }
    chan.endSession(hostId);
  }
}

// Start a session for (hostId, run). Non-blocking: returns { runId, promise }.
// A second call while a session is live for the host returns the existing entry
// instead of starting a competing one.
function start({ hostId, run, deps = {}, logger = console }) {
  if (active.has(hostId)) return active.get(hostId);
  const d = { makeDeps: store.makeDeps, getRun: store.getRun, ...deps };
  const promise = runSession({ hostId, run, deps: d })
    .catch((err) => {
      const write = logger.error || logger.log;
      write.call(logger, '[sourcing-session]', (err && err.message) || String(err));
    })
    .finally(() => active.delete(hostId));
  const entry = { runId: run.id, promise };
  active.set(hostId, entry);
  return entry;
}

function isActive(hostId) { return active.has(hostId); }

function activeRunId(hostId) {
  const e = active.get(hostId);
  return e ? e.runId : null;
}

// Test-only helpers.
function _activeCount() { return active.size; }
function _reset() { active.clear(); }

module.exports = { start, isActive, activeRunId, _activeCount, _reset, DEFAULT_PACING_MS, DEFAULT_CAPTURE_CAP };
