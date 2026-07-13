#!/usr/bin/env node
'use strict';

// One-off repair: undo creators that were wrongly flipped to 'followup_sent'
// (and stamped with a bogus 'sent_followup' timeline event) by the old
// markFollowupSent time-gap heuristic.
//
// Background: markFollowupSent used to advance a creator to followup_sent when
// an Instantly email_sent webhook arrived more than 10 minutes after
// outreach_sent_at. But outreach_sent_at marks ENROLLMENT, not the actual send —
// Instantly batches/schedules the initial Step 1 send, so the outreach's own
// email_sent webhook can land past that gap and get mislabeled as a follow-up.
// The code fix (trust Instantly's explicit step) stops new occurrences; this
// script cleans up the rows already corrupted.
//
// Signal used: no genuine Step 2+ follow-up is ever sent within 24h of the
// outreach email, so ANY 'sent_followup' event within 24h of the creator's
// outreach_sent_at is definitely the mislabeled initial send. We:
//   1. delete those bogus 'sent_followup' events (removes "Follow-up sent" from
//      the timeline), and
//   2. revert the creator to 'outreach_sent' — clearing followup_sent_at /
//      _message_id / _step — but ONLY when they are still sitting on
//      followup_sent AND have no OTHER (genuine, >24h) follow-up event left.
//      Creators who since replied / negotiated / accepted keep their status; a
//      real later follow-up (>24h) is left untouched.
//
// The delete + revert run in a single transaction.
//
// Prereqs:  DATABASE_URL   (same env the backend uses)
//
// Usage:
//   node backend/scripts/fix-bogus-followup-status.js --dry-run   # preview only
//   node backend/scripts/fix-bogus-followup-status.js             # apply
//   node backend/scripts/fix-bogus-followup-status.js --window-hours 24

require('dotenv').config();
const db = require('../src/db');

function parseArgs(argv) {
  const args = { dryRun: false, windowHours: 24 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--window-hours') args.windowHours = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const { dryRun, windowHours } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    console.error('--window-hours must be a positive number');
    process.exit(1);
  }
  const iv = `${windowHours} hours`;

  // Preview: every bogus 'sent_followup' event (within the window of outreach).
  const bogus = await db.many(
    `SELECT ee.id AS event_id,
            ee.creator_id,
            ee.created_at AS followup_at,
            ee.detail,
            c.status,
            c.instagram_username,
            c.outreach_sent_at,
            EXTRACT(EPOCH FROM (ee.created_at - c.outreach_sent_at)) / 60 AS gap_minutes
       FROM email_events ee
       JOIN creators c ON c.id = ee.creator_id
      WHERE ee.type = 'sent_followup'
        AND c.outreach_sent_at IS NOT NULL
        AND ee.created_at < c.outreach_sent_at + INTERVAL '${iv}'
      ORDER BY ee.creator_id, ee.created_at`,
    [],
  );

  console.log(
    `Found ${bogus.length} bogus 'sent_followup' event(s) within ${windowHours}h of outreach_sent_at:`,
  );
  for (const b of bogus) {
    const gap = b.gap_minutes != null ? `${Math.round(b.gap_minutes)}m after outreach` : 'n/a';
    const step = b.detail && b.detail.step != null ? `step=${b.detail.step}` : 'step=null';
    console.log(
      `  creator ${b.creator_id} @${b.instagram_username || '?'} — status=${b.status}, ${gap}, ${step}`,
    );
  }

  if (!bogus.length) {
    console.log('Nothing to clean up.');
    process.exit(0);
  }

  if (dryRun) {
    // Show which creators WOULD be reverted (still on followup_sent, no genuine
    // follow-up outside the window).
    const wouldRevert = await db.many(
      `SELECT c.id, c.instagram_username
         FROM creators c
        WHERE c.status = 'followup_sent'
          AND c.outreach_sent_at IS NOT NULL
          AND c.followup_sent_at < c.outreach_sent_at + INTERVAL '${iv}'
          AND NOT EXISTS (
            SELECT 1 FROM email_events ee
             WHERE ee.creator_id = c.id
               AND ee.type = 'sent_followup'
               AND ee.created_at >= c.outreach_sent_at + INTERVAL '${iv}'
          )
        ORDER BY c.id`,
      [],
    );
    console.log(
      `\n--dry-run: would delete ${bogus.length} event(s) and revert ${wouldRevert.length} ` +
        `creator(s) to 'outreach_sent':`,
    );
    for (const c of wouldRevert) console.log(`  creator ${c.id} @${c.instagram_username || '?'}`);
    console.log('No changes written.');
    process.exit(0);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const del = await client.query(
      `DELETE FROM email_events ee
        USING creators c
        WHERE ee.creator_id = c.id
          AND ee.type = 'sent_followup'
          AND c.outreach_sent_at IS NOT NULL
          AND ee.created_at < c.outreach_sent_at + INTERVAL '${iv}'`,
    );

    // Revert only creators still parked on the bogus followup_sent state with no
    // genuine (outside-window) follow-up remaining. Runs after the delete so the
    // NOT EXISTS reflects the post-cleanup event set.
    const rev = await client.query(
      `UPDATE creators c
          SET status = 'outreach_sent',
              followup_sent_at = NULL,
              followup_message_id = NULL,
              followup_step = 0,
              updated_at = NOW()
        WHERE c.status = 'followup_sent'
          AND c.outreach_sent_at IS NOT NULL
          AND c.followup_sent_at < c.outreach_sent_at + INTERVAL '${iv}'
          AND NOT EXISTS (
            SELECT 1 FROM email_events ee
             WHERE ee.creator_id = c.id AND ee.type = 'sent_followup'
          )`,
    );

    await client.query('COMMIT');
    console.log(
      `\n✓ Deleted ${del.rowCount} bogus 'sent_followup' event(s); ` +
        `reverted ${rev.rowCount} creator(s) to 'outreach_sent'.`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-bogus-followup-status] fatal:', err);
  process.exit(1);
});
