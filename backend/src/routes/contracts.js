'use strict';

// Public contract endpoints: the signing page fetches its data here and posts the
// signed submission back. Contracts are resolved by their unguessable `token`
// only — no database id is ever accepted or exposed.

const path = require('path');
const express = require('express');
const db = require('../db');
const contracts = require('../services/contracts');
const creatorDb = require('../services/creatorDb');
const campaignDashboard = require('../services/campaignDashboard');

const api = express.Router();

// GET /api/contracts/:token — the contract data the signing page renders.
api.get('/:token', async (req, res, next) => {
  try {
    const c = await contracts.getByToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'Contract not found' });
    res.json({
      token: c.token,
      status: c.status,
      data: c.data,
      signedAt: c.signed_at,
      signerName: c.signer_name,
      signerEmail: c.signer_email,
      // What the creator actually submitted when signing (contact, address,
      // drawn signature, bank/payout details). Present once signed; null while
      // still pending. Reachable only via the unguessable contract token, the
      // same credential used to fill these in.
      submission: c.status !== 'pending' ? c.submission || null : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/contracts/:token/submit — the creator signs the contract.
api.post('/:token/submit', async (req, res, next) => {
  try {
    const token = req.params.token;
    const c = await contracts.getByToken(token);
    if (!c) return res.status(404).json({ error: 'Contract not found' });

    const body = req.body || {};
    const signerName = String(body.signerName || body.fullName || '').trim();
    const agreed = body.agree === true || body.agreed === true;
    if (!signerName) {
      return res.status(400).json({ error: 'Please type your full legal name to sign.' });
    }
    if (!agreed) {
      return res
        .status(400)
        .json({ error: 'Please confirm you have read and agree to the contract terms.' });
    }

    const signerIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();

    const { row, alreadySigned } = await contracts.recordSubmission(token, {
      signerName,
      signerEmail: body.signerEmail || (c.data && c.data.email) || null,
      signerIp,
      submission: {
        fields: body.fields || null,
        agreedAt: new Date().toISOString(),
        userAgent: req.headers['user-agent'] || null,
      },
    });

    if (alreadySigned) {
      return res.json({ status: row ? row.status : 'signed', alreadySigned: true });
    }

    // Touch the creator so the dashboard re-renders the Status column promptly.
    await db.query(`UPDATE creators SET updated_at = NOW() WHERE id = $1`, [row.creator_id]);

    const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [row.creator_id]);

    // Sync into the Creator Database (best-effort — the signature already stuck).
    let synced = false;
    if (creatorDb.isConfigured()) {
      try {
        await creatorDb.syncSignedCreator(row, creator);
        synced = true;
      } catch (err) {
        console.error(`[contracts] Creator-DB sync failed for token ${token}:`, err.message);
        await contracts.markSynced(token, false, { error: err.message });
      }
    } else {
      console.warn('[contracts] CREATOR_DB_URL not set — skipping Creator-DB sync');
    }
    if (synced) await contracts.markSynced(token, true);

    // Push the signed creator + deliverables/deadline into the campaign
    // dashboard (best-effort — independent of the Creator-DB sync above).
    if (campaignDashboard.isConfigured()) {
      try {
        await campaignDashboard.syncSignedCreator(row, creator);
        await contracts.markDashboardSynced(token, true);
      } catch (err) {
        console.error(`[contracts] Campaign-dashboard sync failed for token ${token}:`, err.message);
        await contracts.markDashboardSynced(token, false, { error: err.message });
      }
    } else {
      console.warn('[contracts] CAMPAIGN_DASHBOARD_URL not set — skipping dashboard sync');
    }

    res.json({ status: synced ? 'completed' : 'signed', synced });
  } catch (err) {
    next(err);
  }
});

// GET /contracts/:token — the public signing page shell. The page fetches its
// data client-side from /api/contracts/:token, so an unknown token simply shows
// a "not found" state. Served before the SPA static handler in server.js.
function page(_req, res) {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'contract.html'));
}

module.exports = { api, page };
