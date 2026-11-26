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
  assert.strictEqual(patch.commission.summary, '15% of net sales on every order placed with promo code DEV15, for 6 months from signing. No cap on earnings.');
  assert.strictEqual(patch.paymentTerms, "Paid monthly to the creator's bank account, within 30 days of each month's end, with the brand's sales report.");
  // The numbers and the code are the stored ones.
  for (const k of ['ratePct', 'attribution', 'promoCode', 'cookieDays', 'termMonths', 'payoutNetDays']) {
    assert.strictEqual(patch.commission[k], data.commission[k], k);
  }
  const rows = rowsOf({ ...data, ...patch });
  assert.strictEqual(rows.Compensation, '15% sales commission');
  assert.strictEqual(rows['Usage rights'], 'Retained by the creator');
  assert.strictEqual(rows.Tracking, undefined, 'tracking is part of the Commission row');
  assert.strictEqual(rows.Reporting, undefined, 'reporting is part of the Payment terms row');
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
  assert.strictEqual(c.summary, "8% of the total campaign budget of each new brand the creator refers to INFLUENCE, on the brand's first 2 campaigns started within 12 months of its sign-up. No limit on how many brands the creator refers.");
  assert.doesNotMatch(c.summary, /campaign spend/);
  assert.strictEqual(c.returns, 'Commission is on budget the brand has paid, before tax. Budget later refunded or cancelled is deducted from the next payout.');
  assert.doesNotMatch(c.summary, /MAYA/);
  assert.strictEqual(c.tracking, "Brands that sign up through the creator's referral link in the 12 months after this agreement is signed. The sign-up must be within 90 days of using the link.");
  assert.strictEqual(c.reporting, null);
  assert.match(c.rules, /^Each brand is credited to one creator, permanently\./);
  assert.match(c.rules, /Not eligible: existing INFLUENCE customers, companies already referred under any account, and businesses the creator owns or works for\.$/);
  assert.strictEqual(patch.paymentTerms, "Paid monthly to the creator's bank account, within 30 days of each month's end, with INFLUENCE's billing records for each referred brand.");
});

test('referral wording: v2 says "campaign spend"; a v2 contract still unsigned moves to the current wording', () => {
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
  assert.match(patch.commission.summary, /^8% of the total campaign budget of each new brand/);
  assert.match(patch.commission.returns, /^Commission is on budget the brand has paid, before tax\./);
});

test('currentWordingPatch: flat, product and already-current contracts', () => {
  const flat = contracts.currentWordingPatch({ compensationModel: 'flat', compensation: 900, paymentTermsDays: 7, upfrontPercent: 30, remainderPercent: 70 });
  assert.strictEqual(flat.paymentTerms, 'Bank transfer within 7 working days of each payment milestone.');
  const product = contracts.currentWordingPatch({ compensationModel: 'product', productDescription: 'Kit' });
  assert.strictEqual(product.paymentTerms, 'Shipped to the creator before content production begins.');
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
  const v2no = rowsOf({ copyVersion: 2, paidAdsIncluded: false });
  assert.strictEqual(v2no['Usage rights'], 'Retained by the creator');
  assert.strictEqual(v2no['Paid ads'], "The creator's content stays organic — it won't run as paid ads");
  const v2yes = rowsOf({ copyVersion: 3, paidAdsIncluded: true });
  assert.strictEqual(v2yes['Usage rights'], "Included — the brand can feature the creator's content in its marketing");
  assert.strictEqual(v2yes['Paid ads'], "Included — the brand can boost the creator's content with paid ads");
  const no = rowsOf({ copyVersion: V, paidAdsIncluded: false });
  assert.strictEqual(no['Usage rights'], 'Retained by the creator');
  assert.strictEqual(no['Paid ads'], 'Not allowed — the content stays organic');
  const yes = rowsOf({ copyVersion: V, paidAdsIncluded: true });
  assert.strictEqual(yes['Usage rights'], 'The brand may use the content in its marketing');
  assert.strictEqual(yes['Paid ads'], 'The brand may run the content as paid ads');
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
  assert.match(current.commission.summary, /^10% of the total campaign budget/);
  assert.match(current.commission.tracking, /\/r\/OMAR2\) or enter referral code OMAR2 at sign-up/);
  assert.match(current.commission.rules, /^Each brand is credited to one creator, permanently/);

  // A signed v3 contract keeps v3's words through a code change too.
  const v3 = { ...data, copyVersion: 3, commission: { ...data.commission } };
  referrals.applyReferralCode(v3, terms, 'OMAR3', { shown: true });
  assert.strictEqual(v3.copyVersion, 3);
  assert.match(v3.commission.summary, /^The creator earns 10% of the total campaign budget of every new brand/);
  assert.match(v3.commission.rules, /^Once a brand is credited to the creator/);
});

// ── The short wording (v4) ─────────────────────────────────────────────────

test('short wording: the referral pay section states each term once', () => {
  const referrals = require('./referrals');
  const terms = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 5, cookie_days: 180, payout_net_days: 14 } });
  const data = { currency: 'USD', ...contracts.termsContractFields(terms) };
  referrals.applyReferralCode(data, terms, 'MAYA', { shown: false });
  const pay = contractSections(data).find((s) => s.title === 'Compensation & Payment');
  assert.deepStrictEqual(pay.rows.map((r) => [r.label, r.value]), [
    ['Compensation', '5% referral commission'],
    ['Referral commission', "5% of the total campaign budget of each new brand the creator refers to INFLUENCE, on the brand's first 2 campaigns started within 12 months of its sign-up. No limit on how many brands the creator refers."],
    ['Who counts', "Brands that sign up through the creator's referral link in the 12 months after this agreement is signed. The sign-up must be within 180 days of using the link."],
    ['Referral rules', 'Each brand is credited to one creator, permanently. If more than one creator could claim a brand, a code entered at sign-up beats a link; otherwise the most recent link used wins. Not eligible: existing INFLUENCE customers, companies already referred under any account, and businesses the creator owns or works for.'],
    ['Refunds', 'Commission is on budget the brand has paid, before tax. Budget later refunded or cancelled is deducted from the next payout.'],
    ['Currency', 'USD'],
    ['Payment terms', "Paid monthly to the creator's bank account, within 14 days of each month's end, with INFLUENCE's billing records for each referred brand."],
  ]);
  // Each fact once: when it's paid, the limit on brands, the 12-month windows.
  const all = pay.rows.map((r) => r.value).join(' ');
  assert.strictEqual(all.match(/each month's end/g).length, 1);
  assert.strictEqual(all.match(/[Nn]o limit/g).length, 1);
});

test('short wording: every way a referral brand comes in', () => {
  const referrals = require('./referrals');
  const texts = (commission, url) => referrals.referralContractTexts(dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 5, ...commission } }).commission, url);
  assert.strictEqual(texts({ attribution: 'code', promo_code: 'OMAR' }).tracking, 'Brands that enter referral code OMAR at sign-up in the 12 months after this agreement is signed.');
  assert.strictEqual(
    texts({ attribution: 'link_and_code', promo_code: 'OMAR', term_months: null }, 'https://x/r/OMAR').tracking,
    "Brands that sign up through the creator's referral link (https://x/r/OMAR) or enter referral code OMAR at sign-up, while this agreement is in force. A link sign-up must be within 90 days of using the link.",
  );
  assert.match(texts({ attribution: 'link', term_months: 1 }).tracking, /in the 1 month after this agreement is signed\. The sign-up must be within 90 days/);
});

test('short wording: a sales commission names its orders by how they are tracked', () => {
  const s = (commission) => dealTerms.commissionSentence(dealTerms.normalizeTerms({ model: 'commission', commission: { rate_pct: 10, ...commission } }));
  assert.strictEqual(s({ attribution: 'link' }), "10% of net sales on every order placed within 30 days of a click on the creator's tracked link, for 6 months from signing. No cap on earnings.");
  assert.strictEqual(s({ attribution: 'code' }), "10% of net sales on every order placed with the creator's personal promo code, for 6 months from signing. No cap on earnings.");
  assert.strictEqual(s({ attribution: 'link_and_code', promo_code: 'KAI', term_months: null, cookie_days: 1 }), "10% of net sales on every order placed with promo code KAI or within 1 day of a click on the creator's tracked link, until either party ends this agreement in writing. No cap on earnings.");
});

test('short wording: flat, bonus, view-based, product and hybrid rows', () => {
  const view = rowsOf({ copyVersion: V, offerType: 'view_based', minTotalViews: 750000, viewCountingDays: 14, compensation: 3000, currency: 'USD', paymentTermsDays: 7, postLiveMonths: 6, exclusivity: 'None' });
  assert.strictEqual(view['Guaranteed total views'], "750,000, combined across all the creator's Instagram posts");
  assert.strictEqual(view['Posting commitment'], "The creator keeps posting short-form videos on Instagram until combined views reach 750,000. Each post's views count for 14 days after it goes live.");
  assert.strictEqual(view['View counting window'], undefined, 'the window is part of the posting commitment');
  assert.strictEqual(view['Payment terms'], 'Bank transfer within 7 working days of posting all agreed deliverables.');
  assert.strictEqual(view['Posts remain live for'], '6 months from posting');
  assert.strictEqual(view.Exclusivity, 'None — the creator can work with any brand');

  const bonus = rowsOf({ copyVersion: V, compensation: 1000, bonusAmount: 500, bonusThresholdViews: 100000, viewCountingDays: 30, currency: 'USD', upfrontPercent: 30, remainderPercent: 70 });
  assert.strictEqual(bonus['Performance bonus'], "$500 more if total views reach 100,000. Each post's views count for 30 days after it goes live.");
  assert.strictEqual(bonus['Payment terms'], 'Bank transfer within 7 working days of each payment milestone.');

  const product = rowsOf({ ...contracts.termsContractFields(dealTerms.normalizeTerms({ model: 'product', product: 'Kit' })), currency: 'USD' });
  assert.strictEqual(product.Delivery, 'Shipped to the creator before content production begins.');
  assert.strictEqual(product['Payment terms'], undefined);

  const referral = dealTerms.normalizeTerms({ model: 'hybrid', fee: 300, commission: { basis: 'referral', rate_pct: 8 } });
  const hybrid = rowsOf({ currency: 'USD', ...contracts.termsContractFields(referral) });
  assert.strictEqual(hybrid['Upfront fee'], '$300');
  assert.strictEqual(hybrid['Commission payment'], "Paid monthly to the creator's bank account, within 30 days of each month's end, with INFLUENCE's billing records for each referred brand.");
});

test('short wording: the standard open / no-deliverables lines of an unsigned contract move too; typed ones stay', () => {
  const none = contracts.currentWordingPatch({ copyVersion: 3, compensationModel: 'product', productDescription: 'Kit', deliverablesMode: 'none',
    deliverables: 'None — this agreement asks for no content. The creator earns commission on the sales they drive alone.' });
  assert.strictEqual(none.deliverables, 'None — no content is required.');
  const open = contracts.currentWordingPatch({ copyVersion: 3, compensationModel: 'product', productDescription: 'Kit', deliverablesMode: 'open',
    deliverables: 'Open-ended — the creator promotes Reve in their own content, in whatever format suits them.',
    postingCommitment: 'There is no minimum number of posts and no posting deadline — the creator posts as often as they choose.' });
  assert.strictEqual(open.deliverables, 'Open-ended — the creator promotes Reve in their own content, in any format.');
  assert.strictEqual(open.postingCommitment, 'No minimum number of posts and no deadline.');
  const typed = contracts.currentWordingPatch({ copyVersion: 3, compensationModel: 'product', productDescription: 'Kit', deliverablesMode: 'open',
    deliverables: 'Referral link in bio, plus stories when it fits', postingCommitment: 'There is no minimum number of posts and no posting deadline — the creator posts as often as they choose.' });
  assert.strictEqual(typed.deliverables, undefined);
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
