'use strict';

// Run with: npm test  (node --test)
//
// Guards the outreach {{firstName}} merge-tag fallback: when the scraper
// couldn't find a name for a creator's Instagram profile, the outreach
// email must greet them by @handle instead of an empty string. Fixes the
// jarring "Hi ," greeting.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const outreach = require('./outreach');
const { outreachFirstName, isExplicitFollowupStep, markFollowupSent } = outreach;

test('outreachFirstName uses first_name verbatim when present', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: 'Rabin', instagram_username: 'rabin' }),
    'Rabin',
  );
});

test('outreachFirstName preserves multi-word first_name (e.g. "Anvith K")', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: 'Anvith K', instagram_username: 'anvith' }),
    'Anvith K',
  );
});

test('outreachFirstName falls back to @<handle> when first_name is empty', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: 'rabin' }),
    '@rabin',
  );
  assert.strictEqual(
    outreachFirstName({ first_name: '', instagram_username: 'kota.does.things' }),
    '@kota.does.things',
  );
});

test('outreachFirstName strips any existing @ so we never end up with double @@', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: '@rabin' }),
    '@rabin',
  );
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: '@@rabin' }),
    '@rabin',
  );
});

test('outreachFirstName trims whitespace on first_name before falling back', () => {
  // A whitespace-only first_name is effectively empty — fall back to @handle.
  assert.strictEqual(
    outreachFirstName({ first_name: '   ', instagram_username: 'rabin' }),
    '@rabin',
  );
});

test('outreachFirstName returns "" when neither first_name nor handle exist', () => {
  // Instantly's merge tag will render as empty — better than throwing at
  // send time. This case should be vanishingly rare (a creator row with no
  // Instagram context has no way to reach outreach anyway).
  assert.strictEqual(outreachFirstName({}), '');
  assert.strictEqual(outreachFirstName({ first_name: null, instagram_username: null }), '');
});

// isExplicitFollowupStep decides whether an Instantly email_sent event is a
// follow-up (Step 2+) purely from the step number. Step 1 is the outreach
// email and must NOT be treated as a follow-up.
test('isExplicitFollowupStep treats step >= 2 as a follow-up', () => {
  assert.strictEqual(isExplicitFollowupStep(2), true);
  assert.strictEqual(isExplicitFollowupStep(3), true);
  assert.strictEqual(isExplicitFollowupStep('2'), true); // string from JSON payload
});

test('isExplicitFollowupStep does NOT treat the outreach step (1) as a follow-up', () => {
  assert.strictEqual(isExplicitFollowupStep(1), false);
  assert.strictEqual(isExplicitFollowupStep('1'), false);
  assert.strictEqual(isExplicitFollowupStep(0), false);
});

test('isExplicitFollowupStep is false when the step is missing/unparseable', () => {
  // The time-gap guard in markFollowupSent covers this case instead.
  assert.strictEqual(isExplicitFollowupStep(null), false);
  assert.strictEqual(isExplicitFollowupStep(undefined), false);
  assert.strictEqual(isExplicitFollowupStep('abc'), false);
});

// ── markFollowupSent: the initial Step 1 send must never be mislabeled a
//    follow-up, even when its webhook arrives long after enrollment. ──────────
//
// Regression for the bug where the Deal Studio timeline showed "Follow-up sent"
// for creators who only ever got the outreach email. Instantly batches the
// initial send on its own schedule, so the Step 1 email_sent webhook can land
// well past FOLLOWUP_MIN_GAP_MINUTES after outreach_sent_at (which marks
// enrollment, not the actual send). The elapsed-time fallback then flipped those
// creators to followup_sent. The fix: an explicit step wins over the gap
// heuristic — Step 1 hard-blocks, and the gap fallback is only allowed when the
// step is unknown.
//
// markFollowupSent encodes its decision into the UPDATE's params: $4 = byStep
// (advance because it's Step 2+), $5 = allowGapFallback (fall back to the elapsed
// -time clause). We stub db.query to capture them without a real DB. The SQL is
// guarded so no row would actually change unless the app itself decided it could.
const origQuery = db.query;
function captureFollowupUpdate() {
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  };
  return calls;
}

test('markFollowupSent: known Step 1 never enables the time-gap fallback', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(() => { db.query = origQuery; });
  await markFollowupSent(7, { step: 1, messageId: 'm1' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  assert.ok(update, 'the follow-up UPDATE runs');
  const [, , , byStep, allowGapFallback] = update.params;
  assert.strictEqual(byStep, false, 'Step 1 is not an explicit follow-up');
  assert.strictEqual(
    allowGapFallback,
    false,
    'a known Step 1 must NOT fall through to the elapsed-time clause',
  );
});

test('markFollowupSent: explicit Step 2+ advances via byStep', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(() => { db.query = origQuery; });
  await markFollowupSent(7, { step: 2, messageId: 'm2' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , byStep] = update.params;
  assert.strictEqual(byStep, true, 'Step 2 advances outright, independent of timing');
});

test('markFollowupSent: absent step still permits the time-gap fallback', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(() => { db.query = origQuery; });
  await markFollowupSent(7, { step: null, messageId: 'm3' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , byStep, allowGapFallback] = update.params;
  assert.strictEqual(byStep, false);
  assert.strictEqual(
    allowGapFallback,
    true,
    'with no step, the elapsed-time heuristic is the only signal left',
  );
});
