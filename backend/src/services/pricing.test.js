'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const {
  parseViewCount,
  calculatePercentile,
  computeStats,
  computeSixOffers,
  cpmFor,
} = require('./pricing');

test('parseViewCount handles K / M / raw', () => {
  assert.strictEqual(parseViewCount('1.2K'), 1200);
  assert.strictEqual(parseViewCount('3M'), 3_000_000);
  assert.strictEqual(parseViewCount('950'), 950);
});

test('calculatePercentile interpolates', () => {
  assert.strictEqual(calculatePercentile([], 0.5), 0);
  assert.strictEqual(calculatePercentile([42], 0.5), 42);
  assert.strictEqual(calculatePercentile([0, 100], 0.5), 50);
  assert.strictEqual(calculatePercentile([0, 100], 0.25), 25);
});

test('computeStats percentiles', () => {
  const stats = computeStats([300000, 100000, 500000, 200000, 400000]);
  assert.strictEqual(stats.p10, 140000);
  assert.strictEqual(stats.p25, 200000);
  assert.strictEqual(stats.p50, 300000);
  assert.strictEqual(stats.p75, 400000);
  assert.strictEqual(stats.reel_count, 5);
  assert.strictEqual(stats.min_views, 100000);
});

test('computeSixOffers shape + fees (maxCpm 15, RISK_BUFFER 0.20 => eff 12)', () => {
  const stats = computeStats([100000, 200000, 300000, 400000, 500000]);
  const offers = computeSixOffers(stats, 15, null);
  assert.strictEqual(offers.length, 6);

  const byId = Object.fromEntries(offers.map((o) => [o.offer_id, o]));
  // view offers: views/1000 * eff(12)
  assert.strictEqual(byId.view_1.flat_fee, 1200); // 100k
  assert.strictEqual(byId.view_2.flat_fee, 2400); // 200k (p25)
  assert.strictEqual(byId.view_3.flat_fee, 3600); // 300k (p50)
  // video offers: perVid = p25/1000 * eff = 2400, times n
  assert.strictEqual(byId.video_1.flat_fee, 2400);
  assert.strictEqual(byId.video_2.flat_fee, 4800);
  assert.strictEqual(byId.video_3.flat_fee, 7200);

  assert.strictEqual(byId.view_1.view_guarantee, 100000);
  assert.strictEqual(byId.view_1.cpm_applied, 12);
  assert.strictEqual(byId.video_1.view_guarantee, 0);
  assert.strictEqual(byId.video_1.cpm_applied, 12); // no views -> eff
  assert.strictEqual(byId.video_2.flat_per_video, 2400);
  // all 6 have the expected types
  assert.deepStrictEqual(
    offers.map((o) => o.offer_type),
    ['view_based', 'view_based', 'view_based', 'video_based', 'video_based', 'video_based'],
  );
});

test('satisfies_creator_rate reflects the quoted rate', () => {
  const stats = computeStats([100000, 200000, 300000, 400000, 500000]);
  const offers = computeSixOffers(stats, 15, 3000);
  const byId = Object.fromEntries(offers.map((o) => [o.offer_id, o]));
  assert.strictEqual(byId.view_1.satisfies_creator_rate, false); // 1200 < 3000
  assert.strictEqual(byId.view_3.satisfies_creator_rate, true); // 3600 >= 3000
  // null when no quoted rate
  const noRate = computeSixOffers(stats, 15, null);
  assert.strictEqual(noRate[0].satisfies_creator_rate, null);
});

test('cpmFor live recompute', () => {
  assert.strictEqual(cpmFor(1200, 100000), 12);
  assert.strictEqual(cpmFor(1500, 100000), 15);
  assert.strictEqual(cpmFor(1000, 0), null);
});
