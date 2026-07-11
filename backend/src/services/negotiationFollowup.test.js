'use strict';

// Regression guard for the "follow-up nudge fired after the creator already
// replied" bug.
//
// Symptom the admin reported: after an offer/rate had been put forward and the
// creator replied ("Sounds good. Next steps?"), the automation still sent the
// "Did you get a chance to check my last email?" follow-up — three times, on
// consecutive scheduler ticks.
//
// Cause: runNegotiationFollowup (and the scheduler's idle query that feeds it)
// decided a creator was "silent" purely on an elapsed timer. It never checked
// whether the creator had already replied, so a nudge went out even though the
// ball was in OUR court.
//
// Fix: a follow-up is only for a genuinely silent creator. Suppress it when a
// reply is sitting unprocessed in latest_inbound_text, or when the creator's
// most recent reply (replied_at) is newer than our last outbound negotiation
// email (last_negotiation_email_at). In both cases we bail WITHOUT sending or
// bumping negotiation_followup_count.
//
// The DB layer is a thin singleton (src/db), so we stub db.one/query/many to
// observe writes. DRY_RUN keeps sendNegotiationEmail off the network.

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
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));

const baseCreator = {
  id: 42,
  first_name: 'Micah',
  brand_name: 'Reve',
  campaign_name: 'Summer',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-42',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Paid Partnership with Reve',
  email: 'micah@example.com',
  negotiation_status: 'AWAITING_DECISION',
  negotiation_followup_count: 0,
};

function mock(creator) {
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

// ── 1. Creator replied AFTER our last email → no nudge ──────────────────────

test('runNegotiationFollowup does NOT nudge a creator who replied after our last email', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  // Offer went out at 10:31; the creator replied 8 minutes later at 10:39. Their
  // reply is newer than our last outbound — the ball is in our court.
  const creator = {
    ...baseCreator,
    last_negotiation_email_at: '2026-07-09T22:31:00Z',
    replied_at: '2026-07-09T22:39:00Z',
    latest_inbound_text: null,
  };
  const writes = mock(creator);
  try {
    const res = await negotiation.runNegotiationFollowup(creator.id);
    assert.strictEqual(res.skipped, 'creator_replied', 'the nudge is suppressed');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'no follow-up email is sent');
    assert.ok(
      !has(writes, /negotiation_followup_count/i),
      'the follow-up counter is not bumped (the creator is engaged, not silent)',
    );
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 2. A reply is still sitting unprocessed → no nudge ──────────────────────

test('runNegotiationFollowup does NOT nudge while an inbound reply is pending', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const creator = {
    ...baseCreator,
    last_negotiation_email_at: '2026-07-09T22:31:00Z',
    replied_at: '2026-07-09T22:31:00Z', // stale; the fresh reply is the pending text
    latest_inbound_text: 'Sounds good. Next steps?',
  };
  const writes = mock(creator);
  try {
    const res = await negotiation.runNegotiationFollowup(creator.id);
    assert.strictEqual(res.skipped, 'pending_reply', 'the nudge is suppressed');
    assert.ok(!has(writes, /'sent_negotiation'/i), 'no follow-up email is sent');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── 3. Genuinely silent creator → the nudge still goes out ──────────────────

test('runNegotiationFollowup still nudges a genuinely silent creator', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  // We sent the offer; the creator's only reply predates it, and nothing is
  // pending — they have gone quiet. This is exactly what a follow-up is for.
  const creator = {
    ...baseCreator,
    last_negotiation_email_at: '2026-07-09T22:31:00Z',
    replied_at: '2026-07-09T22:20:00Z',
    latest_inbound_text: null,
  };
  const writes = mock(creator);
  try {
    const res = await negotiation.runNegotiationFollowup(creator.id);
    assert.strictEqual(res.sent, true, 'the follow-up is sent');
    assert.ok(has(writes, /'sent_negotiation'/i), 'a follow-up email goes out');
    assert.ok(
      has(writes, /negotiation_followup_count\s*=\s*COALESCE/i),
      'the counter is bumped (guarded against a legacy NULL) so the cap terminates',
    );
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
