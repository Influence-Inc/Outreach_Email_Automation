#!/usr/bin/env node
'use strict';

// One-off repair: remove bogus, BODYLESS 'sent_manual_reply' timeline events.
//
// Background: the Instantly email_sent handler treats a send from a
// past-outreach creator as a human "manual reply". But Instantly re-fires
// email_sent as an echo/tracking event for a send we already made — with NO
// body — and the old handler logged those too, producing a contentless "Manual
// reply sent" on the timeline for creators who never actually got a manual
// reply. The code fix now requires a real body before logging a manual reply
// (a genuine Gmail / unibox send always carries the typed body); this script
// cleans up the bodyless rows already logged.
//
// Signal used: a real manual reply always stored its body — detail.snippet is
// set (and a paired kind='manual_reply' thread message exists). The phantoms
// have NEITHER: detail->>'snippet' IS NULL. So a 'sent_manual_reply' event with
// no snippet is exactly a bodyless echo. GENUINE manual sends (with a body /
// snippet) are left completely untouched, whether or not the creator has
// replied — deleting those would erase real activity.
//
// We delete only the bodyless 'sent_manual_reply' events. No thread messages are
// touched: bodyless phantoms never recorded one, and every kind='manual_reply'
// message belongs to a real send we must keep.
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

// A bogus event: type 'sent_manual_reply' with no stored body (snippet). The
// genuine ones always carry detail.snippet, so this never matches a real send.
const BOGUS_WHERE = `
      ee.type = 'sent_manual_reply'
      AND (ee.detail IS NULL OR ee.detail->>'snippet' IS NULL)`;

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const bogus = await db.many(
    `SELECT ee.id AS event_id,
            ee.creator_id,
            ee.created_at,
            c.status,
            c.instagram_username
       FROM email_events ee
       JOIN creators c ON c.id = ee.creator_id
      WHERE ${BOGUS_WHERE}
      ORDER BY ee.creator_id, ee.created_at`,
    [],
  );

  console.log(
    `Found ${bogus.length} bogus, bodyless 'sent_manual_reply' event(s) ` +
      `(contentless "Manual reply sent"):`,
  );
  for (const b of bogus) {
    console.log(
      `  creator ${b.creator_id} @${b.instagram_username || '?'} — status=${b.status}, at ${b.created_at.toISOString?.() || b.created_at}`,
    );
  }

  if (!bogus.length) {
    console.log('Nothing to clean up.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\n--dry-run: no changes written.');
    process.exit(0);
  }

  const del = await db.query(
    `DELETE FROM email_events ee
      WHERE ${BOGUS_WHERE}`,
  );
  console.log(`\n✓ Deleted ${del.rowCount} bodyless 'sent_manual_reply' event(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-bogus-manual-reply] fatal:', err);
  process.exit(1);
});
