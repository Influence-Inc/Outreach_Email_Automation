const express = require('express');
const db = require('../db');
const { verifyToken } = require('../services/unsubscribe');

const router = express.Router();

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

// Unbranded path so naive "/track/" string-match filters don't flag the
// pixel host. Mounted under /track in server.js, so the public URL is
// /track/o/:trackingId.gif served from track.useinfluence.xyz in prod.
router.get('/o/:trackingId.gif', async (req, res) => {
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

// Backwards-compatible alias for any in-flight emails that already shipped
// with the old pixel URL. Same behavior; can be removed once those have
// rotated out of inboxes.
router.get('/open/:trackingId.png', (req, res, next) => {
  req.url = `/o/${req.params.trackingId}.gif`;
  next();
});

async function recordUnsubscribe(creatorId, email) {
  await db.query(
    `INSERT INTO email_suppressions (email, reason, creator_id)
     VALUES ($1, 'unsubscribed', $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, creatorId],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail)
     VALUES ($1, 'unsubscribed', $2)`,
    [creatorId, { email }],
  );
}

// Looks up the creator + email for an unsubscribe token. Returns null if
// the token is bad or the creator doesn't exist — both surface as 404 to
// the caller (no info leak about whether the ID is valid).
async function resolveUnsubscribe(creatorIdRaw, token) {
  const creatorId = Number(creatorIdRaw);
  if (!Number.isInteger(creatorId) || creatorId <= 0) return null;
  if (!verifyToken(creatorId, token)) return null;
  const creator = await db.one(`SELECT id, email FROM creators WHERE id = $1`, [creatorId]);
  if (!creator || !creator.email) return null;
  return creator;
}

// RFC 8058 one-click. Gmail / Yahoo POST here with no body when the user
// clicks the "Unsubscribe" pip; the response must be 2xx for the click to
// register. Idempotent.
router.post('/unsubscribe/:creatorId/:token', async (req, res) => {
  const creator = await resolveUnsubscribe(req.params.creatorId, req.params.token);
  if (!creator) return res.status(404).send('Not found');
  try {
    await recordUnsubscribe(creator.id, creator.email);
    res.status(200).send('Unsubscribed');
  } catch (err) {
    console.error('one-click unsubscribe failed:', err.message);
    res.status(500).send('Server error');
  }
});

// Human-facing confirmation page used when someone clicks the link in the
// email body. Same effect as the POST, plus a small visible confirmation
// so the recipient knows it worked.
router.get('/unsubscribe/:creatorId/:token', async (req, res) => {
  const creator = await resolveUnsubscribe(req.params.creatorId, req.params.token);
  if (!creator) {
    res.status(404).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>` +
      `<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;color:#222;">` +
      `<h1 style="font-size:18px;">Link not valid</h1>` +
      `<p>This unsubscribe link is expired or invalid. Reply to the original email with "unsubscribe" and we'll remove you.</p>` +
      `</body>`,
    );
    return;
  }
  try {
    await recordUnsubscribe(creator.id, creator.email);
    res.status(200).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>` +
      `<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;color:#222;">` +
      `<h1 style="font-size:18px;">You're unsubscribed</h1>` +
      `<p>${creator.email} won't receive any more outreach from us. Sorry for the noise.</p>` +
      `</body>`,
    );
  } catch (err) {
    console.error('unsubscribe failed:', err.message);
    res.status(500).type('html').send('Server error');
  }
});

module.exports = router;
