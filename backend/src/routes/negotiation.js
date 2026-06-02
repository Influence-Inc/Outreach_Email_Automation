/**
 * Internal webhook from the influence-negotiation backend.
 *
 * POST /api/negotiation/push
 *   Receives scraped IG stats + 6 AI-suggested offers for a creator,
 *   matched by instagram_username (case-insensitive).
 *
 * Auth: x-bot-token header must equal NEGOTIATION_API_TOKEN env var.
 *       If the env var is unset, the endpoint is open (dev-only).
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

function authenticate(req, res) {
  const token = process.env.NEGOTIATION_API_TOKEN;
  if (!token) return true; // no token configured — open (dev / single-host setups)
  if (req.headers['x-bot-token'] === token) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

/**
 * POST /api/negotiation/push
 *
 * Body:
 *   instagram_handle  string   — IG username (without @)
 *   ig_scraped_data   object   — {p10, p25, p50, p75, reel_count, min_views, views_raw}
 *   suggested_offers  array    — 6 SuggestedOffer objects
 *   creator_email?    string
 *   creator_name?     string
 *   quoted_rate?      number   — creator's stated rate (optional)
 */
router.post('/push', async (req, res, next) => {
  try {
    if (!authenticate(req, res)) return;

    const { instagram_handle, ig_scraped_data, suggested_offers, quoted_rate } = req.body || {};

    if (!instagram_handle) {
      return res.status(400).json({ error: 'instagram_handle is required' });
    }
    if (!ig_scraped_data || !Array.isArray(suggested_offers)) {
      return res.status(400).json({ error: 'ig_scraped_data (object) and suggested_offers (array) are required' });
    }

    // Match creators by instagram_username, case-insensitive.
    // A handle may appear in multiple campaigns — update all of them.
    const rows = await db.many(
      `SELECT id FROM creators
       WHERE LOWER(instagram_username) = LOWER($1)
       ORDER BY created_at DESC`,
      [instagram_handle],
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: `No creator found with instagram_username=${instagram_handle}`,
      });
    }

    // Normalise quoted_rate: must be a positive finite number or null.
    const parsedRate = (quoted_rate != null && quoted_rate !== '')
      ? Number(quoted_rate)
      : null;
    const safeRate = (parsedRate != null && Number.isFinite(parsedRate) && parsedRate >= 0)
      ? parsedRate
      : null;

    const updatedIds = [];
    for (const row of rows) {
      await db.query(
        `UPDATE creators
         SET ig_scraped_data  = $2,
             suggested_offers = $3,
             quoted_rate      = COALESCE($4, quoted_rate),
             updated_at       = NOW()
         WHERE id = $1`,
        [row.id, JSON.stringify(ig_scraped_data), JSON.stringify(suggested_offers), safeRate],
      );
      updatedIds.push(row.id);
    }

    res.json({ ok: true, updated_creator_ids: updatedIds });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/negotiation/offer
 *
 * Lets the influence-negotiation backend pull, for a given creator:
 *   - the campaign's admin-configured max_cpm, and
 *   - the admin's approved/edited offer (custom_offer), if one has been selected.
 *
 * This closes the loop: the worker can honor the dashboard CPM and email the
 * exact offer an admin approved, instead of its own computed one.
 *
 * Query:
 *   instagram_handle  string (required) — IG username (without @)
 *   brand_name        string (optional) — disambiguates when a handle is in
 *                                         multiple campaigns; matches campaigns.brand_name
 *
 * Auth: x-bot-token header must equal NEGOTIATION_API_TOKEN (same as /push).
 *
 * Always 200. When no matching creator exists, returns { ok: true, found: false }.
 * Prefers the row that already has an approved offer, then the most recently updated.
 */
router.get('/offer', async (req, res, next) => {
  try {
    if (!authenticate(req, res)) return;

    const handle = String(req.query.instagram_handle || '').trim();
    if (!handle) {
      return res.status(400).json({ error: 'instagram_handle is required' });
    }
    const brand = req.query.brand_name ? String(req.query.brand_name).trim() : null;

    const row = await db.one(
      `SELECT cr.id AS creator_id, cr.instagram_username, cr.quoted_rate,
              cr.selected_offer_id, cr.custom_offer,
              c.id AS campaign_id, c.name AS campaign_name,
              c.brand_name, c.max_cpm
       FROM creators cr
       JOIN campaigns c ON c.id = cr.campaign_id
       WHERE LOWER(cr.instagram_username) = LOWER($1)
         AND ($2::text IS NULL OR LOWER(c.brand_name) = LOWER($2))
       ORDER BY (cr.custom_offer IS NOT NULL) DESC, cr.updated_at DESC
       LIMIT 1`,
      [handle, brand],
    );

    if (!row) {
      return res.json({ ok: true, found: false });
    }

    const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

    res.json({
      ok: true,
      found: true,
      creator_id: row.creator_id,
      instagram_username: row.instagram_username,
      campaign: {
        id: row.campaign_id,
        name: row.campaign_name,
        brand_name: row.brand_name,
        max_cpm: num(row.max_cpm),
      },
      max_cpm: num(row.max_cpm),
      selected_offer_id: row.selected_offer_id || null,
      approved_offer: row.custom_offer || null,
      quoted_rate: num(row.quoted_rate),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
