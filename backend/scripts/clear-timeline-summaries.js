#!/usr/bin/env node
'use strict';

// One-off maintenance: clear the cached timeline summaries on email_messages so
// they get regenerated with the current (shorter) prompt.
//
// Background: each gist message (creator replies + our manual/delegate replies)
// caches a one-line Claude summary in email_messages.summary. Changing the
// summary prompt only affects NEW summaries — rows summarized under an older
// prompt keep their stale text until the column is cleared. Setting summary back
// to NULL makes the dashboard's read-path backfill regenerate each one (with the
// current prompt) the next time that creator's row is viewed.
//
// Safe: this only nulls a display column. It never touches the message bodies,
// the conversation, statuses, or anything else — and the timeline simply falls
// back to the deterministic gist for the brief moment before each summary is
// regenerated.
//
// Prereqs:  DATABASE_URL   (same env the backend uses)
//
// Usage:
//   node backend/scripts/clear-timeline-summaries.js --dry-run   # preview count only
//   node backend/scripts/clear-timeline-summaries.js             # apply

require('dotenv').config();
const db = require('../src/db');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
  }
  return args;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const { count } = await db.one(
    `SELECT COUNT(*)::int AS count FROM email_messages WHERE summary IS NOT NULL`,
  );

  if (!count) {
    console.log('No cached summaries to clear — nothing to do.');
    process.exit(0);
  }

  if (dryRun) {
    console.log(`--dry-run: would clear ${count} cached summary/summaries. No changes written.`);
    process.exit(0);
  }

  const res = await db.query(`UPDATE email_messages SET summary = NULL WHERE summary IS NOT NULL`);
  console.log(
    `✓ Cleared ${res.rowCount} cached summary/summaries. ` +
      `They regenerate (shorter) as each creator's row is next viewed on the dashboard.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[clear-timeline-summaries] fatal:', err);
  process.exit(1);
});
