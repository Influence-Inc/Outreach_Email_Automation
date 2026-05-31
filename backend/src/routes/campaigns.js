const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');
const { computeSixOffers } = require('../services/offerCalculator');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.name, c.brand_name, c.slug, c.synced_at,
              c.template_id, c.max_cpm,
              COUNT(cr.id)::int AS creator_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'pending_extraction')::int AS pending_extraction_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'email_found')::int AS email_found_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'outreach_sent')::int AS outreach_sent_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'followup_sent')::int AS followup_sent_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'replied')::int AS replied_count
       FROM campaigns c
       LEFT JOIN creators cr ON cr.campaign_id = c.id
       GROUP BY c.id
       ORDER BY c.brand_name ASC, c.name ASC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/sync', async (_req, res) => {
  try {
    const result = await syncCampaigns();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('campaigns sync failed:', err);
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.one(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// Update campaign settings: template_id and/or max_cpm.
// Both are optional independently — at least one must be present.
router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const hasTemplateId = Object.prototype.hasOwnProperty.call(body, 'template_id');
    const hasMaxCpm = Object.prototype.hasOwnProperty.call(body, 'max_cpm');

    if (!hasTemplateId && !hasMaxCpm) {
      return res.status(400).json({ error: 'At least one of template_id or max_cpm is required' });
    }

    const sets = [];
    const params = [req.params.id];

    if (hasTemplateId) {
      const raw = body.template_id;
      const templateId = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
      if (templateId !== null && !Number.isFinite(templateId)) {
        return res.status(400).json({ error: 'template_id must be a number or null' });
      }
      params.push(templateId);
      sets.push(`template_id = $${params.length}`);
    }

    if (hasMaxCpm) {
      const raw = body.max_cpm;
      const maxCpm = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
      if (maxCpm !== null && (!Number.isFinite(maxCpm) || maxCpm < 0)) {
        return res.status(400).json({ error: 'max_cpm must be a non-negative number or null' });
      }
      params.push(maxCpm);
      sets.push(`max_cpm = $${params.length}`);
    }

    const row = await db.one(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    if (err && err.code === '23503') {
      return res.status(400).json({ error: 'template_id does not reference an existing template' });
    }
    next(err);
  }
});

/**
 * POST /:id/recalculate-offers
 *
 * Re-runs the 6-offer CPM math (+ optional Claude notes) for every creator
 * in the campaign that has ig_scraped_data. Requires max_cpm to be set on
 * the campaign.
 *
 * Returns: { ok: true, updated: N }
 */
router.post('/:id/recalculate-offers', async (req, res, next) => {
  try {
    // Fetch the campaign to get max_cpm.
    const campaign = await db.one(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const maxCpm = campaign.max_cpm != null ? Number(campaign.max_cpm) : null;
    if (maxCpm == null || !Number.isFinite(maxCpm) || maxCpm <= 0) {
      return res.status(400).json({
        error: 'Campaign max_cpm must be set to a positive number before recalculating offers.',
      });
    }

    // Fetch all creators in this campaign that have scraped IG data.
    const creators = await db.many(
      `SELECT id, instagram_username, ig_scraped_data, quoted_rate
       FROM creators
       WHERE campaign_id = $1
         AND ig_scraped_data IS NOT NULL`,
      [req.params.id],
    );

    if (!creators.length) {
      return res.json({ ok: true, updated: 0 });
    }

    let updated = 0;
    for (const creator of creators) {
      try {
        const igData       = creator.ig_scraped_data;
        const quotedRate   = creator.quoted_rate != null ? Number(creator.quoted_rate) : null;
        const handle       = creator.instagram_username || '';

        const offers = await computeSixOffers(igData, maxCpm, quotedRate, handle);

        await db.query(
          `UPDATE creators SET suggested_offers = $2, updated_at = NOW() WHERE id = $1`,
          [creator.id, JSON.stringify(offers)],
        );
        updated += 1;
      } catch (innerErr) {
        console.error(`[recalculate-offers] Failed for creator ${creator.id}:`, innerErr.message);
      }
    }

    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});

module.exports = router;
