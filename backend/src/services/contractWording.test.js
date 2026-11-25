'use strict';

// Contract wording versions: unsigned contracts move to the current wording,
// signed contracts keep the words that were signed.

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const contracts = require('./contracts');
const { contractSections } = require('./contractTerms');
const dealTerms = require('./dealTerms');

const V = dealTerms.CONTRACT_COPY_VERSION;

// A commission contract as stored before the current wording (no copyVersion).
const oldSales = () => ({
  compensationModel: 'commission',
  currency: 'USD',
  compensation: null,
  paidAdsIncluded: false,
  commission: {
    ratePct: 15, attribution: 'code', promoCode: 'DEV15', cookieDays: 30, termMonths: 6, payoutNetDays: 30,
    summary: "15% commission on net sales (excluding taxes, shipping, refunds and returns) attributed to the creator's promo code DEV15 within 30 days of a click or code use, paid monthly within 30 days of each month's end against the brand's sales report, for 6 months from signing.",
  },
  paymentTerms: "Commission is paid by direct bank transfer, monthly, within 30 days of each month's end",
});

const rowsOf = (data) => {
  const out = {};
  for (const s of contractSections(data)) for (const r of s.rows || []) out[r.label] = r.value;
  return out;
};

test('currentWordingPatch: a sales-commission contract is re-worded with every term unchanged', () => {
  const data = oldSales();
  const patch = contracts.currentWordingPatch(data);
  assert.strictEqual(patch.copyVersion, V);
  assert.match(patch.commission.summary, /^The creator earns 15% of net sales on every order placed through the creator's promo code DEV15, up to 30 days after a click or code use, for 6 months from signing/);
  assert.strictEqual(patch.paymentTerms, "Commission is paid to the creator's bank account every month, within 30 days of each month's end.");
  // The numbers and the code are the stored ones.
  for (const k of ['ratePct', 'attribution', 'promoCode', 'cookieDays', 'termMonths', 'payoutNetDays']) {
    assert.strictEqual(patch.commission[k], data.commission[k], k);
  }
  const rows = rowsOf({ ...data, ...patch });
  assert.strictEqual(rows.Compensation, 'Uncapped commission');
  assert.strictEqual(rows['Usage rights'], 'Retained by the creator');
});

test('currentWordingPatch: a referral contract keeps its code and whether the code is shown', () => {
  const data = {
    compensationModel: 'commission',
    currency: 'USD',
    commission: {
      basis: 'referral', ratePct: 8, attribution: 'link_and_code', cookieDays: 90, termMonths: 12, payoutNetDays: 30,
      campaignsPerBrand: 2, campaignWindowMonths: 12,
      referralCode: 'MAYA', referralUrl: 'http://localhost/r/MAYA', promoCode: null, codeOnContract: false,
      summary: 'old', tracking: "Brands are credited when they sign up through the creator's referral link.", reporting: 'old', returns: 'old', rules: 'old',
    },
  };
  const patch = contracts.currentWordingPatch(data);
  const c = patch.commission;
  assert.strictEqual(c.referralCode, 'MAYA');
  assert.strictEqual(c.promoCode, null);
  assert.match(c.summary, /^The creator earns 8% of the total campaign budget of every new brand/);
  assert.match(c.summary, /on the total campaign budget the brand has paid\.$/);
  assert.doesNotMatch(c.summary, /campaign spend/);
  assert.match(c.returns, /^The creator earns on the total campaign budget before tax\./);
  assert.doesNotMatch(c.summary, /MAYA/);
  assert.strictEqual(c.tracking, "Brands are credited when they sign up through the creator's referral link.");
  assert.match(c.reporting, /^Each payout comes with/);
  assert.match(c.rules, /^Once a brand is credited to the creator/);
});

test('referral wording: v2 says "campaign spend"; a v2 contract still unsigned moves to "total campaign budget"', () => {
  const referrals = require('./referrals');
  const terms = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 8 } });
  assert.match(dealTerms.commissionSentence(terms, { version: 2 }), /8% of the campaign spend of every new brand/);
  assert.match(referrals.referralContractTexts(terms.commission, null, { version: 2 }).returns, /^The creator earns on campaign spend before tax/);

  const v2 = {
    compensationModel: 'commission',
    currency: 'USD',
    copyVersion: 2,
    commission: {
      basis: 'referral', ratePct: 8, attribution: 'link', cookieDays: 90, termMonths: 12, payoutNetDays: 30,
      campaignsPerBrand: 2, campaignWindowMonths: 12, summary: 'v2', returns: 'v2',
    },
  };
  const patch = contracts.currentWordingPatch(v2);
  assert.strictEqual(patch.copyVersion, V);
  assert.match(patch.commission.summary, /8% of the total campaign budget of every new brand/);
  assert.match(patch.paymentTerms, /on the total campaign budget the brand has paid\.$/);
});

test('currentWordingPatch: flat, product and already-current contracts', () => {
  const flat = contracts.currentWordingPatch({ compensationModel: 'flat', compensation: 900, paymentTermsDays: 7, upfrontPercent: 30, remainderPercent: 70 });
  assert.strictEqual(flat.paymentTerms, 'Payment is sent by direct bank transfer within 7 working days of each payment milestone.');
  const product = contracts.currentWordingPatch({ compensationModel: 'product', productDescription: 'Kit' });
  assert.strictEqual(product.paymentTerms, 'The product ships to the creator before content production begins.');
  assert.strictEqual(contracts.currentWordingPatch({ compensationModel: 'flat', copyVersion: V }), null);
  // Terms that can't be read back keep the original wording whole.
  assert.strictEqual(contracts.currentWordingPatch({ compensationModel: 'commission', commission: { ratePct: 0 } }), null);
});

test('updateUnsignedContractWording: only unsigned contracts are re-worded, and only if still unsigned', async () => {
  const origMany = db.many;
  const origQuery = db.query;
  const seen = [];
  db.many = async (sql) => {
    assert.match(sql, /status = 'pending' AND signed_at IS NULL/);
    return [{ id: 1, data: oldSales() }, { id: 2, data: { compensationModel: 'flat', copyVersion: V } }];
  };
  db.query = async (sql, params) => {
    assert.match(sql, /WHERE id = \$1 AND status = 'pending' AND signed_at IS NULL/);
    seen.push({ id: params[0], patch: JSON.parse(params[1]) });
    return { rowCount: 1 };
  };
  try {
    const r = await contracts.updateUnsignedContractWording();
    assert.deepStrictEqual(r, { checked: 2, updated: 1 });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 1);
    assert.strictEqual(seen[0].patch.copyVersion, V);
  } finally {
    db.many = origMany;
    db.query = origQuery;
  }
});

test('usage rights rows: same grant, said from the creator\'s side', () => {
  const v1 = rowsOf({ paidAdsIncluded: false });
  assert.strictEqual(v1['Usage rights'], 'Not included');
  assert.strictEqual(v1['Paid ads'], 'Not included');
  const no = rowsOf({ copyVersion: V, paidAdsIncluded: false });
  assert.strictEqual(no['Usage rights'], 'Retained by the creator');
  assert.strictEqual(no['Paid ads'], "The creator's content stays organic — it won't run as paid ads");
  const yes = rowsOf({ copyVersion: V, paidAdsIncluded: true });
  assert.strictEqual(yes['Usage rights'], "Included — the brand can feature the creator's content in its marketing");
  assert.strictEqual(yes['Paid ads'], "Included — the brand can boost the creator's content with paid ads");
});

test('a new referral code on a signed, original-wording contract changes the code and nothing else', () => {
  const referrals = require('./referrals');
  const data = {
    compensationModel: 'commission',
    currency: 'USD',
    commission: {
      basis: 'referral', ratePct: 10, attribution: 'link_and_code', cookieDays: 90, termMonths: 12, payoutNetDays: 30,
      campaignsPerBrand: 2, campaignWindowMonths: 12, referralCode: 'OMARBUILDS', promoCode: 'OMARBUILDS', codeOnContract: true,
    },
  };
  const terms = referrals.termsFromContractData(data);
  referrals.applyReferralCode(data, terms, 'OMAR', { shown: true });
  assert.strictEqual(data.copyVersion, undefined);
  assert.match(data.commission.summary, /^10% of the campaign spend of each new brand .* referral code OMAR entered at sign-up/);
  assert.match(data.commission.reporting, /^Commission is calculated from/);
  assert.match(data.commission.rules, /^Each referred brand is credited to one creator only/);
  assert.match(data.commission.tracking, /\/r\/OMAR\) or enter the creator's referral code OMAR at sign-up/);
  assert.strictEqual(rowsOf(data).Compensation, 'Commission only — no upfront fee');

  // A contract in the current wording keeps it.
  const current = { ...data, copyVersion: V, commission: { ...data.commission } };
  referrals.applyReferralCode(current, terms, 'OMAR2', { shown: true });
  assert.strictEqual(current.copyVersion, V);
  assert.match(current.commission.summary, /^The creator earns 10%/);
  assert.match(current.commission.rules, /^Once a brand is credited to the creator/);
});

test('Deals column deadline: a typed date reads the way a generated contract does', () => {
  const f = contracts.formatDeadlineInput;
  assert.strictEqual(f('2027-01-15'), 'Friday, January 15, 2027');
  assert.strictEqual(f('Jan 15 2027'), 'Friday, January 15, 2027');
  assert.strictEqual(f('15 January 2027'), 'Friday, January 15, 2027');
  assert.strictEqual(f('Monday, January 15, 2027'), 'Friday, January 15, 2027'); // the weekday is recomputed
  assert.strictEqual(f('Sept 3, 2027'), 'Friday, September 3, 2027');
  // Not a full, unambiguous date: kept as typed.
  assert.strictEqual(f('end of March'), 'end of March');
  assert.strictEqual(f('February 30, 2027'), 'February 30, 2027');
  assert.strictEqual(f('12/01/2027'), '12/01/2027');
  const patch = contracts.coerceContractPatch({ postingDeadline: '2027-01-15' });
  assert.strictEqual(patch.postingDeadline, 'Friday, January 15, 2027');
  assert.strictEqual(patch.deadline, 'Friday, January 15, 2027');
  assert.strictEqual(contracts.coerceContractPatch({ postingDeadline: '' }).postingDeadline, null);
});
