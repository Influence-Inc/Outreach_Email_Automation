const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { brand_id } = req.query;
    const params = [];
    let where = '';
    if (brand_id) {
      params.push(brand_id);
      where = 'WHERE c.brand_id = $1';
    }
    const rows = await db.many(
      `SELECT c.*, b.name AS brand_name,
              COUNT(cr.id)::int AS creator_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'outreach_sent')::int AS outreach_sent_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'followup_sent')::int AS followup_sent_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'replied')::int AS replied_count
       FROM campaigns c
       JOIN brands b ON b.id = c.brand_id
       LEFT JOIN creators cr ON cr.campaign_id = c.id
       ${where}
       GROUP BY c.id, b.name
       ORDER BY c.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { brand_id, name } = req.body || {};
    if (!brand_id || !name) {
      return res.status(400).json({ error: 'brand_id and name are required' });
    }
    const row = await db.one(
      `INSERT INTO campaigns (brand_id, name) VALUES ($1, $2) RETURNING *`,
      [brand_id, name.trim()],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.one(
      `SELECT c.*, b.name AS brand_name
       FROM campaigns c JOIN brands b ON b.id = c.brand_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
