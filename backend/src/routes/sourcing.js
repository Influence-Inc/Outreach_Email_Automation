'use strict';

// Creator-sourcing API. All routes sit behind the dashboard's Slack/site-auth gate
// (see server.js); the paired host authenticates with the machine token
// (x-api-token) the same gate accepts, so it can POST captured candidates to
// /runs/:id/candidates.
//
//   Admin:
//     GET   /api/sourcing/config/:campaignId     current scouting defaults
//     PATCH /api/sourcing/config/:campaignId      save scouting defaults
//     POST  /api/sourcing/runs                    start a run for a campaign
//     GET   /api/sourcing/runs/:id                run status + captured candidates
//     POST  /api/sourcing/runs/:id/stop           halt a run
//   Host / ingest:
//     POST  /api/sourcing/runs/:id/candidates     score a captured batch + add passers

const express = require('express');
const db = require('../db');
const store = require('../services/sourcingStore');
const { processCandidate } = require('../services/sourcingOrchestrator');
const { buildConfig } = require('../services/sourcingConfig');

const router = express.Router();

router.get('/config/:campaignId', async (req, res, next) => {
  try {
    const row = await db.one(`SELECT sourcing_defaults FROM campaigns WHERE id = $1`, [
      req.params.campaignId,
    ]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row.sourcing_defaults || {});
  } catch (err) {
    next(err);
  }
});

router.patch('/config/:campaignId', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }
    const row = await db.one(
      `UPDATE campaigns SET sourcing_defaults = $2::jsonb WHERE id = $1 RETURNING sourcing_defaults`,
      [req.params.campaignId, JSON.stringify(body)],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row.sourcing_defaults || {});
  } catch (err) {
    next(err);
  }
});

// Start a scouting run. Freezes the merged (defaults + overrides) config onto the
// run so later edits to the campaign defaults never change an in-flight run.
router.post('/runs', async (req, res, next) => {
  try {
    const { campaign_id, config: override } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });
    const campaign = await db.one(`SELECT id, sourcing_defaults FROM campaigns WHERE id = $1`, [
      campaign_id,
    ]);
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const config = buildConfig(campaign.sourcing_defaults, override);
    if (!config.targetCount || config.targetCount < 1) {
      return res
        .status(400)
        .json({ error: 'targetCount (number of creators to source) is required' });
    }
    if (!config.niche && !config.keywords.length) {
      return res.status(400).json({ error: 'a niche or at least one keyword is required' });
    }

    const run = await store.createRun({
      campaignId: campaign_id,
      config,
      targetCount: config.targetCount,
      createdBy: (req.session && req.session.email) || null,
    });
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const run = await store.getRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'not found' });
    const candidates = await store.listCandidates(run.id);
    res.json({ run, candidates });
  } catch (err) {
    next(err);
  }
});

router.post('/runs/:id/stop', async (req, res, next) => {
  try {
    const run = await store.updateRun(Number(req.params.id), { status: 'stopped' });
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  } catch (err) {
    next(err);
  }
});

// Ingest a batch of captured candidates. The paired host posts here as it scouts;
// each candidate is scored against the run's frozen rules, deduped, and — if it
// passes — added to the campaign. Idempotent per handle (unique index).
router.post('/runs/:id/candidates', async (req, res, next) => {
  try {
    const run = await store.getRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (run.status === 'stopped' || run.status === 'done') {
      return res.status(409).json({ error: `run is ${run.status}` });
    }
    const batch = Array.isArray(req.body && req.body.candidates) ? req.body.candidates : [];
    if (!batch.length) return res.status(400).json({ error: 'candidates array is required' });

    const deps = store.makeDeps(run);
    const results = [];
    for (const cand of batch) {
      const r = await processCandidate(run, run.config, cand, deps);
      results.push({ username: cand && cand.username, ...r });
    }

    // Recompute progress from the DB (added candidates), advance to 'done' at target.
    const { n: found } = await db.one(
      `SELECT COUNT(*)::int AS n FROM sourced_candidates WHERE run_id = $1 AND decision = 'added'`,
      [run.id],
    );
    const done = run.target_count && found >= run.target_count;
    const updated = await store.updateRun(run.id, {
      found_count: found,
      ...(done ? { status: 'done' } : {}),
    });
    res.json({ run: updated, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
