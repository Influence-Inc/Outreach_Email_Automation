const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.name, c.brand_name, c.slug, c.synced_at,
              c.template_id,
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

// Update campaign settings: template_id.
router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'template_id')) {
      return res.status(400).json({ error: 'template_id is required' });
    }

    const raw = body.template_id;
    const templateId = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
    if (templateId !== null && !Number.isFinite(templateId)) {
      return res.status(400).json({ error: 'template_id must be a number or null' });
    }

    const row = await db.one(
      `UPDATE campaigns SET template_id = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, templateId],
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

module.exports = router;
