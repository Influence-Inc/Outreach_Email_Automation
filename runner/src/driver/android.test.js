'use strict';

// Runs AndroidDriver through an injected `exec` stub — no adb, no phone, no
// Appium. Verifies each DeviceDriver verb maps to the right `adb` invocation,
// that a device serial is threaded through every call when given, and that
// text typing is escaped for the device-side shell.

const test = require('node:test');
const assert = require('node:assert');
const { AndroidDriver, escapeAdbText } = require('./android');
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
