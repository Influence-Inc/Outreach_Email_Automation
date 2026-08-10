'use strict';

// Run with: npm test  (node --test)
//
// Guards nextRunStatus() — the rule that decides whether a run's status
// changes when a candidate batch is ingested. This is what makes a run
// created via the dashboard (status='queued', see sourcingStore.createRun)
// discoverable by a persistent runner in RUNNER_RUN_ID=auto mode (which only
// claims 'queued' rows via GET /runs/next): the FIRST successful ingest also
// flips 'queued' -> 'running', so either path (a runner claiming the run, or
// candidates just arriving) converges on the same visible state.
const test = require('node:test');
const assert = require('node:assert');
const sourcing = require('./sourcing');

test('nextRunStatus flips a queued run to running on first activity', () => {
  assert.deepStrictEqual(sourcing.nextRunStatus('queued', false), { status: 'running' });
});

test('nextRunStatus marks done once the target is reached, regardless of prior status', () => {
  assert.deepStrictEqual(sourcing.nextRunStatus('queued', true), { status: 'done' });
  assert.deepStrictEqual(sourcing.nextRunStatus('running', true), { status: 'done' });
});

test('nextRunStatus leaves an already-running run alone', () => {
  assert.deepStrictEqual(sourcing.nextRunStatus('running', false), {});
});

test('nextRunStatus never un-pauses a paused run', () => {
  // A late/straggling candidate batch landing after an admin paused the run
  // must not silently flip it back to running.
  assert.deepStrictEqual(sourcing.nextRunStatus('paused', false), {});
});

test('nextRunStatus leaves error alone (not queued, so no implicit resume)', () => {
  assert.deepStrictEqual(sourcing.nextRunStatus('error', false), {});
});

test('annotateHostHealth marks which host has a live backend session', () => {
  const session = { isActive: (id) => id === 2, activeRunId: (id) => (id === 2 ? 99 : null) };
  const out = sourcing.annotateHostHealth([{ id: 1, label: 'a' }, { id: 2, label: 'b' }], session);
  assert.strictEqual(out[0].sessionActive, false);
  assert.strictEqual(out[0].activeRunId, null);
  assert.strictEqual(out[1].sessionActive, true);
  assert.strictEqual(out[1].activeRunId, 99);
  assert.strictEqual(out[1].label, 'b'); // original fields preserved
});

test('annotateHostHealth tolerates empty input', () => {
  assert.deepStrictEqual(sourcing.annotateHostHealth(null, { isActive: () => false, activeRunId: () => null }), []);
});
