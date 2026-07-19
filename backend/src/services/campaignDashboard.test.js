'use strict';

// Run with: npm test  (node --test)
// Covers the pure mapping from a signed contract + creator into the campaign
// dashboard's "new creator row" DTO (POST /api/external/deal-studio/creators).
// The HTTP push itself (syncSignedCreator) is exercised by the end-to-end
// verification, same as creatorDb — see contracts.test.js's header comment.
const test = require('node:test');
const assert = require('node:assert');

const campaignDashboard = require('./campaignDashboard');

test('buildPayload maps a signed video-based contract to the dashboard DTO', () => {
  const contract = {
    token: 'tok123',
    data: {
      email: 'alex@example.com',
      instagramUsername: '@alexcreates',
      numberOfVideos: 2,
      minTotalViews: null,
      guaranteedViews: null,
      deadline: 'Monday, August 10, 2026',
      postingDeadline: 'Monday, August 10, 2026',
    },
  };
  const creator = { campaign_id: 'fc6cd16f226f', full_name: 'Alex Lee', email: 'alex@example.com', instagram_username: 'alexcreates' };
  const p = campaignDashboard.buildPayload(contract, creator);

  assert.strictEqual(p.campaignId, 'fc6cd16f226f');
  assert.strictEqual(p.username, 'alexcreates', '@ stripped');
  assert.strictEqual(p.email, 'alex@example.com');
  assert.strictEqual(p.delMinVideos, 2);
  assert.strictEqual(p.deadline, '2026-08-10');
  assert.strictEqual(p.contractRef, 'tok123');
  assert.ok(!('delMinViews' in p), 'a video-based deal has no view floor to sync');
});

test('buildPayload maps a signed view-based contract without a video count', () => {
  const contract = {
    token: 'tok456',
    data: {
      email: 'alex@example.com',
      instagramUsername: 'alexcreates',
      numberOfVideos: null, // view-based deals have no fixed video count
      minTotalViews: 200000,
      guaranteedViews: 200000,
      postingDeadline: '2026-09-01T00:00:00.000Z',
    },
  };
  const creator = { campaign_id: 'fc6cd16f226f', email: 'alex@example.com', instagram_username: 'alexcreates' };
  const p = campaignDashboard.buildPayload(contract, creator);

  assert.strictEqual(p.delMinViews, 200000);
  assert.strictEqual(p.deadline, '2026-09-01');
  assert.ok(!('delMinVideos' in p), 'a view-based deal has no fixed video count to sync');
});

test('buildPayload falls back to the creator row when contract data is missing identity fields', () => {
  const contract = { token: 'tok789', data: {} };
  const creator = {
    campaign_id: 'campXYZ',
    email: 'fallback@example.com',
    instagram_username: 'fallbackhandle',
  };
  const p = campaignDashboard.buildPayload(contract, creator);

  assert.strictEqual(p.campaignId, 'campXYZ');
  assert.strictEqual(p.username, 'fallbackhandle');
  assert.strictEqual(p.email, 'fallback@example.com');
  assert.ok(!Object.values(p).some((v) => v === null || v === '' || v === undefined));
});
