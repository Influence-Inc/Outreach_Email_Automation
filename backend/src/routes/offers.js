'use strict';

// Public offer-portal endpoints. The hosted offer page (/o/:token) fetches its
// data here and posts accept / decline / counter back. Offers are resolved by
// their unguessable `token` only — the SERIAL id is never accepted or exposed.
// Mirrors the Influence-CDB-portal API routes (respond + counter).

const path = require('path');
const express = require('express');
const offers = require('../services/offers');
const { DECLINE_REASONS } = require('../services/offerPortal/replies');

const api = express.Router();

// GET /api/offers/:token — the offer data the page renders. Logs a `viewed`
// event as a side effect (see getOfferForPage).
api.get('/:token', async (req, res, next) => {
  try {
    const data = await offers.getOfferForPage(req.params.token);
    if (!data) return res.status(404).json({ ok: false, reason: 'not_found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/offers/:token/respond — accept or decline from the web page.
api.post('/:token/respond', async (req, res, next) => {
  try {
    const body = req.body || {};
    const response = body.response;
    if (response !== 'accepted' && response !== 'declined') {
      return res.status(400).json({ ok: false, reason: 'invalid_response' });
    }
    const reason =
      response === 'declined' && DECLINE_REASONS.includes(body.reason) ? body.reason : null;

    const result = await offers.respondToOffer({
      token: req.params.token,
      response,
      channel: 'web',
      declineReason: reason,
    });
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/offers/:token/counter — the creator proposes their own rate on a
// Budget decline. Returns a counter-offer, a "too high" verdict, or an error.
api.post('/:token/counter', async (req, res, next) => {
  try {
    const requestedRate = Number((req.body || {}).requestedRate);
    const result = await offers.negotiateBudget({ token: req.params.token, requestedRate });
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/offers/:token/sign-contract — the creator signs the mini contract
// (a typed-name signature) after accepting. Returns { ok } or a reason.
api.post('/:token/sign-contract', async (req, res, next) => {
  try {
    const signerName = (req.body || {}).signerName;
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) ||
      null;
    const result = await offers.signMiniContract({ token: req.params.token, signerName, ip });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /o/:token — the public offer page shell. The page fetches its data
// client-side from /api/offers/:token, so an unknown token shows a "not found"
// state. Served before the SPA static handler in server.js.
function page(_req, res) {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'offer.html'));
}

module.exports = { api, page };
