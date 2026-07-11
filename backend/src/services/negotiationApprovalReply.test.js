'use strict';

// Surfacing mid-approval replies (negotiation.surfaceApprovalReply).
//
// A creator whose offer is awaiting the admin's approval (AWAITING_APPROVAL) can
// reply again. The main negotiation loop (processReply) only runs for
// NULL / AWAITING_RATE / AWAITING_DECISION, so that message used to sit unseen in
// latest_inbound_text until the admin sent the offer (which consumed it). This
// handler instead SURFACES the reply in the Delegate window as a hand-off — no
// auto-reply, because a human is deliberately in the loop at the approval stage.
//
// Also covers the companion behaviour: sending the offer clears the hand-off
// flags, so a creator that was surfaced drops cleanly out of the Delegate window.
//
// Same harness as negotiationAccepted.test.js: stub db.one/query/many to observe
// writes; force the Claude client to null so nothing hits the network.

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
  id: 9,
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

test('surfaceApprovalReply flags a mid-approval reply for the Delegate window (no auto-reply)', async () => {
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'AWAITING_APPROVAL',
    latest_inbound_text: 'Quick q before we finalize — is this Instagram only?',
  };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceApprovalReply(creator.id);
    assert.strictEqual(res.action, 'surfaced');
    assert.ok(has(writes, /needs_human\s*=\s*TRUE/i), 'creator is flagged for a human');
    assert.ok(has(writes, /'delegated'/i), 'a delegated event is logged so it shows in Delegate');
    // The message is stashed as delegate_question and consumed from the inbox.
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

test('surfaceApprovalReply is a no-op when the creator is not awaiting approval', async () => {
  const writes = [];
  const creator = { ...baseCreator, negotiation_status: 'AWAITING_DECISION', latest_inbound_text: 'hi' };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceApprovalReply(creator.id);
    assert.strictEqual(res.skipped, 'stage');
    assert.strictEqual(writes.length, 0, 'nothing is written');
  } finally {
    restore();
  }
});

test('surfaceApprovalReply is a no-op when there is no pending inbound', async () => {
  const writes = [];
  const creator = { ...baseCreator, negotiation_status: 'AWAITING_APPROVAL', latest_inbound_text: null };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.surfaceApprovalReply(creator.id);
    assert.strictEqual(res.skipped, 'no inbound text');
    assert.strictEqual(writes.length, 0, 'nothing is written');
  } finally {
    restore();
  }
});

test('sendApprovedOffer clears the hand-off flags so a surfaced creator leaves the Delegate window', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1'; // don't hit Instantly's network
  negotiation._setClient(null); // template fallback for the offer body
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'AWAITING_APPROVAL',
    offer_approved: true,
    needs_human: true, // surfaced earlier by surfaceApprovalReply
    delegate_reason: 'Creator replied while their offer was awaiting your approval',
    delegate_question: 'Is this Instagram only?',
    custom_offer: {
      offer_type: 'view_based',
      flat_fee: 3000,
      view_guarantee: 500000,
      label: 'View-Based Offer',
    },
    latest_inbound_text: null,
  };
  db.one = async (sql) => {
    if (/UPDATE creators SET negotiation_status = 'AWAITING_DECISION'/i.test(sql) && /RETURNING id/i.test(sql)) {
      return { id: creator.id };
    }
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.sendApprovedOffer(creator.id, {
      fromStages: ['AWAITING_APPROVAL', 'AWAITING_RATE'],
    });
    assert.strictEqual(res.sent, true, 'the offer is sent');
    assert.ok(
      has(writes, /needs_human\s*=\s*FALSE/i),
      'the hand-off flags are cleared when the offer sends',
    );
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
