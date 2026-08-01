'use strict';

// Guards the two-deal-option counter (offers.negotiateBudget with view stats on
// the web portal). When a creator's counter lands above our tolerance but at/under
// 2× their prior-campaign CPM, we no longer just add deliverables — we mint TWO
// child offers (view-based + video-based), both paying their rate, and let them
// pick one on the page. Covers: the pure sizing helper (buildCounterOptions), the
// full mint path, the messaging-channel fallback to a single counter, and the
// no-stats fallback. DB + prior-CPM lookup are stubbed — no network, no Postgres.

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

// Wire an in-memory offer + prior-CPM + creator stats so negotiateBudget runs end
// to end. `stats` becomes creators.ig_scraped_data (null → no options path). The
// withTransaction stub captures every INSERTed offer row so a test can assert both
// children were minted.
function install({ offer, priorCpm, stats }) {
  const inserts = []; // captured child-offer INSERT params

  db.one = async (sql) => {
    if (/FROM offers WHERE token/i.test(sql)) return { ...offer };
    if (/ca\.id = \$2/.test(sql) && /instagram_username/i.test(sql)) {
      return {
        email: 'sam@x.com',
        instagram_username: 'sam',
        ig_scraped_data: stats,
        max_cpm: 12,
        campaign_data: {},
      };
    }
    if (/established_channel FROM creators/i.test(sql)) return { established_channel: null };
    // Final fetch of the freshly-minted single counter (fallback path only).
    if (/SELECT \* FROM offers WHERE id = \$1/i.test(sql)) {
      const last = inserts[inserts.length - 1];
      if (!last) return null;
      return {
        id: 999,
        token: last.token,
        brand_name: offer.brand_name,
        deliverables: last.deliverables,
        rate: last.rate,
        currency: offer.currency,
        expected_impressions: last.impressions,
        expires_at: FUTURE,
        parent_offer_id: last.parentId,
      };
    }
    return null;
  };
  db.query = async () => ({ rows: [], rowCount: 1 });
  db.withTransaction = async (fn) => {
    let nextId = 900;
    const client = {
      query: async (sql, params) => {
        if (/UPDATE offers SET status = 'declined'/i.test(sql)) return { rowCount: 1 };
        if (/INSERT INTO offers/i.test(sql)) {
          nextId += 1;
          inserts.push({
            token: params[2],
            deliverables: JSON.parse(params[4]),
            rate: params[5],
            impressions: params[7],
            parentId: params[8],
          });
          return { rows: [{ id: nextId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  };
  creatorDb.lookupCpmFromCreatorDb = async () => priorCpm;
  return { inserts };
}

function restoreAll() {
  db.one = origOne;
  db.query = origQuery;
  db.withTransaction = origWithTx;
  creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
}

// $1,500 / 100k impressions → CPM $15. Prior CPM $15 → ceiling = 15 × 2 = $30 CPM.
// Median per-video views 50k.
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
const stats = { p50: 50000, p25: 30000 };

// ── pure helper ────────────────────────────────────────────────────────────
test('buildCounterOptions: view-based guarantees the CPM-holding impressions; video-based expresses them as whole Reels', () => {
  // capCpm 16.5 ($15 CPM + $1.5 tolerance), requestedRate $2,000.
  // requiredImpressions = 2000 * 1000 / 16.5 = 121,212 → rounded up to 125,000.
  // videos = ceil(121,212 / 50,000) = 3.
  const [view, video] = offers.buildCounterOptions({
    requestedRate: 2000,
    capCpm: 16.5,
    medianViews: 50000,
  });

  assert.strictEqual(view.dealType, 'view_based');
  assert.strictEqual(view.rate, 2000);
  assert.strictEqual(view.viewGuarantee, 125000);
  assert.strictEqual(view.expectedImpressions, 125000);
  assert.strictEqual(view.numVideos, null);
  // Effective CPM at the guarantee holds at/under the cap.
  assert.ok((2000 * 1000) / view.viewGuarantee <= 16.5);

  assert.strictEqual(video.dealType, 'video_based');
  assert.strictEqual(video.rate, 2000);
  assert.strictEqual(video.numVideos, 3);
  assert.strictEqual(video.viewGuarantee, null);
  assert.deepStrictEqual(video.deliverables, ['3 Reels']);
  assert.strictEqual(video.expectedImpressions, 150000);
});

test('buildCounterOptions: a single video reads "Reel" (singular)', () => {
  const [, video] = offers.buildCounterOptions({
    requestedRate: 800,
    capCpm: 16.5,
    medianViews: 500000, // one video already clears the required impressions
  });
  assert.strictEqual(video.numVideos, 1);
  assert.deepStrictEqual(video.deliverables, ['1 Reel']);
});

// ── full mint path ─────────────────────────────────────────────────────────
test('web counter above tolerance, ≤ 2× prior CPM, with stats → two options minted', async () => {
  // $2,000 → CPM 20: +5 over our 15 (> 1.5 tolerance), still ≤ 30 ceiling.
  const { inserts } = install({ offer: { ...baseOffer }, priorCpm: 15, stats });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 2000, channel: 'web' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'options');
    assert.strictEqual(r.options.length, 2);

    const [view, video] = r.options;
    assert.strictEqual(view.dealType, 'view_based');
    assert.strictEqual(video.dealType, 'video_based');
    // Both pay the creator's requested rate.
    assert.strictEqual(view.rate, 2000);
    assert.strictEqual(video.rate, 2000);
    // Each carries its own accept token + a human rate/expiry.
    assert.ok(view.token && video.token && view.token !== video.token);
    assert.match(view.rateFormatted, /2,000/);
    assert.ok(view.expiresFormatted);
    assert.strictEqual(view.brandName, 'Netflix');
    // Shape-specific fields.
    assert.ok(view.viewGuarantee > 0 && view.numVideos == null);
    assert.ok(video.numVideos > 0 && video.viewGuarantee == null);

    // Two child rows were inserted, both under the parent offer.
    assert.strictEqual(inserts.length, 2);
    assert.ok(inserts.every((i) => i.parentId === baseOffer.id));
  } finally {
    restoreAll();
  }
});

test('a messaging-channel counter never returns options (single counter instead)', async () => {
  // Same ask + stats, but over WhatsApp → the two-option flow is web-only.
  install({ offer: { ...baseOffer }, priorCpm: 15, stats });
  try {
    const r = await offers.negotiateBudget({
      token: 'tok',
      requestedRate: 2000,
      channel: 'whatsapp',
    });
    assert.strictEqual(r.outcome, 'countered');
    assert.ok(!r.options, 'no options array on the messaging path');
  } finally {
    restoreAll();
  }
});

test('no ig_scraped_data → fall back to a single expand-deliverables counter', async () => {
  install({ offer: { ...baseOffer }, priorCpm: 15, stats: null });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 2000, channel: 'web' });
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(r.counter.deliverablesChanged, true);
  } finally {
    restoreAll();
  }
});

test('over 2× the prior CPM → too high even with stats (no options)', async () => {
  // $3,100 → CPM 31, above the $30 ceiling.
  install({ offer: { ...baseOffer }, priorCpm: 15, stats });
  try {
    const r = await offers.negotiateBudget({ token: 'tok', requestedRate: 3100, channel: 'web' });
    assert.strictEqual(r.outcome, 'too_high');
  } finally {
    restoreAll();
  }
});
