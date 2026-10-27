'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rl = require('./reviewLessons');

test.afterEach(() => rl._resetCache());

const row = (id, decision, note, shares) => ({
  id, decision, review_note: note, jev: { creator: { shares } },
});

const ROWS = [
  row(1, 'rejected', 'only memes, no real tutorials', { topic: { tech: 0.9 }, genre: { comedy: 0.8, educational: 0.2 } }),
  row(2, 'rejected', 'meme page again', { topic: { tech: 1 }, genre: { comedy: 0.7 } }),
  row(3, 'added', 'explains every step, great', { topic: { tech: 1 }, genre: { educational: 0.9 } }),
];

test('Claude is shown each note with the decision and what Jev saw, and the taxonomy keys', async () => {
  let asked = null;
  await rl.learn(ROWS, { ask: async (system, user) => { asked = { system, user: JSON.parse(user) }; return '{"avoid":[]}'; } });
  assert.match(asked.system, /only the exact option keys/);
  assert.ok(asked.user.options.genre.includes('comedy'));
  assert.deepStrictEqual(asked.user.reviewed[0], {
    decision: 'rejected', note: 'only memes, no real tutorials', labels: { topic: ['tech 90%'], genre: ['comedy 80%', 'educational 20%'] },
  });
  assert.strictEqual(asked.user.reviewed[2].decision, 'shortlisted');
});

test('rules are kept only on real taxonomy labels, with a reason', async () => {
  const reply = JSON.stringify({
    avoid: [
      { dim: 'genre', value: 'comedy', why: 'only memes, no real tutorials', notes: 2 },
      { dim: 'genre', value: 'made_up_label', why: 'x' },
      { dim: 'mood', value: 'comedy', why: 'x' },
      { dim: 'genre', value: 'comedy', why: 'duplicate' },
      { dim: 'format', value: 'skit', why: '' },
    ],
  });
  const l = await rl.learn(ROWS, { ask: async () => `\`\`\`json\n${reply}\n\`\`\`` });
  assert.deepStrictEqual(l, { rules: [{ dim: 'genre', value: 'comedy', why: 'only memes, no real tutorials', notes: 2 }], basis: 3 });
});

test('Claude is asked again only when the notes change', async () => {
  let calls = 0;
  const ask = async () => { calls += 1; return '{"avoid":[{"dim":"genre","value":"comedy","why":"memes"}]}'; };
  await rl.learn(ROWS, { ask });
  await rl.learn(ROWS, { ask });
  assert.strictEqual(calls, 1);
  await rl.learn([...ROWS, row(4, 'rejected', 'too salesy', { genre: { promotional: 1 } })], { ask });
  assert.strictEqual(calls, 2);
});

test('no notes, only shortlists, or no Claude: no rules, and says so', async () => {
  const never = async () => { throw new Error('not asked'); };
  assert.deepStrictEqual(await rl.learn([], { ask: never }), { rules: [], basis: 0 });
  assert.deepStrictEqual(await rl.learn([row(1, 'rejected', '  ', {})], { ask: never }), { rules: [], basis: 0 });
  assert.deepStrictEqual(await rl.learn([ROWS[2]], { ask: never }), { rules: [], basis: 1 });
  const none = await rl.learn(ROWS, { ask: async () => null });
  assert.strictEqual(none.rules.length, 0);
  assert.match(none.error, /ANTHROPIC_API_KEY/);
  assert.match(rl.describe(none), /saved, but could not be learned from/);
});

test('a creator matches a rule when at least half their Reels carry it', () => {
  const lessons = { rules: [{ dim: 'genre', value: 'comedy', why: 'memes' }, { dim: 'format', value: 'skit', why: 'skits' }] };
  const m = rl.matches(lessons, { genre: { comedy: 0.5 }, format: { skit: 0.8 } });
  assert.deepStrictEqual(m.map((x) => [x.rule.value, x.share]), [['skit', 0.8], ['comedy', 0.5]]);
  assert.deepStrictEqual(rl.matches(lessons, { genre: { comedy: 0.4 } }), []);
  assert.deepStrictEqual(rl.matches(null, { genre: { comedy: 1 } }), []);
});

test('load reads human decisions with notes, and never throws', async () => {
  let sql = null;
  const db = { many: async (q) => { sql = q; return ROWS; } };
  const l = await rl.load({ db, ask: async () => '{"avoid":[{"dim":"genre","value":"comedy","why":"memes"}]}' });
  assert.match(sql, /decided_by = 'human'/);
  assert.match(sql, /review_note/);
  assert.strictEqual(l.rules[0].value, 'comedy');
  const broken = await rl.load({ db: { many: async () => { throw new Error('db down'); } }, logger: { warn() {} } });
  assert.deepStrictEqual(broken, { rules: [], basis: 0 });
});

test('describe names what the scout now passes on', () => {
  const s = rl.describe({ rules: [{ dim: 'genre', value: 'comedy', why: 'only memes' }], basis: 3 }, (d, k) => (k === 'comedy' ? 'Comedy' : k));
  assert.strictEqual(s, 'Learned from 3 review notes — passing on creators mostly making: Comedy ("only memes")');
  assert.match(rl.describe({ rules: [], basis: 0 }), /Add a reason when you shortlist or reject/);
});
