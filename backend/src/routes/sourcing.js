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
const { generateToken, hashToken, requireHostOrSlack } = require('../services/hostTokens');
const hostChannel = require('../services/hostChannel');

const router = express.Router();

// Feature gate: everything under Live Mirror only exists when SOURCING_LIVE_MIRROR=on.
// Kept as its own middleware so removing the env var flips the whole surface off
// (frame upload, latest-frame read, control push, control drain) with no code change.
function requireLiveMirror(_req, res, next) {
  if (!hostChannel.enabled()) return res.status(404).json({ error: 'live mirror disabled' });
  next();
}

// --- Paired hosts (per-runner token pairing) -------------------------------
// Mint/list/revoke are admin-only — they sit behind the top-level siteAuth gate
// mounted in server.js, so only a signed-in dashboard user reaches them. The
// runner-facing routes further down use requireHostOrSlack, which accepts EITHER
// a dashboard session or a valid per-host token (see services/hostTokens.js).

// POST /api/sourcing/hosts { label, platforms:['android',...] }
// Returns { id, label, platforms, status, token } — token is the PLAINTEXT and
// is only shown here, once. Copy it into the runner's RUNNER_HOST_TOKEN env.
// Android only — the runner has no iOS driver (see runner/README.md).
router.post('/hosts', async (req, res, next) => {
  try {
    const body = req.body || {};
    const label = String(body.label || '').trim();
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p) => p === 'android')
      : [];
    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!platforms.length) return res.status(400).json({ error: 'platforms must include android' });

    const token = generateToken();
    const row = await db.one(
      `INSERT INTO sourcing_hosts (label, platforms, token_hash, status)
       VALUES ($1, $2::jsonb, $3, 'active')
       RETURNING id, label, platforms, status, last_seen_at, created_at`,
      [label, JSON.stringify(platforms), hashToken(token)],
    );
    res.status(201).json({ ...row, token });
  } catch (err) {
    next(err);
  }
});

router.get('/hosts', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT id, label, platforms, status, last_seen_at, created_at
       FROM sourcing_hosts ORDER BY created_at DESC`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Revoke: flip status to 'revoked' rather than deleting so any historical
// run.host_id references (once wired) still resolve to a labelled row.
router.delete('/hosts/:id', async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE sourcing_hosts SET status = 'revoked' WHERE id = $1 RETURNING id, status`,
      [Number(req.params.id)],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

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

// Runner in RUNNER_RUN_ID=auto mode polls this endpoint for the newest queued
// run and takes ownership by flipping status to 'running'. Registered BEFORE
// /runs/:id so the literal segment isn't parsed as an id.
router.get('/runs/next', requireHostOrSlack, async (_req, res, next) => {
  try {
    // FOR UPDATE SKIP LOCKED so two runners polling at the same time each claim
    // a distinct run instead of racing.
    const run = await db.withTransaction(async (client) => {
      const picked = await client.query(
        `SELECT id FROM sourcing_runs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (!picked.rows.length) return null;
      const r = await client.query(
        `UPDATE sourcing_runs
            SET status = 'running', updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [picked.rows[0].id],
      );
      return r.rows[0];
    });
    if (!run) return res.status(204).end();
    res.json({ run });
  } catch (err) {
    next(err);
  }
});

// The runner and the dashboard both need to read run state, so this route
// accepts either a signed-in Slack session (dashboard) or a valid per-host
// token (runner). Same widening applies to /runs/:id/candidates below.
router.get('/runs/:id', requireHostOrSlack, async (req, res, next) => {
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
router.post('/runs/:id/candidates', requireHostOrSlack, async (req, res, next) => {
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

// --- Live screen mirror + human take-over ---------------------------------
// Runner uploads the latest phone frame every N seconds; dashboards render it.
// Admins post control instructions (tap/swipe/type/home/pause/resume) which the
// runner drains on its next poll. All in-memory (see services/hostChannel.js).

// Runner → backend: publish the latest phone frame.
router.post('/hosts/:id/frame', requireLiveMirror, requireHostOrSlack, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = hostChannel.publishFrame(Number(req.params.id), body);
    res.json({ ok: true, bytes: result.bytes });
  } catch (err) {
    // publishFrame throws on validation issues; surface them as 400s.
    if (/empty frame|too large/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Dashboard → backend: read the latest phone frame as an image (or 204 if stale).
router.get('/hosts/:id/frame', requireLiveMirror, async (req, res, next) => {
  try {
    const f = hostChannel.latestFrame(Number(req.params.id));
    if (!f) return res.status(204).end();
    res.set('Content-Type', f.mediaType);
    res.set('Cache-Control', 'no-store');
    if (f.width) res.set('X-Screen-Width', String(f.width));
    if (f.height) res.set('X-Screen-Height', String(f.height));
    res.set('X-Frame-At', String(f.at));
    res.send(f.data);
  } catch (err) {
    next(err);
  }
});

// Dashboard → backend: push a control instruction.
router.post('/hosts/:id/control', requireLiveMirror, async (req, res, next) => {
  try {
    const entry = hostChannel.pushControl(Number(req.params.id), req.body || {});
    res.status(202).json({ ok: true, id: entry.id });
  } catch (err) {
    if (/unknown op|op is required/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Runner → backend: drain queued control instructions.
router.get('/hosts/:id/control', requireLiveMirror, requireHostOrSlack, async (req, res, next) => {
  try {
    res.json({ ops: hostChannel.drainControls(Number(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
