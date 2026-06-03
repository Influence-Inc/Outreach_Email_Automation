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
              cr.selected_offer_id, cr.custom_offer, cr.offer_approved,
              c.id AS campaign_id, c.name AS campaign_name,
              c.brand_name, c.max_cpm
       FROM creators cr
       JOIN campaigns c ON c.id = cr.campaign_id
       WHERE LOWER(cr.instagram_username) = LOWER($1)
         AND ($2::text IS NULL OR LOWER(c.brand_name) = LOWER($2))
       ORDER BY (cr.offer_approved AND cr.custom_offer IS NOT NULL) DESC, cr.updated_at DESC
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
      // Only hand the worker an offer once an admin has explicitly Approved it.
      approved_offer: row.offer_approved ? (row.custom_offer || null) : null,
      offer_approved: !!row.offer_approved,
      quoted_rate: num(row.quoted_rate),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/negotiation/replied
 *
 * Lists creators who have replied to outreach and are ready to be handed off to
 * the influence-negotiation worker. Returns everything the worker needs to seed
 * them and read the thread: email, name, instagram_username, outreach_thread_id,
 * and the campaign's brand_name.
 *
 * The worker de-dupes by email (it skips creators already in its own DB), so
 * this can be polled every tick safely.
 *
 * Query (optional):
 *   since        ISO timestamp — only creators who replied at/after this time
 *   campaign_id  restrict to one campaign
 *
 * Auth: x-bot-token header must equal NEGOTIATION_API_TOKEN (same as /push).
 */
router.get('/replied', async (req, res, next) => {
  try {
    if (!authenticate(req, res)) return;

    const params = [];
    const where = [
      "cr.status = 'replied'",
      'cr.email IS NOT NULL',
      'cr.outreach_thread_id IS NOT NULL',
    ];

    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!Number.isNaN(since.getTime())) {
        params.push(since.toISOString());
        where.push(`cr.replied_at >= $${params.length}`);
      }
    }
    if (req.query.campaign_id) {
      params.push(String(req.query.campaign_id));
      where.push(`cr.campaign_id = $${params.length}`);
    }

    const rows = await db.many(
      `SELECT cr.id, cr.email, cr.first_name, cr.full_name, cr.instagram_username,
              cr.outreach_thread_id, cr.replied_at,
              c.id AS campaign_id, c.name AS campaign_name, c.brand_name
       FROM creators cr
       JOIN campaigns c ON c.id = cr.campaign_id
       WHERE ${where.join(' AND ')}
       ORDER BY cr.replied_at DESC NULLS LAST`,
      params,
    );

    res.json({ ok: true, count: rows.length, creators: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
