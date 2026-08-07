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
//
// RUNNER_RUN_ID=auto is a one-time setup, not a per-run command: instead of
// driving a single run and exiting, the runner polls the backend forever for
// the newest queued run, drives it, and immediately checks for the next one.
// Press Ctrl+C to stop. Fixed RUNNER_RUN_ID=<n> stays one-shot, for controlled
// single-run testing.

const { loadConfig, assertConfig } = require('./config');
const { makeBackend } = require('./backend');
const { runOnce, runForever } = require('./main');

async function main() {
  const cfg = loadConfig();
  assertConfig(cfg);

  // Build the backend client first — the real screen reader needs it (all screen
  // interpretation runs server-side now).
  const backend = makeBackend({ backendUrl: cfg.backendUrl, hostToken: cfg.hostToken });
  const { driver, reader } = await buildDriverAndReader(cfg, backend);

  // Real Android: make the phone ready for a long standing run — establish the
  // Wi-Fi link if any, keep the screen awake, and wake it now. All best-effort.
  if (cfg.driver === 'android') {
    if (driver.connect) await driver.connect().catch(() => {});
    if (cfg.keepAwake && driver.keepAwake) await driver.keepAwake().catch(() => {});
    if (driver.wake) await driver.wake().catch(() => {});
  }

  if (cfg.runMode === 'auto') {
    let stopping = false;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      // eslint-disable-next-line no-console
      console.log(`\n[runner] ${signal} received — stopping after the current step...`);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    // eslint-disable-next-line no-console
    console.log('[runner] auto mode: this is a one-time setup — polling for queued runs forever. Press Ctrl+C to stop.');
    await runForever({ driver, reader, backend, config: cfg, shouldStop: () => stopping });
    return;
  }

  const { run, capturedToday, idle } = await runOnce({ driver, reader, backend, config: cfg });
  if (idle) {
    // eslint-disable-next-line no-console
    console.log('[runner] finished: idle (no queued runs)');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[runner] finished run #${run.id} status=${run.status} captured=${capturedToday}`);
}

// The driver and the screen reader are a matched pair. The mock driver ships
// with a canned fixture the mock reader knows how to decode. The real (Android)
// driver pairs with RealScreenReader, which captures the phone's UI tree and
// asks the backend to interpret it — so the host stays a thin relay and every
// scouting-logic change ships by deploying Deal Studio, not by touching here.
async function buildDriverAndReader(cfg, backend) {
  if (cfg.driver === 'android') {
    const { AndroidDriver } = require('./driver/android');
    const { RealScreenReader } = require('./vision/RealScreenReader');
    const driver = new AndroidDriver({
      serial: cfg.deviceUdid,
      mode: cfg.adbMode,
      reconnectRetries: cfg.reconnectRetries,
      reconnectBackoffMs: cfg.reconnectBackoffMs,
    });
    return { driver, reader: new RealScreenReader({ driver, backend }) };
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
