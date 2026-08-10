'use strict';

const test = require('node:test');
const assert = require('node:assert');
const hc = require('./hostCommands');

test.afterEach(() => hc._reset());

test('enqueue -> pull -> resolve settles the awaiting promise with the result', async () => {
  const { id, promise } = hc.enqueue(1, { op: 'dumpUi' });
  const { commands, done } = hc.pull(1);
  assert.strictEqual(done, false);
  assert.deepStrictEqual(commands, [{ id, op: 'dumpUi', args: {} }]);
  hc.resolve(1, id, { ok: true, result: [{ rid: 'a' }] });
  assert.deepStrictEqual(await promise, [{ rid: 'a' }]);
});

test('pull drains the queue (a second pull is empty)', () => {
  hc.enqueue(1, { op: 'tap', args: { x: 1, y: 2 } });
  assert.strictEqual(hc.pull(1).commands.length, 1);
  assert.strictEqual(hc.pull(1).commands.length, 0);
});

test('resolve with ok:false rejects the awaiter with the error message', async () => {
  const { id, promise } = hc.enqueue(1, { op: 'tap' });
  hc.pull(1);
  hc.resolve(1, id, { ok: false, error: 'screen locked' });
  await assert.rejects(() => promise, /screen locked/);
});

test('a command times out if the agent never answers', async () => {
  const { promise } = hc.enqueue(1, { op: 'dumpUi' }, { timeoutMs: 10 });
  await assert.rejects(() => promise, /timed out/);
});

test('endSession makes the next pull return done:true', () => {
  hc.endSession(1);
  assert.strictEqual(hc.pull(1).done, true);
});

test('beginSession rejects stragglers from a prior run so awaiters never hang', async () => {
  const { promise } = hc.enqueue(1, { op: 'dumpUi' });
  hc.beginSession(1);
  await assert.rejects(() => promise, /reset/);
  // fresh session: done cleared, queue empty
  assert.deepStrictEqual(hc.pull(1), { commands: [], done: false });
});

test('resolve returns false for an unknown/expired command id', () => {
  assert.strictEqual(hc.resolve(1, 999, { ok: true }), false);
});

test('enqueue rejects an op-less command and enforces the queue cap', () => {
  assert.throws(() => hc.enqueue(1, {}), /op is required/);
  for (let i = 0; i < hc.MAX_QUEUE; i += 1) hc.enqueue(2, { op: 'tap' });
  assert.throws(() => hc.enqueue(2, { op: 'tap' }), /queue full/);
});
