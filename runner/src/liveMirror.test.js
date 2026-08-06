'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startLiveMirror, executeOp } = require('./liveMirror');

function stubDriver() {
  const calls = [];
  return {
    calls,
    async screenshot() { calls.push({ op: 'screenshot' }); return { data: Buffer.from('frame'), mediaType: 'image/png' }; },
    async tap(x, y) { calls.push({ op: 'tap', x, y }); },
    async swipe(o) { calls.push({ op: 'swipe', ...o }); },
    async typeText(text) { calls.push({ op: 'type', text }); },
    async home() { calls.push({ op: 'home' }); },
  };
}

function stubBackend({ ops = [] } = {}) {
  const state = { frames: [], drained: 0, ops };
  return {
    state,
    async publishFrame(_id, payload) { state.frames.push(payload); },
    async pullControls() {
      if (state.drained === 0) { state.drained = 1; return { ops: state.ops }; }
      return { ops: [] };
    },
  };
}

test('executeOp maps ops to driver calls', async () => {
  const driver = stubDriver();
  await executeOp({ driver, op: { op: 'tap', x: 5, y: 6 } });
  await executeOp({ driver, op: { op: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 150 } });
  await executeOp({ driver, op: { op: 'type', text: 'hi' } });
  await executeOp({ driver, op: { op: 'home' } });
  await executeOp({ driver, op: { op: 'pause' } }); // no-op on driver
  const ops = driver.calls.map((c) => c.op);
  assert.deepStrictEqual(ops, ['tap', 'swipe', 'type', 'home']);
});

test('startLiveMirror captures a frame and drains queued controls', async () => {
  const driver = stubDriver();
  const backend = stubBackend({ ops: [{ op: 'tap', x: 10, y: 20 }] });
  const ctl = startLiveMirror({
    driver, backend, hostId: 1,
    frameIntervalMs: 1, controlIntervalMs: 1,
  });
  // Give both loops a couple of ticks to run before shutting down.
  await new Promise((r) => setTimeout(r, 40));
  await ctl.stop();
  assert.ok(backend.state.frames.length >= 1, 'at least one frame uploaded');
  const b64 = Buffer.from(backend.state.frames[0].dataBase64, 'base64').toString();
  assert.strictEqual(b64, 'frame');
  assert.ok(driver.calls.some((c) => c.op === 'tap' && c.x === 10), 'the queued tap ran');
});

test('startLiveMirror exits promptly when getShouldStop flips true', async () => {
  const driver = stubDriver();
  const backend = stubBackend();
  let stop = false;
  const ctl = startLiveMirror({
    driver, backend, hostId: 1,
    frameIntervalMs: 20, controlIntervalMs: 20,
    getShouldStop: () => stop,
  });
  await new Promise((r) => setTimeout(r, 5));
  stop = true;
  const start = Date.now();
  await ctl.stop();
  assert.ok(Date.now() - start < 100, 'stop resolves quickly');
});
