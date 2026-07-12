#!/usr/bin/env node
'use strict';

// One-off repair: re-pin an existing contract's usage-rights fields to the
// policy-correct values. Built for contracts generated BEFORE the usage-rights
// pinning fix, where the free-form extraction may have wrongly dropped paid ad
// rights on a "free_only" (Okay if free) campaign even though the creator never
// negotiated them away.
//
// It only touches the usageRights / paidAdsIncluded fields (via the same
// resolveUsageRights logic used at contract creation) — no other term is
// changed. It refuses to alter a SIGNED contract (that's a human amendment),
// and logs a 'contract_usage_rights_repaired' email_event for the audit trail.
//
// Prereqs (same env the backend uses):
//   DATABASE_URL          (the contract lives here)
//   ANTHROPIC_API_KEY     (optional — sharpens the free_only "negotiated away?"
//                          check; without it a conservative rule runs and keeps
//                          rights included unless the thread clearly charges for
//                          them)
//
// Usage:
//   node backend/scripts/fix-contract-usage-rights.js <token>
//   node backend/scripts/fix-contract-usage-rights.js --dry-run <token>   # preview only

require('dotenv').config();
const db = require('../src/db');
const contracts = require('../src/services/contracts');

function parseArgs(argv) {
  const args = { dryRun: false, token: null };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (!a.startsWith('-') && !args.token) args.token = a;
  }
  return args;
}

async function main() {
  const { token, dryRun } = parseArgs(process.argv.slice(2));
  if (!token) {
    console.error('usage: node backend/scripts/fix-contract-usage-rights.js [--dry-run] <token>');
    process.exit(1);
  }

  const existing = await contracts.getByToken(token);
  if (!existing) {
    console.error(`No contract found for token ${token}`);
    process.exit(1);
  }
  if (existing.status !== 'pending') {
    console.error(
      `Contract ${token} is ${existing.status} (not pending) — refusing to alter it. ` +
        'A signed/completed contract is executed; a human must handle any amendment.',
    );
    process.exit(1);
  }

  const before = {
    usageRights: existing.data ? existing.data.usageRights : undefined,
    paidAdsIncluded: existing.data ? existing.data.paidAdsIncluded : undefined,
  };
  console.log(`Contract ${token} (creator_id ${existing.creator_id}, status ${existing.status})`);
  console.log('  before:', JSON.stringify(before));

  if (dryRun) {
    console.log('  --dry-run: no changes written.');
    process.exit(0);
  }

  const res = await contracts.syncUsageRightsForContract(token);
  if (res.missing) {
    console.error(`Could not repair ${token} — contract or creator missing.`);
    process.exit(1);
  }
  if (res.signed) {
    console.error(`Contract ${token} is signed — not altering.`);
    process.exit(1);
  }
  console.log('  after: ', JSON.stringify(res.after));
  console.log(res.changed ? '  ✓ usage rights corrected.' : '  = already correct (no change).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-contract-usage-rights] fatal:', err);
  process.exit(1);
});
