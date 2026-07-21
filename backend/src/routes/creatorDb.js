'use strict';

// Deal Studio ↔ Creator-Database bridge routes.
//
// - GET  /api/creator-db/search   — proxies Creator-DB's paginated /creators
//   search so the dashboard can find Used/Unused creators to pull into a
//   campaign.
// - POST /api/creators/import-from-db — creates a creators row in a specific
//   campaign from a picked Creator-DB record, prefilling email + IG so the
//   admin doesn't have to re-enter them.
//
// The Creator-DB call carries CREATOR_DB_API_KEY (see services/creatorDb.js).
// This backend does NOT expose that key to the browser — the dashboard hits
// these routes on this backend, which in turn calls Creator-DB.

const express = require('express');
const db = require('../db');
const creatorDb = require('../services/creatorDb');

const router = express.Router();

// GET /api/creator-db/search?q=&category=used|unused|any&limit=
// Returns Creator-DB's paginated {data, meta} shape verbatim so the client can
// iterate rows and read the total. Empty q + no category returns all creators
// (paginated) — the client is expected to always pass at least one filter.
router.get('/search', async (req, res, next) => {
  try {
    if (!creatorDb.isConfigured()) {
      return res.status(503).json({
        error: 'Creator Database is not configured (CREATOR_DB_URL unset).',
      });
    }
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || 'any');
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const out = await creatorDb.searchCreators({ q, category, limit });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /api/creators/import-from-db
// Body: { campaign_id, email?, instagram_username?, first_name?, full_name? }
// Creates a creators row in the given campaign from a Creator-DB record. The
// caller is expected to have picked the row from the search results and to
// pass those fields verbatim. If the creator already exists in this campaign
// (dedup on instagram_url), the existing row is returned unchanged.
router.post('/import', async (req, res, next) => {
  try {
    const body = req.body || {};
    const campaign_id = String(body.campaign_id || '').trim();
    const igRaw = String(body.instagram_username || '').trim().replace(/^@/, '');
    const email = String(body.email || '').trim() || null;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });
    if (!igRaw && !email) {
      return res.status(400).json({ error: 'instagram_username or email is required' });
    }
    // The creators table uniques on (campaign_id, instagram_url), so we always
    // need an instagram_url even when the Creator-DB record only has an email.
    // Fall back to a stable email-derived pseudo-URL rather than rejecting the
    // import — the row still dedups correctly on repeat imports.
    const igUrl = igRaw
      ? `https://www.instagram.com/${igRaw.toLowerCase()}/`
      : `mailto:${email.toLowerCase()}`;
    const status = email ? 'email_found' : 'pending_extraction';
    const row = await db.one(
      `INSERT INTO creators (campaign_id, instagram_url, instagram_username, email, first_name, full_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (campaign_id, instagram_url) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, creators.email),
         first_name = COALESCE(EXCLUDED.first_name, creators.first_name),
         full_name = COALESCE(EXCLUDED.full_name, creators.full_name),
         instagram_username = COALESCE(EXCLUDED.instagram_username, creators.instagram_username),
         updated_at = NOW()
       RETURNING *`,
      [
        campaign_id,
        igUrl,
        igRaw ? igRaw.toLowerCase() : null,
        email,
        body.first_name || null,
        body.full_name || null,
        status,
      ],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
