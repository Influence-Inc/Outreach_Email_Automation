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

// The channel is in-memory, so every backend restart — i.e. every deploy —
// empties it. An agent already inside serveSession then pulls against a backend
// that has forgotten it, and `done:false` meant it pulled FOREVER: no commands,
// never done, so it never returned to claim the next run. The phone polled into
// the void until someone reopened the app.
test('a host with no session is told the session is over, not to keep waiting', () => {
  assert.deepStrictEqual(hc.pull(42), { commands: [], done: true });
});

test('a restart mid-session releases the agent instead of wedging it', async () => {
  hc.beginSession(1);
  const { promise } = hc.enqueue(1, { op: 'dumpUi' });
  promise.catch(() => {}); // the restart abandons this awaiter
  assert.strictEqual(hc.pull(1).done, false, 'a live session keeps the agent serving');

  hc._reset(); // the deploy

  assert.deepStrictEqual(hc.pull(1), { commands: [], done: true }, 'agent is freed to re-claim');
});

// The claim response is only sent after beginSession has run (it happens before
// runSession's first await), so "no state" can never mean "a session is about to
// start" — which is what makes done:true safe rather than a race.
test('a session opened after a reset reports not-done again', () => {
  hc._reset();
  assert.strictEqual(hc.pull(7).done, true);
  hc.beginSession(7);
  assert.strictEqual(hc.pull(7).done, false);
});
