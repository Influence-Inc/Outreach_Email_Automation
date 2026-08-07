'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ep = require('./engagementPolicy');

const always = () => 0; // rng that always passes a probability gate

test('defaults are conservative: off, high threshold, sharing disabled', () => {
  const p = ep.loadPolicy({});
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.shareProbability, 0);
  assert.ok(p.minScore >= 0.7);
});

test('a disabled policy engages in nothing', () => {
  const p = ep.loadPolicy({}, { enabled: false });
  assert.deepStrictEqual(ep.decide({ score: 1, policy: p, rng: always }), { like: false, save: false, share: false });
});

test('enabled + strong match + probability gate -> like & save', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0.75, likeProbability: 0.5, saveProbability: 0.5, shareProbability: 0 });
  const out = ep.decide({ score: 0.9, counters: ep.newCounters(), policy: p, rng: always });
  assert.deepStrictEqual(out, { like: true, save: true, share: false });
});

test('a weak match is never engaged', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0.75, likeProbability: 1 });
  assert.strictEqual(ep.decide({ score: 0.5, counters: ep.newCounters(), policy: p, rng: always }).like, false);
});

test('per-session caps stop further engagement', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0, likeProbability: 1, maxLikesPerSession: 1 });
  assert.strictEqual(ep.decide({ score: 1, counters: { likes: 1, saves: 0, shares: 0 }, policy: p, rng: always }).like, false);
});

test('never re-likes an already-liked reel', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0, likeProbability: 1 });
  assert.strictEqual(ep.decide({ score: 1, alreadyLiked: true, counters: ep.newCounters(), policy: p, rng: always }).like, false);
});

test('an action block halts all engagement', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0, likeProbability: 1, saveProbability: 1 });
  assert.deepStrictEqual(
    ep.decide({ score: 1, blocked: true, counters: ep.newCounters(), policy: p, rng: always }),
    { like: false, save: false, share: false },
  );
});

test('probability gate: rng above the threshold skips the action', () => {
  const p = ep.loadPolicy({}, { enabled: true, minScore: 0, likeProbability: 0.2 });
  assert.strictEqual(ep.decide({ score: 1, counters: ep.newCounters(), policy: p, rng: () => 0.9 }).like, false);
});

test('loadPolicy reads env flags', () => {
  const p = ep.loadPolicy({
    SOURCING_ENGAGEMENT: 'on',
    SOURCING_ENGAGE_MIN_SCORE: '0.9',
    SOURCING_ENGAGE_MAX_LIKES: '5',
    SOURCING_ENGAGE_LIKE_PROB: '0.3',
  });
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.minScore, 0.9);
  assert.strictEqual(p.maxLikesPerSession, 5);
  assert.strictEqual(p.likeProbability, 0.3);
});
