'use strict';

// Bot API: read-only, server-to-server endpoints for the campaigns dashboard
// (influence-stats) to fetch data the admin UI needs to render — e.g. the
// per-creator contract signing URL that populates the "Contract submission"
// column. Requests carry `x-bot-token: OUTREACH_BOT_TOKEN`, matching the shape
// influence-stats uses for its own upstream bot endpoint.

const express = require('express');
const db = require('../db');
const contracts = require('../services/contracts');
const { runBackfill } = require('../services/contractBackfill');
const { runBackfill: runDashboardBackfill } = require('../services/dashboardBackfill');

const router = express.Router();

function requireBotToken(req, res, next) {
  const expected = process.env.OUTREACH_BOT_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'Bot API not configured — set OUTREACH_BOT_TOKEN env var',
    });
  }
  const provided = req.headers['x-bot-token'];
  if (provided !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/bot/contracts?campaign_id=X
// Returns the latest contract per creator, optionally filtered to one campaign,
// so influence-stats can render "Copy link" buttons per row.
router.get('/contracts', requireBotToken, async (req, res, next) => {
  try {
    const { campaign_id } = req.query;
    const params = [];
    let where = '';
    if (campaign_id) {
      params.push(campaign_id);
      where = ` WHERE cr.campaign_id = $${params.length}`;
    }
    // DISTINCT ON (creator_id) + ORDER BY creator_id, created_at DESC yields the
    // latest contract per creator (mirroring attachContracts in contracts.js).
    const rows = await db.many(
      `SELECT DISTINCT ON (c.creator_id)
              c.token, c.status, c.created_at, c.signed_at,
              cr.instagram_username, cr.campaign_id
       FROM contracts c JOIN creators cr ON cr.id = c.creator_id
       ${where}
       ORDER BY c.creator_id, c.created_at DESC`,
      params,
    );
    res.json(
      rows.map((r) => ({
        campaign_id: r.campaign_id,
        instagram_username: r.instagram_username,
        token: r.token,
        status: r.status,
        url: contracts.contractUrl(r.token),
        created_at: r.created_at,
        signed_at: r.signed_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/bot/sync-contracts[?dryRun=true][&limit=N]
// One-shot backfill trigger: push already-signed contracts to the Creator-DB
// (same logic as `npm run sync:contracts`), so it can be run with a single curl
// instead of an SSH session. Guarded by OUTREACH_BOT_TOKEN like the rest of the
// bot API. Idempotent.
router.post('/sync-contracts', requireBotToken, async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const result = await runBackfill({ dryRun, limit });
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.status(400).json({ error: 'CREATOR_DB_URL is not set on this service' });
    }
    next(err);
  }
});

// POST /api/bot/sync-contracts-to-dashboard[?dryRun=true][&limit=N]
// One-shot backfill trigger: push already-signed contracts to the campaign
// dashboard (same logic as `npm run sync:dashboard`). Guarded by
// OUTREACH_BOT_TOKEN like the rest of the bot API. Idempotent.
router.post('/sync-contracts-to-dashboard', requireBotToken, async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const result = await runDashboardBackfill({ dryRun, limit });
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.status(400).json({ error: 'CAMPAIGN_DASHBOARD_URL is not set on this service' });
    }
    next(err);
  }
});

module.exports = router;
