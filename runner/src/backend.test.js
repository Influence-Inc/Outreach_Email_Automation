'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeBackend } = require('./backend');

function fakeFetch({ status = 200, body } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      async text() { return body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)); },
    };
  };
  fn.calls = calls;
  return fn;
}

test('makeBackend sends the host token as x-api-token', async () => {
  const fetchImpl = fakeFetch({ body: { run: { id: 1 } } });
  const b = makeBackend({ backendUrl: 'https://x/', hostToken: 'tkn', fetchImpl });
  await b.getRun(1);
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.url, 'https://x/api/sourcing/runs/1');
  assert.strictEqual(call.opts.headers['x-api-token'], 'tkn');
});

test('postCandidates POSTs the batch as JSON', async () => {
  const fetchImpl = fakeFetch({ body: { run: { id: 7, found_count: 2 } } });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  const resp = await b.postCandidates(7, [{ username: 'a' }, { username: 'b' }]);
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.url, 'https://x/api/sourcing/runs/7/candidates');
  assert.strictEqual(call.opts.method, 'POST');
  const body = JSON.parse(call.opts.body);
  assert.deepStrictEqual(body.candidates.map((c) => c.username), ['a', 'b']);
  assert.strictEqual(resp.run.found_count, 2);
});

test('non-2xx responses throw with the backend error message', async () => {
  const fetchImpl = fakeFetch({ status: 400, body: { error: 'bad request' } });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  await assert.rejects(() => b.getRun(1), /bad request/);
});

test('readScreen POSTs the element tree + device size to the vision endpoint', async () => {
  const fetchImpl = fakeFetch({ body: { screen: 'profile', targets: {} } });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  const r = await b.readScreen({ elements: [{ rid: 'a' }], width: 1080, height: 2400 });
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.url, 'https://x/api/sourcing/vision/read');
  assert.strictEqual(call.opts.method, 'POST');
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.width, 1080);
  assert.deepStrictEqual(body.elements, [{ rid: 'a' }]);
  assert.strictEqual(r.screen, 'profile');
});

test('claimSession returns { active:false } on a 204 (nothing queued)', async () => {
  const fetchImpl = fakeFetch({ status: 204 });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  assert.deepStrictEqual(await b.claimSession(3), { active: false });
  assert.strictEqual(fetchImpl.calls[0].url, 'https://x/api/sourcing/hosts/3/session/claim');
  assert.strictEqual(fetchImpl.calls[0].opts.method, 'POST');
});

test('claimSession returns the run info on 201', async () => {
  const fetchImpl = fakeFetch({ status: 201, body: { active: true, runId: 42 } });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  assert.deepStrictEqual(await b.claimSession(3), { active: true, runId: 42 });
});

test('pullCommands + postCommandResult hit the agent endpoints', async () => {
  const fetchImpl = fakeFetch({ body: { commands: [], done: false } });
  const b = makeBackend({ backendUrl: 'https://x', hostToken: 'tkn', fetchImpl });
  await b.pullCommands(5);
  await b.postCommandResult(5, { id: 1, ok: true, result: null });
  assert.strictEqual(fetchImpl.calls[0].url, 'https://x/api/sourcing/hosts/5/commands');
  assert.strictEqual(fetchImpl.calls[1].url, 'https://x/api/sourcing/hosts/5/commands/result');
  assert.strictEqual(fetchImpl.calls[1].opts.method, 'POST');
});
