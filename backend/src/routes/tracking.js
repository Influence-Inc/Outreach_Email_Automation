const express = require('express');
const db = require('../db');

const router = express.Router();

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

router.get('/open/:trackingId.png', async (req, res) => {
  const { trackingId } = req.params;

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(PIXEL);

  // Log after responding so the pixel always returns fast.
  try {
    const creator = await db.one(
      `SELECT id FROM creators
       WHERE outreach_message_id = $1 OR followup_message_id = $1
       LIMIT 1`,
      [trackingId],
    );
    if (!creator) return;
    const userAgent = req.headers['user-agent'] || '';
    // Gmail image proxy fires once per cache cycle; still record every hit.
    await db.query(
      `UPDATE creators
       SET last_open_at = NOW(),
           open_count = open_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [creator.id],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'opened', $2, $3)`,
      [creator.id, trackingId, { userAgent, ip: req.ip }],
    );
  } catch (err) {
    console.error('open-tracking log failed:', err.message);
  }
});

module.exports = router;
