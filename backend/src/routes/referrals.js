'use strict';

// Referral commission — admin endpoints (behind the Slack gate). The platform
// reports sign-ups and campaigns through the bot API (routes/bot.js); these are
// for the team: see a creator's referred brands, review the decisions (the
// contested and rejected ones especially), and settle a dispute by hand.
// All logic lives in services/referrals.js.

const express = require('express');
const referrals = require('../services/referrals');

const router = express.Router();

function fail(res, next, err) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

// GET /api/referrals/creators/:id — the creator's code(s), link, credited
// brands and the commission their counted campaigns have earned.
router.get('/creators/:id', async (req, res, next) => {
  try {
    res.json(await referrals.creatorReferrals(req.params.id));
  } catch (err) {
    fail(res, next, err);
  }
});

// GET /api/referrals/signups[?outcome=attributed|unattributed|rejected][&contested=1]
// Every brand sign-up with its decision and the per-claim audit trail.
router.get('/signups', async (req, res, next) => {
  try {
    res.json(
      await referrals.listSignups({
        outcome: req.query.outcome || null,
        contested: req.query.contested === '1' || req.query.contested === 'true',
        limit: req.query.limit,
      }),
    );
  } catch (err) {
    fail(res, next, err);
  }
});

// POST /api/referrals/signups/:id/override  { code: 'MAYA' | null, note }
// Credit a brand to a code (or to nobody) by hand. The note is required and
// kept with the decision, alongside who made it.
router.post('/signups/:id/override', async (req, res, next) => {
  try {
    const body = req.body || {};
    const by = (req.user && (req.user.email || req.user.name)) || null;
    res.json(await referrals.overrideSignup(req.params.id, { code: body.code, note: body.note, by }));
  } catch (err) {
    fail(res, next, err);
  }
});

module.exports = router;
