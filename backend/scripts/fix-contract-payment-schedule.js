#!/usr/bin/env node
'use strict';

// One-off repair: re-pin an existing contract's payment-schedule fields to the
// thread-correct values. Built for contracts generated BEFORE the payment-
// schedule fix, which ALL carried the "30% upfront, 70% on completion" split
// whether or not the creator ever asked to be prepaid — the reported bug.
//
// It only touches the upfront/remainder fields (via the same
// resolvePaymentSchedule logic used at contract creation): the split stays ONLY
// when the creator explicitly demanded upfront payment in the thread, otherwise
// it's removed and the contract reads "paid in full on completion". No other
// term is changed. It refuses to alter a SIGNED contract (that's a human
// amendment), and logs a 'contract_payment_schedule_repaired' email_event for
// the audit trail.
//
// Prereqs (same env the backend uses):
//   DATABASE_URL          (the contract lives here)
//   ANTHROPIC_API_KEY     (optional — sharpens the "did the creator demand
//                          upfront?" check; without it a conservative keyword
//                          rule runs and keeps the schedule OFF unless the
//                          thread clearly asks for an advance/deposit)
//
// Usage:
//   node backend/scripts/fix-contract-payment-schedule.js <token>
//   node backend/scripts/fix-contract-payment-schedule.js --dry-run <token>   # preview only

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
    console.error('usage: node backend/scripts/fix-contract-payment-schedule.js [--dry-run] <token>');
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
    upfrontPercent: existing.data ? existing.data.upfrontPercent : undefined,
    remainderPercent: existing.data ? existing.data.remainderPercent : undefined,
  };
  console.log(`Contract ${token} (creator_id ${existing.creator_id}, status ${existing.status})`);
  console.log('  before:', JSON.stringify(before));

  if (dryRun) {
    console.log('  --dry-run: no changes written.');
    process.exit(0);
  }

  const res = await contracts.syncPaymentScheduleForContract(token);
  if (res.missing) {
    console.error(`Could not repair ${token} — contract or creator missing.`);
    process.exit(1);
  }
  if (res.signed) {
    console.error(`Contract ${token} is signed — not altering.`);
    process.exit(1);
  }
  console.log('  after: ', JSON.stringify({
    upfrontPercent: res.after.upfrontPercent,
    remainderPercent: res.after.remainderPercent,
  }));
  console.log(res.changed ? '  ✓ payment schedule corrected.' : '  = already correct (no change).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-contract-payment-schedule] fatal:', err);
  process.exit(1);
});
