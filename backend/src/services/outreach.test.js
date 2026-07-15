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
const { outreachFirstName, isExplicitFollowupStep, markFollowupSent, markOutreachSent } = outreach;

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
// for creators who only ever got the outreach email. A first attempt trusted an
// explicit Instantly `step` outright (Step 2+ advances no matter the timing),
// but that alone did NOT stop the mislabeling from recurring in production —
// `step` is not the unimpeachable signal it was assumed to be. The fix now
// requires corroboration: a known Step 2+ must ALSO clear the elapsed-time
// floor, a known Step 1 always hard-blocks, an entirely unknown step falls back
// to the floor alone, and Instantly's `is_first` (when present) hard-blocks
// unconditionally regardless of step or timing.
//
// markFollowupSent encodes its decision into the UPDATE's params: $4 =
// gapEligible (byStep-or-unknown-step, still gated by the floor in SQL), $5 =
// hardBlock (is_first === true, unconditional). We stub db.query to capture
// them without a real DB. The SQL is guarded so no row would actually change
// unless the app itself decided it could.
const origQuery = db.query;
const origOne = db.one;
function captureFollowupUpdate() {
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  };
  // A Step 2+ send whose initial UPDATE doesn't advance falls into the
  // subsequent-follow-up path, which reads db.one to dedupe on message_id.
  // Stub it (no prior follow-up on file) so these tests exercise only the
  // initial UPDATE's params without a real DB.
  db.one = async () => null;
  return calls;
}
function restoreDb() {
  db.query = origQuery;
  db.one = origOne;
}

test('markFollowupSent: known Step 1 is never gap-eligible', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(restoreDb);
  await markFollowupSent(7, { step: 1, messageId: 'm1' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  assert.ok(update, 'the follow-up UPDATE runs');
  const [, , , gapEligible, hardBlock] = update.params;
  assert.strictEqual(gapEligible, false, 'a known Step 1 must never be gap-eligible');
  assert.strictEqual(hardBlock, false);
});

test('markFollowupSent: explicit Step 2+ is gap-eligible but still needs the floor', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(restoreDb);
  await markFollowupSent(7, { step: 2, messageId: 'm2' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , gapEligible] = update.params;
  assert.strictEqual(gapEligible, true, 'Step 2 is gap-eligible');
  assert.match(update.sql, /outreach_sent_at < NOW\(\) - INTERVAL '180 minutes'/,
    'Step 2+ must still clear the elapsed-time floor, not advance on step alone');
});

test('markFollowupSent: absent step still permits the time-gap fallback', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(restoreDb);
  await markFollowupSent(7, { step: null, messageId: 'm3' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , gapEligible] = update.params;
  assert.strictEqual(
    gapEligible,
    true,
    'with no step, the elapsed-time heuristic is the only signal left',
  );
});

test('markFollowupSent: is_first hard-blocks regardless of step or timing', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(restoreDb);
  await markFollowupSent(7, { step: 2, messageId: 'm4', isFirst: true });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , gapEligible, hardBlock] = update.params;
  assert.strictEqual(gapEligible, true, 'step 2 is still gap-eligible on its own');
  assert.strictEqual(hardBlock, true, 'is_first must override an explicit Step 2+');
});

test('markFollowupSent: is_first absent/false does not hard-block', async (t) => {
  const calls = captureFollowupUpdate();
  t.after(restoreDb);
  await markFollowupSent(7, { step: 2, messageId: 'm5' });
  const update = calls.find((c) => /SET status = 'followup_sent'/.test(c.sql));
  const [, , , , hardBlock] = update.params;
  assert.strictEqual(hardBlock, false);
});

// ── Subsequent follow-ups: a 3+-step Instantly campaign keeps firing email_sent
//    events for a creator ALREADY at 'followup_sent'. These are automated
//    follow-ups, NOT the human "manual reply" the webhook otherwise falls back
//    to — the regression that showed "Manual reply sent" on the timeline for
//    creators who only ever got outreach + follow-up emails. ──────────────────
//
// The distinguishing signal is an explicit Step 2+ (a human typing from the
// unibox carries no sequence step). markFollowupSent must return true for such a
// send so the webhook short-circuits before its manual-reply branch.

// Classify the follow-up UPDATEs: the initial advance carries `SET status =
// 'followup_sent'`; the subsequent-follow-up UPDATE only re-stamps timestamps
// (no status change) and is guarded on the creator ALREADY being followup_sent.
function isAdvanceUpdate(sql) {
  return /SET status = 'followup_sent'/.test(sql);
}
function isSubsequentUpdate(sql) {
  return /SET\s+followup_sent_at = NOW\(\)/.test(sql) && !/SET status/.test(sql);
}

test('markFollowupSent: a later Step 3 for a followup_sent creator logs another follow-up, not a manual reply', async (t) => {
  t.after(restoreDb);
  const calls = [];
  db.one = async () => null; // no prior event with this message_id
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (isAdvanceUpdate(sql)) return { rowCount: 0, rows: [] }; // already past outreach_sent
    if (isSubsequentUpdate(sql)) return { rowCount: 1, rows: [] }; // creator IS followup_sent
    return { rowCount: 1, rows: [] }; // the sent_followup INSERT
  };
  const result = await markFollowupSent(9, { step: 3, messageId: 'm-step3' });
  assert.strictEqual(result, true, 'a subsequent automated follow-up is treated as a follow-up');
  const insert = calls.find((c) => /INSERT INTO email_events/.test(c.sql) && /'sent_followup'/.test(c.sql));
  assert.ok(insert, 'the subsequent follow-up is logged as a sent_followup timeline event');
  assert.strictEqual(insert.params[1], 'm-step3');
  assert.strictEqual(insert.params[2].step, 3);
});

test('markFollowupSent: a re-delivered follow-up webhook is not doubled and not a manual reply', async (t) => {
  t.after(restoreDb);
  const calls = [];
  db.one = async () => ({ id: 99 }); // this message_id already logged as a follow-up
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (isAdvanceUpdate(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  };
  const result = await markFollowupSent(9, { step: 2, messageId: 'm-dupe' });
  assert.strictEqual(result, true, 'a redelivered follow-up is still a follow-up, never a manual reply');
  const insert = calls.find((c) => /INSERT INTO email_events/.test(c.sql));
  assert.strictEqual(insert, undefined, 'the duplicate must not add a second timeline row');
});

test('markFollowupSent: an explicit Step 2+ that matches no followup_sent creator falls through (manual-reply path stays intact)', async (t) => {
  t.after(restoreDb);
  db.one = async () => null;
  db.query = async (sql) => {
    if (isAdvanceUpdate(sql)) return { rowCount: 0, rows: [] };
    if (isSubsequentUpdate(sql)) return { rowCount: 0, rows: [] }; // creator is NOT followup_sent
    return { rowCount: 0, rows: [] };
  };
  const result = await markFollowupSent(9, { step: 2, messageId: 'm-x' });
  assert.strictEqual(result, false, 'no follow-up recorded → caller may still treat it as a manual reply');
});

test('markFollowupSent: a stepless send never enters the subsequent-follow-up path', async (t) => {
  t.after(restoreDb);
  let oneCalled = false;
  db.one = async () => { oneCalled = true; return null; };
  db.query = async (sql) => {
    if (isAdvanceUpdate(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  };
  const result = await markFollowupSent(9, { step: null, messageId: 'm-manual' });
  assert.strictEqual(result, false, 'a stepless send (human manual reply) is not a follow-up');
  assert.strictEqual(oneCalled, false, 'the subsequent-follow-up dedupe is skipped without an explicit step');
});

// ── markOutreachSent: the queued → sent transition, driven by Instantly's
//    email_sent webhook confirming the Step 1 send actually went out. ──────────
//
// Enrollment (sendOutreach) only parks the creator in 'outreach_queued'; the
// dashboard must not show "Outreach sent" until this runs. The transition is
// gated purely on the queued status — no reliance on the unreliable step/is_first
// fields — because Instantly can't send a later step before Step 1.

// Stub db.query so the UPDATE reports it changed a row, and capture every call so
// we can assert the follow-on 'sent_outreach' event insert.
function captureOutreachSent({ updated = true } = {}) {
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SET status = 'outreach_sent'/.test(sql)) {
      return { rowCount: updated ? 1 : 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  };
  return calls;
}

test('markOutreachSent: gates on outreach_queued and stamps the real send time', async (t) => {
  const calls = captureOutreachSent();
  t.after(restoreDb);
  const advanced = await markOutreachSent(7, { messageId: 'sent-1' });
  assert.strictEqual(advanced, true, 'a queued creator advances to outreach_sent');
  const update = calls.find((c) => /SET status = 'outreach_sent'/.test(c.sql));
  assert.ok(update, 'the outreach-sent UPDATE runs');
  assert.match(update.sql, /status = 'outreach_queued'/, 'only a queued creator may advance');
  assert.match(update.sql, /outreach_sent_at = NOW\(\)/, 'the confirmed send time is stamped');
});

test('markOutreachSent: logs a sent_outreach event only when the row advanced', async (t) => {
  const calls = captureOutreachSent();
  t.after(restoreDb);
  await markOutreachSent(7, { messageId: 'sent-1' });
  const evt = calls.find((c) => /INSERT INTO email_events/.test(c.sql) && /'sent_outreach'/.test(c.sql));
  assert.ok(evt, 'the sent_outreach timeline event is logged on the confirmed send');
});

test('markOutreachSent: no-op (no event) when the creator was not queued', async (t) => {
  const calls = captureOutreachSent({ updated: false });
  t.after(restoreDb);
  const advanced = await markOutreachSent(7, { messageId: 'sent-1' });
  assert.strictEqual(advanced, false, 'a non-queued creator does not advance');
  const evt = calls.find((c) => /INSERT INTO email_events/.test(c.sql));
  assert.strictEqual(evt, undefined, 'no timeline event is logged when nothing changed');
});
