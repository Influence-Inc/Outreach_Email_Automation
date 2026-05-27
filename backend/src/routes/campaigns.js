const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.name, c.brand_name, c.slug, c.synced_at,
              c.sequence_id, c.templates,
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

// Update per-campaign sequence assignment and/or template overrides. Only
// these two fields are user-editable; everything else comes from upstream sync.
router.patch('/:id', async (req, res, next) => {
  try {
    const { sequence_id, templates } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sequence_id')) {
      params.push(sequence_id === null || sequence_id === '' ? null : Number(sequence_id));
      sets.push(`sequence_id = $${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'templates')) {
      if (templates && typeof templates !== 'object') {
        return res.status(400).json({ error: 'templates must be an object' });
      }
      params.push(JSON.stringify(templates || {}));
      sets.push(`templates = $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no editable fields supplied' });

    const row = await db.one(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
