'use strict';

// Acceptance of a priced offer at AWAITING_DECISION.
//
// Regression guard for the bug where a creator, after the rate/offer was on the
// table, replied "Sounds good. Next steps?" and the automation neither advanced
// the deal nor answered — it later fired follow-up nudges instead. A clear
// affirmative once an offer is on the table means the creator is saying YES:
// it must classify as "accepted" and kick off the contract, not sit unhandled.
//
// Two guards are covered:
//   1. A clear affirmative at AWAITING_DECISION → accepted (contract workflow),
//      in BOTH the Claude path and the deterministic heuristic fallback.
//   2. An acceptance-looking reply at any OTHER stage (no offer on the table) is
//      delegated, never auto-accepted — accepting fires a contract and must not
//      happen with nothing to accept.
//
// The DB layer is a thin singleton (src/db), so we stub db.one/query/many to
// observe writes. DRY_RUN keeps sendNegotiationEmail off the network; the
// contract-generation call inside applyReply is best-effort (wrapped), so the
// ACCEPTED / rate_accepted writes we assert on land regardless.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;

function fakeClientReturning(jsonStr) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text: jsonStr }] }) } };
}

function install(creator) {
  const writes = [];
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // app_settings, rate_offer_sent, contract lookups
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  return writes;
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  negotiation._setClient(null);
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));
const accepted = (writes) => has(writes, /negotiation_status\s*=\s*'ACCEPTED'/i) && has(writes, /'rate_accepted'/i);
const delegated = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);
const consumed = (writes) => has(writes, /latest_inbound_text\s*=\s*NULL/i);

const baseCreator = {
  id: 7,
  first_name: 'Micah',
  brand_name: 'Reve',
  campaign_name: 'Summer',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-7',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 51000 },
  max_cpm: 3,
};

// ── 1. Claude path: affirmative at AWAITING_DECISION → accepted ──────────────

test('processReply accepts a "Sounds good. Next steps?" reply at AWAITING_DECISION (Claude)', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    latest_inbound_text: 'Sounds good. Next steps?',
  });
  negotiation._setClient(
    fakeClientReturning(
      JSON.stringify({ understanding: 'agrees to the offer', action: 'accepted', send_now: true }),
    ),
  );
  try {
    const res = await negotiation.processReply(7);
    assert.strictEqual(res.action, 'accepted');
    assert.ok(accepted(writes), 'the deal moves to ACCEPTED and logs rate_accepted');
    assert.ok(!delegated(writes), 'a clear acceptance is not punted to a human');
    assert.ok(consumed(writes), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 2. Heuristic fallback: affirmative at AWAITING_DECISION → accepted ───────

test('processReply accepts a clear affirmative at AWAITING_DECISION with Claude unavailable', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  negotiation._setClient(null); // force the deterministic heuristic
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    latest_inbound_text: 'Sounds good. Next steps?',
  });
  try {
    const res = await negotiation.processReply(7);
    assert.strictEqual(res.action, 'accepted');
    assert.ok(accepted(writes), 'the heuristic moves the deal to ACCEPTED');
    assert.ok(!delegated(writes), 'not delegated');
    assert.ok(consumed(writes), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 3. Heuristic does NOT accept when the reply pushes back on price ─────────

test('heuristic does NOT accept a price-pushback reply at AWAITING_DECISION', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  negotiation._setClient(null);
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    latest_inbound_text: 'Sounds good but the rate is a bit too low — can you do better?',
  });
  try {
    const res = await negotiation.processReply(7);
    assert.notStrictEqual(res.action, 'accepted', 'a price objection is never an acceptance');
    assert.ok(!accepted(writes), 'no contract is fired on a pushback');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 4. Guard: "accepted" with no offer on the table is delegated ────────────

test('processReply delegates an acceptance-looking reply when no offer has been sent', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({
    ...baseCreator,
    negotiation_status: null, // first reply — nothing to accept yet
    latest_inbound_text: "Sounds good, let's do it!",
  });
  // Even if the classifier over-eagerly says accepted, the stage guard must catch it.
  negotiation._setClient(
    fakeClientReturning(JSON.stringify({ understanding: 'seems keen', action: 'accepted', send_now: true })),
  );
  try {
    const res = await negotiation.processReply(7);
    assert.strictEqual(res.action, 'delegated');
    assert.strictEqual(res.reason, 'accepted_without_offer');
    assert.ok(!accepted(writes), 'no contract is fired with nothing to accept');
    assert.ok(delegated(writes), 'the reply is handed to a human');
    assert.ok(consumed(writes), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
