'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cal = require('./jevCalibration');

const unsure = (confidence, decision) => ({ decision, jev: { decision: 'review', unsureAt: confidence, probablyOffAt: null } });
const off = (confidence, decision) => ({ decision, jev: { decision: 'review', unsureAt: null, probablyOffAt: confidence } });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('no review history leaves both bars at the starting point', () => {
  const out = cal.calibrate([]);
  assert.strictEqual(out.shortlistAt, 0.6);
  assert.strictEqual(out.rejectAt, 0.6);
  assert.match(cal.describe(out), /60% sure .* 60% sure — the starting point until there are review decisions/);
});

test('admins shortlisting the creators Jev was unsure of lowers the shortlist bar', () => {
  // Approved every time at 50%+, mixed below.
  const rows = [
    ...many(6, () => unsure(0.55, 'added')),
    ...many(4, () => unsure(0.5, 'added')),
    ...many(3, () => unsure(0.45, 'rejected')),
    ...many(2, () => unsure(0.4, 'rejected')),
  ];
  const out = cal.calibrate(rows);
  assert.strictEqual(out.shortlistAt, 0.5);
  assert.strictEqual(out.rejectAt, 0.6, 'the other bar has no evidence to move on');
  assert.match(cal.describe(out), /50% sure .* learned from 15 review decisions/);
});

test('admins turning down the unsure ones keeps the bar where it is', () => {
  const rows = many(10, (i) => unsure(0.55, i < 5 ? 'added' : 'rejected'));
  assert.strictEqual(cal.calibrate(rows).shortlistAt, 0.6);
});

test('a bar only moves to a confidence admins actually reviewed', () => {
  // Every one approved, but all at 55%: nothing is known about 45-55%.
  assert.strictEqual(cal.calibrate(many(8, () => unsure(0.55, 'added'))).shortlistAt, 0.55);
});

test('too few decisions do not move a bar', () => {
  assert.strictEqual(cal.calibrate(many(4, () => unsure(0.5, 'added'))).shortlistAt, 0.6);
});

test('the bars never go below 45%', () => {
  assert.strictEqual(cal.calibrate(many(20, () => unsure(0.45, 'added'))).shortlistAt, 0.45);
  assert.strictEqual(cal.calibrate(many(20, () => off(0.45, 'rejected'))).rejectAt, 0.45);
  // Approvals only at confidences below the floor are no evidence for any bar it allows.
  assert.strictEqual(cal.calibrate(many(20, () => unsure(0.2, 'added'))).shortlistAt, 0.6);
});

test('admins rejecting the "probably off-target" ones lowers the reject bar', () => {
  const rows = [
    ...many(6, () => off(0.55, 'rejected')),
    ...many(2, () => off(0.45, 'added')),
  ];
  // At 45% admins disagreed too often (6 of 8); at 55% they rejected all 6.
  assert.strictEqual(cal.calibrate(rows).rejectAt, 0.55);
});

test('older decisions are read from the reasons Jev wrote', () => {
  const legacy = (reason, decision) => ({ decision, jev: { decision: 'review', reasons: [reason] } });
  const s = cal.sampleOf(legacy('unsure of the subject: topic Fitness (52%)', 'added'));
  assert.deepStrictEqual(s, { approved: true, unsureAt: 0.52, probablyOffAt: null });
  const o = cal.sampleOf(legacy('probably off-target genre: genre Comedy (48%)', 'rejected'));
  assert.deepStrictEqual(o, { approved: false, unsureAt: null, probablyOffAt: 0.48 });
  assert.strictEqual(cal.sampleOf(legacy('Jev could not tell what the reel is about', 'added')), null);
});

test('a creator held for both kinds of doubt teaches neither bar', () => {
  const both = { decision: 'added', jev: { unsureAt: 0.5, probablyOffAt: 0.5 } };
  const out = cal.calibrate(many(10, () => both));
  assert.strictEqual(out.shortlistAt, 0.6);
  assert.strictEqual(out.rejectAt, 0.6);
});

test('a failed read falls back to the starting point', async () => {
  const out = await cal.load({ db: { many: async () => { throw new Error('db down'); } }, logger: { warn() {} } });
  assert.strictEqual(out.shortlistAt, 0.6);
});
