'use strict';

// DB-backed persistence + orchestrator wiring for creator sourcing. Keeps all the
// SQL for sourcing_runs / sourced_candidates in one place, and builds the injected
// `deps` object the sourcingOrchestrator consumes — reusing duplicateGuard for
// in-campaign dedup, creatorDb for the Used-creator filter, and creatorInsert for
// promoting a passing candidate into the campaign.

const db = require('../db');
const { findDuplicateCreator } = require('./duplicateGuard');
const creatorDb = require('./creatorDb');
const { insertPendingCreator } = require('./creatorInsert');

// Created as 'queued', matching services/sourcingSweep.js's autoEnqueueRuns —
// both paths that CREATE a run agree it starts life unclaimed. A run only
// becomes 'running' once a runner actually claims it (GET /runs/next) or its
// first candidate batch lands (POST /runs/:id/candidates). That's what makes
// a persistent runner in RUNNER_RUN_ID=auto mode able to discover a run the
// instant an admin clicks "Start scouting run" on the dashboard — before this
// fix, a manually-started run was inserted as 'running' directly, which
// /runs/next's `WHERE status = 'queued'` claim query could never see.
async function createRun({ campaignId, config, targetCount, createdBy = null, hostId = null }) {
  return db.one(
    `INSERT INTO sourcing_runs (campaign_id, host_id, config, status, target_count, created_by)
     VALUES ($1, $2, $3::jsonb, 'queued', $4, $5)
     RETURNING *`,
    [campaignId, hostId, JSON.stringify(config), targetCount, createdBy],
  );
}

async function getRun(id) {
  return db.one(`SELECT * FROM sourcing_runs WHERE id = $1`, [id]);
}

async function listCandidates(runId) {
  return db.many(
    `SELECT * FROM sourced_candidates WHERE run_id = $1 ORDER BY created_at ASC, id ASC`,
    [runId],
  );
}

const RUN_COLS = { found_count: '', status: '', stats: '::jsonb', error: '', host_id: '' };

async function updateRun(id, patch) {
  const sets = [];
  const params = [id];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in RUN_COLS)) continue;
    params.push(k === 'stats' ? JSON.stringify(v) : v);
    sets.push(`${k} = $${params.length}${RUN_COLS[k]}`);
  }
  if (!sets.length) return getRun(id);
  sets.push('updated_at = NOW()');
  return db.one(`UPDATE sourcing_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
}

// Build the orchestrator deps bound to `run`. `nicheClassify` is optional (the
// filters fall back to keyword scoring, and to Claude by default).
function makeDeps(run, { nicheClassify } = {}) {
  return {
    nicheClassify,

    // ON CONFLICT DO NOTHING enforces the (campaign, LOWER(username)) unique index
    // — a duplicate capture returns no row, which the orchestrator treats as
    // "already scouted" (skipped).
    async persistCandidate(rec) {
      return db.one(
        `INSERT INTO sourced_candidates
           (run_id, campaign_id, username, full_name, followers, bio, reels,
            niche_score, niche_reason, view_floor_pass, risk_profile,
            stability_score, growth_trend, decision, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         ON CONFLICT (campaign_id, LOWER(username)) DO NOTHING
         RETURNING *`,
        [
          rec.run_id,
          rec.campaign_id,
          rec.username,
          rec.full_name,
          rec.followers,
          rec.bio,
          JSON.stringify(rec.reels || []),
          rec.niche_score,
          rec.niche_reason,
          rec.view_floor_pass,
          rec.risk_profile,
          rec.stability_score,
          rec.growth_trend,
          rec.decision || 'pending',
          rec.evidence ? JSON.stringify(rec.evidence) : null,
        ],
      );
    },

    async updateCandidate(id, patch) {
      const cols = { decision: true, reject_reason: true, creator_id: true };
      const sets = [];
      const params = [id];
      for (const [k, v] of Object.entries(patch || {})) {
        if (!cols[k]) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      if (!sets.length) return;
      await db.query(`UPDATE sourced_candidates SET ${sets.join(', ')} WHERE id = $1`, params);
    },

    findDuplicate: ({ campaignId, username, email }) =>
      findDuplicateCreator({ campaignId, username, email, excludeUrl: null }),

    async isUsed(username) {
      const res = await creatorDb.categorizeCreators([{ instagramUsername: username }]);
      return Array.isArray(res) && res[0] && res[0].category === 'used';
    },

    insertCreator: ({ campaignId, username, fullName, firstName }) =>
      insertPendingCreator({ campaignId, username, fullName, firstName }),

    updateRun: (patch) => updateRun(run.id, patch),
  };
}

module.exports = { createRun, getRun, listCandidates, updateRun, makeDeps };
