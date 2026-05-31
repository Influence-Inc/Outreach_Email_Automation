const express = require('express');
const db = require('../db');
const { sendOutreach } = require('../services/outreach');
const { scrapeProfile } = require('../services/igScraper');

const router = express.Router();

function parseUsername(url) {
  try {
    const u = new URL(url);
    if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { campaign_id, status } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });
    const params = [campaign_id];
    let where = 'WHERE campaign_id = $1';
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    const rows = await db.many(
      `SELECT * FROM creators ${where} ORDER BY created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { campaign_id, instagram_url, email, first_name, full_name } = req.body || {};
    if (!campaign_id || !instagram_url) {
      return res.status(400).json({ error: 'campaign_id and instagram_url are required' });
    }
    const username = parseUsername(instagram_url);
    const normalizedUrl = username
      ? `https://www.instagram.com/${username}/`
      : instagram_url;
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
      [campaign_id, normalizedUrl, username, email || null, first_name || null, full_name || null, status],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    const events = await db.many(
      `SELECT * FROM email_events WHERE creator_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    res.json({ ...row, events });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['email', 'first_name', 'full_name', 'instagram_username', 'notes'];
    const updates = [];
    const params = [req.params.id];
    for (const f of fields) {
      if (req.body && req.body[f] != null) {
        params.push(req.body[f]);
        updates.push(`${f} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
    if (req.body && req.body.email) {
      updates.push(`status = CASE WHEN status = 'pending_extraction' THEN 'email_found' ELSE status END`);
    }
    updates.push('updated_at = NOW()');
    const row = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    res.json(row);
  } catch (err) { next(err); }
});

router.post('/bulk/fetch-email', async (req, res) => {
  try {
    const { campaign_id } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const pending = await db.many(
      `SELECT id FROM creators
       WHERE campaign_id = $1 AND status IN ('pending_extraction','no_email')
       ORDER BY created_at ASC`,
      [campaign_id],
    );
    const results = [];
    for (const row of pending) {
      try {
        const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [row.id]);
        const scraped = await scrapeProfile({
          instagramUrl: creator.instagram_url,
          instagramUsername: creator.instagram_username,
        });
        const params = [creator.id, scraped.fullName, scraped.firstName];
        const updates = [
          `full_name = COALESCE($2, full_name)`,
          `first_name = COALESCE($3, first_name)`,
          `updated_at = NOW()`,
        ];
        if (scraped.email) {
          params.push(scraped.email);
          updates.push(`email = $${params.length}`);
          updates.push(`status = 'email_found'`);
        } else {
          updates.push(`status = 'no_email'`);
        }
        await db.query(
          `UPDATE creators SET ${updates.join(', ')} WHERE id = $1`,
          params,
        );
        await db.query(
          `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, $2, $3)`,
          [creator.id, scraped.email ? 'email_found' : 'no_email', { source: scraped.source }],
        );
        results.push({ id: creator.id, email: scraped.email, source: scraped.source });
      } catch (err) {
        results.push({ id: row.id, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
    res.json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error('bulk fetch-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk/send-outreach', async (req, res) => {
  try {
    const { campaign_id } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const pending = await db.many(
      `SELECT id FROM creators
       WHERE campaign_id = $1
         AND status = 'email_found'
         AND email IS NOT NULL
         AND outreach_sent_at IS NULL
       ORDER BY created_at ASC`,
      [campaign_id],
    );
    const results = [];
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        const r = await sendOutreach(row.id);
        results.push({ id: row.id, ok: true, trackingId: r.trackingId });
        sent += 1;
      } catch (err) {
        results.push({ id: row.id, ok: false, error: err.message });
        failed += 1;
      }
      if (row !== pending[pending.length - 1]) {
        const baseMs = Number(process.env.SEND_PACING_MS) || 60_000;
        const jitterMs = Math.floor(baseMs * 0.2 * (Math.random() * 2 - 1));
        await new Promise((r) => setTimeout(r, Math.max(0, baseMs + jitterMs)));
      }
    }
    res.json({ ok: true, processed: results.length, sent, failed, results });
  } catch (err) {
    console.error('bulk send-outreach failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/fetch-email', async (req, res) => {
  try {
    const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    if (!creator) return res.status(404).json({ error: 'not found' });

    const scraped = await scrapeProfile({
      instagramUrl: creator.instagram_url,
      instagramUsername: creator.instagram_username,
    });

    const updates = [
      `instagram_username = COALESCE(creators.instagram_username, $2)`,
      `full_name = COALESCE($3, full_name)`,
      `first_name = COALESCE($4, first_name)`,
      `updated_at = NOW()`,
    ];
    const params = [creator.id, scraped.username, scraped.fullName, scraped.firstName];

    if (scraped.email) {
      params.push(scraped.email);
      updates.push(`email = $${params.length}`);
      updates.push(
        `status = CASE WHEN status IN ('pending_extraction','no_email') THEN 'email_found' ELSE status END`,
      );
    } else if (creator.status === 'pending_extraction') {
      updates.push(`status = 'no_email'`);
    }

    const updated = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, detail)
       VALUES ($1, $2, $3)`,
      [
        creator.id,
        scraped.email ? 'email_found' : 'no_email',
        { source: scraped.source, isBusiness: scraped.isBusiness },
      ],
    );

    res.json({ ok: true, creator: updated, source: scraped.source });
  } catch (err) {
    console.error('fetch-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/send-outreach', async (req, res, next) => {
  try {
    const result = await sendOutreach(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM creators WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Offer management ─────────────────────────────────────────────────────────

/**
 * GET /:id/offers
 * Returns scraped IG data, all 6 suggested offers, and the admin's current selection.
 */
router.get('/:id/offers', async (req, res, next) => {
  try {
    const row = await db.one(
      `SELECT id, instagram_username,
              ig_scraped_data, suggested_offers,
              selected_offer_id, custom_offer
       FROM creators WHERE id = $1`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

/**
 * POST /:id/offers/select
 * Admin picks one of the 6 suggested offers. The chosen offer is copied
 * into custom_offer so subsequent edits don't mutate suggested_offers.
 *
 * Body: { offer_id: string }  e.g. "view_2" or "video_1"
 */
router.post('/:id/offers/select', async (req, res, next) => {
  try {
    const { offer_id } = req.body || {};
    if (!offer_id) return res.status(400).json({ error: 'offer_id is required' });

    const creator = await db.one(
      `SELECT id, suggested_offers FROM creators WHERE id = $1`,
      [req.params.id],
    );
    if (!creator) return res.status(404).json({ error: 'not found' });

    const offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : [];
    const selected = offers.find((o) => o.offer_id === offer_id);
    if (!selected) {
      return res.status(400).json({
        error: `offer_id '${offer_id}' not found in suggested_offers`,
        available: offers.map((o) => o.offer_id),
      });
    }

    const row = await db.one(
      `UPDATE creators
         SET selected_offer_id = $2,
             custom_offer      = $3,
             updated_at        = NOW()
       WHERE id = $1
       RETURNING id, selected_offer_id, custom_offer`,
      [req.params.id, offer_id, JSON.stringify(selected)],
    );
    res.json({ ok: true, ...row });
  } catch (err) { next(err); }
});

/**
 * PATCH /:id/offers/custom
 * Admin edits the selected offer. Allowed fields:
 *   flat_fee, flat_per_video, view_guarantee, num_videos, notes
 * Changes are merged into custom_offer; suggested_offers is untouched.
 */
router.patch('/:id/offers/custom', async (req, res, next) => {
  try {
    const EDITABLE = ['flat_fee', 'flat_per_video', 'view_guarantee', 'num_videos', 'notes'];
    const edits = req.body || {};

    const creator = await db.one(
      `SELECT id, custom_offer FROM creators WHERE id = $1`,
      [req.params.id],
    );
    if (!creator) return res.status(404).json({ error: 'not found' });
    if (!creator.custom_offer) {
      return res.status(400).json({
        error: 'No offer selected yet — POST to /:id/offers/select first',
      });
    }

    const merged = { ...creator.custom_offer };
    for (const key of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(edits, key)) {
        merged[key] = edits[key];
      }
    }

    const row = await db.one(
      `UPDATE creators
         SET custom_offer = $2,
             updated_at   = NOW()
       WHERE id = $1
       RETURNING id, selected_offer_id, custom_offer`,
      [req.params.id, JSON.stringify(merged)],
    );
    res.json({ ok: true, ...row });
  } catch (err) { next(err); }
});

module.exports = router;
