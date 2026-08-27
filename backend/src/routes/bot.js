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
const creatorUpdates = require('../services/creatorUpdates');

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

// --- Campaign-update ingest ------------------------------------------------
// POST /api/bot/creator-updates
//
// The INFLUENCE Slack bot's side of the campaign-update lane. That bot sees the
// events (a draft submitted, a brand approval, feedback in the review chat, a
// post link, deliverables complete) but has no phone numbers and no WhatsApp
// credentials; this app has both. So the bot reports WHAT happened and to WHOM
// in its own vocabulary — an Instagram handle and a campaign — and everything
// after that (is this creator subscribed, is their window open, template or
// free-form, queue or send now) is decided here.
//
// Body:
//   { event, creator: { username, email }, campaign: { id, name, brandName },
//     data: { ... }, dedupKey }
//
// `data` carries the kind-specific fields the copy needs (submitPostsUrl,
// feedback, senderName, chatUrl, postUrl) — see UPDATE_KINDS in
// services/creatorUpdates.js.
//
// Always answers 200 with an outcome, never a 4xx, for anything short of a
// malformed request: the bot fires these fire-and-forget with no retries, and an
// unmatched handle or an unsubscribed creator is a perfectly ordinary result
// (most creators are not on this lane), not a failure the bot can do anything
// about. The outcome string says which it was.
router.post('/creator-updates', requireBotToken, async (req, res, next) => {
  try {
    const body = req.body || {};
    const event = String(body.event || '').trim();
    const creator = body.creator || {};
    const campaign = body.campaign || {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};

    if (!event) return res.status(400).json({ error: 'event is required' });
    if (!creator.username && !creator.email) {
      return res.status(400).json({ error: 'creator.username or creator.email is required' });
    }
    if (!creatorUpdates.isKnownKind(event)) {
      return res.status(400).json({
        error: `unknown event "${event}"`,
        known: Object.keys(creatorUpdates.UPDATE_KINDS),
      });
    }

    const match = await creatorUpdates.resolveCreator({
      username: creator.username,
      email: creator.email,
      campaignId: campaign.id,
    });
    if (!match) {
      return res.json({ ok: true, outcome: 'no_matching_creator' });
    }

    // The bot names the brand; fall back to our own campaign row when it
    // doesn't, so the copy never says "your campaign" for a creator whose brand
    // we know perfectly well.
    const payload = { ...data };
    if (campaign.brandName) payload.brandName = campaign.brandName;

    const result =
      event === 'deliverables_complete'
        ? await creatorUpdates.onDeliverablesComplete(match.id, {
            campaignId: campaign.id,
            brandName: payload.brandName,
            dedupKey: body.dedupKey,
          })
        : await creatorUpdates.notify(match.id, event, payload, {
            campaignId: campaign.id,
            dedupKey: body.dedupKey,
          });

    return res.json({
      ok: true,
      creatorId: match.id,
      outcome: result.queued ? (result.sent ? 'sent' : 'queued') : result.reason || 'not_queued',
      reason: result.reason || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bot/creator-updates/:creatorId — subscription state + recent update
// history for one creator. The answer to "did she actually get the approval
// message?" without a database session.
router.get('/creator-updates/:creatorId', requireBotToken, async (req, res, next) => {
  try {
    const id = parseInt(req.params.creatorId, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'creatorId must be a number' });
    const status = await creatorUpdates.statusFor(id);
    if (!status) return res.status(404).json({ error: 'Creator not found' });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
