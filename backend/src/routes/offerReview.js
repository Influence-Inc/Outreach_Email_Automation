'use strict';

// Admin "needs review" inbox for the offer-portal messaging bot. Inbound replies
// the bot couldn't confidently action (offer_messages.needs_review = TRUE) surface
// here so a human can read them and reply on the same channel, or dismiss. Same
// open-admin surface as the rest of /api/* the dashboard calls.

const express = require('express');
const offers = require('../services/offers');

const router = express.Router();

function displayName(r) {
  return (
    (r.first_name && String(r.first_name).trim()) ||
    (r.full_name && String(r.full_name).trim()) ||
    (r.instagram_username ? `@${r.instagram_username}` : 'Creator')
  );
}

function formatRow(r) {
  return {
    id: r.id,
    creatorId: r.creator_id,
    name: displayName(r),
    handle: r.instagram_username ? `@${r.instagram_username}` : null,
    channel: r.channel,
    body: r.body,
    at: r.sent_at,
    offer: r.offer_token
      ? {
          token: r.offer_token,
          status: r.offer_status,
          url: offers.offerUrl(r.offer_token),
          rate: r.offer_rate != null ? Number(r.offer_rate) : null,
          currency: r.offer_currency,
        }
      : null,
  };
}

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid message id' });
    return null;
  }
  return id;
}

// GET /api/offer-review — flagged inbound replies awaiting a human.
router.get('/', async (_req, res, next) => {
  try {
    const rows = await offers.listNeedsReview({ limit: 200 });
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

// POST /api/offer-review/:id/reply { body } — send a reply on the creator's
// channel and clear the flag.
router.post('/:id/reply', async (req, res, next) => {
  try {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const result = await offers.replyToNeedsReview({ messageId: id, body: (req.body || {}).body });
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : 400;
      return res.status(code).json({ error: result.reason });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/offer-review/:id/resolve — dismiss without replying.
router.post('/:id/resolve', async (req, res, next) => {
  try {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const result = await offers.resolveNeedsReview({ messageId: id });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Attach the pure formatter to the router (a function object) for unit testing.
router.formatRow = formatRow;
router.displayName = displayName;

module.exports = router;
