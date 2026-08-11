'use strict';

// Run with: npm test  (node --test)
//
// Exercises the pure scouting-rule logic — the five filters that decide whether a
// captured Instagram creator matches a campaign. All deterministic; no network.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./sourcingFilters');

// Build a reels window (newest-first) from a list of view counts.
const reelsOf = (views, caption) => views.map((v) => ({ views: v, caption }));

test('parseCount handles plain, abbreviated, and messy counts', () => {
  assert.strictEqual(F.parseCount(45000), 45000);
  assert.strictEqual(F.parseCount('45,000'), 45000);
  assert.strictEqual(F.parseCount('23.4K'), 23400);
  assert.strictEqual(F.parseCount('1.2M'), 1200000);
  assert.strictEqual(F.parseCount('2.3k views'), 2300);
  assert.strictEqual(F.parseCount('1B'), 1000000000);
  assert.strictEqual(F.parseCount('no numbers'), null);
  assert.strictEqual(F.parseCount(null), null);
});

test('reelViews parses object and raw reel windows', () => {
  assert.deepStrictEqual(F.reelViews([{ views: '15K' }, { views: 20000 }]), [15000, 20000]);
  assert.deepStrictEqual(F.reelViews(['1.2M', 'junk', 500]), [1200000, 500]);
});

test('passesViewFloor gates on every reel clearing the floor', () => {
  assert.strictEqual(F.passesViewFloor([20000, 30000, 25000], 15000), true);
  assert.strictEqual(F.passesViewFloor([20000, 10000, 25000], 15000), false);
  // tolerance absorbs one dip
  assert.strictEqual(F.passesViewFloor([20000, 10000, 25000], 15000, 1), true);
  // no floor => always passes; empty window can't be verified
  assert.strictEqual(F.passesViewFloor([9000], 0), true);
  assert.strictEqual(F.passesViewFloor([], 15000), false);
});

test('classifyRisk: steady band is low', () => {
  const views = Array(12).fill(100000);
  assert.strictEqual(F.classifyRisk(views, { floor: 15000, ceiling: 500000 }), 'low');
});

test('classifyRisk: moderate swings are medium', () => {
  // cv = 0.5 (six at 50k, six at 150k), no reel above the ceiling
  const views = [...Array(6).fill(50000), ...Array(6).fill(150000)];
  assert.strictEqual(F.classifyRisk(views, { floor: 15000, ceiling: 500000 }), 'medium');
});

test('classifyRisk: a breakout reel above the ceiling is high', () => {
  const views = [...Array(11).fill(20000), 600000];
  assert.strictEqual(F.classifyRisk(views, { floor: 15000, ceiling: 500000 }), 'high');
});

test('classifyRisk: viral by median-multiple when no ceiling is set', () => {
  const views = [...Array(11).fill(20000), 200000]; // 200k > 3x median(20k)
  assert.strictEqual(F.classifyRisk(views, {}), 'high');
});

test('matchesRisk is an ordered appetite (higher accepts more)', () => {
  assert.strictEqual(F.matchesRisk('low', 'low'), true);
  assert.strictEqual(F.matchesRisk('medium', 'low'), false);
  assert.strictEqual(F.matchesRisk('low', 'medium'), true);
  assert.strictEqual(F.matchesRisk('high', 'medium'), false);
  assert.strictEqual(F.matchesRisk('high', 'high'), true);
  assert.strictEqual(F.matchesRisk('low', 'high'), true);
});

test('stability rewards steadiness', () => {
  assert.strictEqual(F.stability(Array(6).fill(100000)), 1);
  const swingy = F.stability([...Array(6).fill(50000), ...Array(6).fill(150000)]);
  assert.ok(swingy > 0.6 && swingy < 0.7, `expected ~0.667, got ${swingy}`);
});

test('growthTrend reads direction from newest-first views', () => {
  // newest-first descending => views grew over time => up
  assert.strictEqual(F.growthTrend([120000, 110000, 100000, 90000, 80000, 70000]), 'up');
  // newest-first ascending => declining => down
  assert.strictEqual(F.growthTrend([70000, 80000, 90000, 100000, 110000, 120000]), 'down');
  assert.strictEqual(F.growthTrend(Array(6).fill(100000)), 'flat');
});

test('keywordNicheScore scores caption/bio keyword overlap', () => {
  const cand = { bio: 'fitness coach', reels: reelsOf([1, 2], 'gym workout of the day') };
  assert.strictEqual(F.keywordNicheScore(cand, { niche: 'fitness', keywords: ['gym', 'workout'] }), 1);
  const off = { bio: 'travel vlogs', reels: reelsOf([1], 'sunset in bali') };
  assert.strictEqual(F.keywordNicheScore(off, { niche: 'fitness', keywords: ['gym'] }), 0);
  // no terms to match on => unassessable
  assert.strictEqual(F.keywordNicheScore(cand, {}), null);
});

test('nicheMatch uses an injected AI classifier, else falls back to keywords', async () => {
  const cand = { bio: 'fitness coach', reels: reelsOf([1], 'gym day') };
  const cfg = { niche: 'fitness', keywords: ['gym'] };

  const ai = await F.nicheMatch(cand, cfg, {
    classify: async () => ({ score: 0.92, reason: 'clearly fitness' }),
  });
  assert.strictEqual(ai.source, 'ai');
  assert.strictEqual(ai.nicheScore, 0.92);

  const fallback = await F.nicheMatch(cand, cfg, { classify: async () => null });
  assert.strictEqual(fallback.source, 'keyword');
  assert.ok(fallback.nicheScore > 0);
});

test('decideReel gates on niche score only (no view window)', () => {
  // A reel captured off the feed: caption only, no views. decide() would reject
  // it for "0 reels", but decideReel passes it on niche score alone.
  const reel = { username: 'a', nicheScore: 0.8, reels: [{ caption: 'home gym workout' }] };
  const pass = F.decideReel(reel, { nicheThreshold: 0.5 });
  assert.strictEqual(pass.pass, true);
  assert.strictEqual(pass.reelCount, 0);
  assert.strictEqual(pass.viewFloorPass, null);

  const low = F.decideReel({ username: 'b', nicheScore: 0.3 }, { nicheThreshold: 0.5 });
  assert.strictEqual(low.pass, false);
  assert.match(low.rejectReason, /below 0\.5/);

  // Falls back to keyword score when no AI score is attached.
  const kw = F.decideReel({ username: 'c', reels: [{ caption: 'gym day' }] }, { keywords: ['gym'], nicheThreshold: 0.4 });
  assert.strictEqual(kw.pass, true);
});

test('decide passes a well-matched creator', () => {
  const cand = { username: 'coach', bio: 'fitness', reels: reelsOf(Array(12).fill(100000), 'gym day') };
  const out = F.decide(cand, {
    floor: 15000,
    ceiling: 500000,
    risk: 'low',
    niche: 'fitness',
    keywords: ['gym'],
    nicheThreshold: 0.5,
  });
  assert.strictEqual(out.pass, true, out.rejectReason || '');
  assert.strictEqual(out.viewFloorPass, true);
  assert.strictEqual(out.riskProfile, 'low');
});

test('decide rejects on the view floor', () => {
  const views = [...Array(11).fill(100000), 10000];
  const out = F.decide({ reels: reelsOf(views, 'gym') }, { floor: 15000, risk: 'high' });
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /below floor/);
});

test('decide rejects when the risk profile exceeds appetite', () => {
  const views = [...Array(11).fill(20000), 600000];
  const out = F.decide({ reels: reelsOf(views, 'gym') }, {
    floor: 15000,
    ceiling: 500000,
    risk: 'low',
  });
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /risk high exceeds appetite low/);
});

test('decide rejects an off-niche creator', () => {
  const cand = { bio: 'fitness', reels: reelsOf(Array(12).fill(100000), 'gym day') };
  const out = F.decide(cand, {
    floor: 15000,
    risk: 'high',
    niche: 'cooking',
    keywords: ['recipe'],
    nicheThreshold: 0.6,
  });
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /niche score/);
});

test('decide rejects when too few reels to judge', () => {
  const out = F.decide({ reels: reelsOf([100000, 100000, 100000], 'gym') }, {
    floor: 15000,
    risk: 'high',
    minReels: 6,
  });
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /only 3 reels/);
});
