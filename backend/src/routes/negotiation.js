// Negotiation admin actions. Mounted at /api/creators (alongside the creators
// router) so the paths read as /api/creators/:id/offer and /quoted-rate.

const express = require('express');
const db = require('../db');
const negotiation = require('../services/negotiation');
const contracts = require('../services/contracts');
const { computeOffers } = require('../services/pricing');
const { flagFingerprintSql } = require('../db/flagFingerprint');

const router = express.Router();

// Admin selects / edits / approves an offer. Sliders write `custom_offer`.
// This route is the ONLY thing that sends a priced offer email: when
// offer_approved is true we send it right here, synchronously. Nothing sends
// offers in the background — if the creator isn't ready to receive it yet
// (no thread / not awaiting an offer) the approval is recorded and the admin
// re-approves once they are.
router.patch('/:id/offer', async (req, res, next) => {
  try {
    const { selected_offer_id, custom_offer, offer_approved, email } = req.body || {};
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
        // When the admin reviewed an AI draft ("Draft with AI"), `email` carries
        // the exact (possibly hand-edited) body — send it verbatim instead of
        // re-drafting. Absent that, the offer email is auto-drafted as before.
        send_result = await negotiation.sendApprovedOffer(row.id, {
          fromStages: ['AWAITING_APPROVAL', 'AWAITING_RATE'],
          preparedEmail: email && email.body ? email : null,
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

// Preview the offer email WITHOUT sending — the "Draft with AI" flow. The admin
// shapes an offer, optionally types a short note describing what to add, and we
// return the drafted email so they can review + edit it before hitting send.
// No side effects (nothing emailed, no stage/flag change). The reviewed body is
// sent later through PATCH /:id/offer (offer_approved:true, email:{...}).
router.post('/:id/draft-offer', async (req, res, next) => {
  try {
    const { custom_offer, instructions } = req.body || {};
    const draft = await negotiation.buildOfferDraft(req.params.id, {
      offer: custom_offer,
      instructions: instructions || '',
    });
    res.json(draft);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Preview a plain hand-off reply WITHOUT sending — the "Draft with AI" box on
// the Delegate reply block. The admin describes what to say; we draft the reply
// so they can review + edit it in the reply box, then send it through the
// existing /:id/delegate-reply path. No side effects.
router.post('/:id/draft-reply', async (req, res, next) => {
  try {
    const { instructions } = req.body || {};
    const draft = await negotiation.buildReplyDraft(req.params.id, {
      instructions: instructions || '',
    });
    res.json(draft);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
      const offers = computeOffers(creator.ig_scraped_data, maxCpm, rate);
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

    // Log the change for the Rate-column timeline (admin set/overrode the rate).
    // NUMERIC comes back from pg as a string, so coerce before comparing.
    const prevRate = creator.quoted_rate != null ? Number(creator.quoted_rate) : null;
    if (rate !== null && rate !== prevRate) {
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_quoted', $2)`,
        [req.params.id, { from: prevRate, to: rate, by: 'admin' }],
      );
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Admin sends a manual reply from the Delegate window. Sends a threaded email
// and clears the needs_human flag.
router.post('/:id/delegate-reply', async (req, res, next) => {
  try {
    const { subject, body } = req.body || {};
    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: 'body is required' });
    }
    const result = await negotiation.sendDelegateReply(req.params.id, { subject, body });
    const fresh = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    res.json({ ...fresh, send_result: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The brand-POC go-ahead on an accepted deal. Acceptance parks the deal in the
// Delegate window; once the team has the brand POC's "go", this approves it,
// which generates the contract and emails its signing link. Contracts never go
// out before this (or the manual /contract escape hatch below) records the
// approval.
router.post('/:id/approve-contract', async (req, res, next) => {
  try {
    const result = await negotiation.approveContract(req.params.id);
    const fresh = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    res.json({ ...fresh, approve_result: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Manually generate + email the contract for a creator (API escape hatch, works
// at any stage). An explicit human "send the contract" counts as the brand
// go-ahead, so the approval is recorded here before sending — ensureContractSent
// refuses to send without it. Idempotent — reuses any existing contract.
router.post('/:id/contract', async (req, res, next) => {
  try {
    const exists = await db.one(`SELECT id FROM creators WHERE id = $1`, [req.params.id]);
    if (!exists) return res.status(404).json({ error: 'not found' });
    const claimed = await db.one(
      `UPDATE creators SET contract_approved = TRUE, updated_at = NOW()
       WHERE id = $1 AND contract_approved = FALSE RETURNING id`,
      [req.params.id],
    );
    if (claimed) {
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_approved', $2)`,
        [req.params.id, { by: 'admin', via: 'manual_contract' }],
      );
    }
    const result = await negotiation.ensureContractSent(req.params.id);
    const fresh = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    res.json({ ...fresh, contract_result: result });
  } catch (err) {
    next(err);
  }
});

// Edit a contract's deal terms straight from the dashboard Deals column
// (videos, min views, platforms, deadline, paid-ad rights, exclusivity).
// By default a signed contract returns 409; pass ?force=1 to update a signed
// contract in place without re-triggering signing or notifying the creator.
router.patch('/:id/contract', async (req, res, next) => {
  try {
    const exists = await db.one(`SELECT id FROM creators WHERE id = $1`, [req.params.id]);
    if (!exists) return res.status(404).json({ error: 'not found' });
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await contracts.updateContractFields(req.params.id, req.body || {}, { force });
    if (result.missing) {
      return res.status(404).json({ error: 'No contract for this creator yet.' });
    }
    if (result.signed) {
      return res
        .status(409)
        .json({ error: 'This contract is already signed — its terms can no longer be edited here.' });
    }
    res.json({
      ok: true,
      contract: { token: result.row.token, status: result.row.status, data: result.row.data },
    });
  } catch (err) {
    next(err);
  }
});

// Admin accepts the creator's quoted rate as-is (instead of shaping a counter
// offer). We agree to their number: the deal moves to ACCEPTED at that fee and
// parks in the Delegate window for the brand POC's approval — the contract is
// generated + emailed only once it's approved there. Mirrors the offer-approval
// flow but for the "yes, take their price" decision.
router.post('/:id/accept-rate', async (req, res, next) => {
  try {
    const result = await negotiation.acceptQuotedRate(req.params.id);
    const fresh = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    res.json({ ...fresh, accept_result: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Dismiss an awaiting-approval offer without sending it. Clears the pending
// offer state (offer_approved flag, custom_offer draft) and moves the creator
// to CLOSED so they drop out of the Delegate window. Distinct from
// dismiss-delegate (which only clears the AI hand-off flag) — this one exists
// so the admin can decline / postpone an offer straight from the offer
// configurator without accidentally firing a send.
router.post('/:id/dismiss-offer', async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE creators
       SET negotiation_status = 'CLOSED',
           offer_approved = FALSE,
           custom_offer = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND negotiation_status IN ('AWAITING_APPROVAL','AWAITING_RATE')
       RETURNING *`,
      [req.params.id],
    );
    if (!row) {
      const exists = await db.one(`SELECT id, negotiation_status FROM creators WHERE id = $1`, [req.params.id]);
      if (!exists) return res.status(404).json({ error: 'not found' });
      return res.status(409).json({
        error: `Cannot dismiss — creator is not awaiting an offer (stage: ${
          exists.negotiation_status ? exists.negotiation_status.replace(/_/g, ' ').toLowerCase() : 'no reply yet'
        }).`,
      });
    }
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'offer_dismissed', $2)`,
      [req.params.id, { by: 'admin' }],
    );
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Dismiss a delegated item without sending (clears the flag).
router.post('/:id/dismiss-delegate', async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE creators
       SET needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'delegate_dismissed', $2)`,
      [req.params.id, {}],
    );
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// "Dismiss" a creator's current flag: snooze it out of the flagged / "needs
// you" list without touching the negotiation state — nothing is closed or sent.
// (Distinct from dismiss-offer, which declines the offer to CLOSED, and from
// dismiss-delegate, which clears the hand-off flag outright.) We stamp the
// fingerprint of the CURRENT flag, so the dismissal holds only until genuinely
// new activity shifts that fingerprint and the creator re-flags on its own.
// Stored server-side so it syncs across devices and the campaigns action_count
// (sidebar pending-dot) honors it.
router.post('/:id/dismiss-flag', async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE creators
       SET flag_dismissed_fp = ${flagFingerprintSql()}, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'flag_dismissed', $2)`,
      [req.params.id, { by: 'admin' }],
    );
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
