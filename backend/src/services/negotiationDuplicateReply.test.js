'use strict';

// Regression guard for the "duplicate REPLY 1 after a manual send" bug.
//
// Symptom the admin reported: they re-approved and sent an offer from the
// Delegate window (worked fine), then a few minutes later a SECOND email went
// out on its own — the REPLY 1 "here are the details, what's your rate?" email,
// which had already been sent to that creator. It fired abruptly, out of order.
//
// Cause: the Instantly webhook stashes every inbound reply in
// latest_inbound_text, and the scheduler's negotiation poll re-processes any
// AWAITING_RATE / AWAITING_DECISION creator that still has one. The manual admin
// sends (sendApprovedOffer, sendDelegateReply) did NOT consume that pending
// inbound, so after the offer moved the creator to AWAITING_DECISION the next
// scheduler tick read the leftover message and (mis)classified it as
// asking_details → re-sent REPLY 1.
//
// Two defenses, both covered here:
//   1. A manual send consumes the pending inbound (guarded on the loaded text so
//      a reply that arrives mid-send is preserved).
//   2. processReply never re-sends REPLY 1 once negotiation_status is set — that
//      action is only valid as the very first reply; anywhere later it's a
//      misread and is delegated to a human instead.
//
// The DB layer is a thin singleton (src/db), so we stub db.one/query/many to
// observe writes, and force the Claude client to null so the deterministic
// heuristic/template fallbacks run (no network, no non-determinism).

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
  id: 7,
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

// ── 1a. Offer approval consumes the pending inbound ─────────────────────────

test('sendApprovedOffer consumes the pending inbound so the scheduler cannot re-fire REPLY 1', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1'; // don't hit Instantly's network from sendNegotiationEmail
  negotiation._setClient(null); // no Claude -> template fallback for the offer body
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'AWAITING_APPROVAL',
    offer_approved: true,
    custom_offer: {
      offer_type: 'view_based',
      flat_fee: 3000,
      view_guarantee: 500000,
      label: 'View-Based Offer',
    },
    // A reply the creator sent WHILE the offer was awaiting approval. The
    // scheduler never processes AWAITING_APPROVAL, so it lingered here until the
    // admin approved.
    latest_inbound_text: 'Sounds great, so what are you offering?',
  };
  db.one = async (sql) => {
    if (/UPDATE creators SET negotiation_status = 'AWAITING_DECISION'/i.test(sql) && /RETURNING id/i.test(sql)) {
      return { id: creator.id }; // atomic claim succeeds
    }
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // app_settings (guidelines ''), countSentNegotiation -> 0
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
    const clear = writes.find(
      (w) => /latest_inbound_text\s*=\s*NULL/i.test(w.sql) && /IS NOT DISTINCT FROM/i.test(w.sql),
    );
    assert.ok(clear, 'the pending inbound is cleared after the offer send');
    assert.strictEqual(
      clear.params[1],
      creator.latest_inbound_text,
      'the clear is guarded on the exact inbound text we loaded (a newer reply survives)',
    );
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 1b. Delegate reply consumes the pending inbound ─────────────────────────

test('sendDelegateReply consumes the pending inbound (guarded) so no auto-reply follows', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'AWAITING_RATE',
    needs_human: true,
    delegate_question: 'Original delegated question',
    latest_inbound_text: 'A follow-up question while waiting for a human',
  };
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.sendDelegateReply(creator.id, {
      body: 'Thanks for waiting — here is the answer to your question.',
    });
    assert.strictEqual(res.sent, true);
    const finalUpdate = writes.find(
      (w) => /needs_human\s*=\s*FALSE/i.test(w.sql) && /latest_inbound_text/i.test(w.sql),
    );
    assert.ok(finalUpdate, 'the flag clear also consumes the pending inbound');
    assert.ok(
      /IS NOT DISTINCT FROM/i.test(finalUpdate.sql),
      'the inbound clear is guarded on the loaded text',
    );
    assert.strictEqual(finalUpdate.params[1], creator.latest_inbound_text);
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 2. processReply never re-sends REPLY 1 once the negotiation has advanced ─

test('processReply does NOT re-send REPLY 1 when asking_details comes back at AWAITING_DECISION', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  negotiation._setClient(null); // force the heuristic: interested + no rate -> asking_details
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION', // an offer is already on the table
    latest_inbound_text: 'This sounds great, tell me more!',
  };
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // app_settings -> AI on, guidelines ''
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.processReply(creator.id);
    assert.strictEqual(res.action, 'delegated');
    assert.strictEqual(res.reason, 'reply1_after_start');
    assert.ok(has(writes, /needs_human\s*=\s*TRUE/i), 'the reply is handed to a human');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'no REPLY 1 email is sent');
    assert.ok(has(writes, /latest_inbound_text\s*=\s*NULL/i), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('processReply still sends REPLY 1 on the FIRST reply (negotiation_status IS NULL)', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  negotiation._setClient(null);
  const writes = [];
  const creator = {
    ...baseCreator,
    negotiation_status: null, // no negotiation email sent yet
    latest_inbound_text: 'This sounds great, tell me more!',
  };
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  try {
    const res = await negotiation.processReply(creator.id);
    assert.strictEqual(res.action, 'asking_details');
    assert.ok(has(writes, /'sent_negotiation'/i), 'REPLY 1 is sent on the first reply');
    assert.ok(!has(writes, /needs_human\s*=\s*TRUE/i), 'the first reply is not delegated');
    const advance = writes.find(
      (w) => /negotiation_status\s*=\s*\$2/i.test(w.sql) && Array.isArray(w.params),
    );
    assert.ok(advance && advance.params.includes('AWAITING_RATE'), 'advances to AWAITING_RATE');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
