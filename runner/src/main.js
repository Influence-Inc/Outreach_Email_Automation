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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runOnce({ driver, reader, backend, config, runOverride }) {
  const run = runOverride || (await backend.getRun(config.runId)).run;
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

  try {
    for await (const cand of scoutCandidates({
      driver,
      reader,
      config: { pacingMs: config.pacingMs },
      opts: {
        keywords: cfg.keywords || [],
        platform: /iphone|ios/i.test(config.driver || '') ? 'ios' : 'android',
      },
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
    if (driver.close) await driver.close().catch(() => {});
  }
  return { run: latest, capturedToday };
}

module.exports = { runOnce };
