#!/usr/bin/env node
'use strict';

// One-off repair: remove bogus 'sent_manual_reply' timeline events (and their
// paired thread messages) that were logged for automated follow-ups.
//
// Background: the Instantly email_sent handler advances outreach_sent →
// followup_sent for the FIRST follow-up, but a campaign with 3+ sequence steps
// keeps firing email_sent for a creator already at 'followup_sent'. The old
// code couldn't advance those (the guard requires status='outreach_sent'), so
// they fell through to the "manual reply" branch and were logged as
// 'sent_manual_reply' — the timeline then showed "Manual reply sent" for
// creators who only ever got outreach + follow-up emails. (A redelivered
// follow-up webhook hit the same path.) The code fix (markFollowupSent now owns
// subsequent follow-ups and redeliveries) stops new occurrences; this script
// cleans up the rows already corrupted.
//
// Signal used — airtight for this system's flow: a genuine manual reply is only
// ever sent in RESPONSE to a creator's reply. So a 'sent_manual_reply' on a
// creator with NO inbound reply on record (no 'replied' event AND no inbound
// email_messages row) cannot be a real manual reply — there was nothing to
// reply to. Those are the mislabeled automated follow-ups. Creators who have
// since replied / negotiated are left completely untouched, because for them a
// manual reply is plausible and we can't safely tell it apart.
//
// We, for each such creator:
//   1. delete their 'sent_manual_reply' events (removes "Manual reply sent"),
//   2. delete their kind='manual_reply' thread messages (the follow-up template
//      wrongly stored as a human reply, which would otherwise pollute the
//      context handed to the next auto-reply).
// Creator status / flags are NOT touched — needs_human was already clear and
// the funnel status was never changed by a manual-reply log.
//
// The deletes run in a single transaction.
//
// Prereqs:  DATABASE_URL   (same env the backend uses)
//
// Usage:
//   node backend/scripts/fix-bogus-manual-reply.js --dry-run   # preview only
//   node backend/scripts/fix-bogus-manual-reply.js             # apply

require('dotenv').config();
const db = require('../src/db');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
  }
  return args;
}

// A creator qualifies when they have at least one 'sent_manual_reply' event but
// have NEVER received an inbound reply — no 'replied' email_event and no inbound
// email_messages row. Such a manual reply is impossible-by-definition, so every
// 'sent_manual_reply' on the row is a mislabeled automated follow-up.
const HAS_NO_INBOUND = `
    NOT EXISTS (
      SELECT 1 FROM email_events e2
       WHERE e2.creator_id = c.id AND e2.type = 'replied'
    )
    AND NOT EXISTS (
      SELECT 1 FROM email_messages m
       WHERE m.creator_id = c.id AND m.direction = 'inbound'
    )`;

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  // Preview: every creator with a bogus manual reply (no inbound on record).
  const affected = await db.many(
    `SELECT c.id,
            c.status,
            c.negotiation_status,
            c.instagram_username,
            COUNT(ee.id) AS manual_reply_events
       FROM creators c
       JOIN email_events ee
         ON ee.creator_id = c.id AND ee.type = 'sent_manual_reply'
      WHERE ${HAS_NO_INBOUND}
      GROUP BY c.id
      ORDER BY c.id`,
    [],
  );

  console.log(
    `Found ${affected.length} creator(s) with a bogus 'sent_manual_reply' (no inbound reply on record):`,
  );
  for (const c of affected) {
    console.log(
      `  creator ${c.id} @${c.instagram_username || '?'} — status=${c.status}` +
        `${c.negotiation_status ? `/${c.negotiation_status}` : ''}, ` +
        `${c.manual_reply_events} manual-reply event(s)`,
    );
  }

  if (!affected.length) {
    console.log('Nothing to clean up.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\n--dry-run: no changes written.');
    process.exit(0);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const delEvents = await client.query(
      `DELETE FROM email_events ee
        USING creators c
        WHERE ee.creator_id = c.id
          AND ee.type = 'sent_manual_reply'
          AND ${HAS_NO_INBOUND}`,
    );

    // The paired thread messages (the follow-up template wrongly stored as a
    // human reply). Safe to remove for these creators: with no inbound, every
    // 'manual_reply' message on the row is one of the bogus follow-ups.
    const delMessages = await client.query(
      `DELETE FROM email_messages m
        USING creators c
        WHERE m.creator_id = c.id
          AND m.kind = 'manual_reply'
          AND ${HAS_NO_INBOUND}`,
    );

    await client.query('COMMIT');
    console.log(
      `\n✓ Deleted ${delEvents.rowCount} bogus 'sent_manual_reply' event(s) and ` +
        `${delMessages.rowCount} paired thread message(s) across ${affected.length} creator(s).`,
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
  console.error('[fix-bogus-manual-reply] fatal:', err);
  process.exit(1);
});
