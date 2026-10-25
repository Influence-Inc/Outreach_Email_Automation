'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { buildConfig, toKeywordList } = require('./sourcingConfig');

test('buildConfig merges defaults + overrides and coerces types', () => {
  const cfg = buildConfig(
    { keywords: 'gym, workout', viralViews: 50000 },
    { targetCount: '20', viralViews: '250000' },
  );
  assert.deepStrictEqual(cfg.keywords, ['gym', 'workout']);
  assert.strictEqual(cfg.viralViews, 250000);
  assert.strictEqual(cfg.targetCount, 20);
  assert.strictEqual(cfg.reelsWindow, 16, '16 reels are read to judge viral potential');
});

// The Scout page has one keywords field; the niche field did the same job.
test('a saved niche is folded into the keywords, once', () => {
  const cfg = buildConfig({ niche: 'home fitness', keywords: 'gym, Home Fitness, workout' }, {});
  assert.deepStrictEqual(cfg.keywords, ['gym', 'Home Fitness', 'workout']);
  assert.strictEqual(cfg.niche, '');
  assert.deepStrictEqual(buildConfig({ niche: 'skincare, spf' }, {}).keywords, ['skincare', 'spf']);
});

test('the viral bar defaults to 100K views', () => {
  const { DEFAULT_VIRAL_VIEWS } = require('./sourcingConfig');
  assert.strictEqual(DEFAULT_VIRAL_VIEWS, 100000);
  assert.strictEqual(buildConfig({}, {}).viralViews, 100000);
  assert.strictEqual(buildConfig({}, { viralViews: '' }).viralViews, 100000, 'a blank field is the default');
  assert.strictEqual(buildConfig({}, { viralViews: 0 }).viralViews, 100000, 'a viral bar of 0 means nothing');
});

// The view floor, its tolerance, the ceiling and the risk shape were replaced
// by the viral rule; a campaign that saved them does not bring them back.
test('the old view-range knobs are no longer read', () => {
  const cfg = buildConfig({ floor: 15000, floorTolerance: 2, ceiling: 500000, risk: 'low' }, {});
  assert.strictEqual(cfg.floor, undefined);
  assert.strictEqual(cfg.floorTolerance, undefined);
  assert.strictEqual(cfg.ceiling, undefined);
  assert.strictEqual(cfg.risk, undefined);
});

// Set by the session from the review queue (jevCalibration), never by a scout.
test("Jev's confidence bars are not taken from saved defaults", () => {
  const cfg = buildConfig({ jevAutoConfidence: 0.9, jevRejectConfidence: 0.2 }, {});
  assert.strictEqual(cfg.jevAutoConfidence, undefined);
  assert.strictEqual(cfg.jevRejectConfidence, undefined);
});

test('buildConfig carries targetAudience + genres for the reel judge', () => {
  const cfg = buildConfig(
    { niche: 'fitness' },
    { targetAudience: '  women 25-34 beginners ', genres: 'fitness, wellness' },
  );
  assert.strictEqual(cfg.targetAudience, 'women 25-34 beginners');
  assert.deepStrictEqual(cfg.genres, ['fitness', 'wellness']);
  // absent -> empty, never undefined
  const bare = buildConfig({}, {});
  assert.strictEqual(bare.targetAudience, '');
  assert.deepStrictEqual(bare.genres, []);
});

test('buildConfig parses the review-queue knobs', () => {
  const cfg = buildConfig({}, { reviewBorderline: 'true', reviewBand: '0.2' });
  assert.strictEqual(cfg.reviewBorderline, true);
  assert.strictEqual(cfg.reviewBand, 0.2);
  assert.strictEqual(buildConfig({}, {}).reviewBorderline, true, 'on unless turned off');
  assert.strictEqual(buildConfig({}, { reviewBorderline: false }).reviewBorderline, false);
});

// The config is a whitelist: a knob missing here is silently dropped whatever
// the campaign sets.
test('buildConfig carries the quality-score review band and the unjudged hold', () => {
  const cfg = buildConfig({}, { reviewScoreBand: '0.08' });
  assert.strictEqual(cfg.reviewScoreBand, 0.08);
  assert.strictEqual(cfg.reviewUnjudged, true, 'holding unjudged creators is on by default');
  assert.strictEqual(buildConfig({}, { reviewUnjudged: false }).reviewUnjudged, false);
  assert.strictEqual(buildConfig({}, { reviewUnjudged: 'false' }).reviewUnjudged, false);
  assert.strictEqual(buildConfig({ reviewUnjudged: false }, {}).reviewUnjudged, false, 'from saved defaults too');
});

test('buildConfig drops junk numbers', () => {
  const cfg = buildConfig({}, { viralViews: 'abc', stallMs: 'soon', targetCount: 5 });
  assert.strictEqual(cfg.viralViews, 100000);
  assert.strictEqual(cfg.stallMs, undefined);
  assert.strictEqual(cfg.targetCount, 5);
});

test('toKeywordList accepts arrays and delimited strings', () => {
  assert.deepStrictEqual(toKeywordList(['a', ' b ', '']), ['a', 'b']);
  assert.deepStrictEqual(toKeywordList('a,b\nc'), ['a', 'b', 'c']);
  assert.deepStrictEqual(toKeywordList(null), []);
});

// buildConfig is a WHITELIST: a knob absent here is silently dropped no matter
// what the dashboard sends. clipsPerProfile / maxProfiles / stallMs were added
// to the UI and the navigator but never to this list, so all three were dead.
test('buildConfig carries the per-run navigator knobs', () => {
  const cfg = buildConfig({}, { clipsPerProfile: '2', stallMs: '30000' });
  assert.strictEqual(cfg.clipsPerProfile, 2);
  assert.strictEqual(cfg.stallMs, 30000);

  // Absent means "use the navigator's default", not 0 — a 0 clip count would
  // stop recording entirely.
  const bare = buildConfig({}, {});
  assert.strictEqual(bare.clipsPerProfile, undefined);
  assert.strictEqual(bare.stallMs, undefined);
});

// A run keeps going until it has sourced its target: no profile budget, even
// for a campaign that saved one.
test('there is no cap on profiles opened', () => {
  assert.strictEqual(buildConfig({}, {}).maxProfiles, 0);
  assert.strictEqual(buildConfig({ maxProfiles: 50 }, { maxProfiles: '20' }).maxProfiles, 0);
  const { createProfileCap } = require('./sourcingResilience');
  const cap = createProfileCap({ max: buildConfig({}, {}).maxProfiles });
  for (let i = 0; i < 1000; i += 1) assert.ok(cap.take());
  assert.strictEqual(cap.spent(), false);
});

test('buildConfig carries the quality dials', () => {
  const cfg = buildConfig({}, { creatorPassThreshold: '0.8', minCreativity: '6' });
  assert.strictEqual(cfg.creatorPassThreshold, 0.8);
  assert.strictEqual(cfg.minCreativity, 6);

  // 0 is a real choice — no craft gate — so it must survive rather than being
  // coerced away as falsy.
  assert.strictEqual(buildConfig({}, { minCreativity: 0 }).minCreativity, 0);
});

test('buildConfig carries the brand product and its fit floor', () => {
  const cfg = buildConfig({}, { brandProduct: '  a carbon-plate racing shoe  ', minBrandFit: '6' });
  assert.strictEqual(cfg.brandProduct, 'a carbon-plate racing shoe');
  assert.strictEqual(cfg.minBrandFit, 6);
  assert.strictEqual(buildConfig({}, {}).brandProduct, '');
  assert.strictEqual(buildConfig({}, { minBrandFit: 0 }).minBrandFit, 0, '0 is a real choice');
});

test('buildConfig carries the screenshot prescreen knobs', () => {
  const on = buildConfig({}, { prescreenNiche: 'true', prescreenMinConfidence: '0.8' });
  assert.strictEqual(on.prescreenNiche, true);
  assert.strictEqual(on.prescreenMinConfidence, 0.8);
  // On unless a campaign turns it off.
  assert.strictEqual(buildConfig({}, {}).prescreenNiche, true);
  assert.strictEqual(buildConfig({ prescreenNiche: false }, {}).prescreenNiche, false);
});

// buildConfig is a whitelist, so a knob it does not name is silently dropped no
// matter what the campaign saved. creatorScore has always READ creatorWeights
// and maxViewSpike; they just never got there, so every campaign scored on the
// defaults and per-brand tuning did nothing.
test('per-campaign scoring weights reach the scorer', () => {
  const cfg = buildConfig({ creatorWeights: { hook: 3, creativity: 2, fit: 1 } }, {});
  assert.deepStrictEqual(cfg.creatorWeights, { hook: 3, creativity: 2, fit: 1 });
});

test('maxViewSpike reaches the scorer', () => {
  assert.strictEqual(buildConfig({ maxViewSpike: 40 }, {}).maxViewSpike, 40);
});

test('unknown or malformed weight keys are dropped, not passed through', () => {
  // A typo must not become an extra component diluting the real ones.
  assert.deepStrictEqual(buildConfig({ creatorWeights: { creativty: 5, hook: 2 } }, {}).creatorWeights, { hook: 2 });
  assert.strictEqual(buildConfig({ creatorWeights: { creativty: 5 } }, {}).creatorWeights, undefined);
  assert.strictEqual(buildConfig({ creatorWeights: 'heavy' }, {}).creatorWeights, undefined);
  assert.strictEqual(buildConfig({ creatorWeights: [1, 2] }, {}).creatorWeights, undefined);
  assert.strictEqual(buildConfig({}, {}).creatorWeights, undefined, 'absent means creatorScore defaults');
});

test('a negative weight is rejected but its siblings survive', () => {
  assert.deepStrictEqual(buildConfig({ creatorWeights: { hook: -1, fit: 2 } }, {}).creatorWeights, { fit: 2 });
});

// The whitelist and the scorer must agree on what a component IS. brandFit was
// added to creatorScore's blend as its single largest weight; a whitelist that
// did not know the name would have made the one weight a brand most wants to
// tune the one weight it could not.
test('every component the scorer weighs can be tuned per campaign', () => {
  const { DEFAULT_WEIGHTS } = require('./creatorScore');
  const asked = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 1]));
  assert.deepStrictEqual(
    Object.keys(buildConfig({ creatorWeights: asked }, {}).creatorWeights).sort(),
    Object.keys(DEFAULT_WEIGHTS).sort(),
  );
});

// "What you're selling" and "Brand & product details" are one field now; a
// campaign saved with both keeps all of what it said, in the one field.
test('a saved brand brief is folded into what the brand sells', () => {
  const cfg = buildConfig({
    brandName: '  Velo Running  ',
    brandProduct: '  a carbon-plate racing shoe  ',
    brandBrief: '  A GBP 280 shoe for sub-4 marathoners.  ',
  }, {});
  assert.strictEqual(cfg.brandName, 'Velo Running');
  assert.strictEqual(cfg.brandProduct, 'a carbon-plate racing shoe\n\nA GBP 280 shoe for sub-4 marathoners.');
  assert.strictEqual(cfg.brandBrief, undefined);
  assert.strictEqual(buildConfig({ brandBrief: 'only the brief' }, {}).brandProduct, 'only the brief');
});

test('an unfilled brand is empty, not undefined', () => {
  const cfg = buildConfig({}, {});
  assert.strictEqual(cfg.brandName, '');
  assert.strictEqual(cfg.brandProduct, '');
});

// Twelve seconds at 1 fps is twelve frames plus audio — enough to see the
// subject and hear the delivery. Below that the judge is guessing from a
// thumbnail with a soundtrack, which is the failure the video exists to avoid.
test('a too-short clip length is raised to the minimum, not honoured', () => {
  assert.strictEqual(buildConfig({}, {}).clipSeconds, 12, 'unset means 12');
  assert.strictEqual(buildConfig({ clipSeconds: 3 }, {}).clipSeconds, 12);
  assert.strictEqual(buildConfig({ clipSeconds: 0 }, {}).clipSeconds, 12);
  assert.strictEqual(buildConfig({ clipSeconds: '' }, {}).clipSeconds, 12, 'a blank field is not zero seconds');
});

test('a longer clip is honoured, up to the recorder ceiling', () => {
  assert.strictEqual(buildConfig({ clipSeconds: 20 }, {}).clipSeconds, 20);
  assert.strictEqual(buildConfig({ clipSeconds: 999 }, {}).clipSeconds, 60, 'the recorder itself caps at 60');
});

// ── the two feed-workflow knobs ─────────────────────────────────────────────
//
// Both on unless a campaign turns them off: the Scout page ticks them by
// default because every run needs them.

test('off-niche reel skipping is on unless a campaign turns it off', () => {
  assert.strictEqual(buildConfig({}, {}).skipOffNicheReels, true);
  assert.strictEqual(buildConfig({ skipOffNicheReels: false }, {}).skipOffNicheReels, false);
  assert.strictEqual(buildConfig({ skipOffNicheReels: 'false' }, {}).skipOffNicheReels, false);
});

test('feed warming is on unless a campaign turns it off', () => {
  assert.strictEqual(buildConfig({}, {}).warmFeed, true);
  assert.strictEqual(buildConfig({ warmFeed: false }, {}).warmFeed, false);
  assert.strictEqual(buildConfig({ warmFeed: 'false' }, {}).warmFeed, false);
});

// ── example creators, as typed ──────────────────────────────────────────────
//
// Handles, links and sentences, one per line. NOT comma-split like keywords:
// a description of a creator may well contain a comma, and splitting on it
// turns one sentence into two fragments that each read as a separate demand.

test('example creators split on newlines, never on commas', () => {
  const cfg = buildConfig({}, {
    idealExamples: '@marathonhandbook\nhttps://www.instagram.com/reel/Cxyz123/\ncoaches who film their own training, no studio lighting',
  });
  assert.deepStrictEqual(cfg.idealExamples, [
    '@marathonhandbook',
    'https://www.instagram.com/reel/Cxyz123/',
    'coaches who film their own training, no studio lighting',
  ]);
});

test('blank lines and stray whitespace are dropped', () => {
  const cfg = buildConfig({}, { avoidExamples: '  @repostpage  \n\n\n   \nmeme aggregators\n' });
  assert.deepStrictEqual(cfg.avoidExamples, ['@repostpage', 'meme aggregators']);
});

test('an already-split array is taken as given', () => {
  const cfg = buildConfig({}, { idealExamples: ['@one', '  @two  ', ''] });
  assert.deepStrictEqual(cfg.idealExamples, ['@one', '@two']);
});

// The niche call belongs to the judge; the threshold is a floor under the
// obviously-wrong, not a gate that overrules it.
test('the niche threshold defaults low enough to leave the call to the judge', () => {
  const { DEFAULTS } = require('./sourcingFilters');
  assert.strictEqual(DEFAULTS.nicheThreshold, 0.1);
});

// The Scout page now sends an emptied field as null (so a save can clear it
// under merge semantics). The same form starts runs, so a null must mean
// "not set" there too — never 0, and never a crash.
test('a field sent as null is unset for the run, not zero', () => {
  const cfg = buildConfig(
    { viralViews: 300000, creatorPassThreshold: 0.8, reelsWindow: 9 },
    {
      viralViews: null, creatorPassThreshold: null, reelsWindow: null, clipsPerProfile: null, targetCount: 5,
    },
  );
  assert.strictEqual(cfg.viralViews, 100000, 'a cleared viral bar is the default, not 0');
  assert.strictEqual(cfg.creatorPassThreshold, undefined, 'the scorer falls back to its default bar');
  assert.strictEqual(cfg.reelsWindow, 16, 'the window falls back to its default');
  assert.strictEqual(cfg.clipsPerProfile, undefined);
  assert.strictEqual(cfg.targetCount, 5);
});
