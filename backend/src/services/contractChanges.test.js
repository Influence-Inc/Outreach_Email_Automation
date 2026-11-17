'use strict';

// A creator's emailed term change waits for the team: it's proposed on the
// contract (pending_change) and only reaches the contract when the team
// applies it in Deal Studio.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const contracts = require('./contracts');
const negotiation = require('./negotiation');

const base = {
  compensation: 1500,
  totalPayment: 1500,
  offerType: 'video_based',
  numberOfVideos: 2,
  numberOfDeliverables: 2,
  deliverables: '2 short-form videos',
  platforms: ['Instagram', 'TikTok'],
  postingDeadline: 'Monday, December 7, 2026',
  deadline: 'Monday, December 7, 2026',
  paidAdsIncluded: true,
  exclusivity: 'None',
  additionalTerms: ['Brand tagged in all posts'],
};

test('proposeFromThread: only what the email changed, never a revert of the team’s own edits', () => {
  // The thread said Dec 7; the team then moved the deadline to Dec 20 by hand.
  const existing = {
    data: { ...base, postingDeadline: 'Sunday, December 20, 2026', deadline: 'Sunday, December 20, 2026' },
    thread_terms: contracts.materialTerms(base),
  };
  // The creator emails "3 videos please" — the thread still says Dec 7.
  const next = { ...base, numberOfVideos: 3, numberOfDeliverables: 3, deliverables: '3 short-form videos' };
  const p = contracts.proposeFromThread(existing, next);
  assert.deepStrictEqual(p.changes.map((c) => c.key), ['numberOfVideos']);
  assert.deepStrictEqual(p.changes[0], { key: 'numberOfVideos', label: 'Videos', from: '2', to: '3' });
  assert.deepStrictEqual(p.patch, { numberOfVideos: 3, numberOfDeliverables: 3, deliverables: '3 short-form videos' });

  // An email that does move the deadline is proposed against the team's value.
  const later = { ...base, postingDeadline: 'Friday, January 8, 2027', deadline: 'Friday, January 8, 2027' };
  const p2 = contracts.proposeFromThread(existing, later);
  assert.deepStrictEqual(p2.changes, [
    { key: 'postingDeadline', label: 'Deadline', from: 'Sunday, December 20, 2026', to: 'Friday, January 8, 2027' },
  ]);
});

test('proposeFromThread: a re-read that only rewords things proposes nothing', () => {
  const existing = { data: base, thread_terms: contracts.materialTerms(base) };
  const reworded = {
    ...base,
    platforms: ['tiktok', 'Instagram'],
    exclusivity: '',
    additionalTerms: ['Brand tagged in all posts.'],
  };
  assert.strictEqual(contracts.proposeFromThread(existing, reworded), null);
  // A contract made before thread_terms existed compares against itself.
  assert.strictEqual(contracts.proposeFromThread({ data: base }, base), null);
  const p = contracts.proposeFromThread({ data: base }, { ...base, paidAdsIncluded: false, usageRights: 'Organic only' });
  assert.deepStrictEqual(p.changes, [{ key: 'paidAdsIncluded', label: 'Paid ads', from: 'Included', to: 'Not included' }]);
});

function stubDb(contract) {
  const orig = { one: db.one, query: db.query };
  const writes = [];
  db.one = async (sql, params) => {
    writes.push({ sql, params });
    if (/^\s*SELECT \* FROM contracts/i.test(sql)) return contract;
    if (/^\s*UPDATE contracts/i.test(sql)) {
      const row = { ...contract };
      if (/pending_change = \$2/.test(sql)) row.pending_change = JSON.parse(params[1]);
      if (/SET data = \$2/.test(sql)) { row.data = JSON.parse(params[1]); row.pending_change = null; }
      return row;
    }
    return null;
  };
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  return { writes, restore: () => { db.one = orig.one; db.query = orig.query; } };
}

test('savePendingChange: a second email folds into the change already waiting', async () => {
  const existing = {
    id: 1, creator_id: 9, token: 't',
    data: base,
    pending_change: {
      changes: [{ key: 'numberOfVideos', label: 'Videos', from: '2', to: '3' }],
      patch: { numberOfVideos: 3 },
      threadTerms: { a: 1 },
      messages: ['3 videos please'],
    },
  };
  const s = stubDb(existing);
  try {
    const row = await contracts.savePendingChange(existing, {
      changes: [
        { key: 'numberOfVideos', label: 'Videos', from: '3', to: '4' },
        { key: 'platforms', label: 'Platforms', from: 'Instagram, TikTok', to: 'Instagram' },
      ],
      patch: { numberOfVideos: 4, platforms: ['Instagram'] },
      threadTerms: { a: 2 },
      message: 'Actually 4, Instagram only',
    });
    const p = row.pending_change;
    // The newer value wins, but "from" stays what the contract says today.
    assert.deepStrictEqual(p.changes, [
      { key: 'numberOfVideos', label: 'Videos', from: '2', to: '4' },
      { key: 'platforms', label: 'Platforms', from: 'Instagram, TikTok', to: 'Instagram' },
    ]);
    assert.deepStrictEqual(p.patch, { numberOfVideos: 4, platforms: ['Instagram'] });
    assert.deepStrictEqual(p.threadTerms, { a: 2 });
    assert.deepStrictEqual(p.messages, ['3 videos please', 'Actually 4, Instagram only']);
    assert.ok(s.writes.some((w) => /'contract_change_proposed'/.test(w.sql)));
  } finally {
    s.restore();
  }
});

test('applyPendingChange: the requested terms go on the contract, the rest stays', async () => {
  const contract = {
    id: 1, creator_id: 9, token: 't', status: 'pending',
    data: { ...base, offerType: 'video_bonus', bonusAmount: 200, bonusThresholdViews: 100000, totalPayment: 1700, manualTerms: ['Raw footage'] },
    pending_change: {
      changes: [{ key: 'compensation', label: 'Fee', from: '$1,500', to: '$1,800' }],
      patch: { compensation: 1800, totalPayment: 1800 },
      threadTerms: { thread: 'now' },
    },
  };
  const s = stubDb(contract);
  try {
    const res = await contracts.applyPendingChange(9);
    assert.ok(res.applied);
    const upd = s.writes.find((w) => /SET data = \$2/.test(w.sql));
    const data = JSON.parse(upd.params[1]);
    assert.strictEqual(data.compensation, 1800);
    assert.strictEqual(data.totalPayment, 2000, 'fee + bonus stay in step');
    assert.deepStrictEqual(data.manualTerms, ['Raw footage']);
    assert.match(upd.sql, /pending_change = NULL/);
    assert.strictEqual(upd.params[2], JSON.stringify({ thread: 'now' }));
    assert.ok(s.writes.some((w) => /UPDATE creators SET quoted_rate/.test(w.sql)), 'the fee correction reaches the rate');
    assert.ok(s.writes.some((w) => /'contract_change_applied'/.test(w.sql)));
  } finally {
    s.restore();
  }
});

test('dismissPendingChange: the contract stays as it is and the email is not proposed again', async () => {
  const contract = {
    id: 1, creator_id: 9, token: 't', status: 'signed', data: base,
    pending_change: { changes: [{ key: 'platforms' }], patch: { platforms: ['Instagram'] }, threadTerms: { thread: 'now' } },
  };
  const s = stubDb(contract);
  try {
    const res = await contracts.dismissPendingChange(9);
    assert.ok(res.dismissed);
    assert.ok(!s.writes.some((w) => /SET data = \$2/.test(w.sql)), 'contract data untouched');
    const upd = s.writes.find((w) => /pending_change = NULL/.test(w.sql));
    assert.strictEqual(upd.params[1], JSON.stringify({ thread: 'now' }));
    assert.ok(s.writes.some((w) => /'contract_change_dismissed'/.test(w.sql)));
  } finally {
    s.restore();
  }
});

test('handleAcceptedReply: an emailed term change is proposed and delegated, never applied', async () => {
  const orig = {
    one: db.one, query: db.query, many: db.many,
    changes: contracts.changesContractTerms, resync: contracts.updateContractTermsFromThread,
  };
  const writes = [];
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql)
    ? { id: 42, first_name: 'Vo', negotiation_status: 'ACCEPTED', usage_rights_policy: 'no_rights', latest_inbound_text: 'Can we do 3 videos instead?' }
    : null);
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; };
  db.many = async () => [];
  let called = null;
  contracts.changesContractTerms = async () => true;
  contracts.updateContractTermsFromThread = async (id, opts) => {
    called = { id, opts };
    return { proposed: true, signed: false, changes: [{ label: 'Videos', from: '2', to: '3' }] };
  };
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.proposed, true);
    assert.strictEqual(res.contractUpdated, false);
    assert.deepStrictEqual(called, { id: 42, opts: { message: 'Can we do 3 videos instead?' } });
    const reason = writes.find((w) => /needs_human = TRUE/i.test(w.sql)).params[1];
    assert.match(reason, /Videos: 2 → 3/);
    assert.match(reason, /apply or keep it in the Deals column/);
    assert.ok(!writes.some((w) => /UPDATE contracts SET data/i.test(w.sql)), 'the contract is not changed');
  } finally {
    Object.assign(db, { one: orig.one, query: orig.query, many: orig.many });
    contracts.changesContractTerms = orig.changes;
    contracts.updateContractTermsFromThread = orig.resync;
  }
});

test('handleAcceptedReply: a usage-rights dispute is proposed, not applied', async () => {
  const orig = { one: db.one, query: db.query, many: db.many, propose: contracts.proposeUsageRightsRemoval, remove: contracts.removeUsageRightsFromContract };
  const writes = [];
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql)
    ? { id: 42, first_name: 'Vo', negotiation_status: 'ACCEPTED', usage_rights_policy: 'free_only', latest_inbound_text: 'Please remove the paid ad rights from the contract.' }
    : null);
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; };
  db.many = async () => [];
  let proposed = false;
  contracts.proposeUsageRightsRemoval = async () => { proposed = true; return { pending_change: {} }; };
  contracts.removeUsageRightsFromContract = async () => { throw new Error('must not remove rights on its own'); };
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.disputed, true);
    assert.strictEqual(res.proposed, true);
    assert.ok(proposed);
    const reason = writes.find((w) => /needs_human = TRUE/i.test(w.sql)).params[1];
    assert.match(reason, /waiting for your OK/);
  } finally {
    Object.assign(db, { one: orig.one, query: orig.query, many: orig.many });
    contracts.proposeUsageRightsRemoval = orig.propose;
    contracts.removeUsageRightsFromContract = orig.remove;
  }
});

test('deliverables: a promo code is not a video count', () => {
  const { statesCount, contractSections } = require('./contractTerms');
  assert.strictEqual(statesCount("Short-form video content promoting the creator's promo code KAI12"), false);
  assert.strictEqual(statesCount('2 Instagram Reels + 1 TikTok'), true);
  assert.strictEqual(statesCount('3x TikToks'), true);
  const rows = {};
  for (const s of contractSections({
    compensationModel: 'commission',
    offerType: 'composed',
    deliverables: "Short-form video content promoting the creator's promo code KAI12",
    numberOfVideos: 2,
    commission: { ratePct: 12, summary: 'x', payoutNetDays: 30 },
  })) for (const r of s.rows || []) rows[r.label] = r.value;
  assert.strictEqual(rows['Number of deliverables'], '2');
});
