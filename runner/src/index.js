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

  const driver = await buildDriver(cfg);
  const reader = await buildReader(cfg);
  const backend = makeBackend({ backendUrl: cfg.backendUrl, hostToken: cfg.hostToken });

  const { run, capturedToday } = await runOnce({ driver, reader, backend, config: cfg });
  // eslint-disable-next-line no-console
  console.log(`[runner] finished run #${run.id} status=${run.status} captured=${capturedToday}`);
}

async function buildDriver(cfg) {
  if (cfg.driver === 'android') {
    const { AndroidDriver } = require('./driver/android');
    return new AndroidDriver({ appiumUrl: cfg.appiumUrl, udid: cfg.deviceUdid });
  }
  if (cfg.driver === 'ios') {
    const { IosDriver } = require('./driver/ios');
    return new IosDriver({
      appiumUrl: cfg.appiumUrl,
      udid: cfg.deviceUdid,
      deviceName: cfg.deviceName,
      xcodeOrgId: cfg.xcodeOrgId,
      xcodeSigningId: cfg.xcodeSigningId,
    });
  }
  const { MockDriver } = require('./driver/mock');
  return new MockDriver({ screens: [] });
}

async function buildReader(_cfg) {
  // Vision layer: production would post screenshots to the backend's Claude
  // helper (services/claudeClient.callClaudeMessages) or a local model. The
  // mock driver ships with MockScreenReader used by tests; for real drivers the
  // reader is intentionally left as an implementation-in-progress so a botched
  // vision call surfaces loudly instead of pretending to read the screen.
  const { ScreenReader } = require('./navigator/screenReader');
  return new ScreenReader();
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[runner] fatal:', err && err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
