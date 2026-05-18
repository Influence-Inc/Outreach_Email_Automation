const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT b.*, COUNT(c.id)::int AS campaign_count
       FROM brands b
       LEFT JOIN campaigns c ON c.brand_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const row = await db.one(
      `INSERT INTO brands (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [name.trim()],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

module.exports = router;
