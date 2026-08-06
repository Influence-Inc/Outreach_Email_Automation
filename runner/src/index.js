#!/usr/bin/env node
'use strict';

// Runner entry point. Reads config from env, picks a driver, and drives the
// Instagram Navigator on a paired phone until the sourcing run completes.
//
// Drivers:
//   RUNNER_DRIVER=mock   in-process fixture (no phone, no Appium)
//   RUNNER_DRIVER=android    real Android via Appium UiAutomator2
//   RUNNER_DRIVER=ios    (Phase 3) real iOS via Appium + WebDriverAgent

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
// with a canned fixture the mock reader knows how to decode. Real drivers pair
// with the (deliberately not-yet-implemented) ScreenReader stub so a real run
// fails loudly if the vision layer isn't wired up, instead of pretending to
// scout with no signal.
async function buildDriverAndReader(cfg) {
  if (cfg.driver === 'android') {
    const { AndroidDriver } = require('./driver/android');
    const { ScreenReader } = require('./navigator/screenReader');
    return {
      driver: new AndroidDriver({ appiumUrl: cfg.appiumUrl, udid: cfg.deviceUdid }),
      reader: new ScreenReader(),
    };
  }
  if (cfg.driver === 'ios') {
    const { IosDriver } = require('./driver/ios');
    const { ScreenReader } = require('./navigator/screenReader');
    return {
      driver: new IosDriver({
        appiumUrl: cfg.appiumUrl,
        udid: cfg.deviceUdid,
        deviceName: cfg.deviceName,
        xcodeOrgId: cfg.xcodeOrgId,
        xcodeSigningId: cfg.xcodeSigningId,
      }),
      reader: new ScreenReader(),
    };
  }
  const { buildSmokeFixture } = require('./mockFixture');
  return buildSmokeFixture();
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[runner] fatal:', err && err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
