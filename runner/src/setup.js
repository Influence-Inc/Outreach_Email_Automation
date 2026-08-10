'use strict';

// Pure helpers behind `npm run setup`. The interactive script (scripts/setup.js)
// is a thin wrapper over these so all the real logic stays unit-testable.

// Parse `adb devices` output into [{ serial, state }].
function parseDevices(stdout) {
  return String(stdout || '')
    .split('\n')
    .slice(1) // drop the "List of devices attached" header
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

// Android 11+ wireless-debugging handshake, then the persistent connection.
function adbPairArgs({ host, pairPort }) { return ['pair', `${host}:${pairPort}`]; }
function adbConnectArgs({ host, port }) { return ['connect', `${host}:${port}`]; }

// Turn wizard answers into the { RUNNER_*: value } object written to .runnerrc.json.
function buildConfigFromAnswers(a = {}) {
  const cfg = { RUNNER_DRIVER: 'android' };
  if (a.backendUrl) cfg.RUNNER_BACKEND_URL = String(a.backendUrl).replace(/\/$/, '');
  if (a.hostToken) cfg.RUNNER_HOST_TOKEN = a.hostToken;

  if (a.mode === 'agent') {
    cfg.RUNNER_MODE = 'agent';
    if (a.hostId) cfg.RUNNER_HOST_ID = String(a.hostId);
  } else {
    cfg.RUNNER_RUN_ID = 'auto'; // standing scout worker
  }

  if (a.adbMode === 'wifi') {
    cfg.RUNNER_ADB_MODE = 'wifi';
    if (a.wifiHost && a.wifiPort) cfg.RUNNER_DEVICE_UDID = `${a.wifiHost}:${a.wifiPort}`;
  } else if (a.deviceUdid) {
    cfg.RUNNER_DEVICE_UDID = a.deviceUdid;
  }
  return cfg;
}

// Which required keys are still missing (mirrors config.assertConfig) so the
// wizard can warn before writing an unusable config.
function missingKeys(cfg = {}) {
  const missing = [];
  if (!cfg.RUNNER_BACKEND_URL) missing.push('RUNNER_BACKEND_URL');
  if (!cfg.RUNNER_HOST_TOKEN) missing.push('RUNNER_HOST_TOKEN');
  if (cfg.RUNNER_MODE === 'agent') {
    if (!cfg.RUNNER_HOST_ID) missing.push('RUNNER_HOST_ID');
  } else if (!cfg.RUNNER_RUN_ID) {
    missing.push('RUNNER_RUN_ID');
  }
  return missing;
}

module.exports = { parseDevices, adbPairArgs, adbConnectArgs, buildConfigFromAnswers, missingKeys };
