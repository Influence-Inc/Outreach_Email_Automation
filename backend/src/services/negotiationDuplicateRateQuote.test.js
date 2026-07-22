'use strict';

// Regression guard for the duplicate rate-quote bug.
//
// Scenario: the creator quoted their per-video flat rate on an earlier reply
// (stored in quoted_rate). The admin then sent a view-based / performance
// offer instead. The creator declined that structure ("I don't work on a
// view-based model, I charge a flat rate per video") without naming a NEW
// number — Claude classifies this as "request_counter_rate", whose default
// action re-sends a REPLY 1-style "what rate would work for you?" email.
// That asks a question the creator has ALREADY answered.
//
// Guard: at request_counter_rate, if the creator already has a quoted_rate on
// file, don't auto-reply — delegate so the admin can either accept the prior
// rate (acceptQuotedRate) or send a new flat-rate offer.

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
    return null;
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
const delegated = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);
const consumed = (writes) => has(writes, /latest_inbound_text\s*=\s*NULL/i);
const rateQuoted = (writes) => has(writes, /'rate_quoted'/i);
const rateCounterRequested = (writes) => has(writes, /'rate_counter_requested'/i);

const baseCreator = {
  id: 21,
  first_name: 'Lorenzo',
  brand_name: 'Reve',
  campaign_name: 'Summer',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-21',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 51000 },
  max_cpm: 3,
};

test('request_counter_rate is delegated when the creator has already quoted a rate', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    quoted_rate: '3500', // NUMERIC comes back from pg as a string
    latest_inbound_text:
      "I don't work on a view-based model. I charge a flat rate per video and deliverable, which gives clear expectations from the start.",
  });
  negotiation._setClient(
    fakeClientReturning(
      JSON.stringify({
        understanding: 'declines the view-based structure, restates flat-rate model, no new number',
        action: 'request_counter_rate',
        quoted_rate: null,
        send_now: true,
      }),
    ),
  );
  try {
    const res = await negotiation.processReply(21);
    assert.strictEqual(res.action, 'delegated');
    assert.strictEqual(res.reason, 'request_counter_rate_with_prior_quote');
    assert.ok(delegated(writes), 'the reply is handed to a human, not auto-answered');
    assert.ok(
      !rateCounterRequested(writes),
      'no rate_counter_requested event: the counter-rate reply was NOT sent',
    );
    assert.ok(
      !rateQuoted(writes),
      'no rate_quoted event: the creator did not name a new number',
    );
    assert.ok(consumed(writes), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('request_counter_rate still auto-replies when NO prior rate is on file', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    quoted_rate: null, // no prior quote — the default counter-rate ask is the right move
    latest_inbound_text: 'That rate is a bit low for me — can you do better?',
  });
  negotiation._setClient(
    fakeClientReturning(
      JSON.stringify({
        understanding: 'pushes back on the offered price without naming a number',
        action: 'request_counter_rate',
        quoted_rate: null,
        email: {
          subject: 'Re: Paid Partnership with Reve',
          body: "Hi Lorenzo,\n\nTotally hear you — what rate would feel right for this?\n\n- Jennifer",
        },
        send_now: true,
      }),
    ),
  );
  try {
    const res = await negotiation.processReply(21);
    assert.strictEqual(res.action, 'request_counter_rate');
    assert.ok(!delegated(writes), 'no hand-off: without a prior rate we still ask for one');
    assert.ok(rateCounterRequested(writes), 'the counter-rate request is logged on the timeline');
    assert.ok(consumed(writes), 'the inbound is consumed');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
