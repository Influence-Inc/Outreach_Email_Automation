'use strict';

// Runs the IosDriver through an injected `remote` stub — no Appium, no Mac, no
// phone. Verifies:
//   * the iOS capability set (XCUITest + WDA signing bits) is what Appium expects
//   * the shared {screenshot, tap, swipe, typeText, openApp, home, close} verbs
//     round-trip through the same W3C pointer protocol AndroidDriver uses, so
//     the navigator + main loop can drive either phone unchanged
//
// The tests build a fake session with just the surface the driver touches
// (takeScreenshot, performActions, releaseActions, execute, deleteSession).

const test = require('node:test');
const assert = require('node:assert');
const { IosDriver } = require('./ios');
const { IG_IOS_BUNDLE } = require('../navigator/instagram');

function stubSession() {
  const calls = [];
  return {
    calls,
    async takeScreenshot() { calls.push({ op: 'screenshot' }); return Buffer.from('shot').toString('base64'); },
    async performActions(actions) { calls.push({ op: 'performActions', actions }); },
    async releaseActions() { calls.push({ op: 'release' }); },
    async execute(cmd, args) { calls.push({ op: 'execute', cmd, args }); },
    async deleteSession() { calls.push({ op: 'delete' }); },
  };
}

function stubRemoteFactory() {
  const session = stubSession();
  const remotes = [];
  const remote = async (opts) => { remotes.push(opts); return session; };
  return { remote, remotes, session };
}

test('IosDriver builds an XCUITest + WDA-signing capability set from env', async () => {
  const { remote, remotes } = stubRemoteFactory();
  const d = new IosDriver({
    appiumUrl: 'http://mac.local:4723',
    udid: '00008101-000A1B2C3D4E5F6',
    deviceName: 'Scouting iPhone',
    xcodeOrgId: 'ABCDE12345',
    remote,
  });
  await d.screenshot();
  assert.strictEqual(remotes.length, 1);
  const caps = remotes[0].capabilities;
  assert.strictEqual(caps.platformName, 'iOS');
  assert.strictEqual(caps['appium:automationName'], 'XCUITest');
  assert.strictEqual(caps['appium:bundleId'], IG_IOS_BUNDLE);
  assert.strictEqual(caps['appium:udid'], '00008101-000A1B2C3D4E5F6');
  assert.strictEqual(caps['appium:deviceName'], 'Scouting iPhone');
  assert.strictEqual(caps['appium:xcodeOrgId'], 'ABCDE12345');
  assert.strictEqual(caps['appium:xcodeSigningId'], 'iPhone Developer');
});

test('tap issues the shared W3C pointer sequence and releases actions', async () => {
  const { remote, session } = stubRemoteFactory();
  const d = new IosDriver({ appiumUrl: 'http://x:4723', remote });
  await d.tap(120, 340);
  const perform = session.calls.find((c) => c.op === 'performActions');
  assert.ok(perform, 'performActions called');
  const seq = perform.actions[0].actions.map((a) => a.type);
  assert.deepStrictEqual(seq, ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
  assert.ok(session.calls.some((c) => c.op === 'release'));
});

test('swipe issues a two-move pointer sequence with the requested duration', async () => {
  const { remote, session } = stubRemoteFactory();
  const d = new IosDriver({ appiumUrl: 'http://x:4723', remote });
  await d.swipe({ x1: 10, y1: 20, x2: 100, y2: 200, durationMs: 250 });
  const perform = session.calls.find((c) => c.op === 'performActions');
  const moves = perform.actions[0].actions.filter((a) => a.type === 'pointerMove');
  assert.strictEqual(moves.length, 2);
  assert.strictEqual(moves[1].duration, 250);
  assert.strictEqual(moves[1].x, 100);
});

test('typeText/home/openApp map to XCUITest mobile: commands', async () => {
  const { remote, session } = stubRemoteFactory();
  const d = new IosDriver({ appiumUrl: 'http://x:4723', remote });
  await d.typeText('gym');
  await d.home();
  await d.openApp();
  const cmds = session.calls.filter((c) => c.op === 'execute').map((c) => ({ cmd: c.cmd, args: c.args }));
  assert.deepStrictEqual(cmds[0], { cmd: 'mobile: type', args: { text: 'gym' } });
  assert.deepStrictEqual(cmds[1], { cmd: 'mobile: pressButton', args: { name: 'home' } });
  assert.deepStrictEqual(cmds[2], { cmd: 'mobile: launchApp', args: { bundleId: IG_IOS_BUNDLE } });
});

test('close deletes the session and clears it (idempotent)', async () => {
  const { remote, session } = stubRemoteFactory();
  const d = new IosDriver({ appiumUrl: 'http://x:4723', remote });
  await d.screenshot();       // open the session
  await d.close();
  assert.ok(session.calls.some((c) => c.op === 'delete'));
  await d.close();            // second call is a no-op
});
