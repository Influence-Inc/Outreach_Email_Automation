'use strict';

// Guards startOfferForCreator — the entry point that puts a USED creator into
// the offer-approval pipeline when they first reach out on WhatsApp/iMessage
// (the invite → "Hi" flow). Unlike routeCreatorToOffer (keyed on a reply object
// from the email thread), this is keyed on creator id and must be IDEMPOTENT:
// a creator who texts "Hi" twice should surface once for the admin to price,
// not re-log or reset on every inbound.
//
// Behaviors covered:
//   - already in an offer/negotiation stage  → no-op skip, zero writes
//   - has view stats + no offer yet          → compute offers, AWAITING_APPROVAL
//   - no view stats                          → flag for a human, no offer
//   - creator not found                      → skip
//
// DB is stubbed (db.one / db.query), no network, no real Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');

const origOne = db.one;
const origQuery = db.query;

function install(creator) {
  const writes = [];
  db.one = async (sql, params) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return creator ? { ...creator } : null;
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  return writes;
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));
const approved = (writes) => has(writes, /negotiation_status\s*=\s*'AWAITING_APPROVAL'/i);
const flaggedForHuman = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);
const loggedOfferRequested = (writes) => has(writes, /'offer_requested'/i);

const baseCreator = {
  id: 77,
  first_name: 'Priya',
  brand_name: 'Reve',
  campaign_name: 'Summer',
  max_cpm: 3,
  quoted_rate: null,
  suggested_offers: null,
  ig_scraped_data: { median: 51000 },
  negotiation_status: null,
};

test('startOfferForCreator prices the offer and moves a fresh creator to AWAITING_APPROVAL', async () => {
  const writes = install({ ...baseCreator });
  try {
    const res = await negotiation.startOfferForCreator(77);
    assert.deepStrictEqual(res, { routed: true });
    assert.ok(approved(writes), 'creator is moved into the approvable offer stage');
    assert.ok(loggedOfferRequested(writes), 'an offer_requested event is logged on the timeline');
    // The offers we persist are the ones priced from their view stats.
    const upd = writes.find((w) => /suggested_offers\s*=\s*\$2::jsonb/i.test(w.sql));
    assert.ok(upd, 'suggested_offers is written');
    assert.ok(JSON.parse(upd.params[1]).length > 0, 'at least one priced offer is stored');
  } finally {
    restore();
  }
});

test('startOfferForCreator is a no-op once the creator is already awaiting approval (repeat "Hi")', async () => {
  const writes = install({ ...baseCreator, negotiation_status: 'AWAITING_APPROVAL' });
  try {
    const res = await negotiation.startOfferForCreator(77);
    assert.deepStrictEqual(res, { skipped: 'already AWAITING_APPROVAL' });
    assert.strictEqual(writes.length, 0, 'nothing is written — no re-log, no reset');
  } finally {
    restore();
  }
});

test('startOfferForCreator does not disturb a creator who has already accepted', async () => {
  const writes = install({ ...baseCreator, negotiation_status: 'ACCEPTED' });
  try {
    const res = await negotiation.startOfferForCreator(77);
    assert.deepStrictEqual(res, { skipped: 'already ACCEPTED' });
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});

test('startOfferForCreator flags a human when there are no view stats to price from', async () => {
  const writes = install({ ...baseCreator, ig_scraped_data: null });
  try {
    const res = await negotiation.startOfferForCreator(77);
    assert.deepStrictEqual(res, { routed: false, reason: 'no_stats' });
    assert.ok(flaggedForHuman(writes), 'creator is flagged for a human to scrape + price');
    assert.ok(!approved(writes), 'no offer stage is set without stats');
    assert.ok(!loggedOfferRequested(writes), 'no offer_requested event without a priced offer');
  } finally {
    restore();
  }
});

test('startOfferForCreator skips a creator id that no longer exists', async () => {
  const writes = install(null);
  try {
    const res = await negotiation.startOfferForCreator(999);
    assert.deepStrictEqual(res, { skipped: 'not_found' });
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});
