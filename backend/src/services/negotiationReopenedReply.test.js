'use strict';

// Re-surfacing a reply on a closed-out conversation (negotiation.surfaceReopenedReply).
//
// Once a creator is dismissed from the Delegate window (dismiss-offer → CLOSED),
// declines (DECLINED), or the idle follow-ups auto-close the thread (→ CLOSED),
// no other scheduler step looks at them again. A fresh reply used to sit unseen
// in latest_inbound_text forever. This handler re-opens the deal and routes it
// into the Delegate window based on what the creator said:
//   • a rate / counter / "make me an offer"  → the OFFER CONFIGURATOR (a priced
//     offer to approve & send), not a bare reply box;
//   • anything else (a question, an objection) → a plain hand-off reply box.
// It never auto-SENDS — the offer paths only stage an offer for admin approval.
//
// Same harness as negotiationApprovalReply.test.js: stub db.one/query/many to
// observe writes; the Claude client stays null so handleCreatorReply falls back
// to the deterministic heuristic (no network).

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
  // A stats shape computeOffers can actually price (needs min_views + p25).
  ig_scraped_data: { min_views: 100000, p25: 200000, p50: 300000, p75: 400000, reel_count: 5 },
  max_cpm: 15,
  email: 'joe@example.com',
};

// Every test stubs the DB the same way: the creator load returns our row, the
// settings lookups (app_settings) return null so AI replies default ON and
// guidelines are empty, and every write is captured.
function stubDb(creator, writes) {
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
}

test('a dismissed (CLOSED) creator who comes back with a rate lands in the offer configurator', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'CLOSED', // dismissed from Delegate via dismiss-offer
    latest_inbound_text: "We can do 300k for $2200 as the last time, let's work again",
  };
  stubDb(creator, writes);
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened_offer');
    assert.strictEqual(res.reason, 'shared_rate');
    // Priced offer staged for approval — this is what renders the configurator.
    assert.ok(
      has(writes, /negotiation_status\s*=\s*'AWAITING_APPROVAL'/i),
      'the deal is moved to AWAITING_APPROVAL (offer awaiting approval)',
    );
    assert.ok(has(writes, /suggested_offers/i), 'priced offers are computed/kept for the configurator');
    // The configurator is a clean card — no lingering reply-box hand-off.
    assert.ok(has(writes, /needs_human\s*=\s*FALSE/i), 'the hand-off flag is cleared');
    assert.ok(!has(writes, /'delegated'/i), 'not surfaced as a plain reply-box hand-off');
    // Nothing is auto-sent — the admin approves & sends from the configurator.
    assert.ok(!has(writes, /'sent_negotiation'/i), 'no offer email is auto-sent');
    assert.ok(has(writes, /latest_inbound_text\s*=\s*NULL/i), 'the inbound is consumed');
  } finally {
    restore();
  }
});

test('a reopened creator who asks US to price it also lands in the offer configurator', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'CLOSED',
    latest_inbound_text: "Hey, we're back and keen to work again — make me an offer?",
  };
  stubDb(creator, writes);
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened_offer');
    assert.ok(
      has(writes, /negotiation_status\s*=\s*'AWAITING_APPROVAL'/i),
      'routed into the offer configurator (AWAITING_APPROVAL)',
    );
    assert.ok(has(writes, /'offer_requested'/i), 'an offer_requested event is logged');
    assert.ok(has(writes, /needs_human\s*=\s*FALSE/i), 'no reply-box hand-off');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'nothing is auto-sent');
  } finally {
    restore();
  }
});

test('a DECLINED creator who comes back with a rate also gets the configurator', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'DECLINED',
    latest_inbound_text: 'Actually, on second thought we could do it for $2000 — still open?',
  };
  stubDb(creator, writes);
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened_offer');
    assert.ok(has(writes, /negotiation_status\s*=\s*'AWAITING_APPROVAL'/i), 'offer configurator');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'nothing is auto-sent');
  } finally {
    restore();
  }
});

test('a reopened creator with a non-offer question is surfaced as a plain hand-off', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'CLOSED',
    latest_inbound_text: 'Quick q before anything else — is this Instagram only?',
  };
  stubDb(creator, writes);
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.action, 'reopened');
    // Re-opened and flagged for a human, NOT routed to the offer configurator.
    assert.ok(has(writes, /needs_human\s*=\s*TRUE/i), 'creator is flagged for a human');
    assert.ok(has(writes, /'delegated'/i), 'a delegated event is logged so it shows in Delegate');
    assert.ok(
      !has(writes, /negotiation_status\s*=\s*'AWAITING_APPROVAL'/i),
      'a plain question does NOT open the offer configurator',
    );
    assert.ok(!has(writes, /'sent_negotiation'/i), 'nothing is auto-sent — the human decides');
    assert.ok(has(writes, /latest_inbound_text\s*=\s*NULL/i), 'the inbound is consumed');
  } finally {
    restore();
  }
});

test('surfaceReopenedReply is a no-op when the creator is not on a terminal stage', async () => {
  const writes = [];
  const creator = { ...baseCreator, negotiation_status: 'AWAITING_DECISION', latest_inbound_text: 'hi' };
  stubDb(creator, writes);
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
  stubDb(creator, writes);
  try {
    const res = await negotiation.surfaceReopenedReply(creator.id);
    assert.strictEqual(res.skipped, 'no inbound text');
    assert.strictEqual(writes.length, 0, 'nothing is written');
  } finally {
    restore();
  }
});
