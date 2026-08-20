'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  collectExamples, renderCalibration, loadCalibration, summarise,
} = require('./nicheCalibration');

// A stored candidate row, as the DB holds it.
function row(over = {}) {
  return {
    username: 'somecoach',
    followers: 42000,
    reject_reason: null,
    evidence: {
      niche: { genre: 'running' },
      clipAnalyses: [
        { niche: 'running', sub_niche: 'marathon training', content_format: 'talking_head', creativity: 8, hook_strength: 7, production_quality: 6 },
        { niche: 'running', sub_niche: 'marathon training', content_format: 'vlog', creativity: 9, hook_strength: 8, production_quality: 7 },
      ],
      creatorScore: { stats: { typical: 51000, steadiness: 0.9 } },
    },
    ...over,
  };
}

// A db double that answers by decision, and records the SQL it was asked.
function fakeDb(byDecision) {
  const queries = [];
  return {
    queries,
    async many(sql, params) {
      queries.push({ sql, params });
      return byDecision[params[0]] || [];
    },
  };
}

// ── what an example carries ─────────────────────────────────────────────────

test('an example keeps the judgement and drops the noise', () => {
  const e = summarise(row());
  assert.strictEqual(e.niche, 'marathon training');
  assert.strictEqual(e.creativity, 8.5, 'averaged across the clips');
  assert.strictEqual(e.hook, 7.5);
  assert.strictEqual(e.typical_views, 51000);
  assert.strictEqual(e.followers, 42000);
});

// Naming accounts invites matching on the handle, and the examples go stale the
// moment those creators change what they post.
test('an example never names the creator', () => {
  const e = summarise(row());
  assert.ok(!('username' in e));
  assert.ok(!JSON.stringify(e).includes('somecoach'));
});

// A human's typed reason is the only place the WHY exists in their own words.
test("a typed rejection reason is kept, the default placeholder is not", () => {
  assert.strictEqual(
    summarise(row({ reject_reason: 'reels are all reposted templates' })).reason,
    'reels are all reposted templates',
  );
  assert.ok(!('reason' in summarise(row({ reject_reason: 'rejected in review' }))));
});

test('missing analysis fields are dropped rather than sent as nulls', () => {
  const e = summarise({ username: 'x', followers: null, evidence: { clipAnalyses: [{ creativity: 5 }] } });
  assert.deepStrictEqual(Object.keys(e).sort(), ['creativity']);
});

test('an older single-clip candidate still summarises', () => {
  const e = summarise({ username: 'x', evidence: { clip: { niche: 'running', creativity: 7 } } });
  assert.strictEqual(e.niche, 'running');
  assert.strictEqual(e.creativity, 7);
});

// ── only human decisions count ──────────────────────────────────────────────

// A candidate rejected for "5 of 12 reels below floor" was rejected by
// arithmetic the gate already enforces — feeding that back teaches nothing and
// drowns the real signals.
test('only human decisions are collected', async () => {
  const db = fakeDb({ added: [row()], rejected: [row()] });
  await collectExamples({ db, campaignId: 'camp-1' });

  for (const q of db.queries) {
    assert.match(q.sql, /decided_by = 'human'/, 'rule decisions are excluded in SQL');
  }
});

test('examples are scoped to the campaign and split by verdict', async () => {
  const db = fakeDb({
    added: [row(), row()],
    rejected: [row({ reject_reason: 'generic stock footage' })],
  });
  const out = await collectExamples({ db, campaignId: 'camp-1' });

  assert.strictEqual(out.approved.length, 2);
  assert.strictEqual(out.rejected.length, 1);
  assert.strictEqual(out.rejected[0].reason, 'generic stock footage');
  assert.ok(db.queries.every((q) => q.params[1] === 'camp-1'));
});

test('the per-side count is bounded so the prompt cannot run away', async () => {
  const db = fakeDb({ added: [], rejected: [] });
  await collectExamples({ db, perSide: 9999 });
  assert.ok(db.queries[0].params[2] <= 12, `limit was ${db.queries[0].params[2]}`);
});

test('no db means no examples rather than a crash', async () => {
  assert.deepStrictEqual(await collectExamples({}), { approved: [], rejected: [] });
});

// ── rendering ───────────────────────────────────────────────────────────────

// One-sided calibration is worse than none: only-approved reads as "score
// everything highly", only-rejected as the reverse. The contrast is the lesson.
test('calibration needs both sides or it renders nothing', () => {
  const one = [summarise(row())];
  assert.strictEqual(renderCalibration({ approved: one, rejected: [] }), '');
  assert.strictEqual(renderCalibration({ approved: [], rejected: one }), '');
  assert.strictEqual(renderCalibration({}), '');
  assert.ok(renderCalibration({ approved: one, rejected: one }).length > 0);
});

test('the rendered block tells the model these outrank its own taste', () => {
  const text = renderCalibration({ approved: [summarise(row())], rejected: [summarise(row())] });
  assert.match(text, /ACCEPTED by the brand/);
  assert.match(text, /REJECTED by the brand/);
  assert.match(text, /follow these/i, 'the examples win where they disagree with the model');
});

// ── loading ─────────────────────────────────────────────────────────────────

test('loadCalibration reports how many examples it found', async () => {
  const db = fakeDb({ added: [row(), row()], rejected: [row()] });
  const c = await loadCalibration({ db, campaignId: 'camp-1' });
  assert.deepStrictEqual(c.counts, { approved: 2, rejected: 1 });
  assert.match(c.text, /CALIBRATION/);
});

test('a campaign with no history calibrates on nothing, not on half a picture', async () => {
  const db = fakeDb({ added: [row()], rejected: [] });
  assert.strictEqual(await loadCalibration({ db, campaignId: 'camp-1' }), null);
});

// Calibration is enrichment. A broken query must not stop a run.
test('a database failure degrades to no calibration', async () => {
  const logged = [];
  const db = { async many() { throw new Error('relation does not exist'); } };
  const c = await loadCalibration({ db, logger: { warn: (...a) => logged.push(a.join(' ')) } });
  assert.strictEqual(c, null);
  assert.match(logged.join(' '), /calibration/i);
});
