'use strict';

// Referral commission (services/referrals.js). The attribution decision and the
// commission ledger are pure, so every rule — and every conflict between
// creators — is pinned here case by case.

const test = require('node:test');
const assert = require('node:assert');
const referrals = require('./referrals');
const dealTerms = require('./dealTerms');
const contracts = require('./contracts');

const { decideAttribution, computeLedger } = referrals;

const SIGNED = new Date('2026-06-01T00:00:00Z');
const SIGNUP = new Date('2026-09-15T12:00:00Z');
const days = (n) => n * 24 * 3600 * 1000;
const before = (n) => new Date(SIGNUP.getTime() - days(n));

function agreement(creatorId, extra = {}) {
  return {
    creatorId,
    contractId: creatorId * 10,
    contractStatus: 'signed',
    signedAt: SIGNED.toISOString(),
    creatorEmail: `creator${creatorId}@gmail.com`,
    commission: { basis: 'referral', windowDays: 90, termMonths: 12, ...(extra.commission || {}) },
    ...extra,
    ...(extra.commission ? { commission: { basis: 'referral', windowDays: 90, termMonths: 12, ...extra.commission } } : {}),
  };
}

const AGREEMENTS = { MAYA: agreement(1), DEV: agreement(2), LENA: agreement(3) };
const decide = (claims, more = {}) =>
  decideAttribution({
    signup: { signedUpAt: SIGNUP, contactEmail: 'ops@glowlabs.com', ...(more.signup || {}) },
    claims,
    agreements: more.agreements || AGREEMENTS,
    priorReferral: more.priorReferral || null,
    existingCustomer: more.existingCustomer || null,
  });

// ── Single claims ───────────────────────────────────────────────────────────

test('a valid link visit within the window credits the creator', () => {
  const d = decide([{ code: 'MAYA', kind: 'link', at: before(10) }]);
  assert.strictEqual(d.outcome, 'attributed');
  assert.deepStrictEqual(d.winner, { code: 'MAYA', kind: 'link', creatorId: 1, contractId: 10 });
  assert.strictEqual(d.candidates[0].won, true);
  assert.strictEqual(d.contested, false);
});

test('a code entered at sign-up credits the creator', () => {
  const d = decide([{ code: 'DEV', kind: 'entered', at: null }]);
  assert.strictEqual(d.winner.creatorId, 2);
});

test('no claims → unattributed, not an error', () => {
  const d = decide([]);
  assert.strictEqual(d.outcome, 'unattributed');
  assert.strictEqual(d.reason, 'no_claims');
});

test('a link visit with no timestamp is the visit they signed up from', () => {
  assert.strictEqual(decide([{ code: 'MAYA', kind: 'link', at: null }]).outcome, 'attributed');
});

// ── Eligibility ─────────────────────────────────────────────────────────────

const reasonFor = (claim, more) => decide([claim], more).candidates[0].reason;

test('each ineligible claim says why', () => {
  assert.strictEqual(reasonFor({ code: 'NOPE', kind: 'entered' }), 'unknown_code');
  assert.strictEqual(reasonFor({ code: null, kind: 'entered' }), 'unknown_code');
  assert.strictEqual(
    reasonFor({ code: 'MAYA', kind: 'link', at: before(91) }),
    'outside_referral_window',
  );
  assert.strictEqual(
    reasonFor({ code: 'MAYA', kind: 'link', at: new Date(SIGNUP.getTime() + days(1)) }),
    'touch_after_signup',
  );
  const unsigned = { MAYA: agreement(1, { contractStatus: 'pending', signedAt: null }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: unsigned }), 'agreement_not_signed');
  const sales = { MAYA: agreement(1, { commission: { basis: 'sales' } }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: sales }), 'not_a_referral_agreement');
  const lateSigned = { MAYA: agreement(1, { signedAt: '2026-10-01T00:00:00Z' }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: lateSigned }), 'signed_up_before_agreement');
  const shortTerm = { MAYA: agreement(1, { commission: { termMonths: 3 } }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: shortTerm }), 'referral_period_ended');
});

test('the window is measured per creator agreement', () => {
  const wide = { MAYA: agreement(1, { commission: { windowDays: 180 } }) };
  assert.strictEqual(decide([{ code: 'MAYA', kind: 'link', at: before(120) }], { agreements: wide }).outcome, 'attributed');
});

test('an ongoing programme (no term) never expires', () => {
  const ongoing = { MAYA: agreement(1, { commission: { termMonths: null } }) };
  const d = decideAttribution({
    signup: { signedUpAt: new Date('2030-01-01T00:00:00Z'), contactEmail: null },
    claims: [{ code: 'MAYA', kind: 'entered', at: null }],
    agreements: ongoing,
  });
  assert.strictEqual(d.outcome, 'attributed');
});

test('a link visit a few minutes after sign-up (clock skew) still counts', () => {
  assert.strictEqual(decide([{ code: 'MAYA', kind: 'link', at: new Date(SIGNUP.getTime() + 5 * 60000) }]).outcome, 'attributed');
});

test('self-referral: same email, or same company domain, is refused', () => {
  const own = { MAYA: agreement(1, { creatorEmail: 'maya@glowlabs.com' }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: own }), 'self_referral');
  const exact = { MAYA: agreement(1, { creatorEmail: 'OPS@glowlabs.com' }) };
  assert.strictEqual(reasonFor({ code: 'MAYA', kind: 'entered' }, { agreements: exact }), 'self_referral');
  // A shared free-mail domain proves nothing.
  const gmailBrand = { signup: { contactEmail: 'glowlabs@gmail.com' } };
  assert.strictEqual(decide([{ code: 'MAYA', kind: 'entered' }], gmailBrand).outcome, 'attributed');
});

// ── Conflicts between creators ──────────────────────────────────────────────

test('a code entered at sign-up beats a more recent link visit from another creator', () => {
  const d = decide([
    { code: 'MAYA', kind: 'link', at: before(1) },
    { code: 'DEV', kind: 'entered', at: null },
  ]);
  assert.strictEqual(d.winner.code, 'DEV');
  assert.strictEqual(d.contested, true);
  assert.deepStrictEqual(d.candidates.map((c) => [c.code, c.won, c.reason]), [
    ['MAYA', false, 'outranked'],
    ['DEV', true, 'attributed'],
  ]);
});

test('an ineligible entered code falls back to a valid link visit', () => {
  const d = decide([
    { code: 'NOPE', kind: 'entered', at: null },
    { code: 'MAYA', kind: 'link', at: before(5) },
  ]);
  assert.strictEqual(d.winner.code, 'MAYA');
  assert.strictEqual(d.candidates[0].reason, 'unknown_code');
});

test('between link visits, the most recent eligible one wins (last click)', () => {
  const d = decide([
    { code: 'MAYA', kind: 'link', at: before(30) },
    { code: 'DEV', kind: 'link', at: before(3) },
    { code: 'LENA', kind: 'link', at: before(120) }, // outside the window — can't win even though first
  ]);
  assert.strictEqual(d.winner.code, 'DEV');
  assert.strictEqual(d.candidates[2].reason, 'outside_referral_window');
});

test('an out-of-window recent visit does not block an older valid one', () => {
  const tight = { ...AGREEMENTS, DEV: agreement(2, { commission: { windowDays: 1 } }) };
  const d = decide(
    [
      { code: 'MAYA', kind: 'link', at: before(30) },
      { code: 'DEV', kind: 'link', at: before(2) },
    ],
    { agreements: tight },
  );
  assert.strictEqual(d.winner.code, 'MAYA');
});

test('exact ties go to the earlier-signed agreement, then the lower creator id', () => {
  const t = before(4);
  const earlierDev = { ...AGREEMENTS, DEV: agreement(2, { signedAt: '2026-05-01T00:00:00Z' }) };
  assert.strictEqual(
    decide([{ code: 'MAYA', kind: 'link', at: t }, { code: 'DEV', kind: 'link', at: t }], { agreements: earlierDev }).winner.code,
    'DEV',
  );
  assert.strictEqual(
    decide([{ code: 'DEV', kind: 'link', at: t }, { code: 'MAYA', kind: 'link', at: t }]).winner.code,
    'MAYA',
  );
});

test('two visits from the same creator are not a contest', () => {
  const d = decide([
    { code: 'MAYA', kind: 'link', at: before(20) },
    { code: 'MAYA', kind: 'entered', at: null },
  ]);
  assert.strictEqual(d.contested, false);
  assert.strictEqual(d.winner.kind, 'entered');
});

test('the decision is the same whatever order the claims arrive in', () => {
  const claims = [
    { code: 'MAYA', kind: 'link', at: before(30) },
    { code: 'DEV', kind: 'link', at: before(3) },
    { code: 'LENA', kind: 'link', at: before(3) },
  ];
  const a = decide(claims).winner.code;
  const b = decide(claims.slice().reverse()).winner.code;
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'DEV'); // DEV and LENA tie on time; same signing date → lower creator id
});

// ── Brand-level exclusions ──────────────────────────────────────────────────

test('a company that was already referred keeps its first credit', () => {
  const d = decide([{ code: 'DEV', kind: 'entered' }], { priorReferral: { id: 4, creator_id: 1, code: 'MAYA' } });
  assert.strictEqual(d.outcome, 'rejected');
  assert.strictEqual(d.reason, 'brand_already_referred');
  assert.strictEqual(d.winner, null);
  // The claim's own verdict is still recorded for the audit trail.
  assert.strictEqual(d.candidates[0].eligible, true);
});

test('an existing customer is never credited', () => {
  const d = decide([{ code: 'DEV', kind: 'entered' }], { existingCustomer: { source: 'platform' } });
  assert.strictEqual(d.outcome, 'rejected');
  assert.strictEqual(d.reason, 'existing_customer');
});

test('brandKey identifies the company across accounts', () => {
  const k = referrals.brandKey;
  assert.strictEqual(k({ brandDomain: 'https://www.GlowLabs.com/shop' }), 'd:glowlabs.com');
  assert.strictEqual(k({ contactEmail: 'ops@glowlabs.com' }), 'd:glowlabs.com');
  assert.strictEqual(k({ contactEmail: 'glow@gmail.com', brandName: 'Glow Labs, Inc.' }), 'n:glowlabs');
  assert.strictEqual(k({ brandName: 'The Glow Labs LLC' }), 'n:glowlabs');
  assert.strictEqual(k({}), null);
});

// ── Ledger ──────────────────────────────────────────────────────────────────

const COMM = { ratePct: 10, campaignsPerBrand: 2, campaignWindowMonths: 12 };
const after = (n) => new Date(SIGNUP.getTime() + days(n)).toISOString();
const byRef = (rows) => Object.fromEntries(rows.map((r) => [r.campaignRef, r]));

test('ledger: the first N started campaigns earn the rate on paid spend', () => {
  const rows = byRef(computeLedger({
    signedUpAt: SIGNUP,
    commission: COMM,
    campaigns: [
      { campaignRef: 'c3', startedAt: after(90), status: 'active', paidSpend: 9000 },
      { campaignRef: 'c1', startedAt: after(10), status: 'active', paidSpend: 5000 },
      { campaignRef: 'c2', startedAt: after(40), status: 'active', paidSpend: 1234.56 },
    ],
  }));
  assert.deepStrictEqual([rows.c1.rank, rows.c1.commission], [1, 500]);
  assert.deepStrictEqual([rows.c2.rank, rows.c2.commission], [2, 123.46]);
  assert.deepStrictEqual([rows.c3.counted, rows.c3.reason, rows.c3.commission], [false, 'beyond_campaign_limit', 0]);
});

test('ledger: cancelled and not-yet-started campaigns never use up a slot', () => {
  const rows = byRef(computeLedger({
    signedUpAt: SIGNUP,
    commission: COMM,
    campaigns: [
      { campaignRef: 'a', startedAt: after(5), status: 'cancelled', paidSpend: 3000 },
      { campaignRef: 'b', startedAt: null, status: 'active', paidSpend: 0 },
      { campaignRef: 'c', startedAt: after(20), status: 'active', paidSpend: 2000 },
      { campaignRef: 'd', startedAt: after(30), status: 'active', paidSpend: 1000 },
    ],
  }));
  assert.strictEqual(rows.a.reason, 'cancelled');
  assert.strictEqual(rows.b.reason, 'not_started');
  assert.deepStrictEqual([rows.c.rank, rows.d.rank], [1, 2]);
});

test('ledger: campaigns outside the window, or before sign-up, do not count', () => {
  const rows = byRef(computeLedger({
    signedUpAt: SIGNUP,
    commission: COMM,
    campaigns: [
      { campaignRef: 'late', startedAt: after(400), status: 'active', paidSpend: 1000 },
      { campaignRef: 'early', startedAt: before(10).toISOString(), status: 'active', paidSpend: 1000 },
      { campaignRef: 'ok', startedAt: after(1), status: 'active', paidSpend: 1000 },
    ],
  }));
  assert.strictEqual(rows.late.reason, 'outside_campaign_window');
  assert.strictEqual(rows.early.reason, 'started_before_signup');
  assert.strictEqual(rows.ok.rank, 1);
});

test('ledger: a late report of an earlier campaign re-ranks the brand', () => {
  const base = [
    { campaignRef: 'x', startedAt: after(20), status: 'active', paidSpend: 1000 },
    { campaignRef: 'y', startedAt: after(30), status: 'active', paidSpend: 1000 },
  ];
  const later = byRef(computeLedger({
    signedUpAt: SIGNUP,
    commission: COMM,
    campaigns: [...base, { campaignRef: 'w', startedAt: after(10), status: 'active', paidSpend: 1000 }],
  }));
  assert.deepStrictEqual([later.w.rank, later.x.rank, later.y.reason], [1, 2, 'beyond_campaign_limit']);
});

test('ledger: a refund lowers the commission; nothing counts for an uncredited brand', () => {
  const rows = computeLedger({
    signedUpAt: SIGNUP, commission: COMM,
    campaigns: [{ campaignRef: 'r', startedAt: after(3), status: 'active', paidSpend: -50 }],
  });
  assert.strictEqual(rows[0].commission, 0);
  const none = computeLedger({
    signedUpAt: SIGNUP, commission: null,
    campaigns: [{ campaignRef: 'r', startedAt: after(3), status: 'active', paidSpend: 500 }],
  });
  assert.deepStrictEqual([none[0].counted, none[0].reason], [false, 'not_attributed']);
});

// ── Terms + contract wording ────────────────────────────────────────────────

test('referral terms normalise with their own defaults; sales terms are unchanged', () => {
  const t = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 10, attribution: 'link' } });
  assert.deepStrictEqual(t.commission, {
    rate_pct: 10, attribution: 'link', promo_code: null, cookie_days: 90, term_months: 12, payout_net_days: 30,
    basis: 'referral', campaigns_per_brand: 2, campaign_window_months: 12,
  });
  const sales = dealTerms.normalizeTerms({ model: 'commission', commission: { rate_pct: 10 } });
  assert.strictEqual('basis' in sales.commission, false);
  assert.throws(
    () => dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 10, campaigns_per_brand: 0 } }),
    /Campaigns per referred brand/,
  );
  // A referral code survives link-only tracking (the link is built from it).
  const linkOnly = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 5, attribution: 'link', promo_code: 'maya' } });
  assert.strictEqual(linkOnly.commission.promo_code, 'MAYA');
});

test('the contract carries the referral clause, link and rules once the code is set', () => {
  const terms = dealTerms.normalizeTerms({ model: 'hybrid', fee: 500, commission: { basis: 'referral', rate_pct: 10 } });
  const data = contracts.baseContractData({ full_name: 'Maya', usage_rights_policy: 'no_rights' }, 500, { offer_type: 'video_based', num_videos: 1 }, terms);
  assert.strictEqual(data.commission.basis, 'referral');
  assert.strictEqual(data.commission.campaignsPerBrand, 2);
  referrals.applyReferralCode(data, terms, 'MAYA');
  assert.strictEqual(data.commission.referralCode, 'MAYA');
  assert.match(data.commission.referralUrl, /\/r\/MAYA$/);
  assert.match(data.commission.summary, /The creator earns 10% of the campaign spend of every new brand/);
  assert.match(data.commission.summary, /referral code MAYA/);
  assert.match(data.commission.summary, /first 2 campaigns/);
  assert.match(data.commission.tracking, /\/r\/MAYA/);
  assert.match(data.commission.rules, /credited to one creator only/);
  assert.match(data.commission.rules, /valid referral code entered at sign-up takes precedence/);
  assert.strictEqual(dealTerms.describeTerms(terms), '$500 + 10% referral commission');
});

test('suggestedCode: typed code first, else the handle, else a stable fallback', () => {
  const t = (code) => ({ commission: { promo_code: code } });
  assert.strictEqual(referrals.suggestedCode({ id: 1, instagram_username: 'maya.makes_' }, t('glow10')), 'GLOW10');
  assert.strictEqual(referrals.suggestedCode({ id: 1, instagram_username: 'maya.makes_' }, t(null)), 'MAYAMAKES');
  assert.strictEqual(referrals.suggestedCode({ id: 7 }, t(null)), 'REF7');
});

test('chooseCode: a typed code another creator holds is refused; an auto code takes a suffix', async () => {
  const held = new Set(['MAYA', 'MAYAMAKES']);
  const q = async (_sql, [code]) => ({ rows: held.has(code) ? [{ creator_id: 99 }] : [] });
  await assert.rejects(
    referrals.chooseCode(q, { id: 1, instagram_username: 'x' }, { commission: { promo_code: 'maya' } }),
    (e) => e.status === 409 && /MAYA is already taken/.test(e.message),
  );
  assert.strictEqual(
    await referrals.chooseCode(q, { id: 1, instagram_username: 'mayamakes' }, { commission: {} }),
    'MAYAMAKES2',
  );
});

test('an unattributed brand names the reason when every claim failed the same way', () => {
  const own = { MAYA: agreement(1, { creatorEmail: 'maya@glowlabs.com' }) };
  assert.strictEqual(decide([{ code: 'MAYA', kind: 'entered' }], { agreements: own }).reason, 'self_referral');
  assert.strictEqual(
    decide([{ code: 'NOPE', kind: 'entered' }, { code: 'MAYA', kind: 'link', at: before(200) }]).reason,
    'no_eligible_claims',
  );
});

test('a code left blank stays off the contract: no code, no link, just the plain sentence', () => {
  const terms = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 10 } });
  const data = contracts.baseContractData({ full_name: 'Maya', usage_rights_policy: 'no_rights' }, null, { offer_type: 'video_based', num_videos: 1 }, terms);
  referrals.applyReferralCode(data, terms, 'MAYAMAKES', { shown: referrals.isTypedCode(terms, 'MAYAMAKES') });
  const c = data.commission;
  assert.strictEqual(c.codeOnContract, false);
  assert.strictEqual(c.tracking, "Brands are credited when they sign up through the creator's referral link.");
  assert.strictEqual(c.promoCode, null);
  // Stored for Deal Studio's "Copy link", but never in the contract's wording.
  assert.strictEqual(c.referralCode, 'MAYAMAKES');
  assert.match(c.referralUrl, /\/r\/MAYAMAKES$/);
  for (const text of [c.summary, c.tracking, c.rules, c.reporting, c.returns, data.paymentTerms]) {
    assert.doesNotMatch(text, /MAYAMAKES|\/r\//);
  }
  assert.match(c.summary, /through the creator's referral link, on that brand's first 2 campaigns/);
});

test('code-only tracking with no code on the contract names the code without a value', () => {
  const terms = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 10, attribution: 'code' } });
  const data = contracts.baseContractData({}, null, { offer_type: 'video_based', num_videos: 1 }, terms);
  referrals.applyReferralCode(data, terms, 'REF9', { shown: false });
  assert.strictEqual(data.commission.tracking, "Brands are credited when they enter the creator's referral code at sign-up.");
  assert.doesNotMatch(data.commission.summary, /REF9/);
});

test('a typed code is named on the contract; isTypedCode tells them apart', () => {
  const terms = dealTerms.normalizeTerms({ model: 'commission', commission: { basis: 'referral', rate_pct: 10, promo_code: 'maya' } });
  assert.strictEqual(referrals.isTypedCode(terms, 'MAYA'), true);
  assert.strictEqual(referrals.isTypedCode(terms, 'MAYA2'), false); // a clash fell back to another code
  const data = contracts.baseContractData({}, null, { offer_type: 'video_based', num_videos: 1 }, terms);
  referrals.applyReferralCode(data, terms, 'MAYA', { shown: true });
  assert.strictEqual(data.commission.codeOnContract, true);
  assert.match(data.commission.tracking, /\/r\/MAYA\) or enter the creator's referral code MAYA/);
});

test('termsFromContractData rebuilds the terms a stored contract was written from', () => {
  const terms = dealTerms.normalizeTerms({
    model: 'hybrid', fee: 800,
    commission: { basis: 'referral', rate_pct: 12.5, attribution: 'code', cookie_days: 60, term_months: null, campaigns_per_brand: 3, campaign_window_months: 6 },
  });
  const data = contracts.baseContractData({}, 800, { offer_type: 'video_based', num_videos: 1 }, terms);
  const back = referrals.termsFromContractData(data);
  assert.deepStrictEqual(back, { ...terms, commission: { ...terms.commission, promo_code: null } });
});
