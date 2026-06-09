// Negotiation admin actions. Mounted at /api/creators (alongside the creators
// router) so the paths read as /api/creators/:id/offer and /quoted-rate.

const express = require('express');
const db = require('../db');
const negotiation = require('../services/negotiation');
const { computeSixOffers } = require('../services/pricing');

const router = express.Router();

// Admin selects / edits / approves an offer. Sliders write `custom_offer`.
// This route is the ONLY thing that sends a priced offer email: when
// offer_approved is true we send it right here, synchronously. Nothing sends
// offers in the background — if the creator isn't ready to receive it yet
// (no thread / not awaiting an offer) the approval is recorded and the admin
// re-approves once they are.
router.patch('/:id/offer', async (req, res, next) => {
  try {
    const { selected_offer_id, custom_offer, offer_approved } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (selected_offer_id !== undefined) {
      params.push(selected_offer_id || null);
      sets.push(`selected_offer_id = $${params.length}`);
    }
    if (custom_offer !== undefined) {
      params.push(custom_offer != null ? JSON.stringify(custom_offer) : null);
      sets.push(`custom_offer = $${params.length}::jsonb`);
    }
    if (offer_approved !== undefined) {
      params.push(!!offer_approved);
      sets.push(`offer_approved = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

    sets.push('updated_at = NOW()');
    const row = await db.one(
      `UPDATE creators SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'not found' });

    let send_result = null;
    if (offer_approved) {
      try {
        // Send the offer email now, as a direct result of this approval. Allow
        // sending from AWAITING_RATE too (not just AWAITING_APPROVAL) so the
        // admin can proactively offer an engaged creator. If the creator isn't
        // ready (no thread / not awaiting an offer), the approval is recorded
        // but nothing is sent — the admin re-approves once they are ready.
        send_result = await negotiation.sendApprovedOffer(row.id, {
          fromStages: ['AWAITING_APPROVAL', 'AWAITING_RATE'],
        });
      } catch (err) {
        send_result = { error: err.message };
      }
    }
    const fresh = await db.one(`SELECT * FROM creators WHERE id = $1`, [row.id]);
    res.json({ ...fresh, send_result });
  } catch (err) {
    next(err);
  }
});

// Manual rate override (e.g. admin types the creator's rate). Recomputes the 6
// offers when IG stats already exist, and moves the creator into the approval
// stage so the offers become approvable.
router.post('/:id/quoted-rate', async (req, res, next) => {
  try {
    const raw = (req.body || {}).quoted_rate;
    const rate = raw == null || raw === '' ? null : Number(raw);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
      return res.status(400).json({ error: 'quoted_rate must be a non-negative number or null' });
    }

    const creator = await db.one(
      `SELECT c.*, ca.max_cpm
       FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!creator) return res.status(404).json({ error: 'not found' });

    const params = [req.params.id, rate];
    let offerSet = '';
    if (rate !== null && creator.ig_scraped_data) {
      const maxCpm = creator.max_cpm != null ? Number(creator.max_cpm) : Number(process.env.TARGET_CPM || 15);
      const offers = computeSixOffers(creator.ig_scraped_data, maxCpm, rate);
      params.push(JSON.stringify(offers));
      offerSet = `, suggested_offers = $${params.length}::jsonb`;
    }
    // Setting a rate advances NULL/AWAITING_RATE into AWAITING_APPROVAL; other
    // stages are left as-is. Clearing the rate touches only the column.
    const statusSet =
      rate !== null
        ? `, negotiation_status = CASE WHEN negotiation_status IS NULL OR negotiation_status = 'AWAITING_RATE' THEN 'AWAITING_APPROVAL' ELSE negotiation_status END`
        : '';

    const row = await db.one(
      `UPDATE creators SET quoted_rate = $2${offerSet}${statusSet}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      params,
    );
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
