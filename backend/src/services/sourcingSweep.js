'use strict';

// Periodic housekeeping for creator sourcing. Kept in its own module so the
// scheduler wiring stays thin and every branch is unit-testable via injected
// deps (no real DB, no real clock).
//
// Three responsibilities, each idempotent:
//   1. Reap runs that stalled. A run in status='running' whose updated_at is
//      older than a stale threshold means the runner crashed or lost the
//      network; flip it to 'error' with a clear message so it surfaces in the
//      dashboard instead of pretending to be alive.
//   2. Reap stale hosts. sourcing_hosts.status='active' + last_seen_at older
//      than the host stale threshold flips to 'stale'. Revoked hosts are left
//      alone (they've already been dispositioned by an admin).
//   3. Auto-enqueue toward a campaign's target. When a campaign's
//      sourcing_defaults says `enabled: true` and no run is currently
//      running/queued/paused for that campaign, insert one — the runner picks
//      the newest queued run on its next getRun call.

const DEFAULT_STALE_RUN_MINUTES = 15;
const DEFAULT_STALE_HOST_HOURS = 24;

function minutesAgo(min) { return new Date(Date.now() - min * 60_000).toISOString(); }
function hoursAgo(hr) { return new Date(Date.now() - hr * 60 * 60_000).toISOString(); }

// The stats stamped on the reaped run — kept in the same JSONB shape the
// orchestrator writes so the dashboard reads them consistently.
function reapErrorPatch(minutesStale) {
  return {
    status: 'error',
    error: `runner heartbeat lost for >${minutesStale}m — run reaped by sweeper`,
  };
}

async function reapStaleRuns({ db, staleMinutes = DEFAULT_STALE_RUN_MINUTES, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const rows = await db.many(
    `SELECT id FROM sourcing_runs WHERE status = 'running' AND updated_at < $1`,
    [cutoff],
  );
  for (const r of rows) {
    await db.query(
      `UPDATE sourcing_runs
         SET status = 'error',
             error = $2,
             updated_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [r.id, `runner heartbeat lost for >${staleMinutes}m — run reaped by sweeper`],
    );
  }
  return { reaped: rows.length };
}

async function reapStaleHosts({ db, staleHours = DEFAULT_STALE_HOST_HOURS } = {}) {
  const cutoff = hoursAgo(staleHours);
  const rows = await db.many(
    `SELECT id FROM sourcing_hosts
      WHERE status = 'active'
        AND last_seen_at IS NOT NULL
        AND last_seen_at < $1`,
    [cutoff],
  );
  for (const r of rows) {
    await db.query(
      `UPDATE sourcing_hosts SET status = 'stale' WHERE id = $1 AND status = 'active'`,
      [r.id],
    );
  }
  return { reaped: rows.length };
}

// Look for campaigns whose defaults say "enabled: true" and no run is currently
// alive — if so, enqueue a fresh run so a runner polling will find something to
// do. The config is the frozen snapshot of the campaign's sourcing_defaults at
// enqueue time (matches routes/sourcing.js POST /runs behavior).
async function autoEnqueueRuns({ db, buildConfig } = {}) {
  const candidates = await db.many(
    `SELECT c.id, c.sourcing_defaults
       FROM campaigns c
      WHERE c.sourcing_defaults IS NOT NULL
        AND (c.sourcing_defaults->>'enabled') = 'true'
        AND NOT EXISTS (
              SELECT 1 FROM sourcing_runs r
               WHERE r.campaign_id = c.id
                 AND r.status IN ('running','queued','paused')
        )`,
  );
  const created = [];
  for (const c of candidates) {
    const cfg = buildConfig(c.sourcing_defaults, {});
    if (!cfg.targetCount || cfg.targetCount < 1) continue;
    if (!cfg.niche && !cfg.keywords.length) continue;
    const row = await db.one(
      `INSERT INTO sourcing_runs (campaign_id, config, status, target_count, created_by)
       VALUES ($1, $2::jsonb, 'queued', $3, 'auto-sweep')
       RETURNING id`,
      [c.id, JSON.stringify(cfg), cfg.targetCount],
    );
    created.push({ campaignId: c.id, runId: row.id });
  }
  return { enqueued: created.length, runs: created };
}

async function runSweep({ db, buildConfig, staleRunMinutes, staleHostHours } = {}) {
  const a = await reapStaleRuns({ db, staleMinutes: staleRunMinutes });
  const b = await reapStaleHosts({ db, staleHours: staleHostHours });
  const c = await autoEnqueueRuns({ db, buildConfig });
  return { reapedRuns: a.reaped, reapedHosts: b.reaped, enqueued: c.enqueued };
}

module.exports = {
  DEFAULT_STALE_RUN_MINUTES,
  DEFAULT_STALE_HOST_HOURS,
  reapErrorPatch,
  reapStaleRuns,
  reapStaleHosts,
  autoEnqueueRuns,
  runSweep,
};
