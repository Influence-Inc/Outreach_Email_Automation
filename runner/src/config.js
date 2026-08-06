'use strict';

// Runner config, loaded from env at boot. Kept in one place so main + tests
// share the same source of truth.
//
//   RUNNER_BACKEND_URL     e.g. https://outreach.your.app  (no trailing slash)
//   RUNNER_HOST_TOKEN      per-host machine token minted by the dashboard
//   RUNNER_RUN_ID          the sourcing_runs id to drive (else long-polls for one)
//   RUNNER_DRIVER          'mock' | 'android' | 'ios'   (default 'mock')
//   RUNNER_APPIUM_URL      e.g. http://127.0.0.1:4723  (android/ios)
//   RUNNER_DEVICE_UDID     ios only (also used by android when several are paired)
//   RUNNER_DEVICE_NAME     ios only ('iPhone' or the name shown in Xcode)
//   RUNNER_XCODE_ORG_ID    ios only (Apple developer team id used to sign WDA)
//   RUNNER_XCODE_SIGNING_ID ios only (default 'iPhone Developer')
//   RUNNER_BATCH_SIZE      candidates per ingest batch (default 5)
//   RUNNER_PACING_MS       min ms between IG actions (default 1800)
//   RUNNER_DAILY_CAP       hard stop after N captures/day (default 200)

function loadConfig(env = process.env) {
  const backend = (env.RUNNER_BACKEND_URL || '').replace(/\/$/, '');
  const cfg = {
    backendUrl: backend,
    hostToken: env.RUNNER_HOST_TOKEN || '',
    runId: env.RUNNER_RUN_ID ? Number(env.RUNNER_RUN_ID) : null,
    driver: env.RUNNER_DRIVER || 'mock',
    appiumUrl: env.RUNNER_APPIUM_URL || 'http://127.0.0.1:4723',
    deviceUdid: env.RUNNER_DEVICE_UDID || null,
    deviceName: env.RUNNER_DEVICE_NAME || null,
    xcodeOrgId: env.RUNNER_XCODE_ORG_ID || null,
    xcodeSigningId: env.RUNNER_XCODE_SIGNING_ID || 'iPhone Developer',
    batchSize: Number(env.RUNNER_BATCH_SIZE || 5),
    pacingMs: Number(env.RUNNER_PACING_MS || 1800),
    dailyCap: Number(env.RUNNER_DAILY_CAP || 200),
  };
  return cfg;
}

function assertConfig(cfg) {
  const missing = [];
  if (!cfg.backendUrl) missing.push('RUNNER_BACKEND_URL');
  if (!cfg.hostToken) missing.push('RUNNER_HOST_TOKEN');
  if (!cfg.runId) missing.push('RUNNER_RUN_ID');
  if (missing.length) {
    throw new Error(`Runner missing required env: ${missing.join(', ')}`);
  }
}

module.exports = { loadConfig, assertConfig };
