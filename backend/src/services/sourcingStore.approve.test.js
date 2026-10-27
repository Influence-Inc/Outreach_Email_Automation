'use strict';

// The admin's "Shortlist" in the review queue sends the creator to creator-list's
// "Curated by INFLUENCE Team" collection, and never adds them to the campaign.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const creatorList = require('./creatorList');
const store = require('./sourcingStore');

test('approving a doubtful creator shortlists them on creator-list only', async () => {
  const orig = { one: db.one, query: db.query, add: creatorList.addToCurated };
  const sql = [];
  const sent = [];
  db.one = async () => ({
    id: 7, run_id: 3, campaign_id: 'c1', username: 'coach', decision: 'review',
    evidence: { sourceTerm: 'gym', niche: { jev: { summary: 'Fitness', labels: { topic: { value: 'fitness' } } } } },
  });
  db.query = async (q, params) => { sql.push({ q, params }); return { rows: [], rowCount: 1 }; };
  creatorList.addToCurated = async (handle, opts) => { sent.push({ handle, opts }); return { status: 'added' }; };
  try {
    const out = await store.approveCandidate(7);
    assert.strictEqual(out.decision, 'added');
    assert.deepStrictEqual(out.creatorList, { status: 'added' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].handle, 'coach');
    assert.strictEqual(sent[0].opts.summary, 'Fitness');
    assert.strictEqual(sent[0].opts.sourceTerm, 'gym');
    assert.ok(!sql.some((s) => /INSERT INTO creators|creator_id/.test(s.q)), 'no campaign creator, no creator_id');
    assert.ok(sql.some((s) => /SET decision = 'added', decided_by = 'human'/.test(s.q)));
  } finally {
    db.one = orig.one; db.query = orig.query; creatorList.addToCurated = orig.add;
  }
});

// The reason typed in the review queue is saved with the decision: it is what
// services/reviewLessons.js learns from.
test('the admin\'s reason is saved with a shortlist or a reject', async () => {
  const orig = { one: db.one, query: db.query, add: creatorList.addToCurated };
  const sql = [];
  db.one = async (q, params) => {
    sql.push({ q, params });
    if (/^SELECT/.test(q.trim())) return { id: 7, run_id: 3, username: 'coach', decision: 'review', evidence: {} };
    return { id: 7, decision: 'rejected' };
  };
  db.query = async (q, params) => { sql.push({ q, params }); return { rows: [], rowCount: 1 }; };
  creatorList.addToCurated = async () => ({ status: 'added' });
  try {
    await store.approveCandidate(7, '  explains every   step ');
    const approve = sql.find((s) => /SET decision = 'added'/.test(s.q));
    assert.match(approve.q, /review_note = \$2/);
    assert.deepStrictEqual(approve.params, [7, 'explains every step']);

    await store.rejectCandidate(7, 'rejected in review', 'only memes');
    const reject = sql.find((s) => /SET decision = 'rejected'/.test(s.q));
    assert.deepStrictEqual(reject.params, [7, 'rejected in review: only memes', 'only memes']);

    await store.rejectCandidate(7, 'rejected in review', '   ');
    const bare = sql.filter((s) => /SET decision = 'rejected'/.test(s.q)).at(-1);
    assert.deepStrictEqual(bare.params, [7, 'rejected in review', null], 'no reason typed: nothing saved');
  } finally {
    db.one = orig.one; db.query = orig.query; creatorList.addToCurated = orig.add;
  }
});

// Shortlisted creators who never reached creator-list's collection — its settings
// were missing (not_configured) or it did not answer — are sent again.
test('shortlisted creators that never reached creator-list are sent again once it is configured', async () => {
  const orig = {
    many: db.many, query: db.query, add: creatorList.addToCurated, ok: creatorList.curatedConfigured,
  };
  const sql = [];
  const sent = [];
  db.many = async (q, params) => {
    sql.push({ q, params });
    return [
      { id: 1, username: 'coach', bio: 'gym', reels: [{ caption: 'leg day' }], evidence: { sourceTerm: 'gym', creatorList: { status: 'not_configured' }, niche: { jev: { summary: 'Fitness' } } } },
      { id: 2, username: 'chef', bio: null, reels: [], evidence: { creatorList: { status: 'error' } } },
    ];
  };
  db.query = async () => ({ rows: [], rowCount: 1 });
  creatorList.addToCurated = async (handle) => { sent.push(handle); return handle === 'coach' ? { status: 'added' } : { status: 'error', error: 'down' }; };
  try {
    creatorList.curatedConfigured = () => false;
    assert.deepStrictEqual(await store.resendToCreatorList(), { sent: 0, failed: 0, pending: null, skipped: 'not configured' });
    assert.strictEqual(sql.length, 0, 'nothing read while it cannot be sent');

    creatorList.curatedConfigured = () => true;
    assert.deepStrictEqual(await store.resendToCreatorList(), { sent: 1, failed: 1, pending: 2 });
    assert.deepStrictEqual(sent, ['coach', 'chef']);
    assert.match(sql[0].q, /decision = 'added'/);
    assert.match(sql[0].q, /<> 'added'/);
  } finally {
    db.many = orig.many; db.query = orig.query; creatorList.addToCurated = orig.add; creatorList.curatedConfigured = orig.ok;
  }
});

test('creator-list names which of its two settings are missing', () => {
  const env = { url: process.env.CREATOR_LIST_WEB_URL, key: process.env.CREATOR_LIST_API_KEY };
  try {
    delete process.env.CREATOR_LIST_WEB_URL;
    process.env.CREATOR_LIST_API_KEY = 'k';
    assert.strictEqual(creatorList.curatedConfigured(), false);
    assert.deepStrictEqual(creatorList.curatedMissing(), ['CREATOR_LIST_WEB_URL']);
    process.env.CREATOR_LIST_WEB_URL = 'https://site.example';
    assert.strictEqual(creatorList.curatedConfigured(), true);
  } finally {
    if (env.url === undefined) delete process.env.CREATOR_LIST_WEB_URL; else process.env.CREATOR_LIST_WEB_URL = env.url;
    if (env.key === undefined) delete process.env.CREATOR_LIST_API_KEY; else process.env.CREATOR_LIST_API_KEY = env.key;
  }
});
