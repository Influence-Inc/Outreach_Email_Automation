'use strict';

const test = require('node:test');
const assert = require('node:assert');
const g = require('./goldenSet');

const good = (username) => ({
  username,
  expect: 'add',
  creator: { fit_score: 88, consistency_of_niche: 9 },
  clips: [{ creativity: 8, hook_strength: 8, is_original_creator: true, brand_safety: 'safe', brand_fit: 8 }],
  reels: [{ views: 50000 }, { views: 52000 }, { views: 48000 }],
  followers: 90000,
  engagement: { likes: 3000, comments: 90 },
});

const repostFarm = (username) => ({
  username,
  expect: 'reject',
  creator: { fit_score: 90, consistency_of_niche: 9 },
  clips: [{ creativity: 9, hook_strength: 9, is_original_creator: false, brand_safety: 'safe' }],
  reels: [{ views: 80000 }, { views: 79000 }],
  followers: 200000,
  engagement: { likes: 6000, comments: 100 },
});

test('a set the gate agrees with passes cleanly', () => {
  const r = g.runGoldenSet([good('a'), good('b'), repostFarm('c')]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.correct, 3);
  assert.strictEqual(r.accuracy, 100);
  assert.strictEqual(r.passed, true);
});

// The two failure kinds cost differently — a false ADD wastes an outreach, a
// false REJECT is a creator silently never seen again — so they are reported
// separately rather than summed into one accuracy number that hides the trade.
test('false adds and false rejects are named separately', () => {
  // Labelled "add", but the gate will reject: no craft, no reach steadiness.
  const mislabelled = {
    username: 'thin',
    expect: 'add',
    creator: { fit_score: 20, consistency_of_niche: 1 },
    clips: [{ creativity: 1, hook_strength: 1, is_original_creator: true }],
    reels: [{ views: 100 }, { views: 90000 }],
    followers: 1000,
  };
  const r = g.runGoldenSet([good('a'), mislabelled, repostFarm('c')]);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.falseRejects.length, 1);
  assert.strictEqual(r.falseRejects[0].username, 'thin');
  assert.strictEqual(r.falseAdds.length, 0, 'the two are not interchangeable');
  assert.strictEqual(r.accuracy, 66.7);
});

test('a rejection carries the reason, so a disagreement is debuggable', () => {
  const r = g.runGoldenSet([repostFarm('farm')]);
  assert.match(r.results[0].rejectReason, /original creator/);
});

test('an empty set is unknown, not perfect', () => {
  const r = g.runGoldenSet([]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.accuracy, null);
});

// The real question a tuning session asks: is this config better than the one
// we have, and which creators did it cost us.
test('compareConfigs names what each change gained and lost', () => {
  const borderline = {
    username: 'borderline',
    expect: 'reject',
    creator: { fit_score: 70, consistency_of_niche: 7 },
    clips: [{ creativity: 7, hook_strength: 7, is_original_creator: true, brand_safety: 'safe', brand_fit: 7 }],
    reels: [{ views: 30000 }, { views: 31000 }],
    followers: 50000,
    engagement: { likes: 1500, comments: 40 },
  };
  const cases = [good('keeper'), borderline];

  // Raising the bar should reject the borderline creator the label says to reject.
  const cmp = g.compareConfigs(cases, { creatorPassThreshold: 0.3 }, { creatorPassThreshold: 0.85 });
  assert.ok(cmp.after.accuracy >= cmp.before.accuracy, 'the stricter bar scored no worse');
  assert.ok(
    cmp.improved.some((c) => c.username === 'borderline') || cmp.before.accuracy === 100,
    `expected the borderline case to improve: ${JSON.stringify(cmp.changed)}`,
  );
  // And it names the cost: the keeper we lost, if we lost it.
  for (const c of cmp.regressed) assert.strictEqual(c.expect, 'add');
});

// Building a set must cost nothing but the labelling — the numbers are already
// on the stored candidate row.
test('caseFromCandidate rebuilds a case from a stored candidate', () => {
  const row = {
    username: 'mia',
    followers: 90000,
    reels: [{ views: 50000 }],
    evidence: {
      niche: {
        creator: { fit_score: 80, consistency_of_niche: 8 },
        clipAnalyses: [{ creativity: 8, hook_strength: 7 }],
      },
      engagement: { likes: 3000, comments: 50 },
    },
  };
  const c = g.caseFromCandidate(row, 'add');
  assert.strictEqual(c.username, 'mia');
  assert.strictEqual(c.expect, 'add');
  assert.strictEqual(c.creator.fit_score, 80);
  assert.strictEqual(c.clips.length, 1);
  assert.strictEqual(c.followers, 90000);
  assert.deepStrictEqual(c.engagement, { likes: 3000, comments: 50 });
});
