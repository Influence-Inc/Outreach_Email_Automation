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
