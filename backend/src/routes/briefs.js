'use strict';

// Public content-brief page. The creator-facing brief is resolved by its
// unguessable `token` only (never a DB id). The page shell fetches its data
// client-side from /api/briefs/:token, so an unknown token simply shows a
// "not found" state. Served before the SPA static handler in server.js.

const path = require('path');
const express = require('express');
const briefs = require('../services/briefs');

const api = express.Router();

// GET /api/briefs/:token — the published brief snapshot the page renders.
api.get('/:token', async (req, res, next) => {
  try {
    const b = await briefs.getByToken(req.params.token);
    if (!b) return res.status(404).json({ error: 'Brief not found' });
    res.json({ token: b.token, data: b.data, publishedAt: b.publishedAt });
  } catch (err) {
    next(err);
  }
});

// GET /brief/:token — the public brief page shell.
function page(_req, res) {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'brief.html'));
}

module.exports = { api, page };
