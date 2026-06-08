const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');
const { offersFor } = require('../services/pricing');

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
router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const hasTemplate = Object.prototype.hasOwnProperty.call(body, 'template_id');
    const hasMaxCpm = Object.prototype.hasOwnProperty.call(body, 'max_cpm');
    if (!hasTemplate && !hasMaxCpm) {
      return res.status(400).json({ error: 'template_id or max_cpm is required' });
    }

    const sets = [];
    const params = [req.params.id];

    if (hasTemplate) {
      const raw = body.template_id;
      const templateId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
      if (templateId !== null && !Number.isFinite(templateId)) {
        return res.status(400).json({ error: 'template_id must be a number or null' });
      }
      params.push(templateId);
      sets.push(`template_id = $${params.length}`);
    }

    if (hasMaxCpm) {
      const raw = body.max_cpm;
      const maxCpm = raw === null || raw === '' || raw === undefined ? null : Number(raw);
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

// Recompute the 6 offers for every creator in a campaign that has both IG
// stats and a quoted rate (e.g. after the admin changes max_cpm).
router.post('/:id/recalculate-offers', async (req, res, next) => {
  try {
    const campaign = await db.one(`SELECT id, max_cpm FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'not found' });
    const maxCpm = campaign.max_cpm != null ? Number(campaign.max_cpm) : Number(process.env.TARGET_CPM || 15);

    // Any creator with a rate can get offers — real scraped stats when present,
    // otherwise synthesized from the rate.
    const creators = await db.many(
      `SELECT id, ig_scraped_data, quoted_rate FROM creators
       WHERE campaign_id = $1 AND quoted_rate IS NOT NULL`,
      [req.params.id],
    );
    let updated = 0;
    for (const c of creators) {
      const offers = offersFor(c.ig_scraped_data, maxCpm, Number(c.quoted_rate));
      if (!offers) continue;
      await db.query(
        `UPDATE creators SET suggested_offers = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [c.id, JSON.stringify(offers)],
      );
      updated += 1;
    }
    res.json({ ok: true, updated, max_cpm: maxCpm });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
