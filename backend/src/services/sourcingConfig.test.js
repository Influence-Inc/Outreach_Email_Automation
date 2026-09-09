'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { buildConfig, toKeywordList } = require('./sourcingConfig');

test('buildConfig merges defaults + overrides and coerces types', () => {
  const cfg = buildConfig(
    { niche: 'fitness', floor: 15000, keywords: 'gym, workout' },
    { targetCount: '20', risk: 'high', ceiling: '500000' },
  );
  assert.strictEqual(cfg.niche, 'fitness');
  assert.deepStrictEqual(cfg.keywords, ['gym', 'workout']);
  assert.strictEqual(cfg.floor, 15000);
  assert.strictEqual(cfg.ceiling, 500000);
  assert.strictEqual(cfg.risk, 'high');
  assert.strictEqual(cfg.targetCount, 20);
  assert.strictEqual(cfg.reelsWindow, 12);
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
  const off = buildConfig({}, {});
  assert.strictEqual(off.reviewBorderline, false);
});

test('buildConfig defaults risk to medium and drops junk numbers', () => {
  const cfg = buildConfig({}, { risk: 'bogus', floor: 'abc', targetCount: 5 });
  assert.strictEqual(cfg.risk, 'medium');
  assert.strictEqual(cfg.floor, undefined);
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
  const cfg = buildConfig({}, { clipsPerProfile: '2', maxProfiles: '50', stallMs: '30000' });
  assert.strictEqual(cfg.clipsPerProfile, 2);
  assert.strictEqual(cfg.maxProfiles, 50);
  assert.strictEqual(cfg.stallMs, 30000);

  // Absent means "use the navigator's default", not 0 — a 0 cap would disable
  // the profile budget and a 0 clip count would stop recording entirely.
  const bare = buildConfig({}, {});
  assert.strictEqual(bare.clipsPerProfile, undefined);
  assert.strictEqual(bare.maxProfiles, undefined);
  assert.strictEqual(bare.stallMs, undefined);
});

test("buildConfig accepts the 'all' risk level", () => {
  assert.strictEqual(buildConfig({}, { risk: 'all' }).risk, 'all');
  assert.strictEqual(buildConfig({}, { risk: 'nonsense' }).risk, 'medium');
});

test('buildConfig carries the quality dials', () => {
  const cfg = buildConfig({}, {
    floorTolerance: '2', creatorPassThreshold: '0.8', minCreativity: '6',
  });
  assert.strictEqual(cfg.floorTolerance, 2);
  assert.strictEqual(cfg.creatorPassThreshold, 0.8);
  assert.strictEqual(cfg.minCreativity, 6);

  // 0 is a real choice for both gates — an absolute floor, and no craft gate —
  // so it must survive rather than being coerced away as falsy.
  const off = buildConfig({}, { floorTolerance: 0, minCreativity: 0 });
  assert.strictEqual(off.floorTolerance, 0);
  assert.strictEqual(off.minCreativity, 0);
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
  // Off unless asked for — it costs a call per creator.
  assert.strictEqual(buildConfig({}, {}).prescreenNiche, false);
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

// buildConfig is a whitelist: a field the dashboard sends but this does not name
// is silently dropped, which is how three knobs and a follower band were quietly
// dead. The brand brief is the field the whole brand-fit judgement rests on.
test('the brand brief survives the config whitelist', () => {
  const cfg = buildConfig({
    brandName: '  Velo Running  ',
    brandProduct: '  a carbon-plate racing shoe  ',
    brandBrief: '  A GBP 280 shoe for sub-4 marathoners.  ',
  }, {});
  assert.strictEqual(cfg.brandName, 'Velo Running');
  assert.strictEqual(cfg.brandProduct, 'a carbon-plate racing shoe');
  assert.strictEqual(cfg.brandBrief, 'A GBP 280 shoe for sub-4 marathoners.');
});

test('an unfilled brand brief is empty, not undefined', () => {
  const cfg = buildConfig({}, {});
  assert.strictEqual(cfg.brandName, '');
  assert.strictEqual(cfg.brandBrief, '');
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
