const express = require('express');
const db = require('../db');

const router = express.Router();

router.use((req, res, next) => {
  const expected = process.env.EXTENSION_API_KEY;
  if (!expected) return next();
  const got = req.headers['x-extension-key'];
  if (got !== expected) return res.status(401).json({ error: 'invalid extension key' });
  next();
});

router.get('/pending', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.instagram_url, c.instagram_username, ca.name AS campaign_name, b.name AS brand_name
       FROM creators c
       JOIN campaigns ca ON ca.id = c.campaign_id
       JOIN brands b ON b.id = ca.brand_id
       WHERE c.status = 'pending_extraction'
       ORDER BY c.created_at ASC
       LIMIT 50`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/extracted/:id', async (req, res, next) => {
  try {
    const { email, first_name, full_name, instagram_username } = req.body || {};
    const updates = ['updated_at = NOW()'];
    const params = [req.params.id];

    if (email) {
      params.push(email);
      updates.push(`email = $${params.length}`);
    }
    if (first_name) {
      params.push(first_name);
      updates.push(`first_name = $${params.length}`);
    }
    if (full_name) {
      params.push(full_name);
      updates.push(`full_name = $${params.length}`);
    }
    if (instagram_username) {
      params.push(instagram_username);
      updates.push(`instagram_username = $${params.length}`);
    }

    if (email) {
      updates.push(`status = 'email_found'`);
    } else {
      updates.push(`status = 'no_email'`);
    }

    const row = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
