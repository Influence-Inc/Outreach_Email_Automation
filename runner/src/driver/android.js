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
//   dumpUi      -> adb shell uiautomator dump + cat        (structured UI tree)
//   keepAwake   -> adb shell svc power stayon true         (screen never locks)
//   wake        -> adb shell input keyevent KEYCODE_WAKEUP (+ dismiss keyguard)
//
// Reliability: `adb` links drop (a bumped USB cable, a Wi-Fi hiccup) and a
// locked screen makes `screencap` return nothing. Both used to fail a whole
// scouting run. Now every adb call goes through _execWithReconnect() which, on a
// transient transport error, re-establishes the link (Wi-Fi: `adb connect
// ip:port`; USB: `adb reconnect`) and retries — and screenshot() wakes the phone
// once before giving up. This is what makes the one-time setup actually stay up.
//
// `adb` must be on PATH and the phone connected + authorized (see
// runner/PHASE_D_CHECKLIST.md). If several devices are attached, pass `serial`
// (from `adb devices`) so every command targets the right one.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DeviceDriver } = require('./base');
const { IG_ANDROID_PACKAGE } = require('../navigator/instagram');

const UI_DUMP_PATH = '/sdcard/window_dump.xml';

// adb errors that mean "the link dropped / device isn't reachable right now" —
// worth a reconnect + retry. A locked-screen empty screenshot is NOT here: that
// surfaces after exec succeeds and is handled in screenshot() by waking first.
const TRANSIENT_ADB =
  /device (?:offline|not found|unauthorized)|no devices\/?|error: closed|protocol fault|cannot connect|connection reset|device still (?:authorizing|connecting)|adb: device offline/i;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

// Minimal XML entity decode for the text/content-desc attributes a UI dump
// carries (captions and bios routinely contain & < > " ').
function xmlUnescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Parse a `uiautomator dump` XML into the flat element array the backend screen
// reader consumes: [{ rid, cls, text, desc, clickable, selected, bounds:{x,y,w,h} }].
// Nodes without a real bounds box are dropped (nothing to tap / read). Pure +
// exported so it's unit-testable without a phone.
function parseUiXml(xml) {
  const out = [];
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  const attrRe = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    const b = attrs.bounds && attrs.bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const x1 = Number(b[1]);
    const y1 = Number(b[2]);
    const x2 = Number(b[3]);
    const y2 = Number(b[4]);
    out.push({
      rid: attrs['resource-id'] || '',
      cls: attrs.class || '',
      text: xmlUnescape(attrs.text || ''),
      desc: xmlUnescape(attrs['content-desc'] || ''),
      clickable: attrs.clickable === 'true',
      selected: attrs.selected === 'true',
      bounds: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
    });
  }
  return out;
}

class AndroidDriver extends DeviceDriver {
  constructor({
    serial = null,
    adbPath = 'adb',
    exec = defaultExec,
    mode = 'usb',
    reconnectRetries = 3,
    reconnectBackoffMs = 1000,
    wakeOnEmpty = true,
    scrcpyPath = 'scrcpy',
    scrcpy = defaultExec,
    readFile = fs.promises.readFile,
    unlink = fs.promises.unlink,
  } = {}) {
    super();
    this.serial = serial;
    this.adbPath = adbPath;
    this._exec = exec;
    this.scrcpyPath = scrcpyPath;
    this._scrcpy = scrcpy;
    this._readFile = readFile;
    this._unlink = unlink;
    // Wi-Fi debugging shows up as an `ip:port` serial; treat that as Wi-Fi even
    // if the caller didn't say so, since reconnect differs (adb connect vs reconnect).
    this.isWifi = mode === 'wifi' || /:\d+$/.test(String(serial || ''));
    this.reconnectRetries = Math.max(0, Number(reconnectRetries) || 0);
    this.reconnectBackoffMs = Math.max(0, Number(reconnectBackoffMs) || 0);
    this.wakeOnEmpty = wakeOnEmpty !== false;
    this._reconnecting = false;
  }

  _isTransient(err) {
    const hay = `${(err && err.message) || ''}\n${(err && err.stderr && err.stderr.toString()) || ''}`;
    return TRANSIENT_ADB.test(hay);
  }

  // Re-establish the adb link. Best-effort: a failed reconnect attempt just
  // means the following command retry fails too and we move to the next attempt.
  async _reconnect(attempt) {
    if (this.reconnectBackoffMs) await sleep(this.reconnectBackoffMs * attempt);
    try {
      if (this.isWifi && this.serial) {
        // Wireless debugging: reconnect to the phone's ip:port.
        await this._exec(this.adbPath, ['connect', this.serial]);
      } else {
        // USB: reset the host<->device connection for offline devices.
        await this._exec(this.adbPath, this.serial ? ['-s', this.serial, 'reconnect'] : ['reconnect']);
      }
    } catch (_) {
      /* ignore — the command retry below is the real signal */
    }
  }

  // Run one adb invocation, transparently reconnecting + retrying on a transient
  // transport error. The happy path is a single _exec call (identical args), so
  // nothing here changes normal behavior — reconnect only kicks in on failure.
  async _execWithReconnect(full) {
    try {
      return await this._exec(this.adbPath, full);
    } catch (err) {
      if (this._reconnecting || !this.reconnectRetries || !this._isTransient(err)) throw err;
      this._reconnecting = true;
      try {
        for (let attempt = 1; attempt <= this.reconnectRetries; attempt += 1) {
          await this._reconnect(attempt);
          try {
            return await this._exec(this.adbPath, full);
          } catch (retryErr) {
            if (attempt === this.reconnectRetries || !this._isTransient(retryErr)) throw retryErr;
          }
        }
        throw err;
      } finally {
        this._reconnecting = false;
      }
    }
  }

  // Every adb invocation is prefixed with `-s <serial>` when one was given, so
  // commands target the right phone when several are attached to the host.
  async _adb(args) {
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    return this._execWithReconnect(full);
  }

  // Establish the Wi-Fi link up front (no-op on USB). Safe to call repeatedly.
  async connect() {
    if (this.isWifi && this.serial) {
      try { await this._exec(this.adbPath, ['connect', this.serial]); }
      catch (_) { /* preflight / first real command surfaces a hard failure */ }
    }
  }

  async screenshot() {
    let { stdout } = await this._adb(['exec-out', 'screencap', '-p']);
    // A locked / asleep screen returns no bytes. Wake once and retry before
    // declaring the screen locked — keeps a long run alive across screen-offs.
    if ((!stdout || !stdout.length) && this.wakeOnEmpty) {
      await this.wake().catch(() => {});
      ({ stdout } = await this._adb(['exec-out', 'screencap', '-p']));
    }
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

  // Commit a typed search query (the keyboard's Search key). Without this IG
  // only shows as-you-type ACCOUNT suggestions, never the keyword's content
  // results. KEYCODE_ENTER fires the IME action on the focused field.
  async submitSearch() {
    await this._adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
  }

  // `monkey -p <pkg> -c LAUNCHER 1` launches the app's default launcher
  // activity without us needing to know its class name — robust across IG
  // app updates that might rename the activity.
  async openApp(pkg = IG_ANDROID_PACKAGE) {
    await this._adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  // Keep the screen on while the phone is charging/plugged so a long standing
  // run never hits a locked screen mid-scout. Best-effort — some ROMs ignore it,
  // which is why screenshot() also wakes on an empty capture.
  async keepAwake() {
    await this._adb(['shell', 'svc', 'power', 'stayon', 'true']);
  }

  // Wake the display and best-effort dismiss a non-secure keyguard so taps land.
  async wake() {
    await this._adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    try { await this._adb(['shell', 'wm', 'dismiss-keyguard']); }
    catch (_) { /* not available on every device / secured lock screens */ }
  }

  // Dump the current screen's accessibility/UI tree and return it parsed. The
  // backend screen reader turns this into {screen, targets, ...} — exact tap
  // coordinates from real element bounds, no pixel-guessing.
  async dumpUi() {
    await this._adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH]);
    const { stdout } = await this._adb(['exec-out', 'cat', UI_DUMP_PATH]);
    return parseUiXml(stdout.toString('utf8'));
  }

  // Record a short clip of the phone screen WITH audio (so the multimodal judge
  // can hear the reel), using scrcpy — `adb screenrecord` cannot capture audio.
  // scrcpy self-terminates at --time-limit; we read the mp4 back and clean up.
  // Audio is captured on Android 11+ (default in scrcpy 2.0+). Returns raw bytes;
  // the agent uploads them to the backend, which sends them to Gemini.
  async recordClip({ seconds = 12 } = {}) {
    const secs = Math.max(1, Math.round(seconds));
    const file = path.join(os.tmpdir(), `reel-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    const args = [];
    if (this.serial) args.push('--serial', this.serial);
    args.push('--no-window', '--no-control', '--record-format=mp4', `--time-limit=${secs}`, `--record=${file}`);
    try {
      await this._scrcpy(this.scrcpyPath, args); // blocks until the time limit elapses
      const data = await this._readFile(file);
      if (!data || !data.length) throw new Error('scrcpy produced an empty recording');
      return { mediaType: 'video/mp4', data };
    } finally {
      try { await this._unlink(file); } catch (_) { /* temp file may not exist */ }
    }
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

module.exports = { AndroidDriver, escapeAdbText, parseUiXml, xmlUnescape };
