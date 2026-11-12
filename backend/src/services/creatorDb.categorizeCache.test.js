'use strict';

// Run with: npm test  (node --test)
//
// Covers categorizeCreatorsCached — the Creator-DB lookup behind the Deal
// Studio's Used / Unused / New badges. It sits on the creators-list path, so it
// must (a) answer repeat loads from cache without a round-trip and (b) never
// hold the list past its budget when Creator-DB is slow.

const test = require('node:test');
const assert = require('node:assert');
const creatorDb = require('./creatorDb');

function resp(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const prevUrl = process.env.CREATOR_DB_URL;
  process.env.CREATOR_DB_URL = 'https://cdb.test';
  creatorDb.clearCategorizeCache();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.keys);
    return impl(body.keys, opts);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    if (prevUrl === undefined) delete process.env.CREATOR_DB_URL;
    else process.env.CREATOR_DB_URL = prevUrl;
    creatorDb.clearCategorizeCache();
  }
}

const answer = (keys) => keys.map((k) => ({ category: k.instagramUsername === 'used1' ? 'used' : 'new', creator: null }));

test('second load is served from cache with no Creator-DB call', async () => {
  await withFetch(async (keys) => resp(answer(keys)), async (calls) => {
    const keys = [{ instagramUsername: 'used1' }, { instagramUsername: 'fresh' }];
    const first = await creatorDb.categorizeCreatorsCached(keys);
    assert.deepStrictEqual(first.map((r) => r.category), ['used', 'new']);
    const second = await creatorDb.categorizeCreatorsCached(keys);
    assert.deepStrictEqual(second.map((r) => r.category), ['used', 'new']);
    assert.strictEqual(calls.length, 1);
  });
});

test('only uncached keys are sent, results stay in input order', async () => {
  await withFetch(async (keys) => resp(answer(keys)), async (calls) => {
    await creatorDb.categorizeCreatorsCached([{ instagramUsername: 'used1' }]);
    const out = await creatorDb.categorizeCreatorsCached([
      { instagramUsername: 'fresh' },
      { instagramUsername: '@USED1' }, // same identity, different spelling
    ]);
    assert.deepStrictEqual(out.map((r) => r.category), ['new', 'used']);
    assert.deepStrictEqual(calls[1], [{ instagramUsername: 'fresh' }]);
  });
});

test('slow Creator-DB: returns nulls within budget, then fills cache and calls onLate', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withFetch(async (keys) => { await gate; return resp(answer(keys)); }, async (calls) => {
    let late = null;
    const t0 = Date.now();
    const out = await creatorDb.categorizeCreatorsCached(
      [{ instagramUsername: 'used1' }],
      { budgetMs: 30, onLate: (k, r) => { late = { k, r }; } },
    );
    assert.ok(Date.now() - t0 < 1000);
    assert.deepStrictEqual(out, [null]);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(late.r[0].category, 'used');
    const again = await creatorDb.categorizeCreatorsCached([{ instagramUsername: 'used1' }]);
    assert.strictEqual(again[0].category, 'used');
    assert.strictEqual(calls.length, 1);
  });
});

test('failure yields nulls (no false "new") and is not cached', async () => {
  let fail = true;
  await withFetch(async (keys) => {
    if (fail) return { ok: false, status: 400, text: async () => 'bad' };
    return resp(answer(keys));
  }, async (calls) => {
    const out = await creatorDb.categorizeCreatorsCached([{ instagramUsername: 'used1' }]);
    assert.deepStrictEqual(out, [null]);
    fail = false;
    const retry = await creatorDb.categorizeCreatorsCached([{ instagramUsername: 'used1' }]);
    assert.strictEqual(retry[0].category, 'used');
    assert.strictEqual(calls.length, 2);
  });
});

test('a second load while the first lookup is still in flight joins it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withFetch(async (keys) => { await gate; return resp(answer(keys)); }, async (calls) => {
    const keys = [{ instagramUsername: 'used1' }];
    const a = creatorDb.categorizeCreatorsCached(keys, { budgetMs: 200 });
    const b = creatorDb.categorizeCreatorsCached(keys, { budgetMs: 200 });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra[0].category, 'used');
    assert.strictEqual(rb[0].category, 'used');
    assert.strictEqual(calls.length, 1);
  });
});
