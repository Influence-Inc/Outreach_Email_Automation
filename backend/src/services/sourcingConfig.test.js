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
