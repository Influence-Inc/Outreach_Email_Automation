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
  const offer = { offer_type: 'view_based', num_videos: 3, view_guarantee: 100000, flat_fee: 900 };
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
  // Compensation split
  assert.strictEqual(d.compensation, 900);
  assert.strictEqual(d.totalPayment, 900);
  assert.strictEqual(d.upfrontPercent + d.remainderPercent, 100);
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
