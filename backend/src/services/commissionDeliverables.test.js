'use strict';

// Run with: npm test  (node --test)
//
// What a commission-only deal asks the creator to post. Every contract used to
// require set videos, platforms and a posting deadline; a commission-only deal
// (a referral deal especially) can instead be
//   • open-ended — the creator promotes as and when they choose, no minimum,
//     no deadline; or
//   • no deliverables — nothing to post, they earn on referrals / sales alone.
// Covered end to end: the Create-contract form's validation, the contract data
// it builds, the rows the contract (and its PDF) show, and switching modes from
// the Deals column.

const test = require('node:test');
const assert = require('node:assert');
const contracts = require('./contracts');
const callContract = require('./callContract');
const { contractSections } = require('./contractTerms');
const { renderContractPdf } = require('./contractPdf');

const NOW = new Date('2026-11-17T15:00:00Z');

const creator = {
  id: 7,
  campaign_id: 'cmp_1',
  first_name: 'Maya',
  full_name: 'Maya Lin',
  email: 'maya@example.com',
  instagram_username: 'mayamakes',
  brand_name: 'Reve',
  campaign_name: 'Winter',
  usage_rights_policy: 'free_only',
};

const REFERRAL = { model: 'commission', commission: { basis: 'referral', rate_pct: 10 } };
const SALES = { model: 'commission', commission: { rate_pct: 15, attribution: 'code', promo_code: 'maya15' } };

function form(overrides = {}) {
  return {
    terms: REFERRAL,
    deliverablesMode: 'open',
    platforms: ['Instagram'],
    paidAdsIncluded: true,
    exclusivity: '',
    manualTerms: '',
    delivery: { method: 'none' },
    ...overrides,
  };
}
const normalize = (o) => callContract.normalizeCallContractInput(form(o), { now: NOW });
const build = (o) => contracts.buildCallContractData(creator, normalize(o), { now: NOW });
const section = (data, title) => contractSections(data).find((s) => s.title === title);
const labels = (s) => (s ? s.rows.map((r) => r.label) : []);

// ── The form ────────────────────────────────────────────────────────────────

test('normalize: open-ended needs no video count, platform or deadline', () => {
  const n = normalize({ platforms: [], deliverablesNote: '  Referral link in bio,\n stories when it fits ' });
  assert.strictEqual(n.deliverablesMode, 'open');
  assert.strictEqual(n.deliverablesNote, 'Referral link in bio, stories when it fits');
  assert.strictEqual(n.numberOfVideos, null);
  assert.strictEqual(n.postingDeadline, null);
  assert.deepStrictEqual(n.platforms, []);
  assert.strictEqual(n.paidAdsIncluded, true);
  // Platforms are optional, but kept when given.
  assert.deepStrictEqual(normalize().platforms, ['Instagram']);
});

test('normalize: no deliverables drops platforms and ad rights, whatever was sent', () => {
  const n = normalize({ deliverablesMode: 'none', numberOfVideos: 3, postingDeadline: '2026-12-10' });
  assert.strictEqual(n.deliverablesMode, 'none');
  assert.deepStrictEqual(n.platforms, []);
  assert.strictEqual(n.paidAdsIncluded, false);
  assert.strictEqual(n.numberOfVideos, null);
  assert.strictEqual(n.postingDeadline, null);
  assert.strictEqual(n.deliverablesNote, null);
});

test('normalize: set videos still need a count, platform and deadline — commission or not', () => {
  assert.throws(() => normalize({ deliverablesMode: 'fixed' }), /number of videos/);
  assert.throws(() => normalize({ deliverablesMode: 'fixed', numberOfVideos: 2 }), /posting deadline/);
  // An older client that sends no mode at all is a set-videos deal.
  assert.throws(() => normalize({ deliverablesMode: undefined, numberOfVideos: 2, platforms: [] }), /at least one platform/);
  const n = normalize({ deliverablesMode: undefined, numberOfVideos: 2, postingDeadline: '2026-12-10' });
  assert.strictEqual(n.deliverablesMode, 'fixed');
  assert.strictEqual(n.numberOfVideos, 2);
});

test('normalize: only a commission-only deal can drop set deliverables', () => {
  for (const terms of [
    { model: 'flat', fee: 1500 },
    { model: 'hybrid', fee: 800, commission: { rate_pct: 10 } },
    { model: 'product', product: 'Skincare set' },
  ]) {
    assert.throws(() => normalize({ terms }), /Only a commission-only deal/);
    assert.throws(() => normalize({ terms, deliverablesMode: 'none' }), /Only a commission-only deal/);
  }
  assert.throws(() => normalize({ deliverablesMode: 'sometimes' }), /what the creator posts/);
  assert.throws(() => normalize({ deliverablesNote: 'x'.repeat(301) }), /under 300 characters/);
});

// ── The contract ────────────────────────────────────────────────────────────

test('open-ended referral deal: no count, no deadline, said in so many words', () => {
  const d = build();
  assert.strictEqual(d.deliverablesMode, 'open');
  assert.match(d.deliverables, /^Open-ended — the creator promotes INFLUENCE in their own content/);
  assert.match(d.postingCommitment, /no minimum number of posts and no posting deadline/);
  assert.strictEqual(d.numberOfVideos, null);
  assert.strictEqual(d.numberOfDeliverables, null);
  assert.strictEqual(d.postingDeadline, null);
  assert.strictEqual(d.deadline, null);
  assert.strictEqual(d.timeline, null);
  assert.deepStrictEqual(d.postingWindows, []);
  assert.deepStrictEqual(d.platforms, ['Instagram']);
  assert.strictEqual(d.paidAdsIncluded, true);
  assert.strictEqual(d.commission.basis, 'referral');

  const campaign = section(d, 'Campaign & Deliverables');
  assert.deepStrictEqual(labels(campaign), ['Campaign', 'Platforms', 'Deliverables', 'Posting commitment']);
  assert.ok(!section(d, 'Timeline'), 'nothing is due, so no Timeline');
  assert.deepStrictEqual(labels(section(d, 'Usage Rights & Exclusivity')), [
    'Usage rights', 'Paid ads', 'Exclusivity', 'Posts remain live for',
  ]);

  // The team's own description replaces the standard line.
  const noted = build({ deliverablesNote: 'Referral link in bio, plus stories when it fits' });
  assert.strictEqual(noted.deliverables, 'Referral link in bio, plus stories when it fits');
  // A sales commission promotes the brand, not the platform.
  assert.match(build({ terms: SALES }).deliverables, /promotes Reve in their own content/);
});

test('no-deliverables deal: nothing to post, no timeline, no content rights', () => {
  const d = build({ deliverablesMode: 'none' });
  assert.strictEqual(d.deliverablesMode, 'none');
  assert.strictEqual(
    d.deliverables,
    'None — this agreement asks for no content. The creator earns commission on the brands they refer alone.',
  );
  assert.deepStrictEqual(d.platforms, []);
  assert.strictEqual(d.paidAdsIncluded, false);
  assert.strictEqual(d.postingDeadline, null);
  assert.strictEqual(d.postingCommitment, null);

  assert.deepStrictEqual(labels(section(d, 'Campaign & Deliverables')), ['Campaign', 'Deliverables']);
  assert.ok(!section(d, 'Timeline'));
  assert.ok(!section(d, 'Usage Rights & Exclusivity'));
  assert.deepStrictEqual(labels(section(d, 'Exclusivity')), ['Exclusivity']);
  // The pay rows are untouched.
  assert.ok(labels(section(d, 'Compensation & Payment')).includes('Referral commission'));

  assert.match(build({ terms: SALES, deliverablesMode: 'none' }).deliverables, /on the sales they drive alone\.$/);
});

test('the booked offer carries the mode instead of a video count', () => {
  const offer = contracts.callContractOffer(normalize({ deliverablesNote: 'Link in bio' }));
  assert.strictEqual(offer.deliverables_mode, 'open');
  assert.strictEqual(offer.deliverables_note, 'Link in bio');
  assert.ok(!('num_videos' in offer));
  const fixed = contracts.callContractOffer(
    normalize({ deliverablesMode: 'fixed', numberOfVideos: 2, postingDeadline: '2026-12-10' }),
  );
  assert.strictEqual(fixed.num_videos, 2);
  assert.ok(!('deliverables_mode' in fixed));
});

test('a set-videos commission contract reads exactly as before', () => {
  const d = build({ deliverablesMode: 'fixed', numberOfVideos: 2, postingDeadline: '2026-12-10' });
  assert.strictEqual(d.deliverables, '2 short-form videos');
  assert.strictEqual(d.postingDeadline, 'Thursday, December 10, 2026');
  assert.ok(section(d, 'Timeline'));
  assert.ok(section(d, 'Usage Rights & Exclusivity'));
  assert.ok(!labels(section(d, 'Campaign & Deliverables')).includes('Posting commitment'));
});

test('the PDF copy renders open-ended and no-deliverables contracts', () => {
  for (const mode of ['open', 'none']) {
    const buf = renderContractPdf({ token: 't', status: 'signed', data: build({ deliverablesMode: mode }), submission: {} });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, `${mode} renders`);
  }
});

// ── Switching modes from the Deals column ───────────────────────────────────

test('Deals column: a commission contract switches between set, open and none', () => {
  const fixed = build({ deliverablesMode: 'fixed', numberOfVideos: 2, postingDeadline: '2026-12-10' });

  const toNone = contracts.coerceContractPatch({ deliverablesMode: 'none' }, fixed);
  assert.strictEqual(toNone.deliverablesMode, 'none');
  assert.strictEqual(toNone.numberOfVideos, null);
  assert.strictEqual(toNone.postingDeadline, null);
  assert.deepStrictEqual(toNone.platforms, []);
  assert.strictEqual(toNone.paidAdsIncluded, false);

  const toOpen = contracts.coerceContractPatch({ deliverablesMode: 'open' }, fixed);
  assert.strictEqual(toOpen.deliverablesMode, 'open');
  assert.match(toOpen.deliverables, /^Open-ended/);
  assert.ok(!('platforms' in toOpen), 'open-ended keeps the platforms already on the contract');

  const open = { ...fixed, ...toOpen };
  const backToFixed = contracts.coerceContractPatch({ deliverablesMode: 'fixed' }, open);
  assert.strictEqual(backToFixed.deliverablesMode, 'fixed');
  assert.strictEqual(backToFixed.numberOfVideos, 1);
  assert.strictEqual(backToFixed.deliverables, '1 short-form video');
  assert.ok(backToFixed.postingDeadline, 'a fresh deadline for the team to adjust');
  assert.deepStrictEqual(backToFixed.platforms, ['Instagram']);

  // Same mode again is a no-op.
  assert.deepStrictEqual(contracts.coerceContractPatch({ deliverablesMode: 'open' }, open), {});
});

test('Deals column: fields an open / none deal does not have are left alone', () => {
  const open = build();
  assert.deepStrictEqual(contracts.coerceContractPatch({ numberOfVideos: 3, postingDeadline: '2026-12-10' }, open), {});
  const note = contracts.coerceContractPatch({ deliverablesNote: 'Stories twice a month' }, open);
  assert.deepStrictEqual(note, { deliverables: 'Stories twice a month' });
  // Clearing the note goes back to the standard line.
  assert.match(contracts.coerceContractPatch({ deliverablesNote: '' }, open).deliverables, /^Open-ended/);

  const none = build({ deliverablesMode: 'none' });
  assert.deepStrictEqual(contracts.coerceContractPatch({ platforms: 'Instagram', paidAdsIncluded: true }, none), {});
});

test('Deals column: a fee, hybrid or product contract cannot drop its deliverables', () => {
  const flat = contracts.buildCallContractData(
    creator,
    callContract.normalizeCallContractInput(
      form({ terms: { model: 'flat', fee: 1500 }, deliverablesMode: 'fixed', numberOfVideos: 2, postingDeadline: '2026-12-10' }),
      { now: NOW },
    ),
    { now: NOW },
  );
  assert.deepStrictEqual(contracts.coerceContractPatch({ deliverablesMode: 'none' }, flat), {});
  // A contract with no stored mode (every contract before this) reads as set videos.
  assert.strictEqual(contracts.deliverablesModeOf({}), 'fixed');
});
