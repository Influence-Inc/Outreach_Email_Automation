const express = require('express');
const db = require('../db');

const router = express.Router();

function normalizeOutreach(o) {
  if (!o || typeof o !== 'object') return { subject: '', body: '' };
  return {
    subject: typeof o.subject === 'string' ? o.subject : '',
    body: typeof o.body === 'string' ? o.body : '',
  };
}

function normalizeFollowups(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => {
      const delayHours = Number(s && s.delayHours);
      if (!Number.isFinite(delayHours) || delayHours < 0) return null;
      const out = { delayHours };
      if (s && typeof s.label === 'string' && s.label.trim()) out.label = s.label.trim();
      if (s && typeof s.subject === 'string') out.subject = s.subject;
      if (s && typeof s.body === 'string') out.body = s.body;
      return out;
    })
    .filter(Boolean);
}

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT id, name, outreach, followups, is_default, created_at, updated_at
       FROM email_templates
       ORDER BY is_default DESC, name ASC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, outreach, followups, is_default } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (is_default) {
        await client.query(`UPDATE email_templates SET is_default = FALSE WHERE is_default`);
      }
      const result = await client.query(
        `INSERT INTO email_templates (name, outreach, followups, is_default)
         VALUES ($1, $2::jsonb, $3::jsonb, $4) RETURNING *`,
        [
          name.trim(),
          JSON.stringify(normalizeOutreach(outreach)),
          JSON.stringify(normalizeFollowups(followups)),
          Boolean(is_default),
        ],
      );
      await client.query('COMMIT');
      res.status(201).json(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'a template with that name already exists' });
    }
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (typeof body.name === 'string' && body.name.trim()) {
      params.push(body.name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (body.outreach !== undefined) {
      params.push(JSON.stringify(normalizeOutreach(body.outreach)));
      sets.push(`outreach = $${params.length}::jsonb`);
    }
    if (body.followups !== undefined) {
      params.push(JSON.stringify(normalizeFollowups(body.followups)));
      sets.push(`followups = $${params.length}::jsonb`);
    }
    const settingDefault = Object.prototype.hasOwnProperty.call(body, 'is_default')
      ? Boolean(body.is_default) : null;
    if (!sets.length && settingDefault === null) {
      return res.status(400).json({ error: 'no editable fields supplied' });
    }
    sets.push(`updated_at = NOW()`);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (settingDefault === true) {
        await client.query(`UPDATE email_templates SET is_default = FALSE WHERE is_default`);
        params.push(true);
        sets.push(`is_default = $${params.length}`);
      } else if (settingDefault === false) {
        params.push(false);
        sets.push(`is_default = $${params.length}`);
      }
      const result = await client.query(
        `UPDATE email_templates SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      );
      await client.query('COMMIT');
      if (!result.rows.length) return res.status(404).json({ error: 'not found' });
      res.json(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'a template with that name already exists' });
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    // Refuse to delete the last remaining template — that would leave the
    // sender with nothing to fall back to.
    const count = await db.one(`SELECT COUNT(*)::int AS n FROM email_templates`);
    if (count && count.n <= 1) {
      return res.status(400).json({ error: 'cannot delete the last template' });
    }
    await db.query(`DELETE FROM email_templates WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
