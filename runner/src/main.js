'use strict';

// Runner main loop: given a run id, drive the Instagram Navigator on the paired
// phone and POST captured candidates to the backend in small batches until the
// run is 'done' (target reached), 'stopped' (admin), or the local daily cap is
// hit. The backend applies the actual scouting rules on ingest, so this side
// stays dumb: capture -> forward -> loop.
//
// Everything is injected so the whole loop is testable with a mock driver, a mock
// screen reader, and a stubbed backend (see main.test.js).

const { scoutCandidates } = require('./navigator/instagram');
const { startLiveMirror } = require('./liveMirror');
const { printDiagnostic } = require('./diagnose');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function resolveRun({ backend, config, runOverride }) {
  if (runOverride) return runOverride;
  if (config.runMode === 'auto') {
    const next = await backend.getNextRun();
    if (!next) return null; // nothing queued right now
    return next.run;
  }
  const { run } = await backend.getRun(config.runId);
  return run;
}

async function runOnce({ driver, reader, backend, config, runOverride }) {
  const run = await resolveRun({ backend, config, runOverride });
  if (!run) return { run: null, capturedToday: 0, idle: true };
  const runId = run.id;
  const cfg = run.config || {};
  const batchSize = Math.max(1, Number(config.batchSize || 5));
  let capturedToday = 0;
  const dailyCap = Math.max(1, Number(config.dailyCap || 200));

  let latest = run;
  const shouldStop = () => latest.status === 'done' || latest.status === 'stopped' || latest.status === 'error';

  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const resp = await backend.postCandidates(runId, batch);
    if (resp && resp.run) latest = resp.run;
    batch = [];
  };

  // Optional live mirror: starts a pair of side loops that upload the phone
  // screen and drain admin control ops. Only enabled when both RUNNER_LIVE_MIRROR
  // and RUNNER_HOST_ID are set — otherwise a scouting run stays "headless".
  let mirror = null;
  if (config.liveMirror && config.hostId) {
    mirror = startLiveMirror({
      driver, backend, hostId: config.hostId,
      frameIntervalMs: config.frameMs,
      controlIntervalMs: config.controlMs,
      getShouldStop: shouldStop,
    });
  }

  try {
    for await (const cand of scoutCandidates({
      driver,
      reader,
      config: { pacingMs: config.pacingMs },
      opts: { keywords: cfg.keywords || [] },
    })) {
      capturedToday += 1;
      batch.push(cand);
      if (batch.length >= batchSize) await flush();
      if (shouldStop()) break;
      if (capturedToday >= dailyCap) break;
      if (config.pacingMs) await sleep(config.pacingMs);
    }
  } finally {
    await flush().catch(() => {});
    if (mirror) await mirror.stop().catch(() => {});
    if (driver.close) await driver.close().catch(() => {});
  }
  return { run: latest, capturedToday };
}

// Keeps calling runOnce() forever so `RUNNER_RUN_ID=auto` is a one-time setup: an
// admin queues a run from the dashboard, this picks it up on its next poll,
// finishes it, and immediately checks for the next one — no re-typing the runner
// command per run. Fixed RUNNER_RUN_ID=<n> stays one-shot and never calls this
// (see index.js).
//
// runOnceFn/sleepFn/shouldStop are injected (defaulting to the real runOnce, the
// real timer, and "never stop") so tests can script a handful of iterations and a
// clean stop with no real driver, backend, or multi-second timers. The real
// SIGINT/SIGTERM wiring lives in index.js, as a thin wrapper flipping a stopping
// flag that shouldStop reads.
async function runForever({
  driver,
  reader,
  backend,
  config,
  logger = console,
  sleepFn = sleep,
  shouldStop = () => false,
  runOnceFn = runOnce,
}) {
  const log = logger && logger.log ? logger.log.bind(logger) : () => {};
  const idleMs = Math.max(1000, Number(config.idlePollMs || 15000));

  while (!shouldStop()) {
    let result;
    try {
      result = await runOnceFn({ driver, reader, backend, config });
    } catch (err) {
      printDiagnostic(err, logger);
      if (shouldStop()) break;
      await sleepFn(idleMs);
      continue;
    }

    if (result.idle) {
      if (shouldStop()) break;
      await sleepFn(idleMs);
      continue;
    }
    log(`[runner] finished run #${result.run.id} status=${result.run.status} captured=${result.capturedToday}`);
  }
  log('[runner] stopped');
}

module.exports = { runOnce, runForever };
