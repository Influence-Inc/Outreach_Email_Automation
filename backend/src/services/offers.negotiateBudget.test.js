'use strict';

// Guards the Budget-decline negotiation engine (offers.negotiateBudget): the
// CPM tolerance, the deliverable-expansion path, and the hard ceiling anchored
// to the creator's PRIOR-campaign CPM (a counter more than MAX_CPM_INCREASE_PCT
// above it is declined outright, standing offer left live). DB, the prior-CPM
// lookup, and the messaging channel are all stubbed — no network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const creatorDb = require('./creatorDb');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origWithTx = db.withTransaction;
const origLookupCpm = creatorDb.lookupCpmFromCreatorDb;

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

// Wire up an in-memory offer + prior-CPM so negotiateBudget can run end to end.
// `offer` needs rate + expected_impressions + deliverables; `priorCpm` is what
// resolvePriorCpm resolves to (via the Creator-DB lookup, stubbed here).
function install({ offer, priorCpm }) {
  const writes = [];
  const inserted = {}; // captured counter-offer INSERT params

  db.one = async (sql, params) => {
    if (/FROM offers WHERE token/i.test(sql)) return { ...offer };
    // Ceiling context: creator email/handle + campaign for resolvePriorCpm.
    if (/ca\.id = \$2/.test(sql) && /instagram_username/i.test(sql)) {
      return { email: 'sam@x.com', instagram_username: 'sam', max_cpm: 12, campaign_data: {} };
    }
    if (/established_channel FROM creators/i.test(sql)) return { established_channel: null };
    // Final fetch of the freshly-minted counter offer.
    if (/SELECT \* FROM offers WHERE id = \$1/i.test(sql)) {
      return {
        id: 999,
        token: inserted.token,
        brand_name: offer.brand_name || 'Netflix',
        deliverables: inserted.deliverables,
        rate: inserted.rate,
        currency: offer.currency,
        expected_impressions: inserted.impressions,
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
          inserted.deliverables = JSON.parse(params[4]);
          inserted.rate = params[5];
          inserted.impressions = params[7];
          return { rows: [{ id: 999 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  };
  creatorDb.lookupCpmFromCreatorDb = async () => priorCpm;
  return { writes };
}

function restoreAll() {
  db.one = origOne;
  db.query = origQuery;
  db.withTransaction = origWithTx;
  creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
}

// A $1,500 offer over 100k impressions → CPM $15. Prior CPM $15 → ceiling
// max(15 * 1.5, 15 + 2.5) = $22.5 CPM (i.e. $2,250 at 100k impressions).
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

test('within $1.5 CPM of our offer → counter at (roughly) their rate, same deliverables', async () => {
  // $1,600 → CPM 16, only +1 over our 15 (≤ 1.5 tolerance).
  install({ offer: { ...baseOffer }, priorCpm: 15 });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 1600 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(r.counter.deliverablesChanged, false);
    // midpoint(1500,1600)=1550, capped at their ask.
    assert.strictEqual(r.counter.rate, 1550);
  } finally {
    restoreAll();
  }
});

test('more than $1.5 CPM over but under the ceiling → expand deliverables, hold CPM', async () => {
  // $2,000 → CPM 20: +5 over our 15 (> 1.5), still ≤ 22.5 ceiling.
  install({ offer: { ...baseOffer }, priorCpm: 15 });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 2000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(r.counter.deliverablesChanged, true);
    assert.ok(r.counter.addedLabel, 'names the extra deliverables added');
    assert.strictEqual(r.counter.rate, 2000, 'matches their rate by giving more');
  } finally {
    restoreAll();
  }
});

test('more than 2× the prior-campaign CPM → too high, offer stays live', async () => {
  // $3,100 → CPM 31, above the $30 ceiling (prior CPM 15 × 2).
  const { writes } = install({ offer: { ...baseOffer }, priorCpm: 15 });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 3100 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'too_high');
    assert.match(r.requestedRateFormatted, /3,100/);
    // The standing offer is NOT declined — only the ask is recorded on it.
    assert.ok(writes.some((w) => /UPDATE offers SET requested_rate/i.test(w.sql)));
    assert.ok(!writes.some((w) => /status = 'declined'/i.test(w.sql)));
  } finally {
    restoreAll();
  }
});

test('a counter at exactly 2× the prior CPM is answered, just over it declines', async () => {
  // Ceiling = 15 × 2 = 30. $3,000 → CPM 30 (== ceiling) is honored (no stats in
  // this stub → single expand-deliverables counter); $3,001 → CPM 30.01 declines.
  install({ offer: { ...baseOffer }, priorCpm: 15 });
  try {
    const at = await offers.negotiateBudget({ token: 'tok', requestedRate: 3000 });
    assert.strictEqual(at.outcome, 'countered');
    const over = await offers.negotiateBudget({ token: 'tok', requestedRate: 3001 });
    assert.strictEqual(over.outcome, 'too_high');
  } finally {
    restoreAll();
  }
});

test('ceiling is anchored to the PRIOR CPM, not the current (already-high) offer', async () => {
  // Offer already at CPM 20 ($2,000/100k). Old offer-relative logic (2× the offer
  // CPM = 40) would have answered a CPM-35 ask; the prior-CPM ceiling (15 × 2 =
  // 30) declines it.
  const highOffer = { ...baseOffer, rate: 2000 };
  install({ offer: highOffer, priorCpm: 15 });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 3500 });
    assert.strictEqual(r.outcome, 'too_high');
  } finally {
    restoreAll();
  }
});

test('a small ask over an offer we priced high is never rejected as too-high', async () => {
  // Offer CPM 22 ($2,200/100k), prior CPM 15. The prior-CPM ceiling alone (15 ×
  // 1.5 = 22.5) would decline a CPM-23 ask, but the floor keeps it ≥ our own
  // offer + tolerance (22 + 1.5 = 23.5), so a +$100 ask (CPM 23) is honored.
  const highOffer = { ...baseOffer, rate: 2200 };
  install({ offer: highOffer, priorCpm: 15 });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 2300 });
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(r.counter.deliverablesChanged, false);
  } finally {
    restoreAll();
  }
});

test('rejects a non-positive requested rate before touching the DB', async () => {
  const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 0 });
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid_rate' });
});
