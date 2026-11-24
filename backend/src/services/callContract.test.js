'use strict';

// Contracts for deals agreed on a call (services/callContract.js):
//   • the form is validated into one canonical shape, with readable errors;
//   • the contract is built from exactly the entered terms (no thread
//     extraction) and marked termsSource 'call';
//   • creating it books the deal + contract in one transaction, delivers the
//     link the way the team chose, and a failed send never loses the contract;
//   • a later thread re-extraction leaves a call contract alone.
//
// The DB layer is a thin singleton (src/db), stubbed here; negotiation helpers
// are called by property access, so they are replaced on the module object.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');
const contracts = require('./contracts');
const callContract = require('./callContract');

const NOW = new Date('2026-11-17T15:00:00Z');

const creator = {
  id: 7,
  campaign_id: 'cmp_1',
  first_name: 'Maya',
  full_name: 'Maya Lin',
  email: 'maya@example.com',
  instagram_username: 'mayamakes',
  brand_name: 'Reve',
  campaign_name: 'Winter',
  usage_rights_policy: 'free_only',
  status: 'outreach_sent',
  negotiation_status: null,
  instantly_reply_uuid: null,
  quoted_rate: null,
  custom_offer: null,
};

function form(overrides = {}) {
  return {
    terms: { model: 'flat', fee: 1500 },
    shape: 'video_based',
    numberOfVideos: 3,
    platforms: ['Instagram', 'TikTok'],
    postingDeadline: '2026-12-10',
    paidAdsIncluded: true,
    exclusivity: '',
    manualTerms: 'One extra round of revisions\n\nRaw footage delivered with each video',
    callNotes: 'Agreed on Tuesday call with Maya',
    delivery: { method: 'none' },
    ...overrides,
  };
}

const normalize = (o) => callContract.normalizeCallContractInput(form(o), { now: NOW });

test('normalize: a flat video deal comes back canonical', () => {
  const n = normalize();
  assert.strictEqual(n.shape, 'video_based');
  assert.strictEqual(n.numberOfVideos, 3);
  assert.deepStrictEqual(n.terms, { model: 'flat', fee: 1500, commission: null, product: null });
  assert.deepStrictEqual(n.platforms, ['Instagram', 'TikTok']);
  assert.strictEqual(n.exclusivity, 'None');
  assert.deepStrictEqual(n.manualTerms, ['One extra round of revisions', 'Raw footage delivered with each video']);
  assert.strictEqual(n.upfrontPercent, null);
  assert.deepStrictEqual(n.delivery, { method: 'none', to: null });
});

test('normalize: commission / product deals are always plain video deals', () => {
  const n = normalize({
    terms: { model: 'commission', commission: { rate_pct: 15 } },
    shape: 'view_based',
    minTotalViews: 500000,
  });
  assert.strictEqual(n.shape, 'video_based');
  assert.strictEqual(n.minTotalViews, null);
  assert.strictEqual(n.numberOfVideos, 3);
});

test('normalize: each shape requires its own numbers', () => {
  assert.throws(() => normalize({ shape: 'view_based', minTotalViews: '' }), /guaranteed total views/);
  const v = normalize({ shape: 'view_based', minTotalViews: '400000', minVideos: '2' });
  assert.strictEqual(v.minTotalViews, 400000);
  assert.strictEqual(v.minVideos, 2);
  assert.strictEqual(v.numberOfVideos, null);
  assert.strictEqual(v.viewCountingDays, 30);

  assert.throws(() => normalize({ shape: 'video_bonus', bonusAmount: 500 }), /views that unlock the bonus/);
  const b = normalize({ shape: 'video_bonus', bonusAmount: 500, bonusThresholdViews: 250000, viewCountingDays: 45 });
  assert.strictEqual(b.bonusAmount, 500);
  assert.strictEqual(b.viewCountingDays, 45);

  assert.throws(() => normalize({ numberOfVideos: 0 }), /number of videos must be between 1 and 50/);
});

test('normalize: refuses what cannot go on a contract', () => {
  assert.throws(() => normalize({ terms: null }), /how the creator is paid/);
  assert.throws(() => normalize({ terms: { model: 'flat' } }), /Enter the fee/);
  assert.throws(() => normalize({ platforms: [' ', ''] }), /at least one platform/);
  assert.throws(() => normalize({ postingDeadline: '2026-10-01' }), /in the past/);
  assert.throws(() => normalize({ postingDeadline: 'next friday' }), /posting deadline/);
  assert.throws(
    () => normalize({ terms: { model: 'product', product: 'Skincare set' }, upfrontPayment: true }),
    /needs a cash fee/,
  );
  assert.throws(() => normalize({ delivery: { method: 'email', to: 'nope' } }), /email address/);
  assert.throws(() => normalize({ delivery: {} }), /how to send/);
});

test('normalize: platforms are de-duplicated; upfront defaults to 30%', () => {
  const n = normalize({ platforms: ['Instagram', 'instagram', ' TikTok '], upfrontPayment: true });
  assert.deepStrictEqual(n.platforms, ['Instagram', 'TikTok']);
  assert.strictEqual(n.upfrontPercent, 30);
  assert.strictEqual(normalize({ upfrontPayment: true, upfrontPercent: 50 }).upfrontPercent, 50);
});

test('buildCallContractData: a flat video deal carries exactly the entered terms', () => {
  const data = contracts.buildCallContractData(creator, normalize(), { now: NOW });
  assert.strictEqual(data.termsSource, 'call');
  assert.strictEqual(data.callAgreedAt, NOW.toISOString());
  assert.strictEqual(data.offerType, 'video_based');
  assert.strictEqual(data.offerLabel, 'Video-based deal');
  assert.strictEqual(data.compensation, 1500);
  assert.strictEqual(data.totalPayment, 1500);
  assert.strictEqual(data.numberOfVideos, 3);
  assert.strictEqual(data.deliverables, '3 short-form videos');
  assert.deepStrictEqual(data.platforms, ['Instagram', 'TikTok']);
  assert.strictEqual(data.postingDeadline, 'Thursday, December 10, 2026');
  assert.strictEqual(data.postingWindows.length, 3);
  assert.strictEqual(data.paidAdsIncluded, true);
  assert.strictEqual(data.exclusivity, 'None');
  assert.strictEqual(data.upfrontPercent, null);
  assert.strictEqual(data.compensationModel, 'flat');
  assert.deepStrictEqual(data.additionalTerms, []);
  assert.deepStrictEqual(data.manualTerms, ['One extra round of revisions', 'Raw footage delivered with each video']);
  assert.match(data.paymentTerms, /completing and posting all agreed deliverables/);
});

test('buildCallContractData: paid ads follow the call, in the policy wording', () => {
  const off = contracts.buildCallContractData(creator, normalize({ paidAdsIncluded: false }), { now: NOW });
  assert.strictEqual(off.paidAdsIncluded, false);
  assert.match(off.usageRights, /Organic only/);
  const req = contracts.buildCallContractData({ ...creator, usage_rights_policy: 'required' }, normalize(), { now: NOW });
  assert.match(req.usageRights, /may use this content in paid advertising/);
});

test('buildCallContractData: a bonus deal pays the base, with the bonus on top', () => {
  const input = normalize({ shape: 'video_bonus', numberOfVideos: 2, bonusAmount: 500, bonusThresholdViews: 250000 });
  const data = contracts.buildCallContractData(creator, input, { now: NOW });
  assert.strictEqual(data.offerType, 'video_bonus');
  assert.strictEqual(data.compensation, 1500);
  assert.strictEqual(data.totalPayment, 2000);
  assert.strictEqual(data.bonusAmount, 500);
  assert.strictEqual(data.bonusThresholdViews, 250000);
  assert.strictEqual(data.viewCountingDays, 30);
  assert.strictEqual(data.minTotalViews, null);
});

test('buildCallContractData: a view-based deal names views, not a video count', () => {
  const input = normalize({ shape: 'view_based', minTotalViews: 400000, minVideos: 2, viewCountingDays: 60 });
  const data = contracts.buildCallContractData(creator, input, { now: NOW });
  assert.strictEqual(data.offerType, 'view_based');
  assert.strictEqual(data.minTotalViews, 400000);
  assert.strictEqual(data.minVideos, 2);
  assert.strictEqual(data.numberOfVideos, null);
  assert.strictEqual(data.viewCountingDays, 60);
  assert.deepStrictEqual(data.postingWindows, []);
  assert.strictEqual(data.timeline, null);
});

test('buildCallContractData: commission and hybrid deals carry their terms; upfront splits the fee', () => {
  const comm = contracts.buildCallContractData(
    creator,
    normalize({ terms: { model: 'commission', commission: { rate_pct: 20, attribution: 'code', promo_code: 'maya20' } } }),
    { now: NOW },
  );
  assert.strictEqual(comm.compensationModel, 'commission');
  assert.strictEqual(comm.compensation, null);
  assert.strictEqual(comm.commission.ratePct, 20);
  assert.strictEqual(comm.commission.promoCode, 'MAYA20');
  assert.match(comm.paymentTerms, /Commission is paid/);

  const hybrid = contracts.buildCallContractData(
    creator,
    normalize({
      terms: { model: 'hybrid', fee: 800, commission: { rate_pct: 10 } },
      upfrontPayment: true,
      upfrontPercent: 40,
    }),
    { now: NOW },
  );
  assert.strictEqual(hybrid.compensationModel, 'hybrid');
  assert.strictEqual(hybrid.compensation, 800);
  assert.strictEqual(hybrid.upfrontPercent, 40);
  assert.strictEqual(hybrid.remainderPercent, 60);
  assert.match(hybrid.paymentTerms, /each payment milestone/);
});

// ── createContractFromCall ──────────────────────────────────────────────────

const orig = {
  one: db.one,
  query: db.query,
  withTransaction: db.withTransaction,
  loadCreator: negotiation.loadCreator,
  hasPortalDeal: negotiation.hasPortalDeal,
  send: negotiation.sendNegotiationEmail,
};

function install({ row = creator, hasContract = false, raceContract = false, portal = false, sendThrows = null } = {}) {
  const log = { txQueries: [], queries: [], sent: [] };
  negotiation.loadCreator = async () => ({ ...row });
  negotiation.hasPortalDeal = async () => portal;
  negotiation.sendNegotiationEmail = async (c, email, kind) => {
    if (sendThrows) throw new Error(sendThrows);
    log.sent.push({ to: c.email, email, kind });
  };
  db.one = async (sql) => {
    if (/FROM contracts WHERE creator_id/i.test(sql)) return hasContract ? { status: 'pending' } : null;
    if (/FROM campaigns/i.test(sql)) return { instantly_campaign_id: null };
    return null;
  };
  db.query = async (sql, params) => {
    log.queries.push({ sql, params });
    return { rows: [] };
  };
  db.withTransaction = async (fn) =>
    fn({
      query: async (sql, params) => {
        log.txQueries.push({ sql, params });
        if (/SELECT 1 FROM contracts/i.test(sql)) return { rows: raceContract ? [{ '?column?': 1 }] : [] };
        if (/INSERT INTO contracts/i.test(sql)) return { rows: [{ id: 99, token: params[0], status: 'pending' }] };
        return { rows: [] };
      },
    });
  return log;
}

test.afterEach(() => {
  db.one = orig.one;
  db.query = orig.query;
  db.withTransaction = orig.withTransaction;
  negotiation.loadCreator = orig.loadCreator;
  negotiation.hasPortalDeal = orig.hasPortalDeal;
  negotiation.sendNegotiationEmail = orig.send;
  delete process.env.DRY_RUN;
});

test('create: books the deal and the contract in one transaction', async () => {
  const log = install();
  const res = await callContract.createContractFromCall(7, form(), { now: NOW });
  assert.match(res.url, /\/contract\/[A-Za-z0-9_-]{32}$/);
  assert.deepStrictEqual(res.delivery, { method: 'none', sent: false });

  const insert = log.txQueries.find((q) => /INSERT INTO contracts/i.test(q.sql));
  const data = JSON.parse(insert.params[3]);
  assert.strictEqual(data.termsSource, 'call');
  assert.strictEqual(data.compensation, 1500);

  const update = log.txQueries.find((q) => /UPDATE creators/i.test(q.sql));
  assert.match(update.sql, /negotiation_status = 'ACCEPTED'/);
  assert.match(update.sql, /contract_approved = TRUE/);
  assert.strictEqual(update.params[3], 1500); // quoted_rate pinned to the flat fee
  const offer = JSON.parse(update.params[2]);
  assert.strictEqual(offer.offer_type, 'video_based');
  assert.strictEqual(offer.num_videos, 3);

  const types = log.txQueries.filter((q) => /INSERT INTO email_events/i.test(q.sql)).map((q) => q.params[1]);
  assert.deepStrictEqual(types, ['rate_accepted', 'contract_approved', 'contract_created']);
  const accepted = log.txQueries.find((q) => q.params && q.params[1] === 'rate_accepted').params[2];
  assert.strictEqual(accepted.source, 'call');
  assert.strictEqual(accepted.notes, 'Agreed on Tuesday call with Maya');
  // Nothing sent, so no contract_sent step.
  assert.ok(!log.queries.some((q) => q.params && JSON.stringify(q.params).includes('"url"')));
});

test('create: replies in the thread with the call acknowledgement', async () => {
  process.env.DRY_RUN = '1';
  const log = install({ row: { ...creator, instantly_reply_uuid: 'uuid-1', status: 'replied' } });
  const res = await callContract.createContractFromCall(7, form({ delivery: { method: 'thread' } }), { now: NOW });
  assert.deepStrictEqual(res.delivery, { method: 'thread', sent: true });
  assert.strictEqual(log.sent.length, 1);
  assert.strictEqual(log.sent[0].kind, 'contract');
  assert.ok(log.sent[0].email.body.includes(res.url));
  assert.ok(log.sent[0].email.body.includes(callContract.CALL_ACK_LINE));
  const sentEvent = log.queries.find((q) => /INSERT INTO email_events/.test(q.sql));
  assert.strictEqual(sentEvent.params[1].channel, 'email_thread');
});

test('create: a failed send keeps the contract and returns the link', async () => {
  process.env.DRY_RUN = '1';
  install({ row: { ...creator, instantly_reply_uuid: 'uuid-1' }, sendThrows: 'Instantly 502' });
  const res = await callContract.createContractFromCall(7, form({ delivery: { method: 'thread' } }), { now: NOW });
  assert.strictEqual(res.delivery.sent, false);
  assert.match(res.delivery.error, /Instantly 502/);
  assert.ok(res.url);
});

test('create: a direct email to a creator with no address on file saves it', async () => {
  process.env.DRY_RUN = '1';
  const log = install({ row: { ...creator, email: null, status: 'no_email' } });
  const res = await callContract.createContractFromCall(
    7,
    form({ delivery: { method: 'email', to: 'Maya@Studio.co' } }),
    { now: NOW },
  );
  assert.strictEqual(res.delivery.sent, true);
  assert.strictEqual(res.delivery.to, 'maya@studio.co');
  const update = log.txQueries.find((q) => /UPDATE creators/i.test(q.sql));
  assert.strictEqual(update.params[4], 'maya@studio.co');
  const data = JSON.parse(log.txQueries.find((q) => /INSERT INTO contracts/i.test(q.sql)).params[3]);
  assert.strictEqual(data.email, 'maya@studio.co');
});

test('create: stops the Instantly sequence only when asked and still running', async () => {
  process.env.DRY_RUN = '1';
  let log = install();
  let res = await callContract.createContractFromCall(7, form({ stopOutreach: true }), { now: NOW });
  assert.deepStrictEqual(res.outreach, { stopped: false, dryRun: true });
  // Nothing actually came off the campaign, so no "Outreach stopped" step.
  assert.ok(!log.queries.some((q) => q.params && q.params[1] && q.params[1].via === 'call_contract'));

  log = install({ row: { ...creator, instantly_reply_uuid: 'uuid-1', status: 'replied' } });
  res = await callContract.createContractFromCall(7, form({ stopOutreach: true }), { now: NOW });
  assert.strictEqual(res.outreach, null);
});

test('create: "Don\u2019t send" leaves a parked hand-off open so the team can still reply', async () => {
  const parked = { ...creator, instantly_reply_uuid: 'uuid-1', status: 'replied', needs_human: true, delegate_question: 'Can we hop on a call?' };
  process.env.DRY_RUN = '1';
  for (const delivery of [{ method: 'none' }, { method: 'email', to: 'maya@example.com' }]) {
    const log = install({ row: parked });
    const res = await callContract.createContractFromCall(7, form({ delivery }), { now: NOW });
    assert.strictEqual(res.handoffOpen, true, delivery.method);
    assert.strictEqual(res.canReplyInThread, true, delivery.method);
    const all = [...log.txQueries, ...log.queries];
    assert.ok(!all.some((q) => /needs_human\s*=\s*FALSE/i.test(q.sql)), `${delivery.method}: hand-off not cleared`);
  }
});

test('create: a contract sent in the thread answers the parked hand-off', async () => {
  process.env.DRY_RUN = '1';
  const parked = { ...creator, instantly_reply_uuid: 'uuid-1', status: 'replied', needs_human: true, latest_inbound_text: 'Sounds good!' };
  const log = install({ row: parked });
  const res = await callContract.createContractFromCall(7, form({ delivery: { method: 'thread' } }), { now: NOW });
  assert.strictEqual(res.handoffOpen, false);
  assert.ok(!log.txQueries.some((q) => /needs_human/i.test(q.sql)), 'not cleared before the send');
  const clear = log.queries.find((q) => /needs_human\s*=\s*FALSE/i.test(q.sql));
  assert.ok(clear, 'cleared after the send');
  assert.match(clear.sql, /IS NOT DISTINCT FROM/);
  assert.strictEqual(clear.params[1], 'Sounds good!');
});

test('create: a failed thread send leaves the hand-off open', async () => {
  process.env.DRY_RUN = '1';
  const log = install({ row: { ...creator, instantly_reply_uuid: 'uuid-1', needs_human: true }, sendThrows: 'Instantly 502' });
  const res = await callContract.createContractFromCall(7, form({ delivery: { method: 'thread' } }), { now: NOW });
  assert.strictEqual(res.handoffOpen, true);
  assert.ok(![...log.txQueries, ...log.queries].some((q) => /needs_human\s*=\s*FALSE/i.test(q.sql)));
});

test('create: no thread to reply in is reported, so no reply box is offered', async () => {
  install();
  const res = await callContract.createContractFromCall(7, form(), { now: NOW });
  assert.strictEqual(res.canReplyInThread, false);
  assert.strictEqual(res.handoffOpen, false);
});

test('create: refuses a creator who already has a contract, or a portal deal', async () => {
  install({ hasContract: true });
  await assert.rejects(callContract.createContractFromCall(7, form(), { now: NOW }), (e) => e.status === 409);
  install({ portal: true });
  await assert.rejects(callContract.createContractFromCall(7, form(), { now: NOW }), /offer portal/);
  // A contract that appears between the check and the lock (a double-click).
  install({ raceContract: true });
  await assert.rejects(callContract.createContractFromCall(7, form(), { now: NOW }), /already has a contract/);
});

test('create: an invalid form is refused before anything is written', async () => {
  const log = install();
  await assert.rejects(
    callContract.createContractFromCall(7, form({ platforms: [] }), { now: NOW }),
    (e) => e.status === 400,
  );
  assert.strictEqual(log.txQueries.length, 0);
});

test('defaults: prefill the deal on the table and the working delivery options', async () => {
  install({
    row: {
      ...creator,
      custom_offer: { offer_type: 'video_bonus', num_videos: 2, base_fee: 1200, flat_fee: 1700, bonus_amount: 500, bonus_threshold_views: 200000 },
    },
  });
  const d = await callContract.callContractDefaults(7, { now: NOW });
  assert.strictEqual(d.blocked, null);
  assert.strictEqual(d.shape, 'video_bonus');
  assert.deepStrictEqual(d.terms, { model: 'flat', fee: 1200, commission: null, product: null });
  assert.strictEqual(d.numberOfVideos, 2);
  assert.strictEqual(d.postingDeadline, '2026-12-08');
  assert.strictEqual(d.paidAdsIncluded, true); // free_only campaign
  assert.strictEqual(d.delivery.thread, false);
  assert.strictEqual(d.delivery.defaultMethod, 'email');
  assert.strictEqual(d.outreachInFlight, true);
});

test('defaults: a creator with a contract is blocked up front', async () => {
  install({ hasContract: true });
  const d = await callContract.callContractDefaults(7, { now: NOW });
  assert.match(d.blocked, /already has a contract/);
});

test('updateContractTermsFromThread leaves a call contract alone', async () => {
  db.one = async (sql) => {
    if (/FROM contracts WHERE creator_id/i.test(sql)) {
      return { id: 1, token: 't', status: 'pending', data: { termsSource: 'call', compensation: 1500 } };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await contracts.updateContractTermsFromThread(7);
  assert.strictEqual(res.updated, false);
  assert.strictEqual(res.handEntered, true);
});

test('the direct contract email names the call and carries the signing link', () => {
  const { renderContractReadyEmail } = require('./offerPortal/email');
  const r = renderContractReadyEmail({ firstName: 'Sunny', brandName: 'Reve <Labs>', contractUrl: 'https://x.test/contract/abc' });
  assert.strictEqual(r.subject, 'Your Reve <Labs> contract is ready to sign');
  assert.match(r.text, /As discussed on our call/);
  assert.match(r.text, /https:\/\/x\.test\/contract\/abc/);
  assert.match(r.html, /href="https:\/\/x\.test\/contract\/abc"/);
  assert.match(r.html, /Reve &lt;Labs&gt;/); // escaped in HTML
});

test('attachContracts marks a contract that was never sent, and only that one', async () => {
  const origMany = db.many;
  let sql = '';
  db.many = async (q) => {
    sql = q;
    return [
      { creator_id: 1, token: 't1', status: 'pending', data: {}, sent: false },
      { creator_id: 2, token: 't2', status: 'pending', data: {}, sent: true },
    ];
  };
  try {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await contracts.attachContracts(rows);
    assert.strictEqual(rows[0].contract.sent, false);
    assert.strictEqual(rows[1].contract.sent, true);
    assert.strictEqual(rows[2].contract, null);
    // Unsent = a contract_created for this token with no contract_sent after it.
    assert.match(sql, /'contract_created'[\s\S]*detail->>'token' = k\.token[\s\S]*'contract_sent'/);
  } finally {
    db.many = origMany;
  }
});
