'use strict';

// Replay hand-labelled creators through the real gate, offline.
//
// The gate is a pure function of numbers already gathered, which makes it
// testable in a way the rest of the pipeline is not: no phone, no Instagram, no
// Gemini, no database. A golden set is a handful of creators per campaign that
// somebody looked at and labelled — `expect: 'add'` for ones worth paying for,
// `expect: 'reject'` for ones that are not — replayed through `scoreCreator`
// whenever the weights, thresholds or prompts change.
//
// This is what stops a change that fixes the skincare campaign from quietly
// ruining the fitness one. Tuning weights without it is guessing twice: once
// about whether the change helps, and once about what it broke.
//
// The labels are the human's; the numbers are whatever the pipeline last
// recorded for that creator (`sourced_candidates.evidence`), so building a set
// costs nothing but the labelling — see `caseFromCandidate`.

const { scoreCreator } = require('./creatorScore');

/**
 * Turn a stored candidate row into a replayable case.
 *
 * Everything the gate needs already lives on the row: the model's per-clip and
 * per-creator analyses under `evidence`, the reach window under `reels`, and the
 * engagement counts the reader captured. `expect` is the only thing a human has
 * to supply.
 */
function caseFromCandidate(row = {}, expect) {
  const evidence = row.evidence || {};
  const niche = evidence.niche || {};
  return {
    username: row.username,
    expect,
    creator: niche.creator || evidence.creator || {},
    clips: niche.clipAnalyses || (niche.clip ? [niche.clip] : []),
    reels: row.reels || [],
    followers: row.followers ?? null,
    engagement: evidence.engagement || row.engagement || null,
  };
}

/** Replay one labelled case through the real gate. */
function runCase(testCase, config = {}) {
  const gate = scoreCreator({
    creator: testCase.creator || {},
    clips: testCase.clips || [],
    reels: testCase.reels || [],
    followers: testCase.followers ?? null,
    engagement: testCase.engagement || null,
  }, config);

  const actual = gate.pass ? 'add' : 'reject';
  return {
    username: testCase.username,
    expect: testCase.expect,
    actual,
    correct: actual === testCase.expect,
    score: gate.score,
    rejectReason: gate.rejectReason,
  };
}

/**
 * Replay a whole set and report where it disagrees with the labels.
 *
 * The two failure kinds are deliberately named rather than summed, because they
 * cost differently: a false ADD wastes an outreach and the brand's goodwill, a
 * false REJECT is a creator silently never seen again. A change that trades one
 * for the other is a decision, not an improvement, and a single "accuracy"
 * number would hide it.
 */
function runGoldenSet(cases = [], config = {}) {
  const results = (cases || []).filter(Boolean).map((c) => runCase(c, config));
  const falseAdds = results.filter((r) => !r.correct && r.actual === 'add');
  const falseRejects = results.filter((r) => !r.correct && r.actual === 'reject');
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;

  return {
    total,
    correct,
    accuracy: total ? Math.round((correct / total) * 1000) / 10 : null,
    falseAdds,
    falseRejects,
    results,
    // The one-line verdict a CI run or a tuning session actually reads.
    passed: falseAdds.length === 0 && falseRejects.length === 0,
  };
}

/**
 * Compare two configs over the same labelled set.
 *
 * The question a tuning session is really asking is not "is this config good"
 * but "is it better than the one we have, and what did it cost" — so the answer
 * names the creators whose verdict changed in each direction.
 */
function compareConfigs(cases = [], before = {}, after = {}) {
  const a = runGoldenSet(cases, before);
  const b = runGoldenSet(cases, after);
  const byName = new Map(a.results.map((r) => [r.username, r]));

  const changed = b.results
    .map((now) => ({ now, was: byName.get(now.username) }))
    .filter(({ now, was }) => was && was.actual !== now.actual)
    .map(({ now, was }) => ({
      username: now.username,
      from: was.actual,
      to: now.actual,
      expect: now.expect,
      // Did this particular change help or hurt?
      improved: now.correct && !was.correct,
      regressed: was.correct && !now.correct,
    }));

  return {
    before: { accuracy: a.accuracy, falseAdds: a.falseAdds.length, falseRejects: a.falseRejects.length },
    after: { accuracy: b.accuracy, falseAdds: b.falseAdds.length, falseRejects: b.falseRejects.length },
    improved: changed.filter((c) => c.improved),
    regressed: changed.filter((c) => c.regressed),
    changed,
  };
}

module.exports = { runGoldenSet, runCase, compareConfigs, caseFromCandidate };
