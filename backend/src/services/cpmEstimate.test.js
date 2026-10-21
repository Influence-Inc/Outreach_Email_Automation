'use strict';

// The Deal Studio side of the CPM + rate estimate: reading a creator's topic and country from
// their scraped Instagram profile, the admin overrides, and the CPM their deals are priced at.
// (cpmEstimate.parity.test.js checks the ported formula against the original.)

const test = require('node:test');
const assert = require('node:assert');
const est = require('./cpmEstimate');

const stats = (p50, extra = {}) => ({ ig_scraped_data: { p50, p25: p50 * 0.7, min_views: p50 * 0.4, reel_count: 12, ...extra } });

test('reads topic and niche labels from the bio and category words', () => {
  const content = est.contentFromProfile({ bio: 'Gym rat. Workouts + nutrition tips 💪', category: 'Fitness Model' });
  assert.ok(content.length >= 3);
  assert.ok(content.every((c) => c.topic));
  assert.ok(content.some((c) => c.topic === 'fitness'));
});

test('a word repeated in the bio counts once', () => {
  const content = est.contentFromProfile({ bio: 'food food food foodie' });
  assert.strictEqual(content.filter((c) => c.word === 'food').length, 1);
});

test('skincare creator in Mumbai: skincare group x India, rate from median views', () => {
  const r = est.estimateForCreator({ ig_biography: '📍 Mumbai | skincare & makeup', ...stats(40000) });
  const [topic, country] = r.cpm.stickers;
  assert.strictEqual(topic.value, 'skincare');
  assert.strictEqual(topic.label, 'Skincare → Health / Fitness / Skincare');
  assert.strictEqual(country.value, 'IN');
  assert.strictEqual(r.inputs.country.evidence, '📍 mumbai');
  // ($20+$35)/2 x (0.15+0.3)/2 = 27.5 x 0.225
  assert.strictEqual(r.cpm.value, 6.1875);
  assert.deepStrictEqual([r.cpm.low, r.cpm.high], [3, 10.5]);
  // 40,000 / 1000 x CPM
  assert.deepStrictEqual([r.rate.value, r.rate.low, r.rate.high], [247.5, 120, 420]);
  assert.strictEqual(r.expected_views.value, 40000);
});

test('an empty profile still estimates: average of the groups x the default market', () => {
  const r = est.estimateForCreator({ ...stats(10000) });
  assert.strictEqual(r.cpm.stickers[0].label, 'No topic detected');
  assert.strictEqual(r.cpm.stickers[1].level, 'default');
  assert.ok(r.cpm.value > 0);
  assert.ok(r.cpm.notes.some((n) => /not the US price/.test(n)), 'an unknown market is never priced as the US');
  assert.strictEqual(r.inputs.topic.source, 'none');
});

test('no view stats: the CPM is still estimated but there is no rate', () => {
  const r = est.estimateForCreator({ ig_biography: 'NYC fashion stylist' });
  assert.ok(r.cpm.value > 0);
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.expected_views, null);
});

test('admin topic and country replace what the profile says', () => {
  const r = est.estimateForCreator({
    ig_biography: '📍 Mumbai | skincare',
    cpm_topic_override: 'tech',
    cpm_country_override: 'us',
    ...stats(100000),
  });
  assert.strictEqual(r.cpm.stickers[0].label, 'Tech → Finance / B2B / Tech');
  assert.strictEqual(r.cpm.stickers[0].evidence, 'set by admin');
  assert.strictEqual(r.cpm.stickers[1].value, 'US');
  assert.strictEqual(r.inputs.topic.source, 'admin');
  assert.strictEqual(r.inputs.country.source, 'admin');
  assert.strictEqual(r.cpm.value, 47.5); // ($35+$60)/2 x 1.0
  assert.strictEqual(r.rate.value, 4750);
});

test('a niche can be picked as the topic', () => {
  const r = est.estimateForCreator({ cpm_topic_override: 'skincare', cpm_country_override: 'US' });
  assert.strictEqual(r.cpm.stickers[0].value, 'skincare');
  assert.strictEqual(r.cpm.value, 27.5);
});

test('unknown override values are ignored rather than trusted', () => {
  const r = est.estimateForCreator({ ig_biography: 'London based', cpm_topic_override: 'nope', cpm_country_override: 'ZZ' });
  assert.strictEqual(r.inputs.topic.source, 'none');
  assert.strictEqual(r.cpm.stickers[1].value, 'GB');
});

test('deal CPM: the admin number wins over the estimate', () => {
  const d = est.dealCpmFor({ deal_cpm: '22.40', max_cpm: 10, ...stats(50000) });
  assert.deepStrictEqual(d, { cpm: 22.4, source: 'admin', campaign_max_cpm: 10, above_campaign_max: true });
});

// creator-list has no campaign ceiling: the Estimated CPM stands, and a campaign's max CPM is
// only reported next to it.
test('deal CPM: the estimate is never cut to the campaign max CPM, only flagged above it', () => {
  const row = { cpm_topic_override: 'tech', cpm_country_override: 'US', max_cpm: '30.00', ...stats(50000) };
  assert.deepStrictEqual(est.dealCpmFor(row), { cpm: 47.5, source: 'estimate', estimate: 47.5, campaign_max_cpm: 30, above_campaign_max: true });
  // An explicit campaignMaxCpm (e.g. a just-changed one) beats the row's.
  assert.strictEqual(est.dealCpmFor(row, { campaignMaxCpm: 60 }).above_campaign_max, false);
});

test('deal CPM: with no campaign max CPM the estimate is used as is', () => {
  const row = { cpm_topic_override: 'fitness', cpm_country_override: 'IN', ...stats(50000) };
  assert.deepStrictEqual(est.dealCpmFor({ ...row, max_cpm: null }), { cpm: 6.19, source: 'estimate', estimate: 6.19 });
  assert.strictEqual(est.dealCpmFor({ ...row, max_cpm: 30 }).above_campaign_max, false);
});

test('panel payload: deal rate follows the deal CPM, overrides are echoed back', () => {
  const p = est.panelEstimate({ deal_cpm: 10, cpm_country_override: 'US', ...stats(80000) });
  assert.strictEqual(p.deal.cpm, 10);
  assert.strictEqual(p.deal.rate, 800);
  assert.deepStrictEqual(p.overrides, { deal_cpm: 10, topic: null, country: 'US' });
});

test('selector options list every topic and country', () => {
  assert.ok(est.OPTIONS.topics.length >= 29);
  assert.ok(!est.OPTIONS.topics.some((t) => t.key === 'other'));
  assert.ok(est.OPTIONS.countries.some((c) => c.code === 'IN' && c.name === 'India'));
  assert.ok(est.isTopicKey('fitness') && est.isTopicKey('skincare') && !est.isTopicKey('nope'));
  assert.ok(est.isCountryCode('in') && !est.isCountryCode('ZZ'));
});
