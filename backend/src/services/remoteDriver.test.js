'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeRemoteDriver } = require('./remoteDriver');

function fakeChannel(resultFor) {
  const calls = [];
  return {
    calls,
    enqueue(hostId, cmd, opts) {
      calls.push({ hostId, cmd, opts });
      return { id: calls.length, promise: Promise.resolve(resultFor(cmd)) };
    },
  };
}

test('each verb enqueues the matching command + args and returns the agent result', async () => {
  const channel = fakeChannel((cmd) =>
    cmd.op === 'dumpUi' ? [{ rid: 'a' }] : cmd.op === 'getWindowSize' ? { width: 1080, height: 2400 } : null,
  );
  const d = makeRemoteDriver({ hostId: 7, channel });

  assert.deepStrictEqual(await d.dumpUi(), [{ rid: 'a' }]);
  assert.deepStrictEqual(await d.getWindowSize(), { width: 1080, height: 2400 });
  await d.openApp('com.instagram.android');
  await d.tap(3, 4);
  await d.swipe({ x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 250 });
  await d.typeText('home gym');

  assert.deepStrictEqual(channel.calls.map((c) => c.cmd.op), [
    'dumpUi', 'getWindowSize', 'openApp', 'tap', 'swipe', 'type',
  ]);
  assert.deepStrictEqual(channel.calls[2].cmd.args, { pkg: 'com.instagram.android' });
  assert.deepStrictEqual(channel.calls[3].cmd.args, { x: 3, y: 4 });
  assert.deepStrictEqual(channel.calls[4].cmd.args, { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 250 });
  assert.deepStrictEqual(channel.calls[5].cmd.args, { text: 'home gym' });
  assert.strictEqual(channel.calls[0].hostId, 7);
});

test('recordClip enqueues with a longer timeout and returns { clipId }', async () => {
  const calls = [];
  const channel = {
    enqueue(hostId, cmd, opts) { calls.push({ cmd, opts }); return { id: 1, promise: Promise.resolve({ clipId: 'clip_1' }) }; },
  };
  const d = makeRemoteDriver({ hostId: 4, channel });
  assert.deepStrictEqual(await d.recordClip(12), { clipId: 'clip_1' });
  assert.strictEqual(calls[0].cmd.op, 'recordClip');
  assert.strictEqual(calls[0].cmd.args.seconds, 12);
  assert.ok(calls[0].opts.timeoutMs >= 12000, 'timeout covers the recording window');
});

test('requires a hostId', () => {
  assert.throws(() => makeRemoteDriver({ channel: {} }), /hostId is required/);
});
