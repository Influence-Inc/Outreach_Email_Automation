#!/usr/bin/env node
'use strict';

// One-time backfill: push every already-signed contract into the Creator
// Database. The live flow only syncs a contract at the moment it's signed
// (routes/contracts.js), so contracts signed BEFORE the Creator-DB integration
// was configured never made it across. This walks them and re-pushes each one.
//
// Idempotent: the Creator-DB upserts on the contract token, so re-running this
// updates rather than duplicates. Safe to run repeatedly.
//
// Prereqs (same env the backend uses):
//   DATABASE_URL          the Outreach Postgres (the contracts live here)
//   CREATOR_DB_URL        the Creator-DB base URL
//                         (e.g. https://creator-database-production.up.railway.app)
//   CREATOR_DB_API_KEY    must equal the Creator-DB's INTERNAL_API_KEY
//
// Usage:
//   node backend/scripts/sync-contracts-to-creator-db.js               # sync all signed/completed
//   node backend/scripts/sync-contracts-to-creator-db.js --dry-run     # list, don't push
//   node backend/scripts/sync-contracts-to-creator-db.js --limit 50    # cap how many
//   node backend/scripts/sync-contracts-to-creator-db.js --only <token>  # a single contract

require('dotenv').config();
const db = require('../src/db');
const { runBackfill } = require('../src/services/contractBackfill');

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || null;
    else if (a === '--only') args.only = argv[++i] || null;
  }
  return args;
}

async function main() {
  const { dryRun, limit, only } = parseArgs(process.argv.slice(2));

  let result;
  try {
    result = await runBackfill({ dryRun, limit, only });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      console.error(
        'CREATOR_DB_URL is not set. Set CREATOR_DB_URL (+ CREATOR_DB_API_KEY) before running.',
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(`Found ${result.total} contract(s) to sync${dryRun ? ' (dry run)' : ''}.`);
  for (const item of result.items) {
    if (item.wouldSync) console.log(`  • would sync ${item.token} (${item.who}, status=${item.status})`);
    else if (item.ok) console.log(`  ✓ ${item.token} (${item.who}) → creator ${item.creatorId}`);
    else console.error(`  ✗ ${item.token} (${item.who || ''}): ${item.error}`);
  }
  if (!dryRun) {
    console.log(`\nDone. created=${result.created} updated=${result.updated} failed=${result.failed}`);
  }

  await db.pool.end();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
