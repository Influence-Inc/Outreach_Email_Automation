'use strict';

// Creator-sourcing API. All routes sit behind the dashboard's Slack/site-auth gate
// (see server.js); the paired host authenticates with the machine token
// (x-api-token) the same gate accepts, so it can POST captured candidates to
// /runs/:id/candidates.
//
//   Admin:
//     GET   /api/sourcing/config                 the Scout page's saved defaults
//     PATCH /api/sourcing/config                 save them
//     GET   /api/sourcing/config/:campaignId     a campaign's scouting defaults (API only)
//     PATCH /api/sourcing/config/:campaignId      save a campaign's scouting defaults (API only)
//     GET   /api/sourcing/jev-calibration         Jev's learned shortlist / reject bars
//     GET   /api/sourcing/review-lessons          what the review notes taught the scout
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
const sourcingMetrics = require('../services/sourcingMetrics');
const jevCalibration = require('../services/jevCalibration');
const reviewLessons = require('../services/reviewLessons');
const creatorList = require('../services/creatorList');
const jevJudge = require('../services/jevJudge');
const phoneFarm = require('../services/phoneFarm');
const reelMedia = require('../services/reelMedia');
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

/**
 * Whether this deployment can judge the creators it scouts, and what that means
 * for a run.
 *
 * Jev (services/jevJudge.js) labels each creator's reel. Without its key every
 * creator who passes the viral rule waits in review; without Groq it cannot
 * hear the reel and reads only the caption and on-screen text. A run looks
 * normal either way, so the Scout page states it. Configuration only, no
 * network call. Pure + exported for tests.
 */
function judgeStatus({ jev = jevJudge } = {}) {
  const labels = !!jev.configured();
  const speech = labels && !!jev.speechConfigured();
  let mode = 'none';
  if (speech) mode = 'full';
  else if (labels) mode = 'no-speech';
  return { jev: labels, speech, mode };
}

// GET /api/sourcing/status — admin-only via the top-level siteAuth gate.
// When this process started — the deploy's go-live time, near enough.
const STARTED_AT = new Date().toISOString();

/**
 * Which code this server is running. Railway sets the commit and branch on
 * every deploy; showing them on the Scout page makes a stale deploy obvious —
 * a site still serving old code looked exactly like the new code with bugs.
 * Pure + exported for tests.
 */
function buildInfo(env = process.env, startedAt = STARTED_AT) {
  const sha = String(env.RAILWAY_GIT_COMMIT_SHA || env.SOURCE_COMMIT || env.GIT_COMMIT || '').trim();
  return {
    commit: sha ? sha.slice(0, 7) : null,
    branch: String(env.RAILWAY_GIT_BRANCH || '').trim() || null,
    startedAt,
  };
}

router.get('/status', async (_req, res, next) => {
  try {
    res.json({
      judge: judgeStatus(),
      // ffmpeg / ffprobe split each recording into audio and frames, Tesseract
      // reads the frames (services/reelMedia.js). Missing on the server, the
      // judge hears less and reads nothing off the screen.
      media: await reelMedia.tools(),
      // Whether shortlisted creators can reach creator-list's collection.
      creatorList: { curated: creatorList.curatedConfigured(), missing: creatorList.curatedMissing() },
      remoteControl: hostCommands.enabled(),
      liveMirror: hostChannel.enabled(),
      build: buildInfo(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/sourcing/metrics?campaignId=… — did the scout find good creators?
//
// Every threshold, weight and prompt in this pipeline is tuned against an
// intuition about quality that nothing measured. This is the measurement: the
// funnel from scanned to replied, how often a human overturned the rules, and
// which keywords produced creators who actually answered. Admin-only via the
// top-level siteAuth gate.
router.get('/metrics', async (req, res, next) => {
  try {
    const campaignId = req.query.campaignId || req.query.campaign || null;
    res.json(await sourcingMetrics.campaignReport({ db, campaignId }));
  } catch (err) {
    next(err);
  }
});

// GET /api/sourcing/jev-calibration — how sure Jev currently has to be to
// shortlist and to reject, as learned from the review queue, with one line
// saying so for the Scout page. Admin-only via the top-level siteAuth gate.
router.get('/jev-calibration', async (_req, res, next) => {
  try {
    const bars = await jevCalibration.load({ db });
    res.json({ ...bars, summary: jevCalibration.describe(bars) });
  } catch (err) {
    next(err);
  }
});

// POST /api/sourcing/creator-list/resend — send again every shortlisted creator
// who never reached creator-list's collection (not configured then, or an error).
router.post('/creator-list/resend', async (_req, res, next) => {
  try {
    res.json(await store.resendToCreatorList());
  } catch (err) {
    next(err);
  }
});

// GET /api/sourcing/review-lessons — what the admins' review notes have taught:
// labels the scout now holds or rejects creators for, with the admins' reasons.
router.get('/review-lessons', async (_req, res, next) => {
  try {
    const lessons = await reviewLessons.load({ db });
    res.json({ ...lessons, summary: reviewLessons.describe(lessons, jevJudge.labelOf) });
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
    // farm_*: where the phone's account is in phone farming
    // (services/phoneFarm.js) — warming up, or scouting its feed.
    const rows = await db.many(
      `SELECT id, label, platforms, status, last_seen_at, created_at,
              farm_phase, farm_warmed, farm_goal, farm_note, farm_phase_at
       FROM sourcing_hosts ORDER BY created_at DESC`,
    );
    const goal = phoneFarm.loadSettings().warmupGoal;
    res.json(annotateHostHealth(rows).map((h) => ({ ...h, farm_goal: h.farm_goal || goal })));
  } catch (err) {
    next(err);
  }
});

// Start a phone's warm-up over — a new Instagram account was signed in on it,
// so what the old one taught its feed no longer applies.
router.post('/hosts/:id/farm/restart', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const host = await db.one(`SELECT id FROM sourcing_hosts WHERE id = $1`, [id]);
    if (!host) return res.status(404).json({ error: 'not found' });
    await phoneFarm.restart(db, id, { note: `restarted by ${(req.session && req.session.email) || 'an admin'}` });
    res.json({ ok: true });
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

// The Scout page's own defaults. Scouting is not done for a campaign any more —
// every shortlisted creator goes to creator-list — so the page keeps one set of
// defaults, in app_settings, rather than one per campaign.
const GLOBAL_DEFAULTS_KEY = 'sourcing_defaults';

function parseDefaults(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

async function globalDefaults() {
  const row = await db.one(`SELECT value FROM app_settings WHERE key = $1`, [GLOBAL_DEFAULTS_KEY]);
  return parseDefaults(row && row.value);
}

router.get('/config', async (_req, res, next) => {
  try {
    res.json(await globalDefaults());
  } catch (err) {
    next(err);
  }
});

router.patch('/config', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }
    // Same merge semantics as a campaign's defaults, under a row lock.
    const saved = await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING`,
        [GLOBAL_DEFAULTS_KEY],
      );
      const cur = await client.query(`SELECT value FROM app_settings WHERE key = $1 FOR UPDATE`, [GLOBAL_DEFAULTS_KEY]);
      const merged = mergeSourcingDefaults(parseDefaults(cur.rows[0] && cur.rows[0].value), body);
      await client.query(
        `UPDATE app_settings SET value = $2, updated_at = NOW() WHERE key = $1`,
        [GLOBAL_DEFAULTS_KEY, JSON.stringify(merged)],
      );
      return merged;
    });
    res.json(saved);
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

/**
 * Apply a PATCH to a campaign's saved scouting defaults.
 *
 * A MERGE, not a replacement. The Scout page only knows the fields it shows,
 * and saving from it used to overwrite the whole object — silently wiping every
 * setting that can only be set through the API (targetAudience, genres,
 * creatorWeights, the engagement floors, avoidExamples, `enabled` for the
 * sweeper's auto-enqueue, ...). Keys in the patch replace the saved ones; a key
 * sent as null is REMOVED, which is how a field is cleared. Shallow on purpose:
 * a nested value such as creatorWeights is replaced whole, as it was sent.
 *
 * Pure + exported for tests.
 */
function mergeSourcingDefaults(current, patch) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

router.patch('/config/:campaignId', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }
    // Read-merge-write under a row lock, so two admins saving at once cannot
    // each drop the other's keys.
    const row = await db.withTransaction(async (client) => {
      const cur = await client.query(
        `SELECT sourcing_defaults FROM campaigns WHERE id = $1 FOR UPDATE`,
        [req.params.campaignId],
      );
      if (!cur.rows.length) return null;
      const merged = mergeSourcingDefaults(cur.rows[0].sourcing_defaults, body);
      const saved = await client.query(
        `UPDATE campaigns SET sourcing_defaults = $2::jsonb WHERE id = $1 RETURNING sourcing_defaults`,
        [req.params.campaignId, JSON.stringify(merged)],
      );
      return saved.rows[0] || null;
    });
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
    const row = await store.approveCandidate(Number(req.params.id), req.body && req.body.note);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/candidates/:id/reject', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || 'rejected in review';
    const row = await store.rejectCandidate(Number(req.params.id), reason, req.body && req.body.note);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Start a scouting run. Freezes the merged (defaults + overrides) config onto the
// run so later edits to the defaults never change an in-flight run.
//
// No campaign: the Scout page's runs are not for one (shortlisted creators go to
// creator-list) and use the page's saved defaults. A campaign_id is still
// accepted from the API, and then that campaign's defaults apply.
router.post('/runs', async (req, res, next) => {
  try {
    const { campaign_id, host_id, config: override } = req.body || {};
    let defaults;
    if (campaign_id) {
      const campaign = await db.one(`SELECT id, sourcing_defaults FROM campaigns WHERE id = $1`, [
        campaign_id,
      ]);
      if (!campaign) return res.status(404).json({ error: 'campaign not found' });
      defaults = campaign.sourcing_defaults;
    } else {
      defaults = await globalDefaults();
    }

    const config = buildConfig(defaults, override);
    if (!config.targetCount || config.targetCount < 1) {
      return res
        .status(400)
        .json({ error: 'targetCount (number of creators to source) is required' });
    }
    if (!config.keywords.length) {
      return res.status(400).json({ error: 'add at least one keyword to search for' });
    }

    // Which phone should scout this run. Optional: a run left unpinned is
    // claimed by whichever paired device asks for work first, which is what
    // every run did before this existed. Pinning one is what lets an admin
    // send a campaign to a specific handset — the account signed into it is
    // the account whose feed gets warmed, so for feed-mode runs it is not an
    // interchangeable choice.
    let hostId = null;
    if (host_id != null && host_id !== '') {
      const n = Number(host_id);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: 'host_id must be the id of a paired device' });
      }
      const host = await db.one(
        `SELECT id FROM sourcing_hosts WHERE id = $1 AND status <> 'revoked'`,
        [n],
      );
      if (!host) {
        return res.status(400).json({ error: 'that device is not paired, or its token was revoked' });
      }
      hostId = n;
    }

    const run = await store.createRun({
      campaignId: campaign_id || null,
      config,
      targetCount: config.targetCount,
      createdBy: (req.session && req.session.email) || null,
      hostId,
    });
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
});

// Runner in RUNNER_RUN_ID=auto mode polls this endpoint for the newest queued
// run and takes ownership by flipping status to 'running'. Registered BEFORE
// /runs/:id so the literal segment isn't parsed as an id.
router.get('/runs/next', requireHostOrSlack, async (req, res, next) => {
  try {
    // Which phone is asking. Set by requireHostOrSlack for a per-host token;
    // undefined for a signed-in dashboard caller, which then only ever sees
    // unpinned runs — it is not a device and cannot scout one.
    const askingHostId = req.sourcingHostId ?? null;
    // FOR UPDATE SKIP LOCKED so two runners polling at the same time each claim
    // a distinct run instead of racing.
    const run = await db.withTransaction(async (client) => {
      const picked = await client.query(
        `SELECT id FROM sourcing_runs
          WHERE status = 'queued'
            AND (host_id IS NULL OR host_id = $1)
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [askingHostId],
      );
      if (!picked.rows.length) return null;
      const r = await client.query(
        `UPDATE sourcing_runs
            SET status = 'running', host_id = COALESCE(host_id, $2), updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [picked.rows[0].id, askingHostId],
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
            AND (host_id IS NULL OR host_id = $1)
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [hostId],
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

// Dashboard -> backend: run one feed WARM-UP pass on a host. Likes only, and
// only reels by creators that already passed the gate — see
// services/feedWarmup.js for why that distinction is the whole point, and for
// the risk posture (hard caps, no shares, stops dead on an activity block).
//
// Deliberately separate from a scouting run rather than a phase of one: a session
// that likes and scouts together has a far more conspicuous pattern than either
// on its own.
router.post('/hosts/:id/warmup', requireRemoteControl, requireHostOrSlack, async (req, res, next) => {
  try {
    const hostId = Number(req.params.id);
    if (sourcingSession.isActive(hostId)) {
      return res.status(409).json({ error: 'a scouting run is using this host — warm up separately' });
    }
    // The same human-hours guard scouting uses. Liking reels at 4am is exactly
    // the pattern this is trying not to have.
    if (!humanize.withinActiveHours(new Date(), process.env.SOURCING_ACTIVE_HOURS)) {
      return res.status(409).json({ error: 'outside active hours' });
    }
    const body = req.body || {};
    const stats = await sourcingSession.runWarmup({
      hostId,
      config: {
        campaignId: body.campaignId || null,
        maxLikes: body.maxLikes,
        maxReels: body.maxReels,
        likeProbability: body.likeProbability,
      },
    });
    res.json(stats);
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

// Which host a phone's live-mirror traffic belongs to: the one its token was
// minted for. The URL's number is whatever was typed into the app's Host ID
// field, and a mistyped one used to file every frame under another host — so
// the dashboard watching the real one waited for frames forever, with no error
// anywhere. A dashboard user or the global token has no host of its own, so for
// them the URL decides. Pure + exported for tests.
function mirrorHostId(req) {
  return req.sourcingHostId != null ? Number(req.sourcingHostId) : Number(req.params.id);
}

// Runner → backend: publish the latest phone frame.
router.post('/hosts/:id/frame', requireLiveMirror, requireHostOrSlack, async (req, res, next) => {
  try {
    const body = req.body || {};
    const hostId = mirrorHostId(req);
    const result = hostChannel.publishFrame(hostId, body, { claimedId: Number(req.params.id) });
    // hostId says where the frame went, so the app can show it.
    res.json({ ok: true, bytes: result.bytes, hostId });
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

// Dashboard → backend: why there is no live frame for this host (when the
// frame read above came back empty) — none since the server started, one that
// went stale, one refused, or a phone addressing another host number.
router.get('/hosts/:id/frame/state', requireLiveMirror, (req, res, next) => {
  try {
    res.json({ ...hostChannel.frameState(Number(req.params.id)), now: Date.now() });
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
    // The same host the phone's frames are filed under, so a tap on the
    // dashboard's picture reaches the phone that sent it.
    res.json({ ops: hostChannel.drainControls(mirrorHostId(req)) });
  } catch (err) {
    next(err);
  }
});

// Attach the pure helpers to the router (which is itself a function, so
// `app.use('/api/sourcing', sourcing)` still works) so they can be unit-tested.
router.nextRunStatus = nextRunStatus;
router.annotateHostHealth = annotateHostHealth;
router.mergeSourcingDefaults = mergeSourcingDefaults;
router.judgeStatus = judgeStatus;
router.mirrorHostId = mirrorHostId;
router.buildInfo = buildInfo;

module.exports = router;
