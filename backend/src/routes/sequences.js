const express = require('express');
const db = require('../db');

const router = express.Router();

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => {
      const delayHours = Number(s && s.delayHours);
      if (!Number.isFinite(delayHours) || delayHours < 0) return null;
      const out = { delayHours };
      if (s && typeof s.label === 'string' && s.label.trim()) out.label = s.label.trim();
      return out;
    })
    .filter(Boolean);
}

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT id, name, steps, created_at, updated_at
       FROM follow_up_sequences ORDER BY name ASC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, steps } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const cleaned = normalizeSteps(steps);
    if (!cleaned.length) {
      return res.status(400).json({ error: 'at least one step with delayHours is required' });
    }
    const row = await db.one(
      `INSERT INTO follow_up_sequences (name, steps)
       VALUES ($1, $2::jsonb) RETURNING *`,
      [name.trim(), JSON.stringify(cleaned)],
    );
    res.status(201).json(row);
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'a sequence with that name already exists' });
    }
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, steps } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (typeof name === 'string' && name.trim()) {
      params.push(name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (steps !== undefined) {
      const cleaned = normalizeSteps(steps);
      if (!cleaned.length) {
        return res.status(400).json({ error: 'at least one step with delayHours is required' });
      }
      params.push(JSON.stringify(cleaned));
      sets.push(`steps = $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no editable fields supplied' });

    sets.push(`updated_at = NOW()`);
    const row = await db.one(
      `UPDATE follow_up_sequences SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'a sequence with that name already exists' });
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM follow_up_sequences WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
