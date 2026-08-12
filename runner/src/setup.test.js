'use strict';

const test = require('node:test');
const assert = require('node:assert');
const s = require('./setup');

test('parseDevices reads adb devices output', () => {
  const out = 'List of devices attached\n12345ABCDE\tdevice\n192.168.1.9:5555\tdevice\nZZZ\tunauthorized\n';
  assert.deepStrictEqual(s.parseDevices(out), [
    { serial: '12345ABCDE', state: 'device' },
    { serial: '192.168.1.9:5555', state: 'device' },
    { serial: 'ZZZ', state: 'unauthorized' },
  ]);
  assert.deepStrictEqual(s.parseDevices(''), []);
});

test('adb pair/connect arg builders', () => {
  assert.deepStrictEqual(s.adbPairArgs({ host: '192.168.1.9', pairPort: 37000 }), ['pair', '192.168.1.9:37000']);
  assert.deepStrictEqual(s.adbConnectArgs({ host: '192.168.1.9', port: 5555 }), ['connect', '192.168.1.9:5555']);
});

test('hostFromInput / portFromInput tolerate a pasted full ip:port in any field', () => {
  assert.strictEqual(s.hostFromInput('192.168.1.5:44209'), '192.168.1.5');
  assert.strictEqual(s.hostFromInput('192.168.1.5'), '192.168.1.5');
  assert.strictEqual(s.hostFromInput('  192.168.1.5:44209  '), '192.168.1.5');
  assert.strictEqual(s.portFromInput('46451'), '46451');
  assert.strictEqual(s.portFromInput('192.168.1.5:46451'), '46451');
  assert.strictEqual(s.portFromInput('', '5555'), '5555');
});

test('pair/connect builders survive a full ip:port pasted into every field', () => {
  // The exact mistake that produced "protocol fault": ip:port in BOTH fields.
  assert.deepStrictEqual(
    s.adbPairArgs({ host: '192.168.1.5:44209', pairPort: '192.168.1.5:46451' }),
    ['pair', '192.168.1.5:46451'],
  );
  assert.deepStrictEqual(
    s.adbConnectArgs({ host: '192.168.1.5:44209', port: '192.168.1.5:44209' }),
    ['connect', '192.168.1.5:44209'],
  );
});

test('buildConfigFromAnswers (agent + wifi) writes the right RUNNER_* keys', () => {
  const cfg = s.buildConfigFromAnswers({
    backendUrl: 'https://deals.influence.technology/',
    hostToken: 'sk_abc',
    mode: 'agent',
    hostId: 4,
    adbMode: 'wifi',
    wifiHost: '192.168.1.9',
    wifiPort: 5555,
  });
  assert.deepStrictEqual(cfg, {
    RUNNER_DRIVER: 'android',
    RUNNER_BACKEND_URL: 'https://deals.influence.technology', // trailing slash trimmed
    RUNNER_HOST_TOKEN: 'sk_abc',
    RUNNER_MODE: 'agent',
    RUNNER_HOST_ID: '4',
    RUNNER_ADB_MODE: 'wifi',
    RUNNER_DEVICE_UDID: '192.168.1.9:5555',
  });
  assert.deepStrictEqual(s.missingKeys(cfg), []);
});

test('buildConfigFromAnswers (scout + usb) defaults RUNNER_RUN_ID=auto', () => {
  const cfg = s.buildConfigFromAnswers({
    backendUrl: 'https://x', hostToken: 't', mode: 'scout', adbMode: 'usb', deviceUdid: 'ABC123',
  });
  assert.strictEqual(cfg.RUNNER_RUN_ID, 'auto');
  assert.strictEqual(cfg.RUNNER_DEVICE_UDID, 'ABC123');
  assert.strictEqual(cfg.RUNNER_MODE, undefined);
});

test('missingKeys flags an incomplete config', () => {
  assert.deepStrictEqual(s.missingKeys({ RUNNER_MODE: 'agent' }).sort(), ['RUNNER_BACKEND_URL', 'RUNNER_HOST_ID', 'RUNNER_HOST_TOKEN']);
});
