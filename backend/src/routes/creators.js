const express = require('express');
const db = require('../db');
const { sendOutreach } = require('../services/outreach');

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
    // If an email is now present and creator was pending, advance status.
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

module.exports = router;
