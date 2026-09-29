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

// ── saving scouting defaults ────────────────────────────────────────────────
//
// The Scout page only knows the fields it shows. Saving from it used to REPLACE
// the stored object, wiping every setting that exists only through the API.

test('saving from the page keeps the settings the page does not show', () => {
  const stored = {
    niche: 'running', floor: 20000,
    targetAudience: 'amateur marathoners 25-40',
    genres: ['running', 'endurance'],
    creatorWeights: { hook: 3, fit: 1 },
    minEngagementRate: 0.02,
    avoidExamples: ['gym meme repost pages'],
    enabled: true,
  };
  const fromPage = { niche: 'trail running', floor: 25000, risk: 'low', reviewBorderline: true };
  const out = sourcing.mergeSourcingDefaults(stored, fromPage);

  assert.strictEqual(out.niche, 'trail running', 'what the page sent wins');
  assert.strictEqual(out.floor, 25000);
  assert.strictEqual(out.risk, 'low');
  assert.strictEqual(out.targetAudience, 'amateur marathoners 25-40', 'API-only settings survive');
  assert.deepStrictEqual(out.genres, ['running', 'endurance']);
  assert.deepStrictEqual(out.creatorWeights, { hook: 3, fit: 1 });
  assert.strictEqual(out.minEngagementRate, 0.02);
  assert.deepStrictEqual(out.avoidExamples, ['gym meme repost pages']);
  assert.strictEqual(out.enabled, true, "the sweeper's auto-enqueue flag survives");
});

test('a field cleared on the page is removed, not left at its old value', () => {
  const out = sourcing.mergeSourcingDefaults({ floor: 20000, ceiling: 500000, niche: 'x' }, { floor: null });
  assert.ok(!('floor' in out), 'null removes the key');
  assert.strictEqual(out.ceiling, 500000);
});

test('merging into nothing, or merging nothing, is safe', () => {
  assert.deepStrictEqual(sourcing.mergeSourcingDefaults(null, { niche: 'x' }), { niche: 'x' });
  assert.deepStrictEqual(sourcing.mergeSourcingDefaults({ niche: 'x' }, {}), { niche: 'x' });
  assert.deepStrictEqual(sourcing.mergeSourcingDefaults(['junk'], { niche: 'x' }), { niche: 'x' });
});

test('a nested setting is replaced whole, as sent', () => {
  const out = sourcing.mergeSourcingDefaults({ creatorWeights: { hook: 3, fit: 1 } }, { creatorWeights: { fit: 2 } });
  assert.deepStrictEqual(out.creatorWeights, { fit: 2 });
});

test('merging never mutates the stored object', () => {
  const stored = { niche: 'x', floor: 1 };
  sourcing.mergeSourcingDefaults(stored, { floor: null, niche: 'y' });
  assert.deepStrictEqual(stored, { niche: 'x', floor: 1 });
});

// ── which judges a run can use ──────────────────────────────────────────────

test('judgeStatus says whether reels are watched, only pictured, or not judged at all', () => {
  const gemini = (on) => ({ available: () => on, model: () => 'gemini-flash-lite-latest' });
  const claude = (on) => ({ getClient: () => (on ? {} : null) });

  assert.deepStrictEqual(sourcing.judgeStatus({ gemini: gemini(true), claude: claude(true) }), {
    gemini: true, geminiModel: 'gemini-flash-lite-latest', claude: true, mode: 'video',
  });
  assert.strictEqual(sourcing.judgeStatus({ gemini: gemini(false), claude: claude(true) }).mode, 'pictures');
  assert.strictEqual(sourcing.judgeStatus({ gemini: gemini(false), claude: claude(false) }).mode, 'none');
  assert.strictEqual(sourcing.judgeStatus({ gemini: gemini(false), claude: claude(false) }).geminiModel, null);
});
