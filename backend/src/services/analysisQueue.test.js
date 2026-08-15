'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createAnalysisQueue } = require('./analysisQueue');

const tick = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});

test('submit returns immediately, before the work has run', () => {
  const q = createAnalysisQueue();
  let started = false;

  const returned = q.submit('a', async () => { started = true; return 'v'; });

  assert.strictEqual(returned, undefined, 'nothing to await by accident');
  assert.strictEqual(started, false, 'work is scheduled, not run inline');
});

// The whole point: collecting must not be slowed by the analysis service.
test('a hung analysis does not slow the caller down', async () => {
  const q = createAnalysisQueue({ timeoutMs: 10 });
  const began = Date.now();

  for (let i = 0; i < 50; i += 1) q.submit(`reel${i}`, never);

  assert.ok(Date.now() - began < 50, 'fifty submissions cost effectively nothing');
  assert.strictEqual(q.pendingCount(), 50);
});

test('a verdict that finished is returned', async () => {
  const q = createAnalysisQueue();
  q.submit('mia', async () => ({ score: 0.9 }));
  await tick();

  assert.deepStrictEqual(await q.take('mia'), { score: 0.9 });
});

test('an in-flight verdict is waited for, but only briefly', async () => {
  const q = createAnalysisQueue({ timeoutMs: 20 });
  q.submit('slow', never);

  const began = Date.now();
  const got = await q.take('slow');
  const waited = Date.now() - began;

  assert.strictEqual(got, null, 'no verdict yet — not a rejection');
  assert.ok(waited < 200, `gave up promptly, waited ${waited}ms`);
});

test('a verdict that lands just after submission is still collected', async () => {
  const q = createAnalysisQueue({ timeoutMs: 500 });
  q.submit('soon', () => new Promise((r) => setTimeout(() => r({ score: 0.5 }), 15)));

  assert.deepStrictEqual(await q.take('soon'), { score: 0.5 });
});

test('a thrown analysis is swallowed and reported as no verdict', async () => {
  const q = createAnalysisQueue({ logger: { warn() {} } });
  q.submit('boom', async () => { throw new Error('gemini 503'); });
  await tick();

  assert.strictEqual(await q.take('boom'), null, 'the run is never failed by the judge');
});

test('taking a key that was never submitted is null, not a hang', async () => {
  const q = createAnalysisQueue();
  assert.strictEqual(await q.take('nobody'), null);
});

test('the same creator is not analysed twice', async () => {
  const q = createAnalysisQueue();
  let calls = 0;
  q.submit('mia', async () => { calls += 1; return 'first'; });
  q.submit('mia', async () => { calls += 1; return 'second'; });
  await tick();

  assert.strictEqual(calls, 1);
  assert.strictEqual(await q.take('mia'), 'first');
});

test('concurrency is capped so a batch cannot open every call at once', async () => {
  const q = createAnalysisQueue({ maxConcurrent: 2 });
  let live = 0;
  let peak = 0;
  const work = () => new Promise((resolve) => {
    live += 1;
    peak = Math.max(peak, live);
    setTimeout(() => { live -= 1; resolve('ok'); }, 10);
  });

  for (let i = 0; i < 6; i += 1) q.submit(`k${i}`, work);
  await q.drain();

  assert.strictEqual(peak, 2, `never more than two at once, saw ${peak}`);
});

test('drain waits for everything still in flight', async () => {
  const q = createAnalysisQueue();
  q.submit('a', () => new Promise((r) => setTimeout(() => r(1), 10)));
  q.submit('b', () => new Promise((r) => setTimeout(() => r(2), 15)));

  await q.drain();

  assert.strictEqual(q.pendingCount(), 0);
  assert.strictEqual(await q.take('a'), 1);
  assert.strictEqual(await q.take('b'), 2);
});
