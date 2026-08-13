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
const hostCommands = require('../services/hostCommands');
const sourcingSession = require('../services/sourcingSession');
const clipStore = require('../services/clipStore');
const humanize = require('../services/humanize');
const geminiClient = require('../services/geminiClient');
const { readScreen } = require('../services/screenVision');

const router = express.Router();

// Feature gate: everything under Live Mirror only exists when SOURCING_LIVE_MIRROR=on.
// Kept as its own middleware so removing the env var flips the whole surface off
// (frame upload, latest-frame read, control push, control drain) with no code change.
function requireLiveMirror(_req, res, next) {
  if (!hostChannel.enabled()) return res.status(404).json({ error: 'live mirror disabled' });
  next();
}

// A run created via the dashboard (or the sourcingSweep auto-enqueue) starts
// 'queued' and only becomes 'running' once real work actually lands on it —
// either a runner claiming it via GET /runs/next, or (here) its first
// candidate batch arriving. Only ever moves a run OFF 'queued'; every other
// status ('running', 'paused', 'error', 'stopped', 'done') is left exactly as
// it is, so a stray/late batch can never silently un-pause an admin's pause or
// resurrect a run that already finished/stopped. Returns {} when nothing about
// the status should change.
function nextRunStatus(currentStatus, done) {
  if (done) return { status: 'done' };
  if (currentStatus === 'queued') return { status: 'running' };
  return {};
}

// GET /api/sourcing/gemini/health — admin diagnostic. Does the configured
// GEMINI_API_KEY + GEMINI_MODEL actually reach a live model? Returns the real
// HTTP status + error body (e.g. a 404 for a mistyped/quoted model name) so a
// misconfigured env is obvious from the dashboard — no phone or reel clip needed.
// Admin-only via the top-level siteAuth gate (no requireHostOrSlack).
router.get('/gemini/health', async (_req, res, next) => {
  try {
    res.json(await geminiClient.ping());
  } catch (err) {
    next(err);
  }
});

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

// Annotate host rows with live health the DB doesn't hold: whether the backend
// is currently driving a session on this host (and which run). Pure + exported
// so it's unit-testable. Last-seen freshness is derived client-side from
// last_seen_at.
function annotateHostHealth(rows, session = sourcingSession) {
  return (rows || []).map((h) => ({
    ...h,
    sessionActive: session.isActive(h.id),
    activeRunId: session.activeRunId(h.id),
  }));
}

router.get('/hosts', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT id, label, platforms, status, last_seen_at, created_at
       FROM sourcing_hosts ORDER BY created_at DESC`,
    );
    res.json(annotateHostHealth(rows));
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

// --- Review queue (borderline matches) -------------------------------------
// Admin-only (top-level siteAuth gate). Candidates whose niche score is just over
// the threshold land here (when reviewBorderline is on) instead of auto-adding.

router.get('/review', async (req, res, next) => {
  try {
    const campaignId = req.query.campaignId || req.query.campaign || null;
    const rows = await store.listReview({ campaignId, limit: req.query.limit });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/candidates/:id/approve', async (req, res, next) => {
  try {
    const row = await store.approveCandidate(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/candidates/:id/reject', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || 'rejected in review';
    const row = await store.rejectCandidate(Number(req.params.id), reason);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
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
      ...nextRunStatus(run.status, done),
    });
    res.json({ run: updated, results });
  } catch (err) {
    next(err);
  }
});

// --- Server-side screen reader (vision) ------------------------------------
// The thin runner captures a screenshot + the Android UI-element tree and POSTs
// the parsed element array here; the backend interprets it into the navigator's
// reading ({screen, targets, results, profile fields, reels}). Moving the
// interpretation server-side means scouting logic ships by deploying Deal Studio
// — the paired host never needs updating. Element trees are small, so the global
// 1 MB json limit is plenty; the raw screenshot is intentionally NOT accepted
// here (it stays bounded and cheap).
router.post('/vision/read', requireHostOrSlack, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.elements)) {
      return res.status(400).json({ error: 'elements array is required' });
    }
    if (body.elements.length > 4000) {
      return res.status(413).json({ error: 'too many elements (>4000)' });
    }
    const reading = readScreen({
      elements: body.elements,
      width: Number(body.width) || null,
      height: Number(body.height) || null,
    });
    res.json(reading);
  } catch (err) {
    next(err);
  }
});

// --- Remote control: backend-driven scouting (agent mode) ------------------
// The inverted control plane. A host running in RUNNER_MODE=agent claims a run,
// then the BACKEND navigator (services/sourcingNavigator.js) drives the phone by
// enqueuing device commands the agent pulls + executes, posting results back.
// Whole surface is opt-in via SOURCING_REMOTE_CONTROL=on (404s otherwise).
function requireRemoteControl(_req, res, next) {
  if (!hostCommands.enabled()) return res.status(404).json({ error: 'remote control disabled' });
  next();
}

// Agent -> backend: claim the newest queued run for this host and start a
// backend-driven session. Idempotent while a session is live for the host.
router.post('/hosts/:id/session/claim', requireRemoteControl, requireHostOrSlack, async (req, res, next) => {
  try {
    const hostId = Number(req.params.id);
    if (sourcingSession.isActive(hostId)) {
      return res.json({ active: true, runId: sourcingSession.activeRunId(hostId) });
    }
    // Anti-flag: don't start scouting outside human-plausible hours. The agent
    // just idle-polls until the window reopens.
    if (!humanize.withinActiveHours(new Date(), process.env.SOURCING_ACTIVE_HOURS)) {
      return res.status(204).end();
    }
    // Claim like GET /runs/next (FOR UPDATE SKIP LOCKED), also binding host_id.
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
            SET status = 'running', host_id = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [picked.rows[0].id, hostId],
      );
      return r.rows[0];
    });
    if (!run) return res.status(204).end();
    sourcingSession.start({ hostId, run });
    res.status(201).json({ active: true, runId: run.id });
  } catch (err) {
    next(err);
  }
});

// Agent -> backend: drain the queued device commands to execute. `done:true`
// tells the agent the backend finished this run's session.
router.get('/hosts/:id/commands', requireRemoteControl, requireHostOrSlack, (req, res, next) => {
  try {
    res.json(hostCommands.pull(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Agent -> backend: post a command's result, settling the navigator's await.
router.post('/hosts/:id/commands/result', requireRemoteControl, requireHostOrSlack, (req, res, next) => {
  try {
    const body = req.body || {};
    const settled = hostCommands.resolve(Number(req.params.id), body.id, {
      ok: body.ok !== false,
      result: body.result,
      error: body.error,
    });
    res.json({ ok: settled });
  } catch (err) {
    next(err);
  }
});

// Agent -> backend: upload a recorded reel clip (raw mp4 bytes) and get a clipId.
// Sent as application/octet-stream so the global 1 MB express.json parser skips
// it (it only parses JSON), letting this route-level raw parser take the larger
// body. The backend navigator hands the clip's bytes to the Gemini judge.
router.post(
  '/hosts/:id/clip',
  requireRemoteControl,
  requireHostOrSlack,
  express.raw({ type: () => true, limit: '25mb' }),
  (req, res, next) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || !buf.length) return res.status(400).json({ error: 'empty clip body' });
      const mediaType = req.get('content-type') || 'video/mp4';
      const clipId = clipStore.put(Number(req.params.id), buf, mediaType);
      res.status(201).json({ clipId });
    } catch (err) {
      if (/empty clip|too large/.test(err.message)) return res.status(413).json({ error: err.message });
      next(err);
    }
  },
);

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

// Attach the pure helpers to the router (which is itself a function, so
// `app.use('/api/sourcing', sourcing)` still works) so they can be unit-tested.
router.nextRunStatus = nextRunStatus;
router.annotateHostHealth = annotateHostHealth;

module.exports = router;
