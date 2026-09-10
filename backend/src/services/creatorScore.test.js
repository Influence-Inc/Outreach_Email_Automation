'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  scoreCreator, reelStats, engagementRate, viewEngagementRate, DEFAULT_PASS_THRESHOLD,
} = require('./creatorScore');

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
    // Absent by default, so every pre-existing case stays "engagement was never
    // measured" rather than silently acquiring a rate.
    engagement: over.engagement || null,
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

// Reach is what a campaign buys, and `floor` / `ceiling` gate on it directly.
// A follower band only ever rejected creators whose reach we had measured and
// liked, so it is gone — and must not come back through config.
test('follower count no longer gates a creator', () => {
  assert.strictEqual(scoreCreator(strong({ followers: 500 }), { minFollowers: 10000 }).pass, true);
  assert.strictEqual(scoreCreator(strong({ followers: 5000000 }), { maxFollowers: 1000000 }).pass, true);
  assert.strictEqual(scoreCreator(strong({ followers: null }), {}).pass, true);
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

// ── the craft floor ─────────────────────────────────────────────────────────

// Creativity + hook are only 25% of the weighting between them, so a creator the
// model loves on FIT clears the bar on fit + consistency + steadiness alone. That
// is the "right keywords, low-quality content" case a weighted average cannot
// express, and a floor can.
test('poor craft is rejected however strong the fit', () => {
  const r = scoreCreator(strong({
    creator: { fit_score: 100, consistency_of_niche: 10 },
    clips: [
      { creativity: 3, hook_strength: 4, is_original_creator: true },
      { creativity: 4, hook_strength: 4, is_original_creator: true },
    ],
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /creativity 3\.5 below 5/);
});

test('the craft floor is a floor, not a rounding of the blend', () => {
  // Mean creativity 5 exactly — at the floor, so it survives and is judged on
  // the weighted score like anything else.
  const at = scoreCreator(strong({
    clips: [{ creativity: 5, hook_strength: 8, is_original_creator: true }],
  }), {});
  assert.ok(!/creativity/.test(String(at.rejectReason)), 'exactly at the floor is not rejected by it');
});

test('the craft floor is tunable, and 0 disables it', () => {
  const weak = strong({
    creator: { fit_score: 100, consistency_of_niche: 10 },
    clips: [{ creativity: 2, hook_strength: 9, is_original_creator: true }],
  });
  assert.match(scoreCreator(weak, {}).rejectReason, /creativity/, 'rejected by default');
  assert.ok(!/creativity/.test(String(scoreCreator(weak, { minCreativity: 0 }).rejectReason)));
  assert.match(scoreCreator(weak, { minCreativity: 9 }).rejectReason, /below 9/);
});

// Same principle as the originality flag: silence is not an accusation.
test('a creator whose clips were never scored is not failed on craft', () => {
  const r = scoreCreator(strong({ clips: [{ hook_strength: 8, is_original_creator: true }] }), {});
  assert.ok(!/creativity/.test(String(r.rejectReason)));
});

// Craft moved from 25% to 40% of the weighting. It still cannot be made
// MANDATORY by weighting — see the floor tests above — but weak craft must at
// least cost a creator real score rather than being a tiebreaker.
test('weak craft costs materially more score than it used to', () => {
  const mediocre = {
    creator: { fit_score: 90, consistency_of_niche: 9 },
    clips: [{ creativity: 5, hook_strength: 5, is_original_creator: true }],
    reels: [{ views: 50000 }, { views: 51000 }, { views: 49000 }],
  };
  const excellent = {
    ...mediocre,
    clips: [{ creativity: 10, hook_strength: 10, is_original_creator: true }],
  };

  const gap = scoreCreator(strong(excellent), {}).score - scoreCreator(strong(mediocre), {}).score;
  // 40% of the weighting spread over half the craft range.
  assert.ok(gap > 0.19, `craft moves the score by ${gap}`);
});

// Steadiness is nearly free to max out, which is why it was over-weighted: any
// creator with a consistent audience scores ~0.98 on it.
test('a steady audience alone no longer carries a weak creator as far', () => {
  const steadyButUninspired = strong({
    creator: { fit_score: 70, consistency_of_niche: 7 },
    clips: [{ creativity: 5, hook_strength: 5, is_original_creator: true }],
    reels: [{ views: 50000 }, { views: 50100 }, { views: 49900 }],
  });
  assert.ok(scoreCreator(steadyButUninspired, {}).score < DEFAULT_PASS_THRESHOLD);
});

test('the raised default bar is the one in force', () => {
  assert.strictEqual(DEFAULT_PASS_THRESHOLD, 0.72);
  // And it is still a dial, not a law.
  const borderline = strong({ creator: { fit_score: 70, consistency_of_niche: 7 } });
  assert.strictEqual(scoreCreator(borderline, { creatorPassThreshold: 0.95 }).pass, false);
  assert.strictEqual(scoreCreator(borderline, { creatorPassThreshold: 0.5 }).pass, true);
});

// Every campaign shared one set of weights, because creatorWeights never crossed
// buildConfig's whitelist. A skincare brand buys production quality; a meme
// brand buys the hook — the same blend cannot serve both.
test('per-campaign weights change which creator passes', () => {
  // Strong hook, weak niche consistency.
  const hooky = {
    creator: { fit_score: 60, consistency_of_niche: 2 },
    clips: [{ creativity: 9, hook_strength: 10, is_original_creator: true, brand_safety: 'safe' }],
    reels: [{ views: 100000 }, { views: 100000 }, { views: 100000 }],
  };
  const balanced = scoreCreator(hooky, {});
  const hookLed = scoreCreator(hooky, { creatorWeights: { hook: 3, creativity: 2, fit: 1, nicheConsistency: 0, viewSteadiness: 1 } });
  assert.ok(hookLed.score > balanced.score, `hook-led ${hookLed.score} should beat balanced ${balanced.score}`);
});

test('weights are relative, not required to sum to 1', () => {
  const cand = {
    creator: { fit_score: 100, consistency_of_niche: 10 },
    clips: [{ creativity: 10, hook_strength: 10, is_original_creator: true, brand_safety: 'safe' }],
    reels: [{ views: 50000 }, { views: 50000 }],
  };
  // All components maxed, so any weighting must normalise to 1.
  assert.strictEqual(scoreCreator(cand, { creatorWeights: { fit: 2, hook: 2 } }).score, 1);
});

test('maxViewSpike is tunable per campaign', () => {
  // Best reel 20x the typical one.
  const spiky = {
    creator: { fit_score: 90, consistency_of_niche: 9 },
    clips: [{ creativity: 9, hook_strength: 9, is_original_creator: true, brand_safety: 'safe' }],
    reels: [{ views: 10000 }, { views: 10000 }, { views: 200000 }],
  };
  assert.match(scoreCreator(spiky, {}).rejectReason, /single outlier/); // default 12
  assert.strictEqual(scoreCreator(spiky, { maxViewSpike: 50 }).pass, true, 'a burst-y niche can allow it');
});

// ── brand fit ───────────────────────────────────────────────────────────────

// The closest thing in the blend to the question an outreach actually asks:
// could this creator hold THIS product and have it look native.
test('a creator who could not plausibly hold the product is rejected', () => {
  const r = scoreCreator(strong({
    creator: { fit_score: 95, consistency_of_niche: 9 },
    clips: [
      { creativity: 9, hook_strength: 9, is_original_creator: true, brand_fit: 2 },
      { creativity: 9, hook_strength: 8, is_original_creator: true, brand_fit: 3 },
    ],
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /brand fit 2\.5 below 4/);
});

test('the brand-fit floor is tunable, and 0 turns it off', () => {
  const poor = strong({ clips: [{ creativity: 9, hook_strength: 9, is_original_creator: true, brand_fit: 2 }] });
  assert.match(scoreCreator(poor, {}).rejectReason, /brand fit/);
  assert.ok(!/brand fit/.test(String(scoreCreator(poor, { minBrandFit: 0 }).rejectReason)));
  assert.match(scoreCreator(strong({
    clips: [{ creativity: 9, hook_strength: 9, is_original_creator: true, brand_fit: 6 }],
  }), { minBrandFit: 8 }).rejectReason, /brand fit 6 below 8/);
});

test('strong brand fit lifts a creator materially', () => {
  const base = { creator: { fit_score: 70, consistency_of_niche: 7 } };
  const weak = scoreCreator(strong({ ...base, clips: [{ creativity: 7, hook_strength: 7, is_original_creator: true, brand_fit: 4 }] }), {});
  const great = scoreCreator(strong({ ...base, clips: [{ creativity: 7, hook_strength: 7, is_original_creator: true, brand_fit: 10 }] }), {});
  assert.ok(great.score - weak.score > 0.13, `brand fit moved the score by ${great.score - weak.score}`);
});

// ── unknown is not zero ─────────────────────────────────────────────────────

// A campaign that never said what it sells is never asked about brand fit. It
// must not be scored as though the answer were "no" — its weight is redistributed
// across the components that WERE measured.
test('a campaign with no product configured is not penalised for brand fit', () => {
  const withoutField = scoreCreator(strong({
    clips: [{ creativity: 8, hook_strength: 8, is_original_creator: true }],
  }), {});
  const withGreatFit = scoreCreator(strong({
    clips: [{ creativity: 8, hook_strength: 8, is_original_creator: true, brand_fit: 8 }],
  }), {});

  assert.strictEqual(withoutField.components.brandFit, null, 'unmeasured, not zero');
  assert.ok(withoutField.pass, 'still judged on everything else');
  // Scoring 8/10 on brand fit is close to the 0.8 the other craft numbers sit at,
  // so the two scores should be near-identical rather than 0.25 apart.
  assert.ok(
    Math.abs(withGreatFit.score - withoutField.score) < 0.05,
    `absent brand fit did not drag the score down (${withoutField.score} vs ${withGreatFit.score})`,
  );
});

// The same trap that made an unanalysed creator score 0 on craft.
test('an unmeasured component drops out of the average rather than scoring zero', () => {
  const noClips = scoreCreator({
    creator: { fit_score: 90, consistency_of_niche: 9 },
    clips: [],
    reels: [{ views: 50000 }, { views: 51000 }, { views: 49000 }],
  }, {});
  assert.strictEqual(noClips.components.creativity, null);
  assert.strictEqual(noClips.components.hook, null);
  // fit 0.9, consistency 0.9, steadiness ~0.98 — nothing else was measured, so
  // the score reflects those three and not three phantom zeroes.
  assert.ok(noClips.score > 0.85, `scored ${noClips.score} on what was actually known`);
});

test('a creator with nothing measurable at all scores zero rather than dividing by zero', () => {
  const r = scoreCreator({}, {});
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.pass, false);
});

// ── engagement: a real audience vs a bought one ─────────────────────────────

// Reach alone cannot tell these apart — views can be bought, and a repost farm's
// numbers look like a creator's until you ask how many people reacted.
test('a creator with followers but almost no reactions is rejected', () => {
  const r = scoreCreator(strong({
    followers: 500000,
    engagement: { likes: 200, comments: 5 },   // 0.04%
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /engagement 0\.04% of followers/);
});

test('a normal engagement rate passes and is reported', () => {
  const r = scoreCreator(strong({
    followers: 100000,
    engagement: { likes: 4000, comments: 120 },  // 4.12%
  }), {});
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.stats.engagementRate, 0.041);
});

// The trap this whole file is built to avoid: Number(null) is 0, and 0 is
// finite, so reading an absent like count through Number() first would turn
// "never measured" into "nobody engaged" and reject every creator whose counts
// we simply could not read.
test('an unread engagement count is unmeasured, not zero', () => {
  assert.strictEqual(engagementRate({ engagement: null, followers: 90000 }), null);
  assert.strictEqual(engagementRate({ engagement: {}, followers: 90000 }), null);
  assert.strictEqual(engagementRate({ engagement: { likes: 10 }, followers: 0 }), null);
  assert.strictEqual(engagementRate({ engagement: { likes: 10 }, followers: null }), null);
  // A creator with no engagement data still gets judged on everything else.
  const r = scoreCreator(strong({ followers: 90000 }), {});
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.stats.engagementRate, null);
});

test('comments alone still measure engagement', () => {
  assert.strictEqual(engagementRate({ engagement: { comments: 500 }, followers: 10000 }), 0.05);
});

test('the engagement floor is tunable, and 0 turns it off', () => {
  const thin = strong({ followers: 500000, engagement: { likes: 200, comments: 5 } });
  assert.match(scoreCreator(thin, {}).rejectReason, /engagement/);
  assert.ok(!/engagement/.test(String(scoreCreator(thin, { minEngagementRate: 0 }).rejectReason)));
  // And a stricter brand can demand more than the forgiving default.
  const ok = strong({ followers: 100000, engagement: { likes: 1500, comments: 0 } }); // 1.5%
  assert.strictEqual(scoreCreator(ok, {}).pass, true);
  assert.match(scoreCreator(ok, { minEngagementRate: 0.05 }).rejectReason, /engagement 1\.50%/);
});

// ── bought views ────────────────────────────────────────────────────────────
//
// Views are the cheapest thing on Instagram to buy and the reactions to them are
// not, so the ratio between them is what separates a real hit from a purchased
// number. This is a DIFFERENT question from the follower ratio: a creator with a
// small genuine following and a large bought view count passes that one
// comfortably, because their real followers really did react.

test('half a million views with a couple of hundred likes is rejected', () => {
  const r = scoreCreator(strong({
    followers: 10000,
    engagement: { views: 500000, likes: 150, comments: 35 },
  }), {});
  assert.strictEqual(r.pass, false);
  assert.match(r.rejectReason, /views look bought/);
});

// The case the follower ratio cannot see, and the reason this check exists.
test('bought views hide behind a healthy-looking follower ratio', () => {
  const bought = { followers: 10000, engagement: { views: 500000, likes: 150, comments: 35 } };

  // Against followers this creator looks fine — 185 reactions on 10k followers.
  assert.ok(engagementRate(bought) >= 0.01, 'passes the follower ratio');
  // Against the views they are actually sold on, they do not.
  assert.ok(viewEngagementRate(bought) < 0.005, 'fails the view ratio');
  assert.match(scoreCreator(strong(bought), {}).rejectReason, /views look bought/);
});

test('a normal creator is not touched by it', () => {
  // ~4% of viewers reacting, around the published Reels median.
  const r = scoreCreator(strong({
    followers: 20000,
    engagement: { views: 50000, likes: 1800, comments: 200 },
  }), {});
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.rejectReason, null);
});

// The floor is deliberately forgiving — six times under the median still passes.
// It exists to catch the indefensible, not to sort the average from the good.
test('a quiet but plausible audience still passes', () => {
  const r = scoreCreator(strong({
    followers: 20000,
    engagement: { views: 100000, likes: 700, comments: 40 },
  }), {});
  assert.strictEqual(r.pass, true, '0.74% of viewers reacted — low, but not fabricated');
});

// Same principle as every other gate here: silence is not an accusation.
test('an unread view count is unmeasured, not fraudulent', () => {
  assert.strictEqual(viewEngagementRate({ engagement: { likes: 150, comments: 35 } }), null);
  assert.strictEqual(viewEngagementRate({ engagement: { views: null, likes: 150 } }), null);
  const r = scoreCreator(strong({ engagement: { likes: 150, comments: 35 } }), {});
  assert.ok(!/views look bought/.test(String(r.rejectReason)));
});

// Views with no reactions read at all is not evidence either — that is a failed
// read of the like count, not a creator nobody reacted to.
test('views with no reaction counts read at all is unmeasured', () => {
  assert.strictEqual(viewEngagementRate({ engagement: { views: 500000 } }), null);
  const r = scoreCreator(strong({ engagement: { views: 500000 } }), {});
  assert.ok(!/views look bought/.test(String(r.rejectReason)));
});

test('the view-engagement floor is tunable, and 0 disables it', () => {
  const bought = strong({ engagement: { views: 500000, likes: 150, comments: 35 } });
  assert.match(scoreCreator(bought, {}).rejectReason, /views look bought/, 'on by default');
  assert.ok(!/views look bought/.test(String(scoreCreator(bought, { minViewEngagementRate: 0 }).rejectReason)));
  // A campaign that wants a stricter bar than the default can have one.
  const quiet = strong({ engagement: { views: 100000, likes: 700, comments: 40 } });
  assert.match(scoreCreator(quiet, { minViewEngagementRate: 0.02 }).rejectReason, /views look bought/);
});

test('the measured ratio is reported whether or not it rejects', () => {
  const r = scoreCreator(strong({
    followers: 20000,
    engagement: { views: 50000, likes: 1800, comments: 200 },
  }), {});
  assert.strictEqual(r.stats.viewEngagementRate, 0.04);
});
