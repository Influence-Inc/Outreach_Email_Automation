'use strict';

// Run with: npm test  (node --test)
//
// Guards the segmentation module's pure handle parsing and the scheduled sweep's
// "no Creator-DB → no-op" guard (which short-circuits before any DB access).
const test = require('node:test');
const assert = require('node:assert');
const segmentation = require('./segmentation');

test('handleFor uses instagram_username, stripping a leading @', () => {
  assert.strictEqual(segmentation.handleFor({ instagram_username: '@sam' }), 'sam');
  assert.strictEqual(segmentation.handleFor({ instagram_username: 'sam' }), 'sam');
});

test('handleFor parses the handle from an instagram_url', () => {
  assert.strictEqual(
    segmentation.handleFor({ instagram_url: 'https://www.instagram.com/sammy/' }),
    'sammy',
  );
});

test('handleFor ignores non-handle URL segments and non-instagram hosts', () => {
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://www.instagram.com/p/abc123/' }), null);
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://www.instagram.com/reel/xyz/' }), null);
  assert.strictEqual(segmentation.handleFor({ instagram_url: 'https://example.com/sammy' }), null);
  assert.strictEqual(segmentation.handleFor({}), null);
});

test('segmentAllCampaigns is a no-op when Creator-DB is not configured', async () => {
  const saved = process.env.CREATOR_DB_URL;
  delete process.env.CREATOR_DB_URL;
  try {
    const r = await segmentation.segmentAllCampaigns();
    assert.deepStrictEqual(r, { skipped: 'CREATOR_DB_URL not set' });
  } finally {
    if (saved === undefined) delete process.env.CREATOR_DB_URL;
    else process.env.CREATOR_DB_URL = saved;
  }
});
