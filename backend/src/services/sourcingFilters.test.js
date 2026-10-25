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

// The per-clip analysis is what the deterministic gate reads. Dropping it here
// would not fail anything loudly — it would just quietly stop rejecting repost
// pages — so it survives whichever way a classifier reports it.
test('nicheMatch keeps a per-clip analysis reported at the top level', async () => {
  const cand = { bio: 'fitness coach', reels: reelsOf([1], 'gym day') };
  const clip = { creativity: 8, is_original_creator: false };

  const topLevel = await F.nicheMatch(cand, {}, {
    classify: async () => ({ score: 0.9, clip }),
  });
  assert.deepStrictEqual(topLevel.evidence.clip, clip);

  const both = await F.nicheMatch(cand, {}, {
    classify: async () => ({ score: 0.9, clip, evidence: { genre: 'fitness', clip } }),
  });
  assert.strictEqual(both.evidence.genre, 'fitness');
  assert.deepStrictEqual(both.evidence.clip, clip);

  const neither = await F.nicheMatch(cand, {}, { classify: async () => ({ score: 0.9 }) });
  assert.strictEqual(neither.evidence, null);
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
  // Three below the floor is past the default tolerance of 2.
  const views = [...Array(9).fill(100000), 10000, 9000, 8000];
  const out = F.decide({ reels: reelsOf(views, 'gym') }, { floor: 15000, risk: 'high' });
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /below floor/);
});

// The floor is the campaign's MINIMUM. A minimum that eleven of twelve reels
// satisfy is not a minimum — one reel under the number the brand is buying
// against means the creator does not clear it.
test('a single reel below the floor rejects by default', () => {
  const views = [...Array(11).fill(100000), 10000];
  const out = F.decide(
    { reels: reelsOf(views, 'gym') },
    { floor: 15000, risk: 'high', niche: 'fitness', keywords: ['gym'], nicheThreshold: 0.4 },
  );
  assert.strictEqual(out.pass, false);
  assert.strictEqual(out.viewFloorPass, false);
  assert.match(out.rejectReason, /1 of 12 reels below floor 15000/);
});

test('a whole window above the floor passes', () => {
  const out = F.decide(
    { reels: reelsOf(Array(12).fill(100000), 'gym') },
    { floor: 15000, risk: 'high', niche: 'fitness', keywords: ['gym'], nicheThreshold: 0.4 },
  );
  assert.strictEqual(out.pass, true, out.rejectReason || '');
});

// Slack is still available, it is just no longer the default.
test('a campaign can opt back into tolerating dips', () => {
  const views = [...Array(11).fill(100000), 10000];
  const out = F.decide(
    { reels: reelsOf(views, 'gym') },
    { floor: 15000, risk: 'high', niche: 'fitness', keywords: ['gym'], nicheThreshold: 0.4, floorTolerance: 2 },
  );
  assert.strictEqual(out.pass, true, out.rejectReason || '');
});

// "all N below floor" reads very differently from "3 of 12" when scanning a run.
test('a creator entirely under the floor says so', () => {
  const out = F.decide({ reels: reelsOf(Array(12).fill(500), 'gym') }, { floor: 15000, risk: 'high' });
  assert.match(out.rejectReason, /all 12 reels below floor 15000/);
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

// The navigator reads AT MOST `reelsWindow` reels, and the dashboard lets that
// go down to 3. Under a fixed minimum of 6 that rejected every creator —
// "only 3 reels (need 6)" — however good they were.
test('the reel minimum never exceeds the window the run was asked to read', () => {
  assert.strictEqual(F.requiredReels({ minReels: 6, reelsWindow: 12 }), 6);
  assert.strictEqual(F.requiredReels({ minReels: 6, reelsWindow: 3 }), 3);
  assert.strictEqual(F.requiredReels({ minReels: 6, reelsWindow: 5 }), 5);
  assert.strictEqual(F.requiredReels({ minReels: 6 }), 6, 'no window stated keeps the minimum');
  assert.strictEqual(F.requiredReels({}), F.DEFAULTS.minReels);
});

test('a small reels window judges on that window instead of rejecting everyone', () => {
  for (const w of [3, 4, 5]) {
    const cfg = { floor: 15000, risk: 'high', reelsWindow: w };
    const full = reelsOf(Array(w).fill(50000), 'gym');
    assert.strictEqual(F.prefilter({ reels: full }, cfg).pass, true, `window ${w}: a full window passes the prefilter`);
    assert.strictEqual(F.decide({ reels: full }, cfg).pass, true, `window ${w}: and the decision`);
  }
  // It is still a minimum: a creator short of even the small window is rejected.
  const cfg3 = { floor: 15000, risk: 'high', reelsWindow: 3 };
  assert.match(F.prefilter({ reels: reelsOf([50000, 50000], 'gym') }, cfg3).rejectReason, /only 2 reels \(need 3\)/);
});

// ── viral potential ─────────────────────────────────────────────────────────
//
// What the Scout page judges reach on: how many of the newest reels (up to 16)
// reached the viral bar. About a third of them, never fewer than two.

const V = 100000; // the viral bar in these tests
const viralCfg = (extra = {}) => ({ viralViews: V, reelsWindow: 16, ...extra });
const hits = (viral, quiet, quietViews = 8000) => reelsOf([
  ...Array(viral).fill(V * 2), ...Array(quiet).fill(quietViews),
], 'gym');

test('how many viral reels a creator needs scales with how many reels they have', () => {
  const need = (n) => F.viralPotential(Array(n).fill(0), viralCfg()).needed;
  assert.strictEqual(need(16), 5);
  assert.strictEqual(need(12), 4);
  assert.strictEqual(need(10), 3);
  assert.strictEqual(need(7), 3);
  assert.strictEqual(need(6), 2);
  assert.strictEqual(need(5), 2);
  assert.strictEqual(need(3), 2, 'never fewer than two: one hit is luck');
});

// Example 1: a creator who usually sits in a modest range, but whose reels
// keep breaking out, goes on to the next step.
test('a modest creator whose reels keep going viral passes', () => {
  const out = F.decide({ reels: hits(5, 11, 12000) }, viralCfg());
  assert.strictEqual(out.pass, true);
  assert.strictEqual(out.viral.viral, 5);
  assert.strictEqual(out.viral.needed, 5);
  assert.strictEqual(out.viewFloorPass, true);
});

// Example 2: few reels, most of them viral.
test('a creator with only 5 reels, 3 of them viral, passes', () => {
  const pre = F.prefilter({ reels: hits(3, 2) }, viralCfg());
  assert.strictEqual(pre.pass, true);
  assert.strictEqual(F.decide({ reels: hits(3, 2) }, viralCfg()).pass, true);
});

// Example 3: 12 reels. Five viral passes; one or two that did a bit better
// than usual is not potential.
test('12 reels: 5 viral passes, 1 or 2 is rejected', () => {
  assert.strictEqual(F.decide({ reels: hits(5, 7) }, viralCfg()).pass, true);
  for (const n of [1, 2]) {
    const out = F.decide({ reels: hits(n, 12 - n) }, viralCfg({ reviewBorderline: true }));
    assert.strictEqual(out.pass, false, `${n} of 12`);
    assert.match(out.rejectReason, new RegExp(`^${n} of 12 reels went viral \\(100K\\+ views\\), needs 4$`));
  }
});

test('a reel that only nears the bar is not viral', () => {
  const out = F.decide({ reels: reelsOf([...Array(10).fill(V - 1), ...Array(6).fill(5000)], 'gym') }, viralCfg());
  assert.strictEqual(out.viral.viral, 0);
  assert.strictEqual(out.pass, false);
});

// One viral reel short, with at least two hits: held for review when the
// campaign reviews borderline creators, rejected when it does not.
test('one viral reel short is borderline: carried on for review, or rejected', () => {
  const reels = hits(4, 12);
  const held = F.decide({ reels }, viralCfg({ reviewBorderline: true }));
  assert.strictEqual(held.pass, true, 'carried on, for the orchestrator to hold');
  assert.strictEqual(held.viral.pass, false);
  assert.strictEqual(held.viral.borderline, true);
  assert.strictEqual(F.prefilter({ reels }, viralCfg({ reviewBorderline: true })).pass, true);

  const off = F.decide({ reels }, viralCfg({ reviewBorderline: false }));
  assert.strictEqual(off.pass, false);
  assert.match(off.rejectReason, /4 of 16 reels went viral/);

  // A single hit is never borderline, even when it is one short of two.
  assert.strictEqual(F.viralPotential([V, 10, 10, 10, 10], viralCfg()).borderline, false);
});

test('a creator with fewer than 3 readable reels cannot be judged', () => {
  const out = F.prefilter({ reels: hits(2, 0) }, viralCfg());
  assert.strictEqual(out.pass, false);
  assert.match(out.rejectReason, /only 2 reels \(need 3\)/);
});

// Breakouts are the point, so the risk shape no longer rejects them, and a
// floor left on an old config does not either.
test('the viral rule ignores the risk shape and any leftover floor', () => {
  const out = F.decide({ reels: hits(6, 10, 3000) }, viralCfg({ risk: 'low', floor: 50000 }));
  assert.strictEqual(out.pass, true);
  assert.strictEqual(F.prefilter({ reels: hits(6, 10, 3000) }, viralCfg({ risk: 'low', floor: 50000 })).pass, true);
});

// ── the 'all' risk appetite ─────────────────────────────────────────────────

// Ordered tolerance already means 'high' accepts everything under it, but "any
// shape is fine" and "I tolerate up to viral" are different intents — and only
// one of them survives a change to how the shapes rank.
test("risk 'all' accepts every shape", () => {
  for (const shape of ['low', 'medium', 'high']) {
    assert.strictEqual(F.matchesRisk(shape, 'all'), true, `${shape} passes under all`);
  }
});

test("risk 'all' is case-insensitive and still gates the other levels", () => {
  assert.strictEqual(F.matchesRisk('high', 'ALL'), true);
  assert.strictEqual(F.matchesRisk('high', 'low'), false, 'low is still strict');
  assert.strictEqual(F.matchesRisk('low', 'low'), true);
});

// ── looksOffNiche: the feed's cheapest possible rejection ────────────────────
//
// Used before a clip is recorded, from the caption alone. It answers "clearly
// not" or "no opinion" — never "probably not" — because the caller skips the
// reel on the back of it.

const OFF_NICHE_CONFIG = { niche: 'running', keywords: ['marathon', '5k'] };

test('a substantial caption that mentions none of our terms is off-niche', () => {
  const caption = 'Slow-braised short rib with a red wine reduction, the recipe '
    + 'that took me three years to get right in my own kitchen.';
  assert.strictEqual(F.looksOffNiche(caption, OFF_NICHE_CONFIG), true);
});

test('a substantial caption that mentions any term is not off-niche', () => {
  const caption = 'Everything I ate the week before my first marathon, including '
    + 'the meal I regret the most the night before the start line.';
  assert.strictEqual(F.looksOffNiche(caption, OFF_NICHE_CONFIG), false);
});

// Silence is not evidence. "day 47 🔥" is a perfectly on-niche fitness caption
// that mentions no keyword at all, and skipping it would lose a real creator.
test('a short caption is never enough to skip a reel', () => {
  assert.strictEqual(F.looksOffNiche('day 47 🔥', OFF_NICHE_CONFIG), false);
  assert.strictEqual(F.looksOffNiche('', OFF_NICHE_CONFIG), false);
  assert.strictEqual(F.looksOffNiche(null, OFF_NICHE_CONFIG), false);
  assert.strictEqual(F.looksOffNiche(undefined, OFF_NICHE_CONFIG), false);
});

test('with no niche or keywords configured there is nothing to compare against', () => {
  const caption = 'Slow-braised short rib with a red wine reduction, three years in the making.';
  assert.strictEqual(F.looksOffNiche(caption, {}), false);
});

test('matching is case-insensitive', () => {
  const caption = 'The MARATHON build-up block that finally worked for me after '
    + 'several years of getting this exact thing wrong.';
  assert.strictEqual(F.looksOffNiche(caption, OFF_NICHE_CONFIG), false);
});
