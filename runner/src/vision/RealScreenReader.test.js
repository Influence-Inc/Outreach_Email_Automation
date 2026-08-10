'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RealScreenReader } = require('./RealScreenReader');

function stubDriver({ elements = [], size = { width: 1080, height: 2400 }, dumpErr = null } = {}) {
  return {
    dumpUi: async () => { if (dumpErr) throw dumpErr; return elements; },
    getWindowSize: async () => size,
  };
}

test('captures the UI tree + device size and returns the backend interpretation', async () => {
  const calls = [];
  const backend = {
    readScreen: async (p) => { calls.push(p); return { screen: 'profile', targets: { back: { x: 1, y: 2 } }, followers: 84000 }; },
  };
  const driver = stubDriver({ elements: [{ rid: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 } }] });
  const reader = new RealScreenReader({ driver, backend });
  const r = await reader.read({ data: Buffer.from('png') });
  assert.strictEqual(r.screen, 'profile');
  assert.strictEqual(r.followers, 84000);
  assert.deepStrictEqual(calls[0], {
    elements: [{ rid: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 } }],
    width: 1080,
    height: 2400,
  });
});

test('caches the device size across reads (one getWindowSize call)', async () => {
  let sizeCalls = 0;
  const backend = { readScreen: async () => ({ screen: 'search', targets: {} }) };
  const driver = {
    dumpUi: async () => [],
    getWindowSize: async () => { sizeCalls += 1; return { width: 720, height: 1560 }; },
  };
  const reader = new RealScreenReader({ driver, backend });
  await reader.read();
  await reader.read();
  assert.strictEqual(sizeCalls, 1);
});

test('degrades to unknown when dumpUi throws (never crashes the run)', async () => {
  const backend = { readScreen: async () => ({ screen: 'profile', targets: {} }) };
  const driver = stubDriver({ dumpErr: new Error('uiautomator: null root node') });
  const logs = [];
  const reader = new RealScreenReader({ driver, backend, logger: { warn: (...a) => logs.push(a) } });
  const r = await reader.read();
  assert.deepStrictEqual(r, { screen: 'unknown', targets: {} });
  assert.ok(logs.length >= 1, 'logs the failure');
});

test('degrades to unknown when the backend read fails', async () => {
  const backend = { readScreen: async () => { throw new Error('500'); } };
  const reader = new RealScreenReader({ driver: stubDriver(), backend, logger: { warn() {} } });
  const r = await reader.read();
  assert.strictEqual(r.screen, 'unknown');
});

test('constructor validates the driver + backend', () => {
  assert.throws(() => new RealScreenReader({ backend: { readScreen() {} } }), /driver/);
  assert.throws(() => new RealScreenReader({ driver: { dumpUi() {} } }), /backend/);
});
