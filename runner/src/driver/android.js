'use strict';

// AndroidDriver — implements the DeviceDriver contract on a real Android phone
// using ONLY adb (Android's own official command-line tool, part of the
// standard Android SDK Platform Tools). No Appium, no extra server process, no
// extra npm dependency — everything the {screenshot, tap, swipe, typeText,
// openApp, home} contract needs is a built-in adb/shell capability:
//
//   screenshot  -> adb exec-out screencap -p              (raw PNG bytes)
//   tap         -> adb shell input tap X Y
//   swipe       -> adb shell input swipe X1 Y1 X2 Y2 DURATION_MS
//   typeText    -> adb shell input text <escaped>
//   home        -> adb shell input keyevent KEYCODE_HOME
//   openApp     -> adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1
//                  (the standard "launch app by package, no need to know its
//                  main activity class name" trick — more robust than hard-
//                  coding an activity name that IG can rename between releases)
//   getWindowSize -> adb shell wm size
//
// `adb` must be on PATH and the phone connected + authorized (see
// runner/PHASE_D_CHECKLIST.md). If several devices are attached, pass `serial`
// (from `adb devices`) so every command targets the right one.

const { execFile } = require('child_process');
const { DeviceDriver } = require('./base');
const { IG_ANDROID_PACKAGE } = require('../navigator/instagram');

// Injectable for tests (see android.test.js) — real usage leaves this as the
// actual child_process.execFile, returning { stdout, stderr } as Buffers so
// binary output (screenshots) survives intact.
function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// `adb shell input text` sends the string through the DEVICE's shell, which
// treats spaces and shell metacharacters specially. Percent-encode spaces
// (Android's documented convention) and backslash-escape the handful of
// characters that shell would otherwise interpret. Good enough for search
// keywords / hashtags / @handles — this is not a general-purpose shell quoter.
function escapeAdbText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/(["'`$&|;()<>*?~!#])/g, '\\$1')
    .replace(/ /g, '%s');
}

class AndroidDriver extends DeviceDriver {
  constructor({ serial = null, adbPath = 'adb', exec = defaultExec } = {}) {
    super();
    this.serial = serial;
    this.adbPath = adbPath;
    this._exec = exec;
  }

  // Every adb invocation is prefixed with `-s <serial>` when one was given, so
  // commands target the right phone when several are attached to the host.
  async _adb(args) {
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    return this._exec(this.adbPath, full);
  }

  async screenshot() {
    const { stdout } = await this._adb(['exec-out', 'screencap', '-p']);
    if (!stdout || !stdout.length) throw new Error('adb screencap returned no data — is the screen locked?');
    return { data: stdout, mediaType: 'image/png' };
  }

  async tap(x, y) {
    await this._adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe({ x1, y1, x2, y2, durationMs = 200 }) {
    await this._adb([
      'shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(Math.round(durationMs)),
    ]);
  }

  async typeText(text) {
    await this._adb(['shell', 'input', 'text', escapeAdbText(text)]);
  }

  async home() {
    await this._adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  }

  // `monkey -p <pkg> -c LAUNCHER 1` launches the app's default launcher
  // activity without us needing to know its class name — robust across IG
  // app updates that might rename the activity.
  async openApp(pkg = IG_ANDROID_PACKAGE) {
    await this._adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  async close() {
    // No persistent session to tear down — each command is a fresh adb call.
  }

  // Real device pixel size, used by the live mirror to normalize an admin
  // click in the dashboard's phone image back to device coordinates.
  async getWindowSize() {
    const { stdout } = await this._adb(['shell', 'wm', 'size']);
    const text = stdout.toString('utf8');
    // "Physical size: 1080x2340" (or "Override size: ..." if the phone has a
    // custom density override — prefer that when present, it's what's actually
    // rendered).
    const override = text.match(/Override size:\s*(\d+)x(\d+)/);
    const physical = text.match(/Physical size:\s*(\d+)x(\d+)/);
    const m = override || physical;
    if (!m) return { width: null, height: null };
    return { width: Number(m[1]), height: Number(m[2]) };
  }
}

module.exports = { AndroidDriver, escapeAdbText };
