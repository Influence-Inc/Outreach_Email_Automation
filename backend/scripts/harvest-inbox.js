#!/usr/bin/env node
'use strict';

// Manual sweep of the connected mailbox (jennifer@useinfluence.xyz) through
// the Instantly API: reconstruct every thread's (creator inbound → manager
// reply) pairs, label each with Claude, and store the keepers in the
// reply_examples table — the in-context-learning bank the negotiation prompt
// picks few-shot examples from.
//
// The scheduler runs the same harvest automatically every LEARN_HARVEST_HOURS;
// this CLI exists for the first big backfill and for ad-hoc re-runs. Re-runs
// are cheap: already-learned pairs are skipped before any Claude call.
//
// (The previous version of this script read Gmail through the OAuth client,
// which was removed when sending moved to Instantly — it had been broken
// since then.)
//
// Prereqs (same env the backend uses):
//   INSTANTLY_API_KEY     (mailbox read access)
//   ANTHROPIC_API_KEY     (used to label each pair)
//   DATABASE_URL          (examples are stored in reply_examples)
//   SENDER_EMAIL          (which From-address counts as "ours"; falls back to
//                          INSTANTLY_EACCOUNT / each email's eaccount field)
//
// Usage:
//   node backend/scripts/harvest-inbox.js                 # default cap (LEARN_HARVEST_MAX_EMAILS or 500)
//   node backend/scripts/harvest-inbox.js --limit 2000    # bigger backfill sweep
//   node backend/scripts/harvest-inbox.js --days 90       # only pairs replied to in the last 90 days
//   node backend/scripts/harvest-inbox.js --dry-run       # label + print per-action counts, store nothing

require('dotenv').config();
const replyLearning = require('../src/services/replyLearning');

function parseArgs(argv) {
  const out = { limit: null, days: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i] || 0) || null;
    else if (a === '--days') out.days = Number(argv[++i] || 0) || null;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node backend/scripts/harvest-inbox.js [--limit N] [--days D] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const since = args.days ? Date.now() - args.days * 24 * 3600_000 : 0;

  const summary = await replyLearning.harvestInbox({
    maxEmails: args.limit || undefined,
    dryRun: args.dryRun,
    since,
  });

  if (summary.skipped) {
    console.error(`[harvest] skipped: ${summary.skipped}`);
    process.exit(1);
  }
  if (summary.perAction && Object.keys(summary.perAction).length) {
    console.log('[harvest] per-action counts:');
    console.table(summary.perAction);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[harvest] fatal:', err);
  process.exit(1);
});
