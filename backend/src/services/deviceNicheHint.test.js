'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { tryDeviceHint, mentionsNiche } = require('./deviceNicheHint');

const CONFIG = { niche: 'running', keywords: ['marathon'] };

function fakeDriver(reply) {
  const calls = [];
  return {
    calls,
    describeImage: async (args) => {
      calls.push(args);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(args) : reply;
    },
  };
}

// ── the asymmetry: it may only ever save a cloud call, never reject alone ────

test('a confident on-device match skips the cloud call', async () => {
  const driver = fakeDriver({ description: 'a person running a marathon on a trail', available: true });
  const r = await tryDeviceHint({ driver, config: CONFIG });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.source, 'on-device');
});

test('an inconclusive description defers to the cloud prescreen', async () => {
  const driver = fakeDriver({ description: 'a person cooking in a kitchen', available: true });
  const r = await tryDeviceHint({ driver, config: CONFIG });
  assert.strictEqual(r, null, 'never a reject on its own — just no opinion');
});

test('available:false is treated the same as no opinion', async () => {
  const driver = fakeDriver({ available: false });
  const r = await tryDeviceHint({ driver, config: CONFIG });
  assert.strictEqual(r, null);
});

test('a missing description is treated the same as no opinion', async () => {
  const driver = fakeDriver({ available: true });
  const r = await tryDeviceHint({ driver, config: CONFIG });
  assert.strictEqual(r, null);
});

test('an agent build that does not implement the op fails silently', async () => {
  const driver = fakeDriver(new Error('unknown command op: describeImage'));
  const r = await tryDeviceHint({ driver, config: CONFIG });
  assert.strictEqual(r, null);
});

test('a driver with no describeImage method is skipped without a call', async () => {
  const r = await tryDeviceHint({ driver: {}, config: CONFIG });
  assert.strictEqual(r, null);
});

test('no niche configured means nothing to compare against', async () => {
  const driver = fakeDriver({ description: 'anything at all', available: true });
  const r = await tryDeviceHint({ driver, config: {} });
  assert.strictEqual(r, null);
  assert.strictEqual(driver.calls.length, 0, 'and does not spend a call to find that out');
});

test('asks for the requested screenshot kind', async () => {
  const driver = fakeDriver({ description: 'a marathon runner', available: true });
  await tryDeviceHint({ driver, kind: 'bio', config: CONFIG });
  assert.strictEqual(driver.calls[0].kind, 'bio');
});

// ── mentionsNiche ─────────────────────────────────────────────────────────────

test('mentionsNiche matches the niche or any keyword, case-insensitively', () => {
  assert.strictEqual(mentionsNiche('A person RUNNING on a track', CONFIG), true);
  assert.strictEqual(mentionsNiche('someone training for a Marathon', CONFIG), true);
  assert.strictEqual(mentionsNiche('a chef plating food', CONFIG), false);
  assert.strictEqual(mentionsNiche('', CONFIG), false);
  assert.strictEqual(mentionsNiche(null, CONFIG), false);
});
