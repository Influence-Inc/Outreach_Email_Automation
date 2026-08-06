#!/usr/bin/env node
'use strict';

// runner/scripts/preflight.js
//
// Verify the whole live-scouting stack is talking BEFORE we start burning IG's
// rate limit against a broken setup. Runs top-down: Appium server → ADB → IG
// installed → open an Appium session → screenshot the phone. Each check prints
// exactly which layer is at fault so the fix is one-line.
//
// Usage:
//   RUNNER_APPIUM_URL=http://127.0.0.1:4723 node scripts/preflight.js
//
// The script is stand-alone — no runner state — so it's safe to run repeatedly
// while diagnosing setup issues on the host.

const { spawnSync } = require('child_process');

const APPIUM_URL = process.env.RUNNER_APPIUM_URL || 'http://127.0.0.1:4723';
const APPIUM_BASE_PATH = process.env.RUNNER_APPIUM_BASE_PATH || '/wd/hub';
const IG_PACKAGE = 'com.instagram.android';
const DEVICE_UDID = process.env.RUNNER_DEVICE_UDID || null;

// Tiny colored log helpers — no dependency on chalk.
const c = {
  ok: (m) => `\x1b[32m${m}\x1b[0m`,
  err: (m) => `\x1b[31m${m}\x1b[0m`,
  dim: (m) => `\x1b[90m${m}\x1b[0m`,
  b: (m) => `\x1b[1m${m}\x1b[0m`,
};
const log = (...a) => console.log('[preflight]', ...a);

let failed = 0;
function fail(msg, fix) {
  failed += 1;
  console.log(c.err(`[preflight] ✗ ${msg}`));
  if (fix) console.log(c.dim('           ↳ fix: ' + fix));
}

// --- checks ---------------------------------------------------------------

async function checkAppiumStatus() {
  try {
    const resp = await fetch(`${APPIUM_URL}${APPIUM_BASE_PATH}/status`);
    if (!resp.ok) {
      fail(
        `Appium /status returned ${resp.status} ${resp.statusText}`,
        `check that 'appium --base-path ${APPIUM_BASE_PATH}' is running on ${APPIUM_URL}`,
      );
      return null;
    }
    const body = await resp.json().catch(() => ({}));
    const build = body.value && body.value.build && body.value.build.version;
    log(c.ok('Appium /status: 200 OK') + ' — ' + (build ? `v${build}` : 'version unknown'));
    return body;
  } catch (err) {
    fail(
      `Cannot reach Appium at ${APPIUM_URL}${APPIUM_BASE_PATH}: ${err.message}`,
      `start it in another terminal: 'appium --base-path ${APPIUM_BASE_PATH}'`,
    );
    return null;
  }
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkAdbAvailable() {
  const adb = which('adb');
  if (!adb) {
    fail(
      "'adb' not in PATH",
      "install Android platform tools (macOS: 'brew install android-platform-tools', " +
        "Ubuntu: 'sudo apt install android-tools-adb', Windows: install Android SDK Platform Tools)",
    );
    return null;
  }
  log(c.ok(`ADB found: ${adb}`));
  return adb;
}

function checkAdbDevices() {
  const r = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`'adb devices' failed: ${(r.stderr || '').trim()}`);
    return null;
  }
  const lines = r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    fail(
      "'adb devices' shows no device",
      'plug the phone in via USB and enable USB debugging (Developer options → USB debugging)',
    );
    return null;
  }
  const devices = lines.map((l) => {
    const [serial, state] = l.split(/\s+/);
    return { serial, state };
  });
  log('ADB devices:');
  for (const d of devices) console.log('             ' + d.serial + '   ' + d.state);
  const unauthed = devices.find((d) => d.state === 'unauthorized');
  if (unauthed) {
    fail(
      `device ${unauthed.serial} is 'unauthorized'`,
      "on the phone: tap Allow on the 'Allow USB debugging?' prompt",
    );
    return null;
  }
  const online = devices.find((d) => d.state === 'device');
  if (!online) {
    fail(`no device in the 'device' state`, 'unplug + replug the phone');
    return null;
  }
  return online;
}

function checkInstagramInstalled(serial) {
  const args = ['-s', serial, 'shell', 'dumpsys', 'package', IG_PACKAGE];
  const r = spawnSync('adb', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`'adb -s ${serial} shell dumpsys package ${IG_PACKAGE}' failed`);
    return null;
  }
  const versionMatch = r.stdout.match(/versionName=([^\s]+)/);
  if (!versionMatch) {
    fail(
      `Instagram (${IG_PACKAGE}) is not installed on the phone`,
      'install Instagram from Play Store and sign into the dedicated sourcing account',
    );
    return null;
  }
  const version = versionMatch[1];
  log(c.ok(`Instagram installed on device: yes (versionName=${version})`));
  return version;
}

async function checkOpenSession(serial) {
  log(c.dim('Attempting Appium UiAutomator2 session against Instagram…'));
  const capsForBody = {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': IG_PACKAGE,
        'appium:appActivity': 'com.instagram.mainactivity.MainActivity',
        'appium:noReset': true,
        'appium:udid': serial,
        'appium:newCommandTimeout': 60,
      },
      firstMatch: [{}],
    },
  };
  let sessionId = null;
  try {
    const resp = await fetch(`${APPIUM_URL}${APPIUM_BASE_PATH}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capsForBody),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = (body.value && (body.value.message || body.value.error)) || `${resp.status}`;
      let hint = 'see runner/README.md for the Android setup section';
      if (/Could not find a driver for automationName/i.test(detail))
        hint = 'install the driver: appium driver install uiautomator2';
      if (/screen is locked/i.test(detail)) hint = 'unlock the phone and disable auto-lock during the run';
      if (/Original error: Instrumentation process/i.test(detail))
        hint = 'try: adb -s ' + serial + ' uninstall io.appium.uiautomator2.server';
      fail(`Could not open Appium session: ${detail}`, hint);
      return null;
    }
    sessionId = (body.value && body.value.sessionId) || body.sessionId;
    log(c.ok('Attempting Appium UiAutomator2 session against Instagram… OK'));
    // Once open, ask for screen size + take a screenshot to prove screen access.
    const sizeResp = await fetch(`${APPIUM_URL}${APPIUM_BASE_PATH}/session/${sessionId}/window/rect`);
    const sizeBody = await sizeResp.json().catch(() => ({}));
    const size = (sizeBody.value && { w: sizeBody.value.width, h: sizeBody.value.height }) || null;
    if (size) log(c.ok(`Screen size reported: ${size.w} x ${size.h}`));
    const shotResp = await fetch(`${APPIUM_URL}${APPIUM_BASE_PATH}/session/${sessionId}/screenshot`);
    const shotBody = await shotResp.json().catch(() => ({}));
    const b64 = shotBody.value;
    if (typeof b64 === 'string' && b64.length > 100) {
      const bytes = Buffer.from(b64, 'base64').length;
      log(c.ok(`Screenshot bytes: ${bytes}`));
    } else {
      fail('Screenshot came back empty');
    }
    return sessionId;
  } catch (err) {
    fail(`Session open threw: ${err.message}`);
    return null;
  } finally {
    if (sessionId) {
      try {
        await fetch(`${APPIUM_URL}${APPIUM_BASE_PATH}/session/${sessionId}`, { method: 'DELETE' });
      } catch (_) { /* best-effort cleanup */ }
    }
  }
}

// --- main -----------------------------------------------------------------

(async () => {
  console.log(c.b('Runner preflight'), c.dim(`(appium=${APPIUM_URL}${APPIUM_BASE_PATH})`));
  await checkAppiumStatus();
  const adb = checkAdbAvailable();
  const device = adb ? checkAdbDevices() : null;
  const serial = DEVICE_UDID || (device && device.serial) || null;
  const igVersion = serial ? checkInstagramInstalled(serial) : null;
  if (serial && igVersion) await checkOpenSession(serial);

  console.log('');
  if (failed) {
    console.log(c.err(`[preflight] ${failed} check(s) failed — fix above and re-run.`));
    process.exit(1);
  }
  console.log(c.ok('[preflight] ✅ all checks passed — the runner is ready to scout'));
})().catch((err) => {
  console.error('[preflight] fatal:', err && err.stack || err.message || err);
  process.exit(2);
});
