'use strict';

// Re-surfacing a reply on a closed-out conversation (negotiation.surfaceReopenedReply).
//
// Once a creator is dismissed from the Delegate window (dismiss-offer → CLOSED),
// declines (DECLINED), or the idle follow-ups auto-close the thread (→ CLOSED),
// no other scheduler step looks at them again. A fresh reply — e.g. the creator
// coming back with an offer — used to sit unseen in latest_inbound_text forever.
// This handler re-opens the deal to an active stage and SURFACES the reply in
// the Delegate window as a hand-off (no auto-reply — a human decides how to
// re-engage a conversation someone had already closed).
//
// Same harness as negotiationApprovalReply.test.js: stub db.one/query/many to
// observe writes; force the Claude client to null so nothing hits the network.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  negotiation._setClient(null);
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));

const baseCreator = {
  id: 12,
  first_name: 'Joe',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-1',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 51000 },
  max_cpm: 3,
  email: 'joe@example.com',
};

test('surfaceReopenedReply re-opens a dismissed (CLOSED) creator and surfaces the reply in Delegate', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'CLOSED', // dismissed from Delegate via dismiss-offer
    latest_inbound_text: "Hey, we're back — can you send over an offer?",
  };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened');
    // The deal is re-opened to an active stage so it's live again.
    assert.ok(
      has(writes, /negotiation_status\s*=\s*'AWAITING_RATE'/i),
      'the closed deal is re-opened to an active stage',
    );
    // The reply is flagged for a human so it shows in the Delegate window.
    assert.ok(has(writes, /needs_human\s*=\s*TRUE/i), 'creator is flagged for a human');
    assert.ok(has(writes, /'delegated'/i), 'a delegated event is logged so it shows in Delegate');
    // The creator's message is stashed as the delegate_question.
    const flag = writes.find((w) => /needs_human\s*=\s*TRUE/i.test(w.sql));
    assert.ok(
      flag && flag.params.includes(creator.latest_inbound_text),
      'the creator message is stored as delegate_question',
    );
    assert.ok(has(writes, /latest_inbound_text\s*=\s*NULL/i), 'the surfaced inbound is consumed');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'nothing is auto-sent — the human decides');
  } finally {
    restore();
  }
});

test('surfaceReopenedReply also handles a DECLINED creator who comes back', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'DECLINED',
    latest_inbound_text: 'Actually, on second thought we could make it work — what can you do?',
  };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened');
    assert.ok(has(writes, /needs_human\s*=\s*TRUE/i), 'creator is flagged for a human');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'nothing is auto-sent');
  } finally {
    restore();
  }
});

test('surfaceReopenedReply is a no-op when the creator is not on a terminal stage', async () => {
  const writes = [];
  const creator = { ...baseCreator, negotiation_status: 'AWAITING_DECISION', latest_inbound_text: 'hi' };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.skipped, 'stage');
    assert.strictEqual(writes.length, 0, 'nothing is written — the main loop already handles this stage');
  } finally {
    restore();
  }
});

test('surfaceReopenedReply is a no-op when there is no pending inbound', async () => {
  const writes = [];
  const creator = { ...baseCreator, negotiation_status: 'CLOSED', latest_inbound_text: null };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.skipped, 'no inbound text');
    assert.strictEqual(writes.length, 0, 'nothing is written');
  } finally {
    restore();
  }
});
