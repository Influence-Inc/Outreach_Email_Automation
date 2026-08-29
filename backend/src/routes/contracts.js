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
const briefs = require('../services/briefs');
const creatorUpdates = require('../services/creatorUpdates');
const offerWhatsapp = require('../services/offerPortal/whatsapp');

const api = express.Router();

// The "message us on WhatsApp" opt-in shown under the signed confirmation.
//
// Subscribing is what lets us reach the creator directly from then on — for
// their brief, their payment, and every future campaign — so the moment they've
// just signed is when asking costs them the least. Returned only when it would
// actually work AND they haven't already subscribed: someone we're already
// chatting with doesn't need to be invited to start a chat, and a creator who
// opted out must never be re-prompted. Null otherwise, and the page hides it.
// onContractSigned above has just subscribed them to the update lane, but that
// lane can only send free-form updates once the creator writes in — the "Hi"
// this card asks for is what opens their 24h window. requestHi() also asks by
// email; showing it here catches them while they're still on the page.
//
// The deep link comes from creatorUpdates.hiDeepLink so the prefilled text and
// number stay identical to the emailed ask.
function whatsappOptInFor(creator) {
  try {
    if (!creator || creator.messaging_opted_out) return null;
    // Already writing to us inside the window — nothing to ask for.
    if (creatorUpdates.windowOpen(creator)) return null;
    const link = creatorUpdates.hiDeepLink();
    if (!link) return null;
    return { number: offerWhatsapp.businessNumber(), link };
  } catch (err) {
    // Never let this cost someone their signature confirmation.
    console.warn('[contracts] whatsapp opt-in lookup failed:', err.message);
    return null;
  }
}

// GET /api/contracts/:token — the contract data the signing page renders.
api.get('/:token', async (req, res, next) => {
  try {
    const c = await contracts.getByToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'Contract not found' });
    res.json({
      token: c.token,
      status: c.status,
      data: c.data,
      // The "Additional Terms" bullets, merged and de-duplicated server-side
      // (contracts.combinedAdditionalTerms): the thread-extracted terms plus the
      // team's hand-added points, minus the extraction's own paraphrase of any
      // clause the team pasted by hand. Sent ready-to-render so the signing page
      // and the dashboard sync show exactly the same list.
      combinedTerms: contracts.combinedAdditionalTerms(c.data),
      signedAt: c.signed_at,
      signerName: c.signer_name,
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

    // Flag a personalised content brief for the team to complete (best-effort —
    // the signature already stuck; a failure here never blocks signing).
    try {
      await briefs.flagBriefPending(row.creator_id);
    } catch (err) {
      console.error(`[contracts] flagBriefPending failed for token ${token}:`, err.message);
    }

    // Open the WhatsApp campaign-update lane. This is the signature that starts
    // it for a NEW creator — from here their brief, review outcomes and
    // completion notice reach them on WhatsApp instead of email. Idempotent on a
    // creator who is already subscribed, and best-effort like every other
    // post-signature step: the contract is signed either way.
    try {
      await creatorUpdates.onContractSigned(row.creator_id, { campaignId: creator.campaign_id });
    } catch (err) {
      console.error(`[contracts] creator-updates subscribe failed for token ${token}:`, err.message);
    }

    res.json({
      status: synced ? 'completed' : 'signed',
      synced,
      whatsappOptIn: whatsappOptInFor(creator),
    });
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
