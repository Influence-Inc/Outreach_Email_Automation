'use strict';

// Runner config, loaded from env at boot. Kept in one place so main + tests
// share the source of truth. Android-only — driven directly over adb, no
// Appium, no extra npm dependency.
//
//   RUNNER_BACKEND_URL     e.g. https://outreach.your.app  (no trailing slash)
//   RUNNER_HOST_TOKEN      per-host machine token minted by the dashboard
//   RUNNER_RUN_ID          a sourcing_runs id to drive once, or 'auto' to poll
//                          forever for the newest queued run (one-time setup —
//                          see RUNNER_IDLE_POLL_MS)
//   RUNNER_DRIVER          'mock' | 'android'   (default 'mock')
//   RUNNER_DEVICE_UDID     the adb serial to target. Only required when more
//                          than one phone is attached to the host; adb
//                          auto-picks the lone device otherwise.
//   RUNNER_BATCH_SIZE      candidates per ingest batch (default 5)
//   RUNNER_PACING_MS       min ms between IG actions (default 1800)
//   RUNNER_DAILY_CAP       hard stop after N captures/day (default 200)
//   RUNNER_HOST_ID         paired-host id (integer). Required when
//                          RUNNER_LIVE_MIRROR=on so frame uploads + control drains
//                          address the right host on the backend.
//   RUNNER_LIVE_MIRROR     'on' to start the live-mirror + take-over side loops
//                          alongside scouting (default off)
//   RUNNER_FRAME_MS        live-mirror frame upload interval, ms (default 3000)
//   RUNNER_CONTROL_MS      live-mirror control drain interval, ms (default 1500)
//   RUNNER_IDLE_POLL_MS    RUNNER_RUN_ID=auto only: wait this long between polls
//                          when nothing is queued (default 15000)

function loadConfig(env = process.env) {
  const backend = (env.RUNNER_BACKEND_URL || '').replace(/\/$/, '');
  const rawRunId = env.RUNNER_RUN_ID || '';
  const cfg = {
    backendUrl: backend,
    hostToken: env.RUNNER_HOST_TOKEN || '',
    runId: rawRunId && rawRunId !== 'auto' ? Number(rawRunId) : null,
    runMode: rawRunId === 'auto' ? 'auto' : 'fixed',
    driver: env.RUNNER_DRIVER || 'mock',
    deviceUdid: env.RUNNER_DEVICE_UDID || null,
    batchSize: Number(env.RUNNER_BATCH_SIZE || 5),
    pacingMs: Number(env.RUNNER_PACING_MS || 1800),
    dailyCap: Number(env.RUNNER_DAILY_CAP || 200),
    hostId: env.RUNNER_HOST_ID ? Number(env.RUNNER_HOST_ID) : null,
    liveMirror: String(env.RUNNER_LIVE_MIRROR || '').toLowerCase() === 'on',
    frameMs: Number(env.RUNNER_FRAME_MS || 3000),
    controlMs: Number(env.RUNNER_CONTROL_MS || 1500),
    idlePollMs: Number(env.RUNNER_IDLE_POLL_MS || 15000),
  };
  return cfg;
}

function assertConfig(cfg) {
  const missing = [];
  if (!cfg.backendUrl) missing.push('RUNNER_BACKEND_URL');
  if (!cfg.hostToken) missing.push('RUNNER_HOST_TOKEN');
  // RUNNER_RUN_ID may be a number (drive a specific run) OR the literal string
  // 'auto' (poll for the newest queued run for any campaign — populated by the
  // sourcing sweep for campaigns with sourcing_defaults.enabled=true).
  if (!cfg.runId && cfg.runMode !== 'auto') missing.push('RUNNER_RUN_ID');
  if (missing.length) {
    throw new Error(`Runner missing required env: ${missing.join(', ')}`);
  }
}

module.exports = { loadConfig, assertConfig };
