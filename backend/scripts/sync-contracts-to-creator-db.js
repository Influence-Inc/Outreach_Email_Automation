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
const creatorDb = require('../src/services/creatorDb');
const contracts = require('../src/services/contracts');

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

  if (!creatorDb.isConfigured()) {
    console.error(
      'CREATOR_DB_URL is not set. Set CREATOR_DB_URL (+ CREATOR_DB_API_KEY) before running.',
    );
    process.exit(1);
  }

  // Signed + completed contracts carry the full signing submission we forward.
  const rows = only
    ? await db.many(`SELECT * FROM contracts WHERE token = $1`, [only])
    : await db.many(
        `SELECT * FROM contracts
          WHERE status IN ('signed', 'completed')
          ORDER BY signed_at ASC NULLS LAST${limit ? ` LIMIT ${limit}` : ''}`,
      );

  console.log(`Found ${rows.length} contract(s) to sync${dryRun ? ' (dry run)' : ''}.`);

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const contract of rows) {
    let creator;
    try {
      creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [contract.creator_id]);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${contract.token}: creator ${contract.creator_id} not found`);
      continue;
    }

    const who = creator.email || creator.instagram_username || creator.full_name || contract.token;

    if (dryRun) {
      console.log(`  • would sync ${contract.token} (${who}, status=${contract.status})`);
      continue;
    }

    try {
      const res = await creatorDb.syncSignedCreator(contract, creator);
      await contracts.markSynced(contract.token, true);
      if (res && res.created) created += 1;
      else updated += 1;
      console.log(`  ✓ ${contract.token} (${who}) → creator ${res && res.creatorId}`);
    } catch (err) {
      failed += 1;
      await contracts.markSynced(contract.token, false, { error: err.message }).catch(() => {});
      console.error(`  ✗ ${contract.token} (${who}): ${err.message}`);
    }
  }

  if (!dryRun) {
    console.log(`\nDone. created=${created} updated=${updated} failed=${failed}`);
  }
  await db.pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
