const express = require('express');
const { generateAuthUrl, exchangeCode } = require('../services/oauth');
const db = require('../db');

const router = express.Router();

router.get('/google', (_req, res) => {
  res.redirect(generateAuthUrl());
});

router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    const email = await exchangeCode(code);
    res.send(
      `<html><body style="font-family:sans-serif;padding:40px;">
         <h2>Authorized as ${email}</h2>
         <p>You can close this tab and return to the dashboard.</p>
       </body></html>`,
    );
  } catch (err) {
    res.status(500).send(`OAuth callback failed: ${err.message}`);
  }
});

router.get('/status', async (_req, res) => {
  const senderEmail = process.env.SENDER_EMAIL;
  const row = await db.one('SELECT email, updated_at FROM oauth_tokens WHERE email = $1', [senderEmail]);
  res.json({
    senderEmail,
    authorized: Boolean(row),
    authorizedAt: row ? row.updated_at : null,
  });
});

module.exports = router;
