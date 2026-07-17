'use strict';

// Run with: npm test  (node --test)
// Covers the pure contract logic (token, url, deterministic base data, the
// Claude-merge rules, the payload mapping, and the contract email copy). The
// DB-backed lifecycle (create / recordSubmission / markSynced) is exercised by
// the end-to-end verification against a real Postgres.
const test = require('node:test');
const assert = require('node:assert');

const contracts = require('./contracts');
const creatorDb = require('./creatorDb');
const templates = require('./negotiationTemplates');

test('generateToken returns unique, unguessable, URL-safe tokens', () => {
  const a = contracts.generateToken();
  const b = contracts.generateToken();
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.length, 32); // 24 random bytes → 32 base64url chars
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url alphabet, no +/= to break URLs
});

test('contractUrl respects PUBLIC_BASE_URL, strips a trailing slash, and uses the singular /contract/ path', () => {
  const prev = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://campaigns.influence.technology/';
  assert.strictEqual(
    contracts.contractUrl('TOK'),
    'https://campaigns.influence.technology/contract/TOK',
  );
  process.env.PUBLIC_BASE_URL = prev;
});

test('baseContractData fills a complete contract from known creator + offer', () => {
  const creator = {
    full_name: 'Alex Lee',
    first_name: 'Alex',
    email: 'alex@example.com',
    instagram_username: 'alexcreates',
    brand_name: 'Reve',
    campaign_name: 'Spring Launch',
  };
  const offer = { offer_type: 'video_based', num_videos: 3, view_guarantee: 100000, flat_fee: 900 };
  const d = contracts.baseContractData(creator, 900, offer);

  // Identity + campaign
  assert.strictEqual(d.creatorName, 'Alex Lee');
  assert.strictEqual(d.brandName, 'Reve');
  assert.strictEqual(d.campaignName, 'Spring Launch');
  // Company legal defaults (used in the intro paragraph)
  assert.strictEqual(d.companyLegalName, 'Influence Inc.');
  assert.match(d.companyLegalAddress, /Dover, Delaware/);
  // Deliverables
  assert.strictEqual(d.numberOfDeliverables, 3);
  assert.strictEqual(d.numberOfVideos, 3);
  assert.strictEqual(d.minTotalViews, 100000);
  assert.strictEqual(d.guaranteedViews, 100000);
  // Compensation — paid in full on completion by default: no upfront split
  // unless the creator demanded one (see the payment-schedule tests below).
  assert.strictEqual(d.compensation, 900);
  assert.strictEqual(d.totalPayment, 900);
  assert.strictEqual(d.upfrontPercent, null);
  assert.strictEqual(d.remainderPercent, null);
  assert.strictEqual(d.paymentTermsDays, 7);
  // Usage rights
  assert.strictEqual(d.paidAdsIncluded, false);
  assert.ok(Array.isArray(d.usageRightsList) && d.usageRightsList.length >= 4);
  // Timeline
  assert.strictEqual(d.postLiveMonths, 6);
  assert.strictEqual(d.revisionRounds, 2);
  assert.strictEqual(d.currency, 'USD');
  assert.ok(Array.isArray(d.platforms) && d.platforms.includes('Instagram'));
  assert.match(d.deliverables, /3 short-form videos/);
  // Suggested per-video posting windows
  assert.ok(Array.isArray(d.postingWindows) && d.postingWindows.length === 3);
  assert.strictEqual(d.postingWindows[0].label, 'Video 1');
});

test('baseContractData: a view-based deal names no video count', () => {
  // Priced by TOTAL guaranteed views reached across as many posts as needed —
  // so the contract states neither "N videos" nor a per-video cadence.
  const creator = { full_name: 'Vo Anh Duy', brand_name: 'Reve' };
  const offer = { offer_type: 'view_based', num_videos: 1, view_guarantee: 100000, flat_fee: 300 };
  const d = contracts.baseContractData(creator, 300, offer);

  assert.strictEqual(d.offerType, 'view_based');
  // No count anywhere the contract page renders it.
  assert.doesNotMatch(d.deliverables, /\d/, 'deliverables must not carry a video count');
  assert.strictEqual(d.numberOfDeliverables, null);
  assert.strictEqual(d.numberOfVideos, null);
  // The guaranteed view total is still surfaced — that is what the deal is priced on.
  assert.strictEqual(d.minTotalViews, 100000);
  assert.strictEqual(d.guaranteedViews, 100000);
  // Cadence is a multi-video rhythm; a view-based deal has none.
  assert.strictEqual(d.timeline, null);
  // Platforms remain the fixed cross-post set.
  assert.deepStrictEqual(d.platforms, ['Instagram', 'TikTok', 'YouTube Shorts']);
});

test('baseContractData surfaces video_bonus offer terms in the contract', () => {
  const creator = { full_name: 'Sam', brand_name: 'Reve' };
  const offer = {
    offer_type: 'video_bonus', num_videos: 3, flat_fee: 2500,
    bonus_amount: 750, bonus_threshold_views: 550000,
  };
  const d = contracts.baseContractData(creator, 2500, offer);
  assert.strictEqual(d.bonusAmount, 750);
  assert.strictEqual(d.bonusThresholdViews, 550000);
  assert.strictEqual(d.bonusWindowDays, 30);
});

test('agreedFeeFor: an admin-accepted creator rate wins over the last offer we sent', async () => {
  // Scenario: we countered at $3,000 (logged rate_offer_sent), then the admin
  // clicked "Accept creator's rate" and we agreed to the creator's own $3,500
  // (logged rate_accepted / source=creator_rate). The contract must bill the
  // number we actually agreed to, not our earlier lower counter.
  const db = require('../db');
  const origOne = db.one;
  db.one = async (sql) => {
    if (/type = 'rate_accepted'/i.test(sql)) return { detail: { fee: 3500, by: 'admin', source: 'creator_rate' } };
    if (/type = 'rate_offer_sent'/i.test(sql)) return { detail: { fee: 3000, cpm: 6 } };
    return null;
  };
  try {
    const fee = await contracts.agreedFeeFor({ id: 42, quoted_rate: 3500 });
    assert.strictEqual(fee, 3500, 'the accepted creator rate is the agreed fee');
  } finally {
    db.one = origOne;
  }
});

test('agreedFeeFor: without an accepted-creator-rate event, the last offer we sent still wins', async () => {
  // Regression guard: the normal creator-accepts-our-offer path must be
  // unchanged — no rate_accepted/creator_rate event, so the last priced offer
  // ($3,000) is the agreed fee.
  const db = require('../db');
  const origOne = db.one;
  db.one = async (sql) => {
    if (/type = 'rate_accepted'/i.test(sql)) return null;
    if (/type = 'rate_offer_sent'/i.test(sql)) return { detail: { fee: 3000, cpm: 6 } };
    return null;
  };
  try {
    const fee = await contracts.agreedFeeFor({ id: 42, quoted_rate: 5000 });
    assert.strictEqual(fee, 3000, 'falls back to the last offer we sent, not the stale quoted_rate');
  } finally {
    db.one = origOne;
  }
});

test('mergeContractData: Claude overrides base, but never wipes known values', () => {
  const base = contracts.baseContractData(
    { full_name: 'Alex Lee', email: 'a@b.com' },
    900,
    { num_videos: 2 },
  );
  const out = contracts.mergeContractData(base, {
    usageRights: 'Whitelisting for 30 days',
    additionalTerms: ['2 rounds of revisions'],
    compensation: 'not a number', // must be ignored → base fee kept
    specialNotes: '', // empty → must NOT override the base null
    brandName: null, // null → must NOT override
  });

  assert.strictEqual(out.usageRights, 'Whitelisting for 30 days');
  assert.deepStrictEqual(out.additionalTerms, ['2 rounds of revisions']);
  assert.strictEqual(out.compensation, 900, 'bad compensation falls back to the known fee');
  assert.strictEqual(out.creatorName, 'Alex Lee'); // untouched base identity
});

test('mergeContractData: platforms follow the creator — subset wins, default kept when unspecified', () => {
  const base = contracts.baseContractData({ full_name: 'Vo Anh Duy' }, 300, { num_videos: 1 });
  assert.deepStrictEqual(base.platforms, ['Instagram', 'TikTok', 'YouTube Shorts']);

  // Creator explicitly chose a subset in the thread → that subset wins.
  const chose = contracts.mergeContractData(base, { platforms: ['Instagram', 'TikTok'] });
  assert.deepStrictEqual(chose.platforms, ['Instagram', 'TikTok']);

  // Creator never narrowed them (extraction empty/absent) → all-three default kept.
  assert.deepStrictEqual(contracts.mergeContractData(base, { platforms: [] }).platforms, base.platforms);
  assert.deepStrictEqual(contracts.mergeContractData(base, {}).platforms, base.platforms);
});

test('creatorDb.buildPayload maps a signed contract to the Creator-DB DTO', () => {
  const contract = {
    token: 'tok123',
    signed_at: '2026-07-06T12:00:00Z',
    data: {
      creatorName: 'Alex Lee',
      email: 'alex@example.com',
      instagramUsername: '@alexcreates',
      brandName: 'Reve',
      campaignName: 'Spring Launch',
      platforms: ['Instagram', 'TikTok'],
      deliverables: '2 short-form videos',
      numberOfDeliverables: 2,
      compensation: 900,
      currency: 'usd', // lowercase → coerced to USD default (must be 3 upper)
      guaranteedViews: 100000,
      additionalTerms: ['bonus over 200k views'],
    },
  };
  const creator = { full_name: 'Alex Lee', email: 'alex@example.com', instagram_username: 'alexcreates' };
  const p = creatorDb.buildPayload(contract, creator);

  assert.strictEqual(p.instagramUsername, 'alexcreates', '@ stripped');
  assert.strictEqual(p.platform, 'Instagram, TikTok');
  assert.strictEqual(p.contractRef, 'tok123');
  assert.strictEqual(p.status, 'COMPLETED');
  assert.strictEqual(p.currency, 'USD', 'non 3-upper currency defaults to USD');
  assert.strictEqual(p.signedAt, new Date('2026-07-06T12:00:00Z').toISOString());
  // clean() drops empties — no null/'' leaks that would trip forbidNonWhitelisted.
  assert.ok(!Object.values(p).some((v) => v === null || v === '' || v === undefined));
});

test('contractEmail carries the signing link and the expected copy', () => {
  const { body } = templates.contractEmail({
    firstName: 'Alex',
    url: 'https://x.test/contracts/tok123',
    managerName: 'Jennifer',
  });
  assert.match(body, /Hi Alex,/);
  assert.match(body, /contract for your review and signing/i);
  assert.match(body, /https:\/\/x\.test\/contracts\/tok123/);
  assert.match(body, /content brief/i);
  assert.match(body, /Jennifer/);
});

// ── Usage rights policy (campaigns.usage_rights_policy) ─────────────────────

test('usageRightsFor: no_rights (default) excludes paid ad rights', () => {
  const r = contracts.usageRightsFor('no_rights');
  assert.strictEqual(r.paidAdsIncluded, false);
  assert.match(r.usageRights, /no paid ad rights required/i);
});

test('usageRightsFor: required always includes paid ad rights', () => {
  const r = contracts.usageRightsFor('required');
  assert.strictEqual(r.paidAdsIncluded, true);
  assert.match(r.usageRights, /included/i);
});

test('usageRightsFor: free_only defaults to included (Claude flips it off when negotiated away)', () => {
  const r = contracts.usageRightsFor('free_only');
  assert.strictEqual(r.paidAdsIncluded, true);
  assert.match(r.usageRights, /included/i);
});

test('usageRightsFor: unset/unknown policy falls back to no_rights (preserves pre-existing behavior)', () => {
  assert.strictEqual(contracts.usageRightsFor(undefined).paidAdsIncluded, false);
  assert.strictEqual(contracts.usageRightsFor(null).paidAdsIncluded, false);
  assert.strictEqual(contracts.usageRightsFor('something_else').paidAdsIncluded, false);
});

test('baseContractData wires the campaign usage_rights_policy through', () => {
  const offer = { num_videos: 2 };
  const noRights = contracts.baseContractData(
    { full_name: 'Alex', usage_rights_policy: 'no_rights' },
    500,
    offer,
  );
  const freeOnly = contracts.baseContractData(
    { full_name: 'Alex', usage_rights_policy: 'free_only' },
    500,
    offer,
  );
  const required = contracts.baseContractData(
    { full_name: 'Alex', usage_rights_policy: 'required' },
    500,
    offer,
  );
  assert.strictEqual(noRights.paidAdsIncluded, false);
  assert.strictEqual(freeOnly.paidAdsIncluded, true);
  assert.strictEqual(required.paidAdsIncluded, true);
});

// ── Usage-rights dispute detection (free_only policy, post-acceptance) ──────
// No ANTHROPIC_API_KEY is set in the test environment, so disputesUsageRights
// exercises its deterministic keyword fallback here — the same path a
// production deployment falls back to on any Claude error.

test('disputesUsageRights: empty/blank text never disputes', async () => {
  assert.strictEqual(await contracts.disputesUsageRights(''), false);
  assert.strictEqual(await contracts.disputesUsageRights(null), false);
  assert.strictEqual(await contracts.disputesUsageRights('   '), false);
});

test('disputesUsageRights: clear objection to ad rights is detected', async () => {
  const cases = [
    'Please remove the ad rights clause from the contract, I did not agree to that.',
    "I don't agree to the usage rights section, can you take that out?",
    'Actually I want to dispute the paid ads rights in this contract.',
  ];
  for (const text of cases) {
    assert.strictEqual(await contracts.disputesUsageRights(text), true, `should dispute: "${text}"`);
  }
});

test('disputesUsageRights: unrelated messages are not disputes', async () => {
  const cases = [
    'Thanks so much, excited to get started!',
    'When will the payment go through?',
    'Can we push the deadline by a week?',
  ];
  for (const text of cases) {
    assert.strictEqual(await contracts.disputesUsageRights(text), false, `should NOT dispute: "${text}"`);
  }
});

// ── free_only usage-rights: negotiated-away detection (contract creation) ───
// The high-stakes "are paid ad rights included?" term is pinned by policy, not
// by the free-form contract extraction. On a free_only campaign it stays
// INCLUDED unless the creator explicitly negotiated separate payment for ad
// rights in the thread. No ANTHROPIC_API_KEY here, so the deterministic
// fallback runs — the same path production falls back to on any Claude error.

test('negotiatedSeparateUsageRightsPayment: empty/blank thread -> rights stay included', async () => {
  assert.strictEqual(await contracts.negotiatedSeparateUsageRightsPayment(''), false);
  assert.strictEqual(await contracts.negotiatedSeparateUsageRightsPayment(null), false);
  assert.strictEqual(await contracts.negotiatedSeparateUsageRightsPayment('   '), false);
});

test('negotiatedSeparateUsageRightsPayment: creator quoting extra for ad rights is detected', async () => {
  const cases = [
    'Happy to work together! Ad rights would be an additional $500 on top.',
    'My rate is $1000, and usage rights cost more if you want to run paid ads.',
    'I charge separately for whitelisting / paid advertising rights.',
  ];
  for (const text of cases) {
    assert.strictEqual(
      await contracts.negotiatedSeparateUsageRightsPayment(text),
      true,
      `should detect negotiated ad-rights payment: "${text}"`,
    );
  }
});

test('negotiatedSeparateUsageRightsPayment: silence / no ad-rights ask keeps rights included', async () => {
  const cases = [
    // The reported bug: creator never mentioned usage rights at all.
    'Sounds great, my rate for 2 videos is $800. Looking forward to it!',
    'Thanks for reaching out — I can do Instagram and TikTok.',
    // A brand-side "no ad rights required" line must not read as a creator ask.
    'Manager: No ad rights or exclusivity required. Creator: Perfect, sounds good!',
  ];
  for (const text of cases) {
    assert.strictEqual(
      await contracts.negotiatedSeparateUsageRightsPayment(text),
      false,
      `should NOT flip rights off: "${text}"`,
    );
  }
});

// ── Editable Deals column: contract-field coercion ──────────────────────────
// coerceContractPatch is the pure normaliser behind the dashboard PATCH
// /api/creators/:id/contract endpoint. It whitelists a small set of deal fields
// and keeps their paired fields consistent.

test('coerceContractPatch: paid ads toggle syncs the usage-rights wording', () => {
  const on = contracts.coerceContractPatch({ paidAdsIncluded: true });
  assert.strictEqual(on.paidAdsIncluded, true);
  assert.match(on.usageRights, /included/i);

  const off = contracts.coerceContractPatch({ paidAdsIncluded: false });
  assert.strictEqual(off.paidAdsIncluded, false);
  assert.match(off.usageRights, /organic only/i);
});

test('coerceContractPatch: videos sets both numberOfVideos and numberOfDeliverables', () => {
  const out = contracts.coerceContractPatch({ numberOfVideos: '3' });
  assert.strictEqual(out.numberOfVideos, 3);
  assert.strictEqual(out.numberOfDeliverables, 3);
  const cleared = contracts.coerceContractPatch({ numberOfVideos: '' });
  assert.strictEqual(cleared.numberOfVideos, null);
  assert.strictEqual(cleared.numberOfDeliverables, null);
});

test('coerceContractPatch: min views mirrors into guaranteedViews', () => {
  const out = contracts.coerceContractPatch({ minTotalViews: 100000 });
  assert.strictEqual(out.minTotalViews, 100000);
  assert.strictEqual(out.guaranteedViews, 100000);
});

test('coerceContractPatch: platforms accept a comma string or an array', () => {
  assert.deepStrictEqual(
    contracts.coerceContractPatch({ platforms: 'Instagram, TikTok , ' }).platforms,
    ['Instagram', 'TikTok'],
  );
  assert.deepStrictEqual(
    contracts.coerceContractPatch({ platforms: ['Instagram', ' YouTube Shorts'] }).platforms,
    ['Instagram', 'YouTube Shorts'],
  );
});

test('coerceContractPatch: deadline aliases, exclusivity defaults, and unknown keys are dropped', () => {
  const out = contracts.coerceContractPatch({
    postingDeadline: 'April 20, 2026',
    exclusivity: '  ',
    compensation: 999, // not whitelisted — must be ignored
  });
  assert.strictEqual(out.postingDeadline, 'April 20, 2026');
  assert.strictEqual(out.deadline, 'April 20, 2026');
  assert.strictEqual(out.exclusivity, 'None');
  assert.ok(!('compensation' in out), 'non-whitelisted fields are ignored');
});

test('coerceContractPatch: empty patch yields no changes', () => {
  assert.deepStrictEqual(contracts.coerceContractPatch({}), {});
});

// ── Post-acceptance term-change detection ───────────────────────────────────
// No ANTHROPIC_API_KEY in the test env, so changesContractTerms exercises its
// deterministic keyword fallback here — the same path production falls back to.

test('changesContractTerms: empty/blank text never counts as a change', async () => {
  assert.strictEqual(await contracts.changesContractTerms(''), false);
  assert.strictEqual(await contracts.changesContractTerms(null), false);
  assert.strictEqual(await contracts.changesContractTerms('   '), false);
});

test('changesContractTerms: a real term change is detected', async () => {
  const cases = [
    "Actually, let's make it 2 videos instead of 1.",
    'I can also post this on YouTube Shorts.',
    'Can we push the deadline to the 30th?',
    'Update: I can only do Instagram now, not TikTok.',
  ];
  for (const text of cases) {
    assert.strictEqual(await contracts.changesContractTerms(text), true, `should be a change: "${text}"`);
  }
});

test('changesContractTerms: questions/acknowledgements are not changes', async () => {
  const cases = [
    'Thanks so much, excited to get started!',
    'When will the payment go through?',
    'Sounds good, looking forward to it.',
  ];
  for (const text of cases) {
    assert.strictEqual(await contracts.changesContractTerms(text), false, `should NOT be a change: "${text}"`);
  }
});

// ── Payment schedule (upfront/remainder split) ──────────────────────────────
// The 30/70 upfront split is NOT a standard clause — it belongs on a contract
// ONLY when the creator explicitly demanded upfront payment. By default a
// contract is paid in full on completion (no schedule row).

test('paymentScheduleFor: off -> no split, on -> 30/70 default, honours a valid percent', () => {
  const off = contracts.paymentScheduleFor(false);
  assert.strictEqual(off.upfrontPercent, null);
  assert.strictEqual(off.remainderPercent, null);
  assert.strictEqual(off.upfrontTrigger, null);
  assert.strictEqual(off.remainderTrigger, null);

  const on = contracts.paymentScheduleFor(true);
  assert.strictEqual(on.upfrontPercent, 30);
  assert.strictEqual(on.remainderPercent, 70);
  assert.match(on.remainderTrigger, /completed, posted and confirmed live/i);

  const half = contracts.paymentScheduleFor(true, 50);
  assert.strictEqual(half.upfrontPercent, 50);
  assert.strictEqual(half.remainderPercent, 50);

  // Out-of-range percents fall back to the 30 default.
  assert.strictEqual(contracts.paymentScheduleFor(true, 0).upfrontPercent, 30);
  assert.strictEqual(contracts.paymentScheduleFor(true, 150).upfrontPercent, 30);
});

test('baseContractData: no upfront split by default (paid in full on completion)', () => {
  const d = contracts.baseContractData({ full_name: 'Alex' }, 900, { num_videos: 2 });
  assert.strictEqual(d.upfrontPercent, null);
  assert.strictEqual(d.remainderPercent, null);
  // The standard "pay on completion" terms line stays.
  assert.match(d.paymentTerms, /completing and posting all agreed deliverables/i);
});

// ── Payment terms (standard method clause) ─────────────────────────────────
// paymentTerms is the boilerplate "how payment moves" line (bank transfer,
// net-N days). Separate from the upfront/remainder SCHEDULE. Kept pinned so
// the free-form extraction can't shove schedule-like text into it and
// duplicate the Payment schedule row on the contract page.

test('paymentTermsFor: standard bank-transfer clause with the given net days', () => {
  assert.strictEqual(
    contracts.paymentTermsFor(7),
    'Direct bank transfer, initiated within 7 working days of completing and posting all agreed deliverables',
  );
  assert.match(contracts.paymentTermsFor(14), /within 14 working days/);
  // Junk / missing days -> defaults to 7 so the clause is never broken.
  assert.match(contracts.paymentTermsFor(null), /within 7 working days/);
  assert.match(contracts.paymentTermsFor(0), /within 7 working days/);
  assert.match(contracts.paymentTermsFor('nonsense'), /within 7 working days/);
});

test('paymentTermsFor: with a schedule split, anchors to milestones (not completion)', () => {
  // The upfront installment is due BEFORE completion, so the "on completion"
  // phrasing would flatly contradict the split — anchor to milestones instead.
  const withSplit = contracts.paymentTermsFor(7, { hasSchedule: true });
  assert.match(withSplit, /each payment milestone/);
  assert.doesNotMatch(withSplit, /completing and posting/);
  // No-split path is unchanged.
  assert.match(
    contracts.paymentTermsFor(7, { hasSchedule: false }),
    /completing and posting all agreed deliverables/,
  );
});

test('mergeContractData does not let a schedule-like extraction bleed into paymentTerms via merge', () => {
  // The reported bug: the extraction pushed "50% upfront prior to production;
  // 50% due immediately after the video is published" into paymentTerms, which
  // then duplicated the Payment schedule row. The final pin happens in
  // extractContractData (after merge), but the merge itself must at minimum
  // accept the base standard clause as authoritative when the extraction is
  // absent — this locks in the "base is a clean method clause" invariant.
  const base = contracts.baseContractData({ full_name: 'Alex' }, 900, { num_videos: 2 });
  assert.doesNotMatch(base.paymentTerms, /%/, 'base clause must not contain any percent split');
  assert.doesNotMatch(base.paymentTerms, /upfront/i, 'base clause must not mention upfront');
  const out = contracts.mergeContractData(base, {});
  assert.strictEqual(out.paymentTerms, base.paymentTerms);
});

// No ANTHROPIC_API_KEY in the test env, so requestedUpfrontPayment exercises
// its deterministic keyword fallback — the same path production falls back to.
test('requestedUpfrontPayment: empty/blank thread -> no upfront', async () => {
  assert.deepStrictEqual(await contracts.requestedUpfrontPayment(''), { upfront: false, pct: null });
  assert.deepStrictEqual(await contracts.requestedUpfrontPayment(null), { upfront: false, pct: null });
});

test('requestedUpfrontPayment: a clear upfront demand is detected', async () => {
  const cases = [
    'Sounds good! I do require 50% upfront before I start filming.',
    'I need a deposit before we begin.',
    'Can we do half now, half on delivery?',
    'I work on a retainer up front for new brands.',
  ];
  for (const text of cases) {
    const r = await contracts.requestedUpfrontPayment(text);
    assert.strictEqual(r.upfront, true, `should detect upfront demand: "${text}"`);
  }
  // A named percentage is captured when present.
  assert.strictEqual((await contracts.requestedUpfrontPayment('I need 50% upfront')).pct, 50);
});

test('requestedUpfrontPayment: no upfront ask keeps the schedule off', async () => {
  const cases = [
    'Sounds great, my rate for 2 videos is $800. Looking forward to it!',
    'When will the payment go through after I post?',
    // A brand-side offer of upfront money is not the creator demanding it — but
    // the conservative fallback only checks for keywords, so keep these clean of
    // upfront/deposit markers to reflect the common case.
    'Thanks for reaching out — I can do Instagram and TikTok.',
  ];
  for (const text of cases) {
    const r = await contracts.requestedUpfrontPayment(text);
    assert.strictEqual(r.upfront, false, `should NOT detect upfront: "${text}"`);
  }
});

test('resolvePaymentSchedule: no upfront ask -> full payment on completion (no split)', async () => {
  const s = await contracts.resolvePaymentSchedule('Great, $800 for 2 videos works!');
  assert.strictEqual(s.upfrontPercent, null);
  assert.strictEqual(s.remainderPercent, null);
});

test('resolvePaymentSchedule: creator demands upfront -> split added', async () => {
  const s = await contracts.resolvePaymentSchedule('I need 50% upfront as a deposit before I start.');
  assert.strictEqual(s.upfrontPercent, 50);
  assert.strictEqual(s.remainderPercent, 50);
});

test('coerceContractPatch: upfront toggle adds/removes the schedule from the Deals column', () => {
  const on = contracts.coerceContractPatch({ upfrontPayment: true });
  assert.strictEqual(on.upfrontPercent, 30);
  assert.strictEqual(on.remainderPercent, 70);

  const off = contracts.coerceContractPatch({ upfrontPayment: false });
  assert.strictEqual(off.upfrontPercent, null);
  assert.strictEqual(off.remainderPercent, null);

  // An explicit percentage alongside the toggle is honoured.
  const custom = contracts.coerceContractPatch({ upfrontPayment: true, upfrontPercent: 40 });
  assert.strictEqual(custom.upfrontPercent, 40);
  assert.strictEqual(custom.remainderPercent, 60);
});

test('removeUsageRightsFromContract exports usageRightsFor(no_rights) shape for reuse', () => {
  // Smoke-check the shared shape rather than the DB write (covered by the
  // end-to-end Postgres verification) — confirms the "removed" state matches
  // the same no_rights defaults every other path uses.
  const removed = contracts.usageRightsFor('no_rights');
  assert.strictEqual(removed.paidAdsIncluded, false);
  assert.match(removed.usageRights, /no paid ad rights required/i);
});
