'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./humanize');

test('jitteredDelay stays within +/- factor of the base, and 0 -> 0', () => {
  assert.strictEqual(h.jitteredDelay(0), 0);
  for (let i = 0; i < 100; i += 1) {
    const d = h.jitteredDelay(1000, Math.random, 0.4);
    assert.ok(d >= 600 && d <= 1400, `delay ${d} out of band`);
  }
  assert.strictEqual(h.jitteredDelay(1000, () => 0.5), 1000); // rng midpoint = base
});

test('jitterTap nudges within +/- px, and px<=0 leaves the point exact', () => {
  const p = { x: 100, y: 200 };
  assert.deepStrictEqual(h.jitterTap(p, 0), p);
  assert.deepStrictEqual(h.jitterTap(p), p); // default px 0
  const j = h.jitterTap(p, 6, () => 1); // rng 1 -> +6 both axes
  assert.deepStrictEqual(j, { x: 106, y: 206 });
  const j2 = h.jitterTap(p, 6, () => 0); // rng 0 -> -6
  assert.deepStrictEqual(j2, { x: 94, y: 194 });
});

test('parseActiveHours reads day + overnight windows, rejects junk', () => {
  assert.deepStrictEqual(h.parseActiveHours('8-23'), { start: 8, end: 23 });
  assert.deepStrictEqual(h.parseActiveHours('22-6'), { start: 22, end: 6 });
  assert.strictEqual(h.parseActiveHours(''), null);
  assert.strictEqual(h.parseActiveHours('nonsense'), null);
});

test('withinActiveHours: no window = always; day + overnight windows', () => {
  assert.strictEqual(h.withinActiveHours(new Date(), ''), true);
  const at = (hour) => new Date(2026, 0, 1, hour, 0, 0);
  assert.strictEqual(h.withinActiveHours(at(10), '8-23'), true);
  assert.strictEqual(h.withinActiveHours(at(2), '8-23'), false);
  assert.strictEqual(h.withinActiveHours(at(23), '8-23'), false); // end exclusive
  // overnight 22-6
  assert.strictEqual(h.withinActiveHours(at(23), '22-6'), true);
  assert.strictEqual(h.withinActiveHours(at(3), '22-6'), true);
  assert.strictEqual(h.withinActiveHours(at(12), '22-6'), false);
});
