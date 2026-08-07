'use strict';

// Runs AndroidDriver through an injected `exec` stub — no adb, no phone, no
// Appium. Verifies each DeviceDriver verb maps to the right `adb` invocation,
// that a device serial is threaded through every call when given, and that
// text typing is escaped for the device-side shell.

const test = require('node:test');
const assert = require('node:assert');
const { AndroidDriver, escapeAdbText, parseUiXml } = require('./android');
const { IG_ANDROID_PACKAGE } = require('../navigator/instagram');

function stubExec() {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    // Fixtures the individual tests key off of.
    if (args.includes('screencap')) return { stdout: Buffer.from('PNGDATA'), stderr: Buffer.alloc(0) };
    if (args.includes('size')) return { stdout: Buffer.from('Physical size: 1080x2340\n'), stderr: Buffer.alloc(0) };
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  exec.calls = calls;
  return exec;
}

test('screenshot calls adb exec-out screencap -p and returns raw PNG bytes', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  const shot = await d.screenshot();
  assert.deepStrictEqual(exec.calls[0].args, ['exec-out', 'screencap', '-p']);
  assert.strictEqual(shot.mediaType, 'image/png');
  assert.strictEqual(shot.data.toString(), 'PNGDATA');
});

test('screenshot throws a clear error on empty output (locked screen)', async () => {
  const exec = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const d = new AndroidDriver({ exec });
  await assert.rejects(() => d.screenshot(), /screen locked/);
});

test('tap issues adb shell input tap with rounded coordinates', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.tap(120.6, 340.2);
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'input', 'tap', '121', '340']);
});

test('swipe issues adb shell input swipe with all five params', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.swipe({ x1: 10, y1: 20, x2: 100, y2: 200, durationMs: 250 });
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'input', 'swipe', '10', '20', '100', '200', '250']);
});

test('swipe defaults durationMs to 200 when omitted', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.swipe({ x1: 0, y1: 0, x2: 1, y2: 1 });
  assert.strictEqual(exec.calls[0].args[7], '200');
});

test('typeText escapes spaces and shell metacharacters for the device shell', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.typeText('gym & fitness');
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'input', 'text', 'gym%s\\&%sfitness']);
});

test('home issues the KEYCODE_HOME keyevent', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.home();
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
});

test('openApp launches via monkey -c LAUNCHER, defaulting to the IG package', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.openApp();
  assert.deepStrictEqual(exec.calls[0].args, [
    'shell', 'monkey', '-p', IG_ANDROID_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1',
  ]);
});

test('openApp accepts a custom package name', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.openApp('com.example.other');
  assert.strictEqual(exec.calls[0].args[3], 'com.example.other');
});

test('getWindowSize parses "Physical size: WxH"', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  const size = await d.getWindowSize();
  assert.deepStrictEqual(size, { width: 1080, height: 2340 });
});

test('getWindowSize prefers "Override size" over "Physical size" when both are present', async () => {
  const exec = async () => ({
    stdout: Buffer.from('Physical size: 1080x2340\nOverride size: 720x1560\n'),
    stderr: Buffer.alloc(0),
  });
  const d = new AndroidDriver({ exec });
  const size = await d.getWindowSize();
  assert.deepStrictEqual(size, { width: 720, height: 1560 });
});

test('every call is prefixed with -s <serial> when a serial is given', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec, serial: 'ABC123' });
  await d.tap(1, 1);
  await d.home();
  await d.screenshot();
  for (const call of exec.calls) {
    assert.deepStrictEqual(call.args.slice(0, 2), ['-s', 'ABC123']);
  }
});

test('no serial given -> no -s prefix', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.tap(1, 1);
  assert.strictEqual(exec.calls[0].args[0], 'shell');
});

test('close() is a no-op (no persistent session to tear down)', async () => {
  const d = new AndroidDriver({ exec: stubExec() });
  await assert.doesNotReject(() => d.close());
});

test('escapeAdbText percent-encodes spaces and backslash-escapes shell metacharacters', () => {
  assert.strictEqual(escapeAdbText('hello world'), 'hello%sworld');
  assert.strictEqual(escapeAdbText('a&b|c'), 'a\\&b\\|c');
  assert.strictEqual(escapeAdbText("it's \"quoted\""), 'it\\\'s%s\\"quoted\\"');
});

// --- keep-awake + wake -----------------------------------------------------

test('keepAwake issues svc power stayon true', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.keepAwake();
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'svc', 'power', 'stayon', 'true']);
});

test('wake sends KEYCODE_WAKEUP then best-effort dismiss-keyguard', async () => {
  const exec = stubExec();
  const d = new AndroidDriver({ exec });
  await d.wake();
  assert.deepStrictEqual(exec.calls[0].args, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  assert.deepStrictEqual(exec.calls[1].args, ['shell', 'wm', 'dismiss-keyguard']);
});

test('screenshot wakes once and retries on an empty capture, then returns bytes', async () => {
  let shots = 0;
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('screencap')) {
      shots += 1;
      return { stdout: shots === 1 ? Buffer.alloc(0) : Buffer.from('PNG'), stderr: Buffer.alloc(0) };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const d = new AndroidDriver({ exec });
  const shot = await d.screenshot();
  assert.strictEqual(shot.data.toString(), 'PNG');
  assert.ok(calls.some((a) => a.includes('KEYCODE_WAKEUP')), 'should have woken the phone');
  assert.strictEqual(calls.filter((a) => a.includes('screencap')).length, 2);
});

test('screenshot still throws "screen locked" when waking does not help', async () => {
  const exec = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const d = new AndroidDriver({ exec });
  await assert.rejects(() => d.screenshot(), /screen locked/);
});

// --- dumpUi + parseUiXml ---------------------------------------------------

test('dumpUi runs uiautomator dump, cats the file, and parses the tree', async () => {
  const xml =
    '<hierarchy rotation="0"><node text="hi" resource-id="com.x:id/a" ' +
    'class="android.widget.TextView" content-desc="" clickable="true" selected="false" ' +
    'bounds="[0,0][100,50]"/></hierarchy>';
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('cat')) return { stdout: Buffer.from(xml), stderr: Buffer.alloc(0) };
    return { stdout: Buffer.from('UI hierchary dumped to: /sdcard/window_dump.xml'), stderr: Buffer.alloc(0) };
  };
  const d = new AndroidDriver({ exec });
  const els = await d.dumpUi();
  assert.deepStrictEqual(calls[0], ['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
  assert.deepStrictEqual(els, [
    { rid: 'com.x:id/a', cls: 'android.widget.TextView', text: 'hi', desc: '', clickable: true, selected: false, bounds: { x: 0, y: 0, w: 100, h: 50 } },
  ]);
});

test('parseUiXml decodes entities, computes w/h from bounds, and skips boundless nodes', () => {
  const xml = [
    '<hierarchy rotation="0">',
    '<node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">',
    '<node text="gym &amp; fitness" resource-id="com.instagram.android:id/bio" ',
    'content-desc="bio" class="android.widget.TextView" clickable="false" selected="false" bounds="[10,20][210,80]"/>',
    '<node text="" class="android.view.View" clickable="true"/>',
    '</node></hierarchy>',
  ].join('');
  const els = parseUiXml(xml);
  const bio = els.find((e) => e.rid.endsWith('/bio'));
  assert.strictEqual(bio.text, 'gym & fitness');
  assert.deepStrictEqual(bio.bounds, { x: 10, y: 20, w: 200, h: 60 });
  assert.ok(!els.some((e) => e.cls === 'android.view.View'), 'boundless node is skipped');
});

// --- recordClip (scrcpy, video + audio) ------------------------------------

test('recordClip runs scrcpy with --time-limit + --record and returns the mp4 bytes', async () => {
  const calls = [];
  const d = new AndroidDriver({
    exec: stubExec(),
    serial: 'S1',
    scrcpy: async (cmd, args) => { calls.push({ cmd, args }); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    readFile: async () => Buffer.from('MP4DATA'),
    unlink: async () => {},
  });
  const clip = await d.recordClip({ seconds: 10 });
  assert.strictEqual(clip.mediaType, 'video/mp4');
  assert.strictEqual(clip.data.toString(), 'MP4DATA');
  assert.strictEqual(calls[0].cmd, 'scrcpy');
  assert.deepStrictEqual(calls[0].args.slice(0, 2), ['--serial', 'S1']);
  assert.ok(calls[0].args.includes('--time-limit=10'));
  assert.ok(calls[0].args.some((a) => a.startsWith('--record=')));
});

test('recordClip cleans up the temp file and throws on an empty recording', async () => {
  let unlinked = false;
  const d = new AndroidDriver({
    exec: stubExec(),
    scrcpy: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    readFile: async () => Buffer.alloc(0),
    unlink: async () => { unlinked = true; },
  });
  await assert.rejects(() => d.recordClip({ seconds: 5 }), /empty recording/);
  assert.strictEqual(unlinked, true);
});

// --- auto-reconnect --------------------------------------------------------

test('retries a transient adb failure after an (USB) reconnect', async () => {
  let firstTap = true;
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('tap') && firstTap) {
      firstTap = false;
      throw new Error('error: device offline');
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const d = new AndroidDriver({ exec, reconnectBackoffMs: 0 });
  await d.tap(5, 5);
  assert.ok(calls.some((a) => a[0] === 'reconnect'), 'should have issued adb reconnect');
  assert.strictEqual(calls.filter((a) => a.includes('tap')).length, 2, 'tap retried once');
});

test('reconnects over Wi-Fi with `adb connect ip:port`', async () => {
  let failed = false;
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('tap') && !failed) {
      failed = true;
      throw new Error('cannot connect to 192.168.1.9:5555');
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const d = new AndroidDriver({ exec, serial: '192.168.1.9:5555', reconnectBackoffMs: 0 });
  await d.tap(1, 1);
  assert.deepStrictEqual(calls.find((a) => a[0] === 'connect'), ['connect', '192.168.1.9:5555']);
});

test('does not retry a non-transient adb error', async () => {
  let n = 0;
  const exec = async () => { n += 1; throw new Error('some other failure'); };
  const d = new AndroidDriver({ exec, reconnectBackoffMs: 0 });
  await assert.rejects(() => d.tap(1, 1), /some other failure/);
  assert.strictEqual(n, 1, 'called exactly once, no reconnect/retry');
});

test('gives up after reconnectRetries transient failures', async () => {
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('tap')) throw new Error('device offline');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const d = new AndroidDriver({ exec, reconnectRetries: 2, reconnectBackoffMs: 0 });
  await assert.rejects(() => d.tap(1, 1), /device offline/);
  // initial + 2 retries = 3 taps
  assert.strictEqual(calls.filter((a) => a.includes('tap')).length, 3);
});
