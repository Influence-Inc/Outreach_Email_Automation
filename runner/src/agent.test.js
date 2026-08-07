'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runAgent, serveSession, executeCommand } = require('./agent');

test('executeCommand maps ops to driver methods and shapes data results', async () => {
  const ops = [];
  const driver = {
    openApp: async (p) => ops.push(['openApp', p]),
    tap: async (x, y) => ops.push(['tap', x, y]),
    swipe: async (o) => ops.push(['swipe', o]),
    typeText: async (t) => ops.push(['type', t]),
    home: async () => ops.push(['home']),
    dumpUi: async () => [{ rid: 'a' }],
    getWindowSize: async () => ({ width: 1080, height: 2400 }),
    keepAwake: async () => ops.push(['keepAwake']),
    wake: async () => ops.push(['wake']),
    screenshot: async () => ({ mediaType: 'image/png', data: Buffer.from('PNG') }),
  };
  assert.deepStrictEqual(await executeCommand(driver, { op: 'dumpUi' }), [{ rid: 'a' }]);
  assert.deepStrictEqual(await executeCommand(driver, { op: 'getWindowSize' }), { width: 1080, height: 2400 });
  assert.strictEqual(await executeCommand(driver, { op: 'tap', args: { x: 3, y: 4 } }), null);
  await executeCommand(driver, { op: 'type', args: { text: 'home gym' } });
  const shot = await executeCommand(driver, { op: 'screenshot' });
  assert.strictEqual(shot.dataBase64, Buffer.from('PNG').toString('base64'));
  assert.deepStrictEqual(ops.find((o) => o[0] === 'tap'), ['tap', 3, 4]);
  assert.deepStrictEqual(ops.find((o) => o[0] === 'type'), ['type', 'home gym']);
  await assert.rejects(() => executeCommand(driver, { op: 'nope' }), /unknown command op/);
});

test('executeCommand recordClip records, uploads the bytes, and returns the clipId', async () => {
  const driver = { recordClip: async ({ seconds }) => ({ mediaType: 'video/mp4', data: Buffer.from(`MP4${seconds}`) }) };
  const uploads = [];
  const backend = { uploadClip: async (h, bytes, mt) => { uploads.push({ h, bytes: bytes.toString(), mt }); return { clipId: 'clip_9' }; } };
  const out = await executeCommand(driver, { op: 'recordClip', args: { seconds: 8 } }, { backend, hostId: 5 });
  assert.deepStrictEqual(out, { clipId: 'clip_9' });
  assert.strictEqual(uploads[0].h, 5);
  assert.strictEqual(uploads[0].bytes, 'MP48');
  assert.strictEqual(uploads[0].mt, 'video/mp4');
});

test('executeCommand recordClip errors without backend context', async () => {
  const driver = { recordClip: async () => ({ data: Buffer.from('x'), mediaType: 'video/mp4' }) };
  await assert.rejects(() => executeCommand(driver, { op: 'recordClip', args: {} }), /backend \+ hostId/);
});

test('serveSession pulls, executes, posts results, and ends on done', async () => {
  const posted = [];
  let pulls = 0;
  const backend = {
    pullCommands: async () => {
      pulls += 1;
      if (pulls === 1) return { commands: [{ id: 1, op: 'tap', args: { x: 1, y: 2 } }, { id: 2, op: 'dumpUi' }], done: false };
      return { commands: [], done: true };
    },
    postCommandResult: async (_h, r) => posted.push(r),
  };
  const driver = { tap: async () => {}, dumpUi: async () => [{ rid: 'z' }] };
  await serveSession({ driver, backend, hostId: 5, config: { agentPollMs: 0 }, logger: { log() {}, warn() {} }, shouldStop: () => false, sleepFn: async () => {} });
  assert.strictEqual(posted.length, 2);
  assert.deepStrictEqual(posted[0], { id: 1, ok: true, result: null, error: null });
  assert.deepStrictEqual(posted[1].result, [{ rid: 'z' }]);
});

test('serveSession reports ok:false with the error when a command throws', async () => {
  const posted = [];
  let pulls = 0;
  const backend = {
    pullCommands: async () => { pulls += 1; return pulls === 1 ? { commands: [{ id: 9, op: 'tap', args: { x: 1, y: 1 } }], done: true } : { commands: [], done: true }; },
    postCommandResult: async (_h, r) => posted.push(r),
  };
  const driver = { tap: async () => { throw new Error('device offline'); } };
  await serveSession({ driver, backend, hostId: 1, config: { agentPollMs: 0 }, logger: { log() {}, warn() {} }, shouldStop: () => false, sleepFn: async () => {} });
  assert.strictEqual(posted[0].ok, false);
  assert.match(posted[0].error, /device offline/);
});

test('runAgent claims a run, serves the session, then idles + stops', async () => {
  let claims = 0;
  const backend = {
    claimSession: async () => { claims += 1; return claims === 1 ? { active: true, runId: 7 } : { active: false }; },
    pullCommands: async () => ({ commands: [], done: true }),
    postCommandResult: async () => {},
  };
  let stop = false;
  await runAgent({
    driver: {},
    backend,
    config: { hostId: 3, idlePollMs: 0, agentPollMs: 0 },
    logger: { log() {}, warn() {} },
    shouldStop: () => stop,
    sleepFn: async () => { if (claims >= 1) stop = true; }, // stop after the first idle poll
  });
  assert.ok(claims >= 1, 'claimed at least once');
});

test('runAgent requires a host id', async () => {
  await assert.rejects(
    () => runAgent({ driver: {}, backend: {}, config: {}, shouldStop: () => true }),
    /RUNNER_HOST_ID/,
  );
});
