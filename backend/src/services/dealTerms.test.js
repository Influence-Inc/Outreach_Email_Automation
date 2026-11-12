'use strict';

// Run with: npm test  (node --test)
//
// Deal terms: how a deal pays the creator (flat fee / commission / fee +
// commission / product). Validation is what stands between a typo in the
// composer and a contract, so the edges are covered here.
const test = require('node:test');
const assert = require('node:assert');
const dt = require('./dealTerms');

test('"no terms" is a plain reply', () => {
  assert.strictEqual(dt.normalizeTerms(null), null);
  assert.strictEqual(dt.normalizeTerms({ model: 'none' }), null);
  assert.strictEqual(dt.normalizeTerms(''), null);
});

test('flat fee', () => {
  assert.deepStrictEqual(dt.normalizeTerms({ model: 'flat', fee: '4500.4' }), {
    model: 'flat', fee: 4500, commission: null, product: null,
  });
  assert.throws(() => dt.normalizeTerms({ model: 'flat' }), /Enter the fee/);
  assert.throws(() => dt.normalizeTerms({ model: 'flat', fee: -1 }), (e) => e.status === 400);
});

test('commission only: defaults filled, no fee, link attribution drops any code', () => {
  const t = dt.normalizeTerms({ model: 'commission', fee: 999, commission: { rate_pct: '15', promo_code: 'x1' } });
  assert.strictEqual(t.fee, null, 'a commission deal never carries a fee, even if one was sent');
  assert.deepStrictEqual(t.commission, {
    rate_pct: 15, attribution: 'link', promo_code: null, cookie_days: 30, term_months: 6, payout_net_days: 30,
  });
  assert.strictEqual(dt.describeTerms(t), '15% commission');
  assert.match(dt.termsSummary(t), /^Commission only \(no upfront fee\): 15% commission on net sales/);
});

test('hybrid needs both a fee and a rate; codes are upper-cased and validated', () => {
  const t = dt.normalizeTerms({
    model: 'hybrid', fee: 500,
    commission: { rate_pct: 12.5, attribution: 'link_and_code', promo_code: 'sam15', cookie_days: 14, term_months: null },
  });
  assert.strictEqual(t.commission.promo_code, 'SAM15');
  assert.strictEqual(t.commission.term_months, null, 'explicit null = ongoing');
  assert.strictEqual(dt.describeTerms(t), '$500 + 12.5% commission');
  assert.match(dt.commissionSentence(t), /tracked link or promo code SAM15 within 14 days/);
  assert.match(dt.commissionSentence(t), /until either party ends it in writing/);
  assert.throws(() => dt.normalizeTerms({ model: 'hybrid', commission: { rate_pct: 10 } }), /upfront fee/);
  assert.throws(() => dt.normalizeTerms({ model: 'commission', commission: { rate_pct: 0 } }), /commission rate/);
  assert.throws(() => dt.normalizeTerms({ model: 'commission', commission: { rate_pct: 101 } }), /commission rate/);
  assert.throws(
    () => dt.normalizeTerms({ model: 'commission', commission: { rate_pct: 10, attribution: 'code', promo_code: 'no spaces!' } }),
    /Promo codes/,
  );
  assert.throws(() => dt.normalizeTerms({ model: 'commission', commission: { rate_pct: 10, cookie_days: 0 } }), /window/);
});

test('product only', () => {
  const t = dt.normalizeTerms({ model: 'product', product: '  Full   skincare set ' });
  assert.deepStrictEqual(t, { model: 'product', fee: null, commission: null, product: 'Full skincare set' });
  assert.strictEqual(dt.describeTerms(t), 'Product only');
  assert.throws(() => dt.normalizeTerms({ model: 'product' }), /Describe the product/);
});

test('unknown models are refused', () => {
  assert.throws(() => dt.normalizeTerms({ model: 'barter' }), /Unknown pay model/);
});

test('legacy offers read as flat; composed offers carry their own terms', () => {
  assert.deepStrictEqual(dt.termsFromOffer({ offer_type: 'video_based', flat_fee: 3000 }), {
    model: 'flat', fee: 3000, commission: null, product: null,
  });
  const terms = dt.normalizeTerms({ model: 'commission', commission: { rate_pct: 20 } });
  assert.strictEqual(dt.termsFromOffer({ offer_type: 'composed', terms }), terms);
  assert.strictEqual(dt.termsFromOffer({ offer_type: 'view_based' }), null);
  assert.strictEqual(dt.termsFromDetail({ fee: 3000 }), null, 'a plain fee event carries no terms');
});
