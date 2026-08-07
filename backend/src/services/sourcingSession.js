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

  chan.beginSession(hostId);
  const driver = makeDriver({ hostId, channel: chan });
  // Ready the phone (agent maps these to adb). Best-effort.
  try { await driver.keepAwake(); } catch (_) { /* best-effort */ }
  try { await driver.wake(); } catch (_) { /* best-effort */ }

  const config = run.config || {};
  const gen = scoutFn({
    driver,
    config: { pacingMs },
    opts: {
      keywords: config.keywords || [],
      hashtags: config.hashtags || [],
      seedAccounts: config.seedAccounts || [],
      max: captureCap,
    },
  });

  try {
    await runWith(run, config, generatorSource(gen), buildOrchestratorDeps(run, deps));
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
