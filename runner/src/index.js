#!/usr/bin/env node
'use strict';

// Runner entry point. Reads config from env, picks a driver, and drives the
// Instagram Navigator on a paired phone until the sourcing run completes.
//
// Android only — driven directly over adb, no Appium, no extra npm deps.
//
// Drivers:
//   RUNNER_DRIVER=mock      in-process fixture (no phone, no extra tools)
//   RUNNER_DRIVER=android   real Android via adb only (default when unset)

const { loadConfig, assertConfig } = require('./config');
const { makeBackend } = require('./backend');
const { runOnce } = require('./main');

async function main() {
  const cfg = loadConfig();
  assertConfig(cfg);

  const { driver, reader } = await buildDriverAndReader(cfg);
  const backend = makeBackend({ backendUrl: cfg.backendUrl, hostToken: cfg.hostToken });

  const { run, capturedToday, idle } = await runOnce({ driver, reader, backend, config: cfg });
  if (idle) {
    // eslint-disable-next-line no-console
    console.log('[runner] finished: idle (no queued runs)');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[runner] finished run #${run.id} status=${run.status} captured=${capturedToday}`);
}

// The driver and the screen reader are a matched pair — the mock driver ships
// with a canned fixture the mock reader knows how to decode. The real (Android)
// driver pairs with the (deliberately not-yet-implemented) ScreenReader stub so
// a real run fails loudly if the vision layer isn't wired up, instead of
// pretending to scout with no signal.
async function buildDriverAndReader(cfg) {
  if (cfg.driver === 'android') {
    const { AndroidDriver } = require('./driver/android');
    const { ScreenReader } = require('./navigator/screenReader');
    return {
      driver: new AndroidDriver({ serial: cfg.deviceUdid }),
      reader: new ScreenReader(),
    };
  }
  if (cfg.driver === 'mock') {
    const { buildSmokeFixture } = require('./mockFixture');
    return buildSmokeFixture();
  }
  throw new Error(
    `Unsupported RUNNER_DRIVER '${cfg.driver}'. This runner is Android-only — use 'android' ` +
      `(real phone via adb) or 'mock' (no hardware, for testing).`,
  );
}

if (require.main === module) {
  const { printDiagnostic } = require('./diagnose');
  main().catch((err) => {
    printDiagnostic(err, console);
    process.exit(1);
  });
}

module.exports = { main };
