'use strict';

// Offer-portal service. Originally replicated from Influence-CDB-portal
// (src/lib/offers.ts, adapted from Prisma to this app's pg layer). THE single
// backend path for creating offers and accepting / declining / counter-
// negotiating them. Used for OLD creators (see creator_segment): instead of
// email negotiation, the admin's approved offer is minted here.
//
// Delivery never cold-pushes WhatsApp/iMessage. A fresh offer sends only an
// invite email ("text Hi to this number"); the offer's actual details go out
// as a free-form reply the moment the creator initiates contact on WhatsApp or
// iMessage (see deliverOfferOverChannel), and every later offer/counter in that
// negotiation stays on that same channel (creators.established_channel). A
// creator with no usable messaging channel falls back to the full offer email
// with the direct /o/:token web link instead.

const { randomBytes } = require('crypto');
const db = require('../db');
const { formatDate, formatMoney } = require('./offerPortal/format');
const email = require('./offerPortal/email');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const { thankYouMessage, politeCloseMessage } = require('./offerPortal/replies');

const DEFAULT_EXPIRY_DAYS = Number(process.env.OFFER_EXPIRY_DAYS || 7);

// Cryptographically random, unguessable, URL-safe token (~192 bits of entropy).
function generateOfferToken() {
  return randomBytes(24).toString('base64url');
}

function offerUrl(token) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.OFFER_PORTAL_BASE_URL || '').replace(/\/$/, '');
  return `${base}/o/${token}`;
}

const firstNameOf = (creator) =>
  (creator.first_name && String(creator.first_name).trim()) ||
  (creator.full_name ? String(creator.full_name).trim().split(/\s+/)[0] : '') ||
  'there';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Creates an offer and its initial `sent` event in one transaction. Retries on
// the (astronomically unlikely) token collision.
async function createOffer(input) {
  const expiresInDays = input.expiresInDays || DEFAULT_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000);
  const deliverables = JSON.stringify(Array.isArray(input.deliverables) ? input.deliverables : []);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = generateOfferToken();
    try {
      return await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO offers
             (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
           RETURNING *`,
          [
            input.creatorId,
            input.campaignId || null,
            token,
            input.brandName,
            deliverables,
            input.rate,
            input.currency || 'USD',
            input.expectedImpressions != null ? input.expectedImpressions : null,
            expiresAt,
          ],
        );
        const offer = rows[0];
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
          [offer.id],
        );
        return offer;
      });
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }
  throw new Error('Could not generate a unique offer token');
}

// ---------------------------------------------------------------------------
// Respond (accept / decline)
// ---------------------------------------------------------------------------

// THE single backend path for accepting/declining an offer. The web offer page
// (channel 'web') and the WhatsApp/iMessage inbound handlers (channel
// 'whatsapp'/'imessage') all call this — identical state transition, identical
// logging — so a WhatsApp "yes" and a web Accept can never drift apart.
async function respondToOffer({ token, response, channel, declineReason }) {
  const offer = await db.one(`SELECT id, status, expires_at FROM offers WHERE token = $1`, [token]);
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // Atomic, idempotent transition: the guarded UPDATE only flips a still-pending
  // offer, so concurrent responses (a fast double-tap) can't double-fire.
  const transitioned = await db.withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE offers SET status = $2, decline_reason = $3 WHERE id = $1 AND status = 'pending'`,
      [offer.id, response, response === 'declined' ? declineReason || null : null],
    );
    if (upd.rowCount === 0) return false; // lost the race — already responded
    await client.query(
      `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, $2, $3)`,
      [offer.id, response, channel],
    );
    return true;
  });

  if (!transitioned) return { ok: false, reason: 'already_responded' };

  // Follow-up runs from this convergence point, so a web Accept and a WhatsApp
  // "yes" trigger identical messages. A failed send never fails the response —
  // the status transition already committed.
  await onOfferResponded(offer.id, response);
  return { ok: true, status: response };
}

// Append-only view log. Called on each load of the public offer page.
async function logOfferViewed(offerId) {
  await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'viewed', 'web')`, [offerId]);
}

// ---------------------------------------------------------------------------
// Outbound delivery (email + WhatsApp + iMessage)
// ---------------------------------------------------------------------------

// The channel this creator has actually initiated contact on, if any — see
// established_channel's schema comment. Null means "not yet."
async function establishedMessagingChannel(creatorId) {
  const row = await db.one(`SELECT established_channel FROM creators WHERE id = $1`, [creatorId]);
  return (row && row.established_channel) || null;
}

// Deliver an offer's full details directly over an ALREADY-established
// messaging channel, as a free-form reply. Never used for a creator's first
// contact — that would be cold outreach (a WhatsApp message needs a
// pre-approved template outside an open session, and an unsolicited first
// iMessage risks spam-filtering). Used both for the delivery triggered by a
// creator's first "Hi" (see offerWebhook.js) and every later offer/counter in
// the same negotiation. Marks the channel established (sticky) on success.
async function deliverOfferOverChannel(offerId, channel) {
  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name, c.whatsapp, c.imessage
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return { sent: false, reason: 'not_found' };

  const to = channel === 'imessage' ? offer.imessage : offer.whatsapp;
  if (!to) return { sent: false, reason: 'no_contact_for_channel' };

  const params = {
    firstName: firstNameOf(offer),
    brandName: offer.brand_name,
    offerUrl: offerUrl(offer.token),
    expiryDate: formatDate(offer.expires_at),
  };
  const mod = channel === 'imessage' ? imessage : whatsapp;
  const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
  const body = mod.renderOfferOutreachBody(params);

  const result = await send({ to, body });
  if (result.sent) {
    await db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
       VALUES ($1, $2, 'outbound', $3, $4, $5)`,
      [offer.creator_id, offer.id, channel, body, result.id || null],
    );
    await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', $2)`, [offer.id, channel]);
    await db.query(
      `UPDATE creators SET established_channel = COALESCE(established_channel, $2), updated_at = NOW() WHERE id = $1`,
      [offer.creator_id, channel],
    );
  }
  return result;
}

// Top-level dispatcher for a NEW offer. We never cold-push a WhatsApp/iMessage
// message — only three outcomes:
//   established_channel set → deliver the full offer directly (free-form reply)
//   not set, WA/iMessage usable → invite email only ("text Hi to continue")
//   neither usable (opted out / no number / vendor unconfigured) → fall back to
//     the full offer email with the direct web link, so it's always reachable
async function sendOfferOutreach(offerId) {
  const offer = await db.one(
    `SELECT o.*, c.email AS creator_email, c.first_name, c.full_name, c.whatsapp, c.imessage,
            c.messaging_opted_out, c.established_channel
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return;

  if (offer.established_channel && !offer.messaging_opted_out) {
    try {
      await deliverOfferOverChannel(offer.id, offer.established_channel);
    } catch (err) {
      console.error('[offers] outreach delivery failed', err.message);
    }
    return;
  }

  if (!offer.creator_email) return; // no established channel and no email — nothing to try

  const firstName = firstNameOf(offer);
  const url = offerUrl(offer.token);
  const expiry = formatDate(offer.expires_at);
  const logSend = (channel, body) =>
    db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body)
       VALUES ($1, $2, 'outbound', $3, $4)`,
      [offer.creator_id, offer.id, channel, body],
    );

  const waNumber = !offer.messaging_opted_out && offer.whatsapp ? whatsapp.businessNumber() : '';
  const imNumber = !offer.messaging_opted_out && offer.imessage ? imessage.businessNumber() : '';

  try {
    if (waNumber || imNumber) {
      const res = await email.sendPortalInviteEmail({
        to: offer.creator_email,
        firstName,
        brandName: offer.brand_name,
        whatsappNumber: waNumber || null,
        imessageNumber: imNumber || null,
      });
      if (res.sent) {
        const via = [waNumber && 'WhatsApp', imNumber && 'iMessage'].filter(Boolean).join(' / ');
        await logSend('email', `Portal invite email — text "Hi" on ${via} to continue`);
        await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'invited', 'email')`, [
          offer.id,
        ]);
      }
    } else {
      const res = await email.sendOfferEmail({ to: offer.creator_email, firstName, brandName: offer.brand_name, offerUrl: url, expiryDate: expiry });
      if (res.sent) await logSend('email', `Offer email — "New collaboration opportunity — ${offer.brand_name}" (${url})`);
    }
  } catch (err) {
    console.error('[offers] outreach email failed', err.message);
  }
}

// Follow-up dispatch on accept / decline. Best-effort across all channels.
//   accept  → email confirmation + WhatsApp/iMessage thank-you
//   decline → WhatsApp/iMessage polite close
async function onOfferResponded(offerId, response) {
  try {
    const offer = await db.one(
      `SELECT o.*, c.email AS creator_email, c.first_name, c.full_name, c.whatsapp, c.imessage,
              c.messaging_opted_out, c.established_channel
       FROM offers o JOIN creators c ON c.id = o.creator_id
       WHERE o.id = $1`,
      [offerId],
    );
    if (!offer) return;

    const firstName = firstNameOf(offer);
    const logSend = (channel, body, providerMessageId = null) =>
      db.query(
        `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
         VALUES ($1, $2, 'outbound', $3, $4, $5)`,
        [offer.creator_id, offer.id, channel, body, providerMessageId],
      );

    // Email confirmation (accept only — no email on decline).
    if (response === 'accepted' && offer.creator_email) {
      try {
        const res = await email.sendOfferConfirmationEmail({
          to: offer.creator_email,
          firstName,
          brandName: offer.brand_name,
        });
        if (res.sent) await logSend('email', `Confirmation email — "Offer confirmed — ${offer.brand_name}"`);
      } catch (err) {
        console.error('[offers] confirmation email failed', err.message);
      }
    }

    // WhatsApp / iMessage thank-you / polite-close (both accept and decline) —
    // only over an ALREADY-established channel. A web response with no prior
    // messaging contact has nowhere to send this (nothing to establish it with
    // — the email confirmation above already covers the accept case).
    const body = response === 'accepted' ? thankYouMessage(firstName) : politeCloseMessage(firstName);
    const msgChannel = offer.messaging_opted_out ? null : offer.established_channel;
    if (msgChannel === 'whatsapp') {
      try {
        const res = await whatsapp.sendWhatsAppText({ to: offer.whatsapp, body });
        if (res.sent) await logSend('whatsapp', body, res.id);
      } catch (err) {
        console.error('[offers] follow-up WhatsApp failed', err.message);
      }
    } else if (msgChannel === 'imessage') {
      try {
        const res = await imessage.sendIMessageText({ to: offer.imessage, body });
        if (res.sent) await logSend('imessage', body, res.id);
      } catch (err) {
        console.error('[offers] follow-up iMessage failed', err.message);
      }
    }

    // Bridge back into the Deal Studio negotiation state so a portal accept /
    // decline advances the deal exactly like an admin-accepted rate:
    //   accept  → ACCEPTED (rate locked) + parked for the brand-POC contract
    //             approval (isContractApprovalPending → "Approve deal")
    //   decline → CLOSED
    // Best-effort and idempotent (guarded so a re-fire can't double-log).
    try {
      if (response === 'accepted') {
        const claimed = await db.one(
          `UPDATE creators
             SET negotiation_status = 'ACCEPTED', quoted_rate = $2,
                 offer_approved = FALSE, contract_approved = FALSE,
                 needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
                 updated_at = NOW()
           WHERE id = $1 AND negotiation_status IS DISTINCT FROM 'ACCEPTED'
           RETURNING id`,
          [offer.creator_id, Number(offer.rate)],
        );
        if (claimed) {
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_accepted', $2)`,
            [offer.creator_id, { fee: Number(offer.rate), by: 'creator', source: 'offer_portal' }],
          );
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_approval_requested', $2)`,
            [offer.creator_id, { fee: Number(offer.rate) }],
          );
        }
      } else if (response === 'declined') {
        const claimed = await db.one(
          `UPDATE creators SET negotiation_status = 'CLOSED', updated_at = NOW()
           WHERE id = $1 AND negotiation_status IS DISTINCT FROM 'ACCEPTED'
           RETURNING id`,
          [offer.creator_id],
        );
        if (claimed) {
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'negotiation_closed', $2)`,
            [offer.creator_id, { reason: 'offer_declined', via: 'offer_portal', declineReason: offer.decline_reason || null }],
          );
        }
      }
    } catch (err) {
      console.error('[offers] deal-studio bridge failed', err.message);
    }
  } catch (err) {
    console.error('[offers] onOfferResponded failed', err.message);
  }
}

// Update an OUTBOUND message's delivery state from a provider status callback
// (sent / delivered / read / failed), correlated by the id the gateway returned
// on send. A status we can't match to a row (unknown id) is a no-op, never an
// error — status callbacks and sends race, and some sends predate id capture.
async function recordDeliveryStatus({ channel, providerMessageId, status }) {
  if (!providerMessageId || !status) return { ok: false, reason: 'incomplete' };
  const res = await db.query(
    `UPDATE offer_messages
        SET delivery_status = $3, delivery_status_at = NOW()
      WHERE provider_message_id = $1 AND channel = $2 AND direction = 'outbound'`,
    [providerMessageId, channel, status],
  );
  return { ok: true, updated: res.rowCount };
}

// ---------------------------------------------------------------------------
// Budget negotiation (CPM-based counter) — ported from offers.ts
// ---------------------------------------------------------------------------

function cpmToleranceAbs() {
  const raw = Number(process.env.COUNTER_CPM_TOLERANCE);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.5;
}
function legacyRateTolerancePct() {
  const raw = Number(process.env.COUNTER_RATE_TOLERANCE_PCT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.15;
}
function maxCpmMultiple() {
  const raw = Number(process.env.MAX_CPM_MULTIPLE);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}
function computeCounterRate(originalRate, requestedRate) {
  if (process.env.COUNTER_STRATEGY === 'match') return requestedRate;
  const midpoint = Math.round((originalRate + requestedRate) / 2);
  return Math.min(midpoint, requestedRate);
}

function parseDeliverableLine(line) {
  const match = String(line).trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  return { count: Number(match[1]), label: match[2] };
}
function totalDeliverableUnits(deliverables) {
  const parsed = deliverables.map(parseDeliverableLine);
  if (parsed.every((p) => p !== null)) return parsed.reduce((sum, p) => sum + p.count, 0);
  return deliverables.length;
}
function expandDeliverables(deliverables, extraUnits) {
  const parsed = deliverables.map(parseDeliverableLine);
  if (parsed.every((p) => p !== null)) {
    let bumpIndex = 0;
    for (let i = 1; i < parsed.length; i += 1) {
      if (parsed[i].count > parsed[bumpIndex].count) bumpIndex = i;
    }
    const bumped = parsed[bumpIndex];
    const next = [...deliverables];
    next[bumpIndex] = `${bumped.count + extraUnits} ${bumped.label}`;
    return { deliverables: next, addedLabel: `${extraUnits} more ${bumped.label}` };
  }
  const lastLabel = deliverables[deliverables.length - 1];
  return {
    deliverables: [...deliverables, `${extraUnits} extra ${lastLabel}`],
    addedLabel: `${extraUnits} extra ${lastLabel}`,
  };
}

// Judge a creator's counter-ask by CPM (see offers.ts for the full rationale).
async function negotiateBudget({ token, requestedRate }) {
  if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
    return { ok: false, reason: 'invalid_rate' };
  }

  const offer = await db.one(`SELECT * FROM offers WHERE token = $1`, [token]);
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  const originalRate = Number(offer.rate);
  const impressions = offer.expected_impressions != null ? Number(offer.expected_impressions) : null;
  const deliverablesArr = Array.isArray(offer.deliverables) ? offer.deliverables : [];

  let plan;
  if (impressions && impressions > 0) {
    const cpmOriginal = (originalRate / impressions) * 1000;
    const cpmRequested = (requestedRate / impressions) * 1000;
    const cpmTolerance = cpmToleranceAbs();

    if (cpmRequested - cpmOriginal <= cpmTolerance) {
      plan = { kind: 'same_terms', rate: computeCounterRate(originalRate, requestedRate) };
    } else if (cpmRequested > cpmOriginal * maxCpmMultiple()) {
      plan = { kind: 'too_high' };
    } else {
      const capCpm = cpmOriginal + cpmTolerance;
      const requiredImpressions = (requestedRate * 1000) / capCpm;
      const extraImpressions = requiredImpressions - impressions;
      const totalUnits = totalDeliverableUnits(deliverablesArr);
      const perUnitImpressions = impressions / totalUnits;
      const extraUnits = Math.ceil(extraImpressions / perUnitImpressions);
      const { deliverables, addedLabel } = expandDeliverables(deliverablesArr, extraUnits);
      plan = {
        kind: 'expand_deliverables',
        rate: requestedRate,
        deliverables,
        expectedImpressions: Math.round(impressions + extraUnits * perUnitImpressions),
        addedLabel,
      };
    }
  } else {
    const maxAcceptableRate = originalRate * (1 + legacyRateTolerancePct());
    plan =
      requestedRate <= maxAcceptableRate
        ? { kind: 'same_terms', rate: computeCounterRate(originalRate, requestedRate) }
        : { kind: 'too_high' };
  }

  // Too high → don't touch the offer. Record the ask, keep it pending.
  if (plan.kind === 'too_high') {
    await db.query(
      `UPDATE offers SET requested_rate = $2 WHERE id = $1 AND status = 'pending'`,
      [offer.id, requestedRate],
    );
    return {
      ok: true,
      outcome: 'too_high',
      originalRateFormatted: formatMoney(offer.rate, offer.currency),
      requestedRateFormatted: formatMoney(requestedRate, offer.currency),
    };
  }

  // Otherwise → decline the original (recording the ask) and mint a counter-offer
  // atomically. Retry the whole transaction on a token collision.
  const counterDeliverables = plan.kind === 'expand_deliverables' ? plan.deliverables : deliverablesArr;
  const counterImpressions =
    plan.kind === 'expand_deliverables' ? plan.expectedImpressions : offer.expected_impressions;

  let counterId = null;
  let raced = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counterToken = generateOfferToken();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await db.withTransaction(async (client) => {
        const declined = await client.query(
          `UPDATE offers SET status = 'declined', decline_reason = 'Budget', requested_rate = $2
           WHERE id = $1 AND status = 'pending'`,
          [offer.id, requestedRate],
        );
        if (declined.rowCount === 0) return { raced: true, counterId: null };
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'declined', 'web')`,
          [offer.id],
        );
        const { rows } = await client.query(
          `INSERT INTO offers
             (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, parent_offer_id, expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            offer.creator_id,
            offer.campaign_id,
            counterToken,
            offer.brand_name,
            JSON.stringify(counterDeliverables),
            plan.rate,
            offer.currency,
            counterImpressions != null ? counterImpressions : null,
            offer.id,
            new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400000),
          ],
        );
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
          [rows[0].id],
        );
        return { raced: false, counterId: rows[0].id };
      });
      raced = result.raced;
      counterId = result.counterId;
      break;
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }

  if (raced || !counterId) return { ok: false, reason: 'already_responded' };

  // Deliver the counter directly ONLY if this creator already has an
  // established messaging channel (mid-conversation on WhatsApp/iMessage) — a
  // web-originated counter is already shown right on the offer page the creator
  // is looking at, so no extra send (and no cold-outreach invite email) is
  // needed there.
  try {
    const channel = await establishedMessagingChannel(offer.creator_id);
    if (channel) await deliverOfferOverChannel(counterId, channel);
  } catch (err) {
    console.error('[offers] counter delivery failed', err.message);
  }

  const counter = await db.one(`SELECT * FROM offers WHERE id = $1`, [counterId]);
  if (!counter) return { ok: false, reason: 'already_responded' };

  return {
    ok: true,
    outcome: 'countered',
    counter: {
      token: counter.token,
      brandName: counter.brand_name,
      deliverables: counter.deliverables,
      rate: Number(counter.rate),
      currency: counter.currency,
      rateFormatted: formatMoney(counter.rate, counter.currency),
      expiresFormatted: formatDate(counter.expires_at),
      deliverablesChanged: plan.kind === 'expand_deliverables',
      addedLabel: plan.kind === 'expand_deliverables' ? plan.addedLabel : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Page data + Deal Studio entry point
// ---------------------------------------------------------------------------

// Data the public offer page renders (mirrors o/[token]/page.tsx). Logs a view.
async function getOfferForPage(token) {
  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.token = $1`,
    [token],
  );
  if (!offer) return null;

  try {
    await logOfferViewed(offer.id);
  } catch (_) {
    /* never let a logging failure break the page */
  }

  const expired = offer.status === 'pending' && new Date(offer.expires_at).getTime() < Date.now();
  const initialState =
    offer.status === 'accepted'
      ? 'accepted'
      : offer.status === 'declined'
        ? 'declined'
        : expired
          ? 'expired'
          : 'active';

  return {
    token: offer.token,
    firstName: firstNameOf(offer),
    brandName: offer.brand_name,
    deliverables: Array.isArray(offer.deliverables) ? offer.deliverables : [],
    rate: Number(offer.rate),
    currency: offer.currency,
    rateFormatted: formatMoney(offer.rate, offer.currency),
    expiresFormatted: formatDate(offer.expires_at),
    initialState,
  };
}

// Translate an admin-approved Deal Studio offer (pricing.js shape) into portal
// terms. Deliverables become "<n> Reels"; the CPM math needs an impression
// estimate — the guaranteed views for a view-based deal, else the creator's
// median reel views × the number of videos.
function offerTermsFromApproved(creator, approved) {
  const numVideos = Number(approved.num_videos) || 1;
  const rate = Number(approved.flat_fee);
  const noun = numVideos === 1 ? 'Reel' : 'Reels';
  const deliverables = [`${numVideos} ${noun}`];

  let expectedImpressions = null;
  if (approved.offer_type === 'view_based' && Number(approved.view_guarantee) > 0) {
    expectedImpressions = Math.round(Number(approved.view_guarantee));
  } else {
    const stats = creator.ig_scraped_data;
    const median = stats && Number(stats.p50) > 0 ? Number(stats.p50) : null;
    if (median) expectedImpressions = Math.round(median * numVideos);
  }

  return {
    brandName: creator.brand_name || creator.campaign_brand_name || 'INFLUENCE',
    deliverables,
    rate,
    currency: process.env.OFFER_CURRENCY || 'USD',
    expectedImpressions,
    campaignId: creator.campaign_id || null,
  };
}

// Deal Studio entry point for OLD creators. Mints the approved offer as an
// offer-portal offer and sends its link over email + WhatsApp + iMessage.
// Returns the offer id/token/url (or a skip reason when no contact channel).
async function sendPortalOffer(creatorId, approved) {
  const creator = await db.one(
    `SELECT c.*, ca.brand_name AS campaign_brand_name
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return { skipped: 'creator not found' };
  if (!approved || approved.flat_fee == null) return { skipped: 'no approved offer to send' };
  if (!creator.email && !creator.whatsapp && !creator.imessage) {
    return { skipped: 'no email / WhatsApp / iMessage on file for this creator' };
  }

  const terms = offerTermsFromApproved(creator, approved);
  const offer = await createOffer({ creatorId, ...terms });
  await sendOfferOutreach(offer.id);
  return { offerId: offer.id, token: offer.token, url: offerUrl(offer.token) };
}

// Attach a `portal_offer` summary to each dashboard creator row: the current
// (latest) offer, its status, and per-channel activity (email/WhatsApp/iMessage
// sends + replies) so the Status column can show the offer-portal + messaging
// updates. Batched across all rows. Rows with no offer are left untouched.
async function attachOffers(rows) {
  if (!rows || !rows.length) return;
  const ids = rows.map((r) => r.id);

  const latest = await db.many(
    `SELECT DISTINCT ON (creator_id) *
     FROM offers WHERE creator_id = ANY($1::int[])
     ORDER BY creator_id, created_at DESC`,
    [ids],
  );
  if (!latest.length) return;

  const offerByCreator = new Map(latest.map((o) => [o.creator_id, o]));
  const offerIds = latest.map((o) => o.id);

  const [events, msgs] = await Promise.all([
    db.many(
      `SELECT offer_id, event, channel, occurred_at
       FROM offer_events WHERE offer_id = ANY($1::int[])
       ORDER BY occurred_at ASC`,
      [offerIds],
    ),
    db.many(
      `SELECT creator_id, direction, channel, needs_review, delivery_status, sent_at
       FROM offer_messages WHERE creator_id = ANY($1::int[])
       ORDER BY sent_at ASC`,
      [ids],
    ),
  ]);

  const eventsByOffer = new Map();
  for (const e of events) {
    if (!eventsByOffer.has(e.offer_id)) eventsByOffer.set(e.offer_id, []);
    eventsByOffer.get(e.offer_id).push(e);
  }
  const msgByCreator = new Map();
  for (const m of msgs) {
    if (!msgByCreator.has(m.creator_id)) msgByCreator.set(m.creator_id, []);
    msgByCreator.get(m.creator_id).push(m);
  }

  const newer = (a, b) => new Date(a).getTime() > new Date(b).getTime();

  for (const r of rows) {
    const o = offerByCreator.get(r.id);
    if (!o) continue;
    const evs = eventsByOffer.get(o.id) || [];
    const cms = msgByCreator.get(r.id) || [];

    const channels = {
      email: { sent: false },
      whatsapp: { sent: false, replied: false, delivery: null },
      imessage: { sent: false, replied: false, delivery: null },
    };
    let needsReview = false;
    let lastActivityAt = o.created_at;

    for (const m of cms) {
      const ch = channels[m.channel];
      if (ch) {
        if (m.direction === 'outbound') {
          ch.sent = true;
          // Latest outbound wins (rows are ordered by sent_at ASC).
          if ('delivery' in ch && m.delivery_status) ch.delivery = m.delivery_status;
        } else if (m.direction === 'inbound' && 'replied' in ch) ch.replied = true;
      }
      if (m.needs_review) needsReview = true;
      if (newer(m.sent_at, lastActivityAt)) lastActivityAt = m.sent_at;
    }
    for (const e of evs) {
      if (newer(e.occurred_at, lastActivityAt)) lastActivityAt = e.occurred_at;
    }
    // Whether the creator has actually seen the offer page (a `viewed` event).
    const viewed = evs.some((e) => e.event === 'viewed');

    r.portal_offer = {
      token: o.token,
      status: o.status,
      url: offerUrl(o.token),
      rate: Number(o.rate),
      currency: o.currency,
      rateFormatted: formatMoney(o.rate, o.currency),
      expiresAt: o.expires_at,
      isCounter: o.parent_offer_id != null,
      viewed,
      events: evs.map((e) => ({ event: e.event, channel: e.channel, at: e.occurred_at })),
      channels,
      needsReview,
      lastActivityAt,
    };
  }
}

// ---------------------------------------------------------------------------
// needs_review inbox — inbound replies the bot couldn't confidently action
// ---------------------------------------------------------------------------

// List flagged inbound messages with the creator + offer context the admin inbox
// renders. Newest first.
async function listNeedsReview({ limit = 200 } = {}) {
  return db.many(
    `SELECT m.id, m.creator_id, m.channel, m.body, m.sent_at, m.offer_id,
            c.first_name, c.full_name, c.instagram_username, c.whatsapp, c.imessage,
            o.token AS offer_token, o.status AS offer_status,
            o.rate AS offer_rate, o.currency AS offer_currency
       FROM offer_messages m
       JOIN creators c ON c.id = m.creator_id
       LEFT JOIN offers o ON o.id = m.offer_id
      WHERE m.direction = 'inbound' AND m.needs_review = TRUE
      ORDER BY m.sent_at DESC
      LIMIT $1`,
    [limit],
  );
}

// Send an admin's free-form reply on the creator's channel and clear the flag on
// the inbound message it answers. Returns { ok, reason? }.
async function replyToNeedsReview({ messageId, body }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, reason: 'empty_body' };

  const msg = await db.one(
    `SELECT m.id, m.creator_id, m.channel, m.offer_id, c.whatsapp, c.imessage, c.messaging_opted_out
       FROM offer_messages m JOIN creators c ON c.id = m.creator_id
      WHERE m.id = $1 AND m.direction = 'inbound'`,
    [messageId],
  );
  if (!msg) return { ok: false, reason: 'not_found' };
  if (msg.messaging_opted_out) return { ok: false, reason: 'creator_opted_out' };

  const to = msg.channel === 'imessage' ? msg.imessage : msg.channel === 'whatsapp' ? msg.whatsapp : null;
  if (!to) return { ok: false, reason: 'no_contact_for_channel' };

  let sendResult;
  if (msg.channel === 'whatsapp') sendResult = await whatsapp.sendWhatsAppText({ to, body: text });
  else if (msg.channel === 'imessage') sendResult = await imessage.sendIMessageText({ to, body: text });
  else return { ok: false, reason: 'unsupported_channel' };

  if (!sendResult.sent) {
    return { ok: false, reason: sendResult.skipped ? 'channel_not_configured' : sendResult.error || 'send_failed' };
  }

  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
     VALUES ($1, $2, 'outbound', $3, $4, $5)`,
    [msg.creator_id, msg.offer_id, msg.channel, text, sendResult.id || null],
  );
  await db.query(`UPDATE offer_messages SET needs_review = FALSE WHERE id = $1`, [messageId]);
  return { ok: true };
}

// Clear the flag without replying (dismiss).
async function resolveNeedsReview({ messageId }) {
  const res = await db.query(
    `UPDATE offer_messages SET needs_review = FALSE
      WHERE id = $1 AND direction = 'inbound' AND needs_review = TRUE`,
    [messageId],
  );
  return { ok: true, cleared: res.rowCount };
}

module.exports = {
  generateOfferToken,
  offerUrl,
  establishedMessagingChannel,
  deliverOfferOverChannel,
  createOffer,
  respondToOffer,
  listNeedsReview,
  replyToNeedsReview,
  resolveNeedsReview,
  logOfferViewed,
  sendOfferOutreach,
  recordDeliveryStatus,
  negotiateBudget,
  getOfferForPage,
  sendPortalOffer,
  offerTermsFromApproved,
  attachOffers,
};
