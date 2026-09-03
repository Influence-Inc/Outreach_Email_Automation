'use strict';

// Guards the schedule-negotiation flow (a "Timing" decline): offers.negotiateSchedule
// (creator picks a start date → re-offer within the window, or park on hold
// beyond it) and offers.sendRescheduledOffer (admin schedule-counter). DB and the
// messaging channel are stubbed — no network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origWithTx = db.withTransaction;

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

// A local 'YYYY-MM-DD' n days from today (matches what <input type="date"> posts).
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

const baseOffer = {
  id: 1,
  token: 'tok',
  status: 'pending',
  expires_at: FUTURE,
  rate: 1500,
  currency: 'USD',
  expected_impressions: 100000,
  deliverables: ['1 Reel'],
  brand_name: 'Netflix',
  creator_id: 88,
  campaign_id: 1,
};

function install({ offer = baseOffer, latestForCreator = null } = {}) {
  const writes = [];
  const inserted = {};

  db.one = async (sql) => {
    // The negotiateSchedule query joins campaigns for its deadline_date; the
    // baseOffer fixture may or may not carry a campaign_deadline_date field.
    if (/FROM offers o LEFT JOIN campaigns/i.test(sql)) return { ...offer };
    if (/FROM offers WHERE token/i.test(sql)) return { ...offer };
    if (/FROM offers WHERE creator_id/i.test(sql)) return latestForCreator ? { ...latestForCreator } : null;
    // Past-deadline decline UPDATE ... RETURNING id.
    if (/UPDATE offers\s+SET status = 'declined', decline_reason = 'Timing'/i.test(sql)) return { id: offer.id };
    if (/established_channel FROM creators/i.test(sql)) return { established_channel: null };
    // Freshly-minted rescheduled offer.
    if (/SELECT \* FROM offers WHERE id = \$1/i.test(sql)) {
      return {
        id: 999,
        token: inserted.token,
        brand_name: offer.brand_name,
        deliverables: offer.deliverables,
        rate: inserted.rate,
        currency: offer.currency,
        expected_impressions: offer.expected_impressions,
        requested_start_date: inserted.startDate,
        expires_at: FUTURE,
        parent_offer_id: offer.id,
      };
    }
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  db.withTransaction = async (fn) => {
    const client = {
      query: async (sql, params) => {
        if (/UPDATE offers SET status = 'declined'/i.test(sql)) return { rowCount: 1 };
        if (/INSERT INTO offers/i.test(sql)) {
          inserted.token = params[2];
          inserted.rate = params[5];
          inserted.startDate = params[9];
          return { rows: [{ id: 999 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  };
  return { writes };
}

function restoreAll() {
  db.one = origOne;
  db.query = origQuery;
  db.withTransaction = origWithTx;
}

test('a picked date within the campaign deadline → fresh same-terms offer on their dates', async () => {
  install({ offer: { ...baseOffer, campaign_deadline_date: daysFromNow(30) } });
  try {
    const r = await offers.negotiateSchedule({ token: 'tok', availableDate: daysFromNow(7) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'rescheduled');
    assert.strictEqual(r.counter.rate, 1500, 'same rate — only the dates change');
    assert.deepStrictEqual(r.counter.deliverables, ['1 Reel'], 'same deliverables');
    assert.ok(r.counter.startDateFormatted, 'carries the agreed start date');
  } finally {
    restoreAll();
  }
});

test('a picked date on the campaign deadline still accommodates', async () => {
  install({ offer: { ...baseOffer, campaign_deadline_date: daysFromNow(14) } });
  try {
    const r = await offers.negotiateSchedule({ token: 'tok', availableDate: daysFromNow(14) });
    assert.strictEqual(r.outcome, 'rescheduled');
  } finally {
    restoreAll();
  }
});

test('a picked date past the campaign deadline → offer is declined, no delegate hand-off', async () => {
  const { writes } = install({ offer: { ...baseOffer, campaign_deadline_date: daysFromNow(14) } });
  try {
    const r = await offers.negotiateSchedule({ token: 'tok', availableDate: daysFromNow(30) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'past_deadline');
    assert.ok(r.startDateFormatted);
    assert.ok(r.campaignDeadlineFormatted);
    // Deal Studio no longer parks this as ON_HOLD — the offer is closed instead.
    assert.ok(!writes.some((w) => /negotiation_status = 'ON_HOLD'/i.test(w.sql)));
    assert.ok(!writes.some((w) => /'schedule_hold'/i.test(w.sql)));
    // A regular 'declined' event goes on the offer timeline.
    assert.ok(writes.some((w) => /'declined'/i.test(w.sql)));
  } finally {
    restoreAll();
  }
});

test('no campaign deadline set → any future date accommodates (no gate)', async () => {
  install({ offer: { ...baseOffer, campaign_deadline_date: null } });
  try {
    const r = await offers.negotiateSchedule({ token: 'tok', availableDate: daysFromNow(90) });
    assert.strictEqual(r.outcome, 'rescheduled');
  } finally {
    restoreAll();
  }
});

test('an unparseable date is rejected before touching the offer', async () => {
  const r = await offers.negotiateSchedule({ token: 'tok', availableDate: 'whenever' });
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid_date' });
});

test('a past date is rejected', async () => {
  const r = await offers.negotiateSchedule({ token: 'tok', availableDate: daysFromNow(-3) });
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid_date' });
});

test('admin sendRescheduledOffer mints a fresh dated offer and clears the hold', async () => {
  const onHoldOffer = { ...baseOffer, schedule_hold: true };
  const { writes } = install({ latestForCreator: onHoldOffer });
  try {
    const r = await offers.sendRescheduledOffer({ creatorId: 88, startDate: daysFromNow(21) });
    assert.strictEqual(r.ok, true);
    assert.ok(r.token, 'returns the new offer token');
    assert.ok(r.startDateFormatted, 'carries the admin-chosen start date');
    // The parked deal is reactivated (ON_HOLD cleared).
    assert.ok(writes.some((w) => /negotiation_status = NULL/i.test(w.sql) && /'ON_HOLD'/i.test(w.sql)));
  } finally {
    restoreAll();
  }
});

test('admin sendRescheduledOffer rejects an invalid date', async () => {
  const r = await offers.sendRescheduledOffer({ creatorId: 88, startDate: 'soon' });
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid_date' });
});
