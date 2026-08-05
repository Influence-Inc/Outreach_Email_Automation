'use strict';

const test = require('node:test');
const assert = require('node:assert');

const briefs = require('./briefs');
const { computeExpectedViews, buildBrief, normalizeVideoLinks, roundClean } = briefs;

// ── roundClean ───────────────────────────────────────────────────────────────
test('roundClean tidies numbers by magnitude and rejects non-positive', () => {
  assert.strictEqual(roundClean(46000), 45000); // nearest 5k in the 10k–100k band
  assert.strictEqual(roundClean(300000), 300000); // nearest 10k above 100k
  assert.strictEqual(roundClean(1234), 1000); // nearest 1k
  assert.strictEqual(roundClean(0), null);
  assert.strictEqual(roundClean(-5), null);
});

// ── computeExpectedViews ─────────────────────────────────────────────────────
test('view-based deal shows a "minimum views target" and drops "No pressure"', () => {
  const creator = { custom_offer: { offer_type: 'view_based', view_guarantee: 300000 } };
  const ev = computeExpectedViews(creator, null, {});
  assert.strictEqual(ev.value, 300000);
  assert.strictEqual(ev.per, 'total');
  assert.strictEqual(ev.basis, 'contract');
  assert.strictEqual(ev.label, 'Minimum views target');
  assert.strictEqual(ev.noPressure, false);
  assert.match(ev.display, /300,000 views/);
});

test('video-based deal uses p25 + ~15% per video, rounded clean, keeps "No pressure"', () => {
  const creator = {
    custom_offer: { offer_type: 'video_based', num_videos: 2 },
    ig_scraped_data: { p25: 40000, p50: 90000, min_views: 20000 },
  };
  const ev = computeExpectedViews(creator, null, {});
  // 40000 * 1.15 = 46000 -> roundClean -> 45000
  assert.strictEqual(ev.value, 45000);
  assert.strictEqual(ev.per, 'video');
  assert.strictEqual(ev.basis, 'scraped');
  assert.strictEqual(ev.label, 'Expected views');
  assert.strictEqual(ev.noPressure, true);
  assert.match(ev.display, /~45,000 per video/);
});

test('video-based falls back to min_views, then p50, when p25 is missing', () => {
  const creator = {
    custom_offer: { offer_type: 'video_based', num_videos: 1 },
    ig_scraped_data: { min_views: 20000 },
  };
  const ev = computeExpectedViews(creator, null, {});
  // 20000 * 1.15 = 23000 -> roundClean -> 25000 (nearest 5k)
  assert.strictEqual(ev.value, 25000);
  assert.strictEqual(ev.per, 'video');
});

test('no offer + no stats falls back to the campaign default', () => {
  const ev = computeExpectedViews({ ig_scraped_data: null }, null, { expected_views_default: 60000 });
  assert.strictEqual(ev.value, 60000);
  assert.strictEqual(ev.per, 'video');
  assert.strictEqual(ev.basis, 'default');
});

test('no signal at all yields a null (blank) expected-views', () => {
  const ev = computeExpectedViews({}, null, {});
  assert.strictEqual(ev.value, null);
  assert.strictEqual(ev.display, null);
  assert.strictEqual(ev.basis, 'none');
});

// ── normalizeVideoLinks ──────────────────────────────────────────────────────
test('normalizeVideoLinks accepts strings and {label,url}, drops empties', () => {
  const out = normalizeVideoLinks([
    'https://a',
    { label: 'Hook', url: 'https://b' },
    '',
    { url: '' },
    'https://c',
    'Labelled | https://d',
  ]);
  assert.deepStrictEqual(out, [
    { label: '', url: 'https://a' },
    { label: 'Hook', url: 'https://b' },
    { label: '', url: 'https://c' },
    { label: 'Labelled', url: 'https://d' },
  ]);
});

// ── buildBrief (merge) ───────────────────────────────────────────────────────
function ctxFixture(overrides = {}) {
  return {
    creator: {
      first_name: 'Tharun',
      instagram_username: 'tharun.fyi',
      brand_name: 'Reve',
      usage_rights_policy: 'required',
      ig_scraped_data: { p25: 40000 },
      custom_offer: { offer_type: 'video_based', num_videos: 2 },
      ...(overrides.creator || {}),
    },
    contentBrief: {
      website: 'reve.com',
      campaign_narrative: 'AI image tool',
      dm_keyword: 'Reve',
      demo_links: ['https://drive.google.com/file/d/ABC/view'],
      caption: { mention_handle: '@reve_image', hashtags: '#reveimage' },
      ...(overrides.contentBrief || {}),
    },
    contractData: 'contractData' in overrides ? overrides.contractData : { usageRights: 'Paid ad rights included — custom clause' },
    boilerplate: overrides.boilerplate || 'STANDARD RULES',
  };
}

test('buildBrief merges the tracked link into every brand-website slot', () => {
  const brief = buildBrief(ctxFixture(), {
    contentDirection: 'Show the Layers feature',
    videoLinks: ['https://ig.com/reel/1'],
    trackedUrl: 'https://track.example/abc',
  });
  assert.strictEqual(brief.trackedUrl, 'https://track.example/abc');
  assert.strictEqual(brief.brand.websiteUrl, 'https://track.example/abc');
  assert.strictEqual(brief.posting.caption.link, 'https://track.example/abc');
  assert.strictEqual(brief.posting.dmAutomation.link, 'https://track.example/abc');
  assert.strictEqual(brief.brand.website, 'reve.com'); // raw kept for display
});

test('buildBrief without a tracked link falls back to the raw brand site (https-normalised)', () => {
  const brief = buildBrief(ctxFixture(), { contentDirection: '', videoLinks: [], trackedUrl: null });
  assert.strictEqual(brief.brand.websiteUrl, 'https://reve.com');
  assert.strictEqual(brief.trackedUrl, 'https://reve.com');
});

test('buildBrief takes usage rights from the contract, else the campaign policy', () => {
  const fromContract = buildBrief(ctxFixture(), {});
  assert.strictEqual(fromContract.usageRights, 'Paid ad rights included — custom clause');

  const fromPolicy = buildBrief(ctxFixture({ contractData: null }), {});
  assert.match(fromPolicy.usageRights, /Paid ad rights included/);
});

test('buildBrief carries the curated fields, boilerplate and creator identity', () => {
  const brief = buildBrief(ctxFixture(), {
    contentDirection: '  Show the Layers feature  ',
    videoLinks: [{ label: 'Great hook', url: 'https://ig.com/reel/1' }],
  });
  assert.strictEqual(brief.contentDirection, 'Show the Layers feature'); // trimmed
  assert.deepStrictEqual(brief.topVideos, [{ label: 'Great hook', url: 'https://ig.com/reel/1' }]);
  assert.strictEqual(brief.rules, 'STANDARD RULES');
  assert.strictEqual(brief.creator.firstName, 'Tharun');
  assert.strictEqual(brief.creator.handle, '@tharun.fyi');
  assert.strictEqual(brief.expectedViews.per, 'video'); // video-based deal
  assert.strictEqual(brief.campaignNarrative, 'AI image tool');
  assert.deepStrictEqual(brief.brand.demoLinks, ['https://drive.google.com/file/d/ABC/view']);
});

test('buildBrief no longer emits the dropped why-viral / target-audience fields', () => {
  const brief = buildBrief(ctxFixture({ contentBrief: { why_viral: 'x', target_audience: 'y' } }), {});
  assert.ok(!('whyViral' in brief));
  assert.ok(!('targetAudience' in brief));
});

test('buildBrief takes top videos from the campaign example_videos (common), then appends per-creator', () => {
  const ctx = ctxFixture({
    contentBrief: { example_videos: ['https://common/1', 'Labelled | https://common/2'] },
  });
  const brief = buildBrief(ctx, { videoLinks: ['https://common/1', 'https://creator/3'] });
  // Common first, per-creator after, de-duped on URL.
  assert.deepStrictEqual(brief.topVideos, [
    { label: '', url: 'https://common/1' },
    { label: 'Labelled', url: 'https://common/2' },
    { label: '', url: 'https://creator/3' },
  ]);
});

test('buildBrief threads the per-creator review + post links and the bio link', () => {
  const brief = buildBrief(ctxFixture(), {
    trackedUrl: 'https://track.example/abc',
    reviewUrl: 'https://campaigns.influence.technology/reve/submit-for-review?username=tharun.fyi',
    postShareUrl: 'https://campaigns.influence.technology/reve/submit-links?username=tharun.fyi',
  });
  assert.match(brief.reviewUrl, /submit-for-review/);
  assert.match(brief.postShareUrl, /submit-links/);
  assert.strictEqual(brief.posting.linkInBio, 'https://track.example/abc');
});
