'use strict';

// Run with: npm test  (node --test)
//
// Guards the segmentation module's pure handle parsing and the scheduled sweep's
// "no Creator-DB → no-op" guard (which short-circuits before any DB access).
const test = require('node:test');
const assert = require('node:assert');
const segmentation = require('./segmentation');

test('handleFor uses instagram_username, stripping a leading @', () => {
  assert.strictEqual(segmentation.handleFor({ instagram_username: '@sam' }), 'sam');
  assert.strictEqual(segmentation.handleFor({ instagram_username: 'sam' }), 'sam');
});

test('handleFor parses the handle from an instagram_url', () => {
  assert.strictEqual(
    segmentation.handleFor({ instagram_url: 'https://www.instagram.com/sammy/' }),
    'sammy',
  );
});

test('handleFor ignores non-handle URL segments and non-instagram hosts', () => {
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://www.instagram.com/p/abc123/' }), null);
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://www.instagram.com/reel/xyz/' }), null);
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://example.com/sammy' }), null);
  assert.strictEqual(segmentation.handleFor({}), null);
});

test('segmentAllCampaigns is a no-op when Creator-DB is not configured', async () => {
  const saved = process.env.CREATOR_DB_URL;
  delete process.env.CREATOR_DB_URL;
  try {
    const r = await segmentation.segmentAllCampaigns();
    assert.deepStrictEqual(r, { skipped: 'CREATOR_DB_URL not set' });
  } finally {
    if (saved === undefined) delete process.env.CREATOR_DB_URL;
    else process.env.CREATOR_DB_URL = saved;
  }
});

// --- segmentCampaign: single-flight, failure rest, one batched write ---------
// Stubs the db + Creator-DB module functions in place (segmentation reads them
// off the module objects at call time) and restores them after each test.
const db = require('../db');
const creatorDb = require('./creatorDb');

function withStubs(t, { creators, lookup }) {
  const saved = {
    url: process.env.CREATOR_DB_URL,
    one: db.one, many: db.many, query: db.query,
    lookup: creatorDb.lookupParticipation,
  };
  process.env.CREATOR_DB_URL = 'http://creator-db.test';
  const calls = { lookups: 0, queries: [] };
  db.one = async () => ({ id: 'camp-1', name: 'Camp One' });
  db.many = async () => creators;
  db.query = async (sql, params) => {
    calls.queries.push({ sql, params });
    return { rowCount: params[0].length };
  };
  creatorDb.lookupParticipation = async (handles) => {
    calls.lookups += 1;
    return lookup(handles);
  };
  segmentation._resetSegmentState();
  t.after(() => {
    if (saved.url === undefined) delete process.env.CREATOR_DB_URL;
    else process.env.CREATOR_DB_URL = saved.url;
    db.one = saved.one; db.many = saved.many; db.query = saved.query;
    creatorDb.lookupParticipation = saved.lookup;
    segmentation._resetSegmentState();
  });
  return calls;
}

const dueCreators = [
  { id: 1, instagram_username: 'ann', whatsapp: null, imessage: null, segment_checked_at: null },
  { id: 2, instagram_username: 'bob', whatsapp: null, imessage: null, segment_checked_at: null },
  { id: 3, instagram_username: 'cat', whatsapp: null, imessage: null, segment_checked_at: new Date() }, // fresh
];

test('segmentCampaign writes every result in ONE batched UPDATE', async (t) => {
  const calls = withStubs(t, {
    creators: dueCreators,
    lookup: async () => ({
      results: [
        { hasPriorParticipation: true, priorCampaigns: ['Old'], contact: { phoneNumber: '+15550001' } },
        { hasPriorParticipation: false },
      ],
    }),
  });
  const r = await segmentation.segmentCampaign('camp-1');
  assert.deepStrictEqual(r, { checked: 2, updated: 2 });
  assert.strictEqual(calls.queries.length, 1);
  const [ids, segments, priors, phones] = calls.queries[0].params;
  assert.deepStrictEqual(ids, [1, 2]);
  assert.deepStrictEqual(segments, ['old', 'new']);
  assert.deepStrictEqual(priors, ['["Old"]', '[]']);
  assert.deepStrictEqual(phones, ['+15550001', null]);
});

test('concurrent segmentCampaign calls for one campaign share a single pass', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = withStubs(t, {
    creators: dueCreators,
    lookup: async () => { await gate; return { results: [{ hasPriorParticipation: false }] }; },
  });
  const a = segmentation.segmentCampaign('camp-1');
  const b = segmentation.segmentCampaign('camp-1');
  assert.strictEqual(a, b);
  release();
  await a;
  assert.strictEqual(calls.lookups, 1);
  // Once it settles, the next load starts a fresh pass.
  await segmentation.segmentCampaign('camp-1');
  assert.strictEqual(calls.lookups, 2);
});

test('after a failed lookup the campaign rests; force still re-checks', async (t) => {
  const calls = withStubs(t, {
    creators: dueCreators,
    lookup: async () => { throw new Error('creator-db down'); },
  });
  const first = await segmentation.segmentCampaign('camp-1');
  assert.strictEqual(first.error, 'creator-db down');
  const second = await segmentation.segmentCampaign('camp-1');
  assert.match(second.skipped, /recent Creator-DB failure/);
  assert.strictEqual(calls.lookups, 1);
  await segmentation.segmentCampaign('camp-1', { force: true });
  assert.strictEqual(calls.lookups, 2);
  assert.strictEqual(calls.queries.length, 0);
});
