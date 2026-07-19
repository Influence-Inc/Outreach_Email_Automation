'use strict';

// Shared backfill: push already-signed contracts into the campaign dashboard.
// Used by BOTH the CLI (scripts/sync-contracts-to-dashboard.js) and the HTTP
// trigger (POST /api/bot/sync-contracts-to-dashboard), so they behave
// identically. Mirrors contractBackfill.js (Creator-DB) — the two syncs are
// independent, so a contract can need re-pushing to one without the other.
//
// Idempotent: the dashboard upserts on (campaignId, username), so re-runs
// update rather than duplicate.

const db = require('../db');
const campaignDashboard = require('./campaignDashboard');
const contracts = require('./contracts');

/**
 * Re-push signed/completed contracts to the campaign dashboard.
 * @param {object} opts
 * @param {boolean} [opts.dryRun]  list matches without pushing
 * @param {number}  [opts.limit]   cap how many to process
 * @param {string}  [opts.only]    a single contract token
 * @returns {Promise<{total:number,dryRun:boolean,created:number,updated:number,failed:number,items:Array}>}
 */
async function runBackfill({ dryRun = false, limit = null, only = null } = {}) {
  if (!campaignDashboard.isConfigured()) {
    const err = new Error('CAMPAIGN_DASHBOARD_URL is not set');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const rows = only
    ? await db.many(`SELECT * FROM contracts WHERE token = $1`, [only])
    : await db.many(
        `SELECT * FROM contracts
          WHERE status IN ('signed', 'completed')
          ORDER BY signed_at ASC NULLS LAST${cap ? ` LIMIT ${cap}` : ''}`,
      );

  const result = { total: rows.length, dryRun, created: 0, updated: 0, failed: 0, items: [] };

  for (const contract of rows) {
    let creator;
    try {
      creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [contract.creator_id]);
    } catch {
      result.failed += 1;
      result.items.push({ token: contract.token, ok: false, error: 'creator not found' });
      continue;
    }

    const who = creator.email || creator.instagram_username || creator.full_name || contract.token;

    if (dryRun) {
      result.items.push({ token: contract.token, who, status: contract.status, wouldSync: true });
      continue;
    }

    try {
      const res = await campaignDashboard.syncSignedCreator(contract, creator);
      await contracts.markDashboardSynced(contract.token, true);
      if (res && res.created) result.created += 1;
      else result.updated += 1;
      result.items.push({ token: contract.token, who, ok: true, creatorId: res && res.creatorId });
    } catch (err) {
      result.failed += 1;
      await contracts.markDashboardSynced(contract.token, false, { error: err.message }).catch(() => {});
      result.items.push({ token: contract.token, who, ok: false, error: err.message });
    }
  }

  return result;
}

module.exports = { runBackfill };
