#!/usr/bin/env node
'use strict';

// runner/scripts/preflight.js
//
// Verify the whole live-scouting stack is talking BEFORE we start burning IG's
// rate limit against a broken setup. Runs top-down: ADB found → phone attached
// & authorized → IG installed → the REAL AndroidDriver can screenshot the
// phone. Each check prints exactly which layer is at fault so the fix is
// one-line. No Appium involved — Android is driven directly over adb.
//
// Usage:
//   node scripts/preflight.js
//   RUNNER_DEVICE_UDID=<serial> node scripts/preflight.js   # when >1 device attached
//
// The script is stand-alone — no runner state — so it's safe to run repeatedly
// while diagnosing setup issues on the host.

const { spawnSync } = require('child_process');
const { AndroidDriver } = require('../src/driver/android');

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
  if (devices.length > 1 && !DEVICE_UDID) {
    fail(
      `${devices.length} devices attached and RUNNER_DEVICE_UDID is not set`,
      'set RUNNER_DEVICE_UDID=<serial> to pick which one (see the list above)',
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

// Exercises the REAL AndroidDriver — the exact code the runner uses — so a
// green preflight is a genuine guarantee, not a separate reimplementation that
// could drift from the real driver.
async function checkDriverRoundTrip(serial) {
  log(c.dim('Opening the phone with AndroidDriver (adb only, no Appium)…'));
  const driver = new AndroidDriver({ serial });
  try {
    const size = await driver.getWindowSize();
    if (size && size.width) {
      log(c.ok(`Screen size reported: ${size.width} x ${size.height}`));
    } else {
      fail("'adb shell wm size' returned nothing parseable");
    }
    const shot = await driver.screenshot();
    log(c.ok(`Screenshot bytes: ${shot.data.length}`));
  } catch (err) {
    fail(`AndroidDriver round-trip failed: ${err.message}`);
  }
}

// --- main -----------------------------------------------------------------

(async () => {
  console.log(c.b('Runner preflight'), c.dim('(Android via adb — no Appium)'));
  const adb = checkAdbAvailable();
  const device = adb ? checkAdbDevices() : null;
  const serial = DEVICE_UDID || (device && device.serial) || null;
  const igVersion = serial ? checkInstagramInstalled(serial) : null;
  if (serial && igVersion) await checkDriverRoundTrip(serial);

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
