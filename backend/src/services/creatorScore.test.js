'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { scoreCreator, reelStats, DEFAULT_PASS_THRESHOLD } = require('./creatorScore');

// A creator the model likes, whose reels back it up.
function strong(over = {}) {
  return {
    creator: { fit_score: 85, consistency_of_niche: 9, ...(over.creator || {}) },
    clips: over.clips || [
      { creativity: 8, hook_strength: 8, is_original_creator: true, brand_safety: 'safe' },
      { creativity: 9, hook_strength: 7, is_original_creator: true, brand_safety: 'safe' },
    ],
    reels: over.reels || [{ views: 50000 }, { views: 55000 }, { views: 48000 }, { views: 52000 }],
    followers: over.followers != null ? over.followers : 90000,
  };
}

// ── reelStats ───────────────────────────────────────────────────────────────

test('reports lowest, highest and typical reach', () => {
  const s = reelStats([{ views: 10000 }, { views: 30000 }, { views: 20000 }]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.min, 10000);
  assert.strictEqual(s.max, 30000);
  assert.strictEqual(s.typical, 20000);
});

// The median is deliberate: one viral reel must not drag up the number its own
// spike is measured against.
test('one viral reel does not move the typical figure', () => {
  const steady = reelStats([{ views: 10000 }, { views: 11000 }, { views: 9000 }]);
  const spiked = reelStats([{ views: 10000 }, { views: 11000 }, { views: 9000 }, { views: 900000 }]);
  assert.ok(Math.abs(spiked.typical - steady.typical) < 2000, 'typical stayed put');
  assert.ok(spiked.spike > steady.spike * 5, 'but the spike ratio moved a lot');
});

test('steadier reach scores higher than erratic reach', () => {
  const steady = reelStats([{ views: 50000 }, { views: 52000 }, { views: 48000 }]);
  const erratic = reelStats([{ views: 2000 }, { views: 90000 }, { views: 500 }]);
  assert.ok(steady.steadiness > erratic.steadiness);
});

test('no reels degrades to nulls rather than throwing', () => {
  const s = reelStats([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.typical, null);
});

// ── the decision ────────────────────────────────────────────────────────────

test('a strong creator passes', () => {
  const r = scoreCreator(strong(), {});
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.rejectReason, null);
  assert.ok(r.score > DEFAULT_PASS_THRESHOLD);
});

// The whole point of §7: the model's number is an input, not the verdict.
test('a high fit_score alone does not carry a creator', () => {
  const r = scoreCreator(strong({
    creator: { fit_score: 100, consistency_of_niche: 1 },
    clips: [{ creativity: 1, hook_strength: 1, is_original_creator: true }],
    reels: [{ views: 100 }, { views: 90000 }, { views: 200 }],
  }), {});
  assert.strictEqual(r.pass, false, 'everything except fit was poor');
});

test('the same inputs always produce the same answer', () => {
  const input = strong();
  const a = scoreCreator(input, {});
  const b = scoreCreator(input, {});
  assert.deepStrictEqual(a, b);
});

test('the bar is tunable without touching the analysis', () => {
  const input = strong({ creator: { fit_score: 62, consistency_of_niche: 6 } });
  assert.strictEqual(scoreCreator(input, { creatorPassThreshold: 0.95 }).pass, false);
  assert.strictEqual(scoreCreator(input, { creatorPassThreshold: 0.3 }).pass, true);
});

test('weights are configurable', () => {
  const input = strong({
    creator: { fit_score: 10, consistency_of_niche: 10 },
    clips: [{ creativity: 10, hook_strength: 10, is_original_creator: true }],
  });
  const fitHeavy = scoreCreator(input, { creatorWeights: { fit: 1, nicheConsistency: 0, viewSteadiness: 0, creativity: 0, hook: 0 } });
  const craftHeavy = scoreCreator(input, { creatorWeights: { fit: 0, nicheConsistency: 0, viewSteadiness: 0, creativity: 1, hook: 0 } });
  assert.ok(craftHeavy.score > fitHeavy.score);
});

// ── hard rejects ────────────────────────────────────────────────────────────

test('an explicit reject_reason is final, whatever the numbers say', () => {
  const r = scoreCreator(strong({ creator: { fit_score: 99, consistency_of_niche: 10, reject_reason: 'sells competing product' } }), {});
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.rejectReason, 'sells competing product');
});

// is_original_creator alone kills most of the junk — repost pages, meme
// aggregators, clip farms.
test('a repost page is rejected even with strong scores', () => {
  const r = scoreCreator(strong({
    clips: [
      { creativity: 9, hook_strength: 9, is_original_creator: false },
      { creativity: 9, hook_strength: 9, is_original_creator: false },
    ],
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /original creator/);
});

test('a single reposted clip does not condemn an otherwise original creator', () => {
  const r = scoreCreator(strong({
    clips: [
      { creativity: 8, hook_strength: 8, is_original_creator: true },
      { creativity: 8, hook_strength: 8, is_original_creator: true },
      { creativity: 8, hook_strength: 8, is_original_creator: false },
    ],
  }), {});
  assert.strictEqual(r.pass, true);
});

test('an absent originality flag is not counted as a vote either way', () => {
  const r = scoreCreator(strong({ clips: [{ creativity: 8, hook_strength: 8 }] }), {});
  assert.strictEqual(r.pass, true, 'nothing was judged, so nothing is held against them');
});

test('an unsafe brand context is rejected', () => {
  const r = scoreCreator(strong({
    clips: [{ creativity: 9, hook_strength: 9, is_original_creator: true, brand_safety: 'unsafe' }],
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /brand unsafe/);
});

test('caution is not the same as unsafe', () => {
  const r = scoreCreator(strong({
    clips: [{ creativity: 9, hook_strength: 9, is_original_creator: true, brand_safety: 'caution' }],
  }), {});
  assert.strictEqual(r.pass, true);
});

test('a follower count outside the band is rejected', () => {
  assert.match(
    scoreCreator(strong({ followers: 500 }), { minFollowers: 10000 }).rejectReason,
    /below the follower band/,
  );
  assert.match(
    scoreCreator(strong({ followers: 5000000 }), { maxFollowers: 1000000 }).rejectReason,
    /above the follower band/,
  );
});

test('an unknown follower count does not reject on the band', () => {
  const r = scoreCreator(strong({ followers: null }), { minFollowers: 10000 });
  assert.strictEqual(r.pass, true);
});

// "Consistently performs" vs "got one lucky hit" is the distinction a single
// reel off a feed can never make.
test('reach carried by one outlier is rejected', () => {
  const r = scoreCreator(strong({
    reels: [{ views: 1000 }, { views: 900 }, { views: 1100 }, { views: 400000 }],
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /single outlier/);
});

test('the outlier bar is tunable, and 0 disables it', () => {
  const spiky = strong({ reels: [{ views: 1000 }, { views: 900 }, { views: 1100 }, { views: 400000 }] });

  assert.match(scoreCreator(spiky, {}).rejectReason, /single outlier/, 'rejected by default');

  const disabled = scoreCreator(spiky, { maxViewSpike: 0 });
  assert.ok(!/single outlier/.test(String(disabled.rejectReason)), 'no longer the outlier rule');

  const generous = scoreCreator(spiky, { maxViewSpike: 1000 });
  assert.ok(!/single outlier/.test(String(generous.rejectReason)), 'a wide bar tolerates it');
});

test('a creator with no analysis at all is scored, not crashed', () => {
  const r = scoreCreator({}, {});
  assert.strictEqual(r.pass, false);
  assert.strictEqual(typeof r.score, 'number');
});

test('components are reported so a decision can be explained', () => {
  const r = scoreCreator(strong(), {});
  assert.ok(r.components.fit > 0.8);
  assert.ok(r.components.creativity > 0.8);
  assert.ok(r.stats.typical > 0);
});
