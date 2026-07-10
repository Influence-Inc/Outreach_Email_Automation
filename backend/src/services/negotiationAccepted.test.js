'use strict';

// Post-acceptance reply handling (negotiation.handleAcceptedReply).
//
// Regression guard for the bug where a creator who already accepted / signed
// the contract sends a follow-up question (e.g. "who covers the bank transfer
// fees?") and it is neither answered nor delegated — it just sits in
// latest_inbound_text forever. handleAcceptedReply must always attend to such a
// reply: answer the benign factual ones, delegate everything else, and never
// leave a creator question unaddressed.
//
// The DB layer is a thin singleton (src/db), so we stub db.one/db.query/db.many
// to observe the writes, and inject a fake Claude client via _setClient (same
// hook negotiation.examples.test.js uses) to control the classified action.

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

// Install stubs. `creator` is returned by loadCreator; app_settings + any other
// lookup returns null (so guidelines default to '' and AI replies default ON).
// Every db.query is recorded so the test can assert what was written.
function install(creator) {
  const writes = [];
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // app_settings, contracts, rate_offer_sent lookups
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

const baseCreator = {
  id: 42,
  first_name: 'Vo',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  negotiation_status: 'ACCEPTED',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-1',
  instantly_email_account: 'jennifer@useinfluence.xyz',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 51000 },
  max_cpm: 3,
};

const has = (writes, re) => writes.some((w) => re.test(w.sql));
const delegated = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);
const answered = (writes) => has(writes, /'sent_negotiation'/i);
const consumed = (writes) => has(writes, /latest_inbound_text\s*=\s*NULL/i);

test('post-acceptance payment-terms question is delegated, not dropped', async () => {
  const writes = install({
    ...baseCreator,
    latest_inbound_text:
      'Will the payment be sent with all transfer fees covered by the sender, or will bank transfer fees be deducted from my payment?',
  });
  // A payment-structure question is a contractual detail outside the templates —
  // Claude escalates it.
  negotiation._setClient(
    fakeClientReturning(JSON.stringify({ understanding: 'asks who covers transfer fees', action: 'escalate' })),
  );
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.action, 'delegated');
    assert.ok(delegated(writes), 'creator is flagged needs_human');
    assert.ok(!answered(writes), 'no auto-reply is sent');
    assert.ok(consumed(writes), 'the inbound text is consumed exactly once');
  } finally {
    restore();
  }
});

test('post-acceptance benign factual question is answered', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1'; // don't hit Instantly's network from sendNegotiationEmail
  const writes = install({
    ...baseCreator,
    latest_inbound_text: 'Quick one — is this Instagram only, or do you also want TikTok?',
  });
  negotiation._setClient(
    fakeClientReturning(
      JSON.stringify({
        understanding: 'platform question',
        action: 'answer_question',
        email: { subject: 'Re: Paid Partnership with Reve', body: 'Hi Vo, Instagram only for this one. - Jennifer' },
        send_now: true,
      }),
    ),
  );
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.action, 'answer_question');
    assert.ok(answered(writes), 'a reply is sent for a benign factual question');
    assert.ok(!delegated(writes), 'a benign question does not need a human');
    assert.ok(consumed(writes), 'the inbound text is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('post-acceptance trivial acknowledgement is consumed without bothering a human', async () => {
  const writes = install({ ...baseCreator, latest_inbound_text: 'Got it, thanks!' });
  negotiation._setClient(
    fakeClientReturning(JSON.stringify({ understanding: 'thanks', action: 'other' })),
  );
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.action, 'other');
    assert.ok(!delegated(writes), 'a bare acknowledgement is not delegated');
    assert.ok(!answered(writes), 'a bare acknowledgement gets no reply');
    assert.ok(consumed(writes), 'the inbound text is consumed');
  } finally {
    restore();
  }
});

test('post-acceptance usage-rights objection (free_only) amends contract and delegates', async () => {
  const writes = install({
    ...baseCreator,
    usage_rights_policy: 'free_only',
    latest_inbound_text: 'Actually I need you to remove the paid ad rights from the contract.',
  });
  // No Claude call is needed on this branch — the dispute is detected by rule.
  negotiation._setClient(fakeClientReturning('{}'));
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.disputed, true);
    assert.ok(delegated(writes), 'usage-rights dispute goes to a human');
    assert.ok(consumed(writes), 'the inbound text is consumed');
  } finally {
    restore();
  }
});
