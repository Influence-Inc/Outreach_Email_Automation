'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ch = require('./hostChannel');

test('enabled toggles on SOURCING_LIVE_MIRROR=on', () => {
  const prev = process.env.SOURCING_LIVE_MIRROR;
  process.env.SOURCING_LIVE_MIRROR = 'on';
  assert.strictEqual(ch.enabled(), true);
  process.env.SOURCING_LIVE_MIRROR = 'off';
  assert.strictEqual(ch.enabled(), false);
  delete process.env.SOURCING_LIVE_MIRROR;
  assert.strictEqual(ch.enabled(), false);
  if (prev != null) process.env.SOURCING_LIVE_MIRROR = prev;
});

test('publishFrame stores the newest frame and latestFrame reads it', () => {
  ch._reset();
  ch.publishFrame(1, { dataBase64: Buffer.from('hello').toString('base64'), width: 100, height: 200 });
  const f = ch.latestFrame(1);
  assert.ok(f);
  assert.strictEqual(f.width, 100);
  assert.strictEqual(f.data.toString(), 'hello');
});

test('publishFrame rejects oversize payloads', () => {
  ch._reset();
  const big = Buffer.alloc(ch.MAX_FRAME_BYTES + 1).toString('base64');
  assert.throws(() => ch.publishFrame(1, { dataBase64: big }), /too large/);
});

test('publishFrame rejects an empty payload', () => {
  ch._reset();
  assert.throws(() => ch.publishFrame(1, { dataBase64: '' }), /empty/);
});

test('latestFrame ignores stale frames', () => {
  ch._reset();
  ch.publishFrame(1, { dataBase64: Buffer.from('x').toString('base64') });
  const frame = ch.latestFrame(1);
  // Age it past the freshness window (mutate the internal timestamp).
  frame.at -= ch.FRAME_STALE_MS + 1000;
  assert.strictEqual(ch.latestFrame(1), null);
});

test('pushControl queues valid ops; drainControls returns and clears', () => {
  ch._reset();
  ch.pushControl(7, { op: 'tap', x: 10, y: 20 });
  ch.pushControl(7, { op: 'swipe', x1: 0, y1: 0, x2: 5, y2: 5 });
  const drained = ch.drainControls(7);
  assert.strictEqual(drained.length, 2);
  assert.strictEqual(drained[0].op, 'tap');
  assert.deepStrictEqual(ch.drainControls(7), []);
});

test('pushControl rejects unknown ops', () => {
  ch._reset();
  assert.throws(() => ch.pushControl(7, { op: 'shoot-lasers' }), /unknown op/);
});

test('pushControl caps queue depth to prevent runaway', () => {
  ch._reset();
  for (let i = 0; i < ch.MAX_CONTROL_QUEUE + 5; i += 1) {
    ch.pushControl(9, { op: 'tap', x: i, y: 0 });
  }
  const drained = ch.drainControls(9);
  assert.strictEqual(drained.length, ch.MAX_CONTROL_QUEUE);
});

// ── why there is no live frame ──────────────────────────────────────────────

test('frameState says when the last frame arrived, and nothing for a silent host', () => {
  ch._reset();
  assert.deepStrictEqual(
    { ...ch.frameState(6), staleAfterMs: undefined },
    { lastFrameAt: null, lastError: null, misdirected: null, staleAfterMs: undefined },
  );
  ch.publishFrame(6, { dataBase64: Buffer.from('x').toString('base64') });
  assert.ok(ch.frameState(6).lastFrameAt > 0);
  assert.strictEqual(ch.frameState(6).staleAfterMs, ch.FRAME_STALE_MS);
});

test('a refused frame is remembered until the next good one', () => {
  ch._reset();
  const big = Buffer.alloc(ch.MAX_FRAME_BYTES + 1).toString('base64');
  assert.throws(() => ch.publishFrame(6, { dataBase64: big }), /too large/);
  assert.match(ch.frameState(6).lastError.message, /too large/);
  ch.publishFrame(6, { dataBase64: Buffer.from('ok').toString('base64') });
  assert.strictEqual(ch.frameState(6).lastError, null);
});

test('a frame addressed to another host number is noted on the real host', () => {
  ch._reset();
  ch.publishFrame(6, { dataBase64: Buffer.from('x').toString('base64') }, { claimedId: 3 });
  assert.ok(ch.latestFrame(6), 'filed under the host it belongs to');
  assert.strictEqual(ch.latestFrame(3), null);
  assert.strictEqual(ch.frameState(6).misdirected.claimedId, 3);
  // Addressed correctly: nothing to note.
  ch._reset();
  ch.publishFrame(6, { dataBase64: Buffer.from('x').toString('base64') }, { claimedId: 6 });
  assert.strictEqual(ch.frameState(6).misdirected, null);
});
