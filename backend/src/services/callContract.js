'use strict';

// Contracts for deals agreed on a CALL.
//
// Every other contract path assumes the deal was struck over email: the deal
// reaches ACCEPTED when the classifier reads a "yes" in the thread, the contract
// is written by extracting the terms FROM that thread, and the signing link goes
// out as a reply IN it. A deal settled on a call breaks all three — there is no
// "yes" to read, the thread (if there is one) stops at "let's jump on a call",
// and a creator reached by DM or phone has no thread to reply in at all.
//
// So here the team enters what was agreed, and in one step:
//   1. the contract is built deterministically from those terms
//      (contracts.buildCallContractData) — no thread extraction, marked
//      termsSource: 'call' so a later re-extraction never overwrites it;
//   2. the deal is booked as accepted on those terms, with the brand go-ahead
//      recorded — creating the contract is an explicit human "send", the same
//      posture as the manual POST /:id/contract escape hatch;
//   3. the signing link is delivered the way the team chose: a reply in the
//      creator's email thread, a direct email, or not at all (the team shares
//      the link themselves — e.g. while still on WhatsApp with the creator).
//
// Steps 1–2 commit in one transaction, so a deal is never left booked without
// its contract (which would let the scheduler's backfill write one from the
// thread instead). Delivery runs after the commit and never undoes it: a send
// that fails still leaves the contract and its link for the team to share.

const db = require('../db');
const contracts = require('./contracts');
const dealTerms = require('./dealTerms');
const negotiation = require('./negotiation');
const templates = require('./negotiationTemplates');
const instantly = require('./instantly');
const portalEmail = require('./offerPortal/email');
const referrals = require('./referrals');

const SHAPES = ['video_based', 'view_based', 'video_bonus'];
const DELIVERY_METHODS = ['thread', 'email', 'none'];
const DEFAULT_PLATFORMS = ['Instagram', 'TikTok', 'YouTube Shorts'];
// Outreach statuses where Instantly may still have follow-ups queued — the
// creator was emailed but never replied by email (a reply stops the sequence).
const OUTREACH_IN_FLIGHT = ['outreach_queued', 'outreach_sent', 'followup_sent'];
const DEFAULT_DEADLINE_DAYS = 21;
const DAY_MS = 24 * 3600 * 1000;

const isDryRun = () => /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const num = (v) => (v == null || v === '' ? null : Number(v));

function wholeNumber(v, { min, max, label, required = false }) {
  const n = num(v);
  if (n == null) {
    if (required) throw httpError(400, `Enter ${label}.`);
    return null;
  }
  if (!Number.isFinite(n) || n < min || n > max) {
    throw httpError(400, `${label[0].toUpperCase()}${label.slice(1)} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`);
  }
  return Math.round(n);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validate + canonicalise the form. Throws status-400 errors whose messages are
// shown to the team as-is. Pure apart from `now` (for the deadline check).
function normalizeCallContractInput(raw, { now = new Date() } = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};

  const terms = dealTerms.normalizeTerms(body.terms);
  if (!terms) throw httpError(400, 'Choose how the creator is paid.');

  // Deal shape. Guaranteed-views and views-bonus deals are priced on a cash
  // fee, so a commission / product deal is always a plain video deal.
  let shape = SHAPES.includes(body.shape) ? body.shape : 'video_based';
  if (terms.model !== 'flat') shape = 'video_based';

  const out = {
    terms,
    shape,
    numberOfVideos: null,
    minTotalViews: null,
    minVideos: null,
    bonusAmount: null,
    bonusThresholdViews: null,
    viewCountingDays: null,
  };

  if (shape === 'view_based') {
    out.minTotalViews = wholeNumber(body.minTotalViews, {
      min: 1000, max: 1e9, label: 'the guaranteed total views', required: true,
    });
    out.minVideos = wholeNumber(body.minVideos, { min: 1, max: 50, label: 'the minimum number of videos' });
  } else {
    out.numberOfVideos = wholeNumber(body.numberOfVideos, {
      min: 1, max: 50, label: 'the number of videos', required: true,
    });
  }
  if (shape === 'video_bonus') {
    out.bonusAmount = wholeNumber(body.bonusAmount, { min: 1, max: 1e7, label: 'the bonus amount', required: true });
    out.bonusThresholdViews = wholeNumber(body.bonusThresholdViews, {
      min: 1000, max: 1e9, label: 'the views that unlock the bonus', required: true,
    });
  }
  if (shape !== 'video_based') {
    out.viewCountingDays = wholeNumber(body.viewCountingDays, {
      min: 1, max: 365, label: 'the view-counting window (days)',
    }) || 30;
  }

  const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
    .map((p) => String(p == null ? '' : p).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set();
  out.platforms = platforms.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!out.platforms.length) throw httpError(400, 'Pick at least one platform they will post on.');
  if (out.platforms.length > 8 || out.platforms.some((p) => p.length > 40)) {
    throw httpError(400, 'Keep platforms to a short list of names.');
  }

  const deadline = String(body.postingDeadline || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(new Date(`${deadline}T12:00:00Z`).getTime())) {
    throw httpError(400, 'Pick the posting deadline.');
  }
  // Yesterday is still allowed so a deadline entered late at night in a
  // timezone behind the server's isn't refused.
  if (deadline < isoDay(new Date(now.getTime() - DAY_MS))) {
    throw httpError(400, 'The posting deadline is in the past.');
  }
  if (deadline > isoDay(new Date(now.getTime() + 2 * 365 * DAY_MS))) {
    throw httpError(400, 'The posting deadline is more than two years out — check the date.');
  }
  out.postingDeadline = deadline;

  out.paidAdsIncluded = body.paidAdsIncluded === true;

  out.upfrontPercent = null;
  if (body.upfrontPayment === true) {
    if (terms.fee == null) {
      throw httpError(400, 'An upfront payment needs a cash fee — this deal has none.');
    }
    out.upfrontPercent = wholeNumber(body.upfrontPercent, { min: 1, max: 99, label: 'the upfront percentage' }) || 30;
  }

  const exclusivity = String(body.exclusivity == null ? '' : body.exclusivity).replace(/\s+/g, ' ').trim();
  if (exclusivity.length > 200) throw httpError(400, 'Keep the exclusivity line under 200 characters.');
  out.exclusivity = exclusivity || 'None';

  const extraRaw = body.manualTerms == null ? '' : body.manualTerms;
  if ((Array.isArray(extraRaw) ? extraRaw.join('\n') : String(extraRaw)).length > 6000) {
    throw httpError(400, 'The extra terms are too long — keep them under 6,000 characters.');
  }
  out.manualTerms = contracts.splitManualTerms(extraRaw);

  const notes = String(body.callNotes == null ? '' : body.callNotes).trim();
  if (notes.length > 4000) throw httpError(400, 'Keep the call notes under 4,000 characters.');
  out.callNotes = notes || null;

  const d = body.delivery && typeof body.delivery === 'object' ? body.delivery : {};
  const method = DELIVERY_METHODS.includes(d.method) ? d.method : null;
  if (!method) throw httpError(400, 'Choose how to send the contract.');
  const to = String(d.to == null ? '' : d.to).trim();
  if (method === 'email' && !EMAIL_RE.test(to)) throw httpError(400, 'Enter the email address to send the contract to.');
  out.delivery = { method, to: method === 'email' ? to.toLowerCase() : null };

  out.stopOutreach = body.stopOutreach === true;
  return out;
}

// Can the contract go out as a reply in the creator's existing email thread?
// Mirrors negotiation.sendNegotiationEmail's own preconditions — except that a
// thread is required even in DRY_RUN, so a dry run offers exactly the options
// production would.
function threadAvailable(creator) {
  if (!creator.instantly_reply_uuid) return false;
  return isDryRun() || !!(creator.instantly_email_account || process.env.INSTANTLY_EACCOUNT);
}

// Instantly may still be sending this creator follow-ups: they were emailed but
// never replied by email (a reply stops the sequence on Instantly's side).
function outreachInFlight(creator) {
  return !creator.instantly_reply_uuid && !!creator.email && OUTREACH_IN_FLIGHT.includes(creator.status);
}

// Why this creator can't get a call contract, or null. Shared by the form's
// defaults (so the dashboard can say so up front) and the create path.
async function blockedReason(creator) {
  const existing = await db.one(`SELECT status FROM contracts WHERE creator_id = $1 LIMIT 1`, [creator.id]);
  if (existing) {
    return 'This creator already has a contract — change its terms from the Deals column instead.';
  }
  if (await negotiation.hasPortalDeal(creator.id)) {
    return 'This creator accepted on the offer portal and signs the mini contract there — no separate contract is needed.';
  }
  return null;
}

// The terms to pre-fill: the deal on the table (a composed / call / custom
// offer), else the creator's quoted rate as a flat fee, else nothing.
function prefillTerms(creator) {
  const offer = creator.custom_offer && typeof creator.custom_offer === 'object' ? creator.custom_offer : null;
  const fromOffer = offer ? dealTerms.termsFromOffer(offer) : null;
  if (fromOffer) {
    // A bonus offer's flat_fee is base + bonus; the form takes the base.
    if (fromOffer.model === 'flat' && offer.base_fee != null && Number.isFinite(Number(offer.base_fee))) {
      return { ...fromOffer, fee: Math.round(Number(offer.base_fee)) };
    }
    return fromOffer;
  }
  const q = num(creator.quoted_rate);
  return Number.isFinite(q) && q > 0 ? { model: 'flat', fee: Math.round(q), commission: null, product: null } : null;
}

// Everything the "Create contract" form needs: sensible defaults for each term
// (the deal on the table, the campaign's usage-rights policy) and which delivery
// options actually work for this creator.
async function callContractDefaults(creatorId, { now = new Date() } = {}) {
  const creator = await negotiation.loadCreator(creatorId);
  if (!creator) throw httpError(404, 'creator not found');

  const offer = creator.custom_offer && typeof creator.custom_offer === 'object' ? creator.custom_offer : {};
  const shape = SHAPES.includes(offer.offer_type) ? offer.offer_type : 'video_based';
  const n = num(offer.num_videos);
  const policy = creator.usage_rights_policy || 'no_rights';
  const hasThread = threadAvailable(creator);

  return {
    blocked: await blockedReason(creator),
    creator: {
      id: creator.id,
      name: creator.full_name || creator.first_name || null,
      handle: creator.instagram_username || null,
      email: creator.email || null,
    },
    brandName: creator.brand_name || null,
    campaignName: creator.campaign_name || null,
    terms: prefillTerms(creator),
    shape,
    numberOfVideos: Number.isFinite(n) && n > 0 ? Math.round(n) : 1,
    minTotalViews: num(offer.view_guarantee) || null,
    minVideos: num(offer.min_videos) || null,
    bonusAmount: num(offer.bonus_amount) || null,
    bonusThresholdViews: num(offer.bonus_threshold_views) || null,
    viewCountingDays: num(offer.view_counting_days) || 30,
    platformOptions: DEFAULT_PLATFORMS,
    platforms: DEFAULT_PLATFORMS,
    postingDeadline: isoDay(new Date(now.getTime() + DEFAULT_DEADLINE_DAYS * DAY_MS)),
    usageRightsPolicy: policy,
    paidAdsIncluded: policy !== 'no_rights',
    exclusivity: 'None',
    delivery: {
      thread: hasThread,
      emailConfigured: isDryRun() || portalEmail.isConfigured(),
      defaultMethod: hasThread ? 'thread' : creator.email ? 'email' : 'none',
    },
    outreachInFlight: outreachInFlight(creator),
  };
}

const CALL_ACK_LINE = 'Great speaking with you! This contract sets out everything we agreed on the call.';

// Send the signing link the way the team chose. Never throws: the contract is
// already committed, so a failed send comes back as { sent: false, error } and
// the dashboard hands the team the link instead.
async function deliverContract(creator, url, delivery) {
  if (delivery.method === 'none') return { method: 'none', sent: false };
  try {
    if (delivery.method === 'thread') {
      if (!threadAvailable(creator)) {
        return { method: 'thread', sent: false, error: 'There is no email thread with this creator to reply in.' };
      }
      const v = negotiation.templateVars(negotiation.ctxFor(creator));
      const mail = templates.contractEmail({ ...v, url, ackLine: CALL_ACK_LINE });
      await negotiation.sendNegotiationEmail(creator, mail, 'contract');
      return { method: 'thread', sent: true };
    }
    // Direct email.
    if (isDryRun()) {
      console.log(`[call-contract][DRY_RUN] contract link -> ${delivery.to}: ${url}`);
      return { method: 'email', sent: true, to: delivery.to, dryRun: true };
    }
    const firstName = String(creator.first_name || creator.full_name || 'there').trim().split(/\s+/)[0];
    const result = await portalEmail.sendContractReadyEmail({
      to: delivery.to,
      firstName,
      brandName: creator.brand_name,
      contractUrl: url,
    });
    if (result.sent) return { method: 'email', sent: true, to: delivery.to };
    return {
      method: 'email',
      sent: false,
      to: delivery.to,
      error: result.skipped ? 'Direct email is not set up on this server (RESEND_API_KEY).' : result.error || 'The email could not be sent.',
    };
  } catch (err) {
    console.error(`[call-contract] delivery (${delivery.method}) failed for creator ${creator.id}:`, err.message);
    return { method: delivery.method, sent: false, error: err.message };
  }
}

// Halt Instantly's queued follow-ups for a creator whose deal moved to a call —
// a "just bumping this" email landing after the contract reads badly. Removes
// the lead from THIS campaign only (same as the Stop-outreach button) but,
// unlike that button, leaves the row's status alone: the creator is now in a
// live deal and must stay visible to the post-acceptance scheduler. Never throws.
async function stopOutreachSequence(creator) {
  try {
    const row = await db.one(`SELECT instantly_campaign_id FROM campaigns WHERE id = $1`, [creator.campaign_id]);
    const campaignId = (row && row.instantly_campaign_id) || process.env.INSTANTLY_CAMPAIGN_ID || null;
    let result;
    if (isDryRun()) result = { stopped: false, dryRun: true };
    else if (!process.env.INSTANTLY_API_KEY || !campaignId) {
      result = { stopped: false, error: 'Instantly is not configured for this campaign — remove the lead there by hand to halt its follow-ups.' };
    } else {
      const n = await instantly.removeLeadFromCampaign({ email: creator.email, campaignId });
      result = { stopped: n > 0 };
    }
    // Logged only when a lead actually came off the campaign — the timeline
    // step reads "Outreach stopped", which must not appear when nothing did.
    if (result.stopped) {
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'outreach_stopped', $2)`,
        [creator.id, { email: creator.email, instantlyCampaignId: campaignId, removed: true, via: 'call_contract' }],
      );
    }
    return result;
  } catch (err) {
    console.error(`[call-contract] stopping outreach failed for creator ${creator.id}:`, err.message);
    return { stopped: false, error: `Couldn't stop the Instantly follow-ups (${err.message}) — remove the lead there by hand.` };
  }
}

// Create the contract for a deal agreed on a call, book the deal, and deliver
// the signing link. Returns { url, token, delivery, outreach }.
async function createContractFromCall(creatorId, rawInput, { now = new Date() } = {}) {
  const input = normalizeCallContractInput(rawInput, { now });
  const creator = await negotiation.loadCreator(creatorId);
  if (!creator) throw httpError(404, 'creator not found');
  const blocked = await blockedReason(creator);
  if (blocked) throw httpError(409, blocked);

  const data = contracts.buildCallContractData(creator, input, { now });
  const offer = contracts.callContractOffer(input);
  const terms = input.terms;
  const token = contracts.generateToken();
  const newEmail = !creator.email && input.delivery.to ? input.delivery.to : null;

  const contract = await db.withTransaction(async (client) => {
    // Serialise concurrent creates for this creator (a double-click), then
    // re-check under the lock — the check above ran before it.
    await client.query(`SELECT id FROM creators WHERE id = $1 FOR UPDATE`, [creator.id]);
    const raced = await client.query(`SELECT 1 FROM contracts WHERE creator_id = $1 LIMIT 1`, [creator.id]);
    if (raced.rows.length) return null;

    // A referral deal gets its code inside the same transaction: a typed code
    // another creator holds is refused (409, nothing written), and the code is
    // reserved with the contract or not at all.
    const q = (sql, params) => client.query(sql, params);
    const referralCode = dealTerms.isReferral(terms) ? await referrals.chooseCode(q, creator, terms) : null;
    if (referralCode) referrals.applyReferralCode(data, terms, referralCode);

    const inserted = await client.query(
      `INSERT INTO contracts (token, creator_id, campaign_id, status, data)
       VALUES ($1, $2, $3, 'pending', $4::jsonb) RETURNING *`,
      [token, creator.id, creator.campaign_id, JSON.stringify(data)],
    );
    if (referralCode) {
      await referrals.reserveCode(q, { code: referralCode, creatorId: creator.id, contractId: inserted.rows[0].id });
    }
    // Book the deal exactly as recordAgreedTerms + approveContract would, in
    // one step: accepted on these terms, brand go-ahead recorded (creating the
    // contract is the explicit human "send"), any parked hand-off answered.
    await client.query(
      `UPDATE creators
       SET negotiation_status = 'ACCEPTED', offer_approved = TRUE, contract_approved = TRUE,
           selected_offer_id = $2, custom_offer = $3::jsonb,
           quoted_rate = COALESCE($4, quoted_rate),
           email = COALESCE(email, $5),
           needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [creator.id, offer.offer_id, JSON.stringify(offer), terms.model === 'flat' ? terms.fee : null, newEmail],
    );
    const events = [
      ['rate_accepted', negotiation.termsDetail(terms, { by: 'team', source: 'call', notes: input.callNotes })],
      ['contract_approved', { by: 'admin', via: 'call' }],
      ['contract_created', { token, contract_id: inserted.rows[0].id, source: 'call' }],
    ];
    for (const [type, detail] of events) {
      await client.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, $2, $3)`, [
        creator.id,
        type,
        detail,
      ]);
    }
    return inserted.rows[0];
  });
  if (!contract) throw httpError(409, 'This creator already has a contract — change its terms from the Deals column instead.');

  const url = contracts.contractUrl(token);
  const sendTo = { ...creator, email: creator.email || newEmail };

  // Judged on the creator as loaded: an address added just now was never
  // enrolled in Instantly, so there is no sequence to stop for it.
  let outreach = null;
  if (input.stopOutreach && outreachInFlight(creator)) outreach = await stopOutreachSequence(creator);

  const delivery = await deliverContract(sendTo, url, input.delivery);
  if (delivery.sent) {
    try {
      await db.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_sent', $2)`, [
        creator.id,
        { url, channel: delivery.method === 'thread' ? 'email_thread' : 'email', via: 'call', to: delivery.to || undefined },
      ]);
    } catch (err) {
      console.error(`[call-contract] contract_sent log failed for creator ${creator.id}:`, err.message);
    }
  }

  return { url, token, status: contract.status, delivery, outreach };
}

module.exports = {
  normalizeCallContractInput,
  callContractDefaults,
  createContractFromCall,
  // exposed for tests
  threadAvailable,
  outreachInFlight,
  prefillTerms,
  CALL_ACK_LINE,
  DEFAULT_PLATFORMS,
};
