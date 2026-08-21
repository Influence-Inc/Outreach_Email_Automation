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
const { sourceNote } = require('./sourcingOrchestrator');
const reelJudge = require('./reelJudge');

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

// Candidates held for human review (decision='review'), newest first, optionally
// scoped to one campaign. Powers the dashboard's "Pending review" queue.
async function listReview({ campaignId = null, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  if (campaignId) {
    return db.many(
      `SELECT * FROM sourced_candidates
        WHERE decision = 'review' AND campaign_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [campaignId, lim],
    );
  }
  return db.many(
    `SELECT * FROM sourced_candidates WHERE decision = 'review' ORDER BY created_at DESC LIMIT $1`,
    [lim],
  );
}

// Approve a reviewed candidate: promote it into the campaign (idempotent) and
// bump the run's found count so the dashboard reflects the manual add.
async function approveCandidate(id) {
  const cand = await getCandidate(id);
  if (!cand) return null;
  if (cand.decision === 'added') return cand;
  const creator = await insertPendingCreator({
    campaignId: cand.campaign_id,
    username: cand.username,
    fullName: cand.full_name,
    firstName: null,
  });
  await db.query(
    `UPDATE sourced_candidates
        SET decision = 'added', creator_id = $2, decided_by = 'human'
      WHERE id = $1`,
    [id, creator.id],
  );
  await db.query(
    `UPDATE sourcing_runs SET found_count = found_count + 1, updated_at = NOW() WHERE id = $1`,
    [cand.run_id],
  );
  return { ...cand, decision: 'added', creator_id: creator.id };
}

async function rejectCandidate(id, reason = 'rejected in review') {
  return db.one(
    `UPDATE sourced_candidates
        SET decision = 'rejected', reject_reason = $2, decided_by = 'human'
      WHERE id = $1
      RETURNING *`,
    [id, reason],
  );
}

async function getCandidate(id) {
  return db.one(`SELECT * FROM sourced_candidates WHERE id = $1`, [id]);
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

// Build the orchestrator deps bound to `run`. `nicheClassify` defaults to the
// composite reel judge (Gemini video when a clip + key are present -> Claude on
// thumbnails/captions -> keyword). Injectable so tests can override it.
function makeDeps(run, { nicheClassify = reelJudge.makeClassifier() } = {}) {
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
      const cols = { decision: true, reject_reason: true, creator_id: true, decided_by: true };
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

    insertCreator: ({ campaignId, username, fullName, firstName, sourcedVia }) =>
      insertPendingCreator({
        campaignId,
        username,
        fullName,
        firstName,
        sourcedVia,
        note: sourcedVia ? sourceNote(sourcedVia) : null,
      }),

    updateRun: (patch) => updateRun(run.id, patch),
  };
}

/**
 * Handles that PASSED the deterministic gate — the only creators the feed
 * warm-up may like (services/feedWarmup.js).
 *
 * Deliberately `decision = 'added'` rather than anything looser: a candidate in
 * review has not been judged good yet, and liking on a raw niche score would
 * teach the feed our keywords instead of our taste.
 */
async function approvedHandles({ campaignId = null, limit = 500 } = {}) {
  const rows = await db.many(
    `SELECT DISTINCT LOWER(username) AS username
       FROM sourced_candidates
      WHERE decision = 'added'
        AND ($1::text IS NULL OR campaign_id = $1)
      ORDER BY 1
      LIMIT $2`,
    [campaignId, Math.max(1, Number(limit) || 500)],
  );
  return rows.map((r) => r.username).filter(Boolean);
}

/**
 * Every creator this campaign has ALREADY looked at, whatever came of it.
 *
 * The unique index on (campaign_id, lower(username)) means a re-scouted creator
 * is dropped at persist time — but that is the very last step, after the phone
 * has opened their profile, scrolled their grid, recorded a reel and paid for a
 * multimodal judgement. The duplicate was always caught; it was just caught
 * after we had spent everything it cost.
 *
 * Deliberately every decision, not just 'added': 'rejected' means we decided
 * against them, 'review' means a human already has them queued, and 'pending'
 * means we looked. All four are creators there is no reason to visit again.
 */
async function scoutedHandles({ campaignId = null, limit = 20000 } = {}) {
  const rows = await db.many(
    `SELECT DISTINCT LOWER(username) AS username
       FROM sourced_candidates
      WHERE ($1::text IS NULL OR campaign_id = $1)
      LIMIT $2`,
    [campaignId, Math.max(1, Number(limit) || 20000)],
  );
  return rows.map((r) => r.username).filter(Boolean);
}

module.exports = {
  createRun,
  getRun,
  listCandidates,
  listReview,
  approveCandidate,
  rejectCandidate,
  getCandidate,
  updateRun,
  approvedHandles,
  scoutedHandles,
  makeDeps,
};
