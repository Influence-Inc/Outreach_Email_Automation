'use strict';

// Referral commission: a creator earns a share of the campaign spend of each NEW
// brand they refer to the platform, on that brand's first N campaigns (dealTerms
// commission.basis = 'referral').
//
//   codes      every referral contract gets a code, unique across all creators;
//              the referral link is /r/<code>. A visit is logged as a "touch"
//              and forwarded to the platform's sign-up page with ?ref=&rt=.
//   sign-ups   the platform reports each new brand account with the referral
//              claims it saw: the code typed at sign-up, the link it arrived
//              from (with our touch id), any earlier link visits it kept.
//              decideAttribution picks AT MOST ONE creator. Permanent.
//   campaigns  the platform reports each campaign of a brand (start date,
//              status, spend paid). computeLedger decides which count (the
//              brand's first N started within the window) and what each earns.
//
// The two deciders are pure functions — every rule below is unit-tested in
// referrals.test.js. Everything else here is loading their inputs and storing
// their outputs.
//
// ── Attribution rules (also written into the contract, see RULES_TEXT) ──────
//   1. One brand, one creator, permanently. A brand already attributed — by
//      account or by company (normalised domain / name) — is never re-credited.
//   2. A brand that was already a customer doesn't qualify.
//   3. A claim only counts if its code belongs to a SIGNED referral agreement,
//      the brand signed up after signing and within the referral period, a
//      link visit was within the referral window before sign-up, and the brand
//      isn't the creator's own business (same email or company domain).
//   4. Among eligible claims a code ENTERED at sign-up beats any link visit (it
//      is the brand's own statement of who sent them); otherwise the most recent
//      eligible link visit wins (last click). Ties: the earlier-signed agreement,
//      then the lower creator id — deterministic, never arbitrary.

const crypto = require('crypto');
const db = require('../db');
const dealTerms = require('./dealTerms');

const DAY_MS = 24 * 3600 * 1000;
// A link visit stamped slightly AFTER the sign-up (clock skew between the two
// systems) is still the visit that led to it.
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const OUTCOMES = ['attributed', 'unattributed', 'rejected'];

// Plain-English reasons, shown in the dashboard and returned by the API.
const REASONS = {
  attributed: 'Credited to this creator',
  unknown_code: 'No referral agreement uses this code',
  agreement_not_signed: "The creator's referral agreement wasn't signed yet",
  not_a_referral_agreement: "The code's agreement isn't a referral deal",
  signed_up_before_agreement: 'The brand signed up before the agreement was signed',
  referral_period_ended: "The brand signed up after the creator's referral period ended",
  touch_after_signup: 'The link visit came after the sign-up',
  outside_referral_window: 'The link visit was outside the referral window',
  self_referral: "The brand is the creator's own business",
  outranked: 'Another claim took precedence',
  no_claims: 'No referral code or link was used',
  no_eligible_claims: 'No referral claim qualified',
  existing_customer: 'The brand was already a customer',
  brand_already_referred: 'This company was already referred (credit stays with the first referral)',
  manual_override: 'Set by the team',
  cancelled: 'Campaign cancelled',
  not_started: "Campaign hasn't started",
  started_before_signup: 'Campaign started before the brand signed up',
  outside_campaign_window: 'Campaign started after the campaign window',
  beyond_campaign_limit: 'Beyond the first-campaigns limit',
  counted: 'Counts toward commission',
  not_attributed: 'Brand is not credited to a creator',
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ── Normalisation ───────────────────────────────────────────────────────────

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.net', 'mail.com', 'yandex.com', 'hey.com', 'fastmail.com', 'zoho.com', 'qq.com', '163.com',
]);

function normCode(code) {
  const s = String(code == null ? '' : code).trim().toUpperCase();
  return /^[A-Z0-9_-]{2,40}$/.test(s) ? s : null;
}

function normEmail(email) {
  const s = String(email == null ? '' : email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function emailDomain(email) {
  const e = normEmail(email);
  return e ? e.split('@')[1] : null;
}

// "https://www.Glow-Labs.com/shop" → "glow-labs.com"
function normDomain(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

// "Glow Labs, Inc." → "glowlabs"
function normName(raw) {
  const s = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|gmbh|pvt|private|plc|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  return s || null;
}

// The COMPANY a brand account belongs to: its website domain, else its
// contact email's domain when that's a company domain, else its name.
function brandKey({ brandDomain, contactEmail, brandName }) {
  const d = normDomain(brandDomain);
  if (d) return `d:${d}`;
  const ed = emailDomain(contactEmail);
  if (ed && !FREE_MAIL.has(ed)) return `d:${ed}`;
  const n = normName(brandName);
  return n ? `n:${n}` : null;
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// ── Attribution (pure) ──────────────────────────────────────────────────────

// Is this claim's creator the brand itself? Same contact email, or the same
// company email domain (a free-mail domain proves nothing).
function isSelfReferral(contactEmail, creatorEmail) {
  const a = normEmail(contactEmail);
  const b = normEmail(creatorEmail);
  if (!a || !b) return false;
  if (a === b) return true;
  const da = a.split('@')[1];
  return da === b.split('@')[1] && !FREE_MAIL.has(da);
}

// Why one claim can't win, or null if it's eligible. `agreement` is what
// loadAgreements returns for the claim's code (undefined when unknown).
function claimIneligibility(claim, agreement, signup) {
  if (!claim.code || !agreement) return 'unknown_code';
  if (!['signed', 'completed'].includes(agreement.contractStatus)) return 'agreement_not_signed';
  const c = agreement.commission;
  if (!c || c.basis !== 'referral') return 'not_a_referral_agreement';
  const signedAt = toDate(agreement.signedAt);
  if (!signedAt) return 'agreement_not_signed';
  const at = signup.signedUpAt;
  if (at < signedAt) return 'signed_up_before_agreement';
  if (c.termMonths && at > addMonths(signedAt, c.termMonths)) return 'referral_period_ended';
  if (claim.kind === 'link') {
    // A link visit with no timestamp is the one the brand signed up from.
    const touched = claim.at || at;
    if (touched.getTime() > at.getTime() + CLOCK_SKEW_MS) return 'touch_after_signup';
    if (at.getTime() - touched.getTime() > c.windowDays * DAY_MS) return 'outside_referral_window';
  }
  if (isSelfReferral(signup.contactEmail, agreement.creatorEmail)) return 'self_referral';
  return null;
}

// Rule 4's ordering: entered code first, then latest link visit, then the
// earlier-signed agreement, then the lower creator id.
function compareClaims(a, b) {
  const ka = a.claim.kind === 'entered' ? 0 : 1;
  const kb = b.claim.kind === 'entered' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  const ta = (a.claim.at || a.signedUpAt).getTime();
  const tb = (b.claim.at || b.signedUpAt).getTime();
  if (ta !== tb) return tb - ta;
  const sa = toDate(a.agreement.signedAt).getTime();
  const sb = toDate(b.agreement.signedAt).getTime();
  if (sa !== sb) return sa - sb;
  return a.agreement.creatorId - b.agreement.creatorId;
}

// Decide who (if anyone) gets credit for a brand sign-up.
//   signup        { signedUpAt: Date, contactEmail }
//   claims        [{ code, kind: 'entered' | 'link', at: Date | null }]
//   agreements    { CODE: { creatorId, contractId, contractStatus, signedAt,
//                   creatorEmail, commission: { basis, windowDays, termMonths } } }
//   priorReferral the attributed sign-up of the same company, if any
//   existingCustomer  truthy when the brand was already a customer
// Returns { outcome, reason, winner, contested, candidates }.
function decideAttribution({ signup, claims, agreements, priorReferral = null, existingCustomer = null }) {
  const evaluated = (claims || []).map((claim) => {
    const agreement = claim.code ? agreements[claim.code] : undefined;
    const reason = claimIneligibility(claim, agreement, signup);
    return { claim, agreement, reason, signedUpAt: signup.signedUpAt };
  });
  const eligible = evaluated.filter((e) => !e.reason).sort(compareClaims);
  const winner = eligible[0] || null;
  const contested = new Set(eligible.map((e) => e.agreement.creatorId)).size > 1;

  const candidates = evaluated.map((e) => ({
    code: e.claim.code || null,
    kind: e.claim.kind,
    at: e.claim.at ? e.claim.at.toISOString() : null,
    creator_id: e.agreement ? e.agreement.creatorId : null,
    eligible: !e.reason,
    won: false,
    reason: e.reason || 'outranked',
  }));

  let outcome;
  let reason;
  if (priorReferral) {
    outcome = 'rejected';
    reason = 'brand_already_referred';
  } else if (existingCustomer) {
    outcome = 'rejected';
    reason = 'existing_customer';
  } else if (winner) {
    outcome = 'attributed';
    reason = 'attributed';
    const i = evaluated.indexOf(winner);
    candidates[i].won = true;
    candidates[i].reason = 'attributed';
  } else {
    outcome = 'unattributed';
    // When every claim failed for the same reason, that reason IS the answer
    // ("self-referral" reads better than "no eligible claims").
    const reasons = new Set(evaluated.map((e) => e.reason));
    reason = !evaluated.length ? 'no_claims' : reasons.size === 1 ? [...reasons][0] : 'no_eligible_claims';
  }

  return {
    outcome,
    reason,
    contested: outcome === 'attributed' && contested,
    winner: outcome === 'attributed'
      ? {
          code: winner.claim.code,
          kind: winner.claim.kind,
          creatorId: winner.agreement.creatorId,
          contractId: winner.agreement.contractId,
        }
      : null,
    candidates,
  };
}

// ── Commission ledger (pure) ────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;

// Which of a referred brand's campaigns count, and what each earns.
//   signedUpAt  the brand's sign-up
//   commission  { ratePct, campaignsPerBrand, campaignWindowMonths } or null
//               (null = brand not credited to anyone: nothing counts)
//   campaigns   [{ campaignRef, startedAt, status, paidSpend }]
// Returns one row per campaign: { campaignRef, counted, rank, reason, commission }.
// A campaign that is cancelled or hasn't started never uses up one of the N.
function computeLedger({ signedUpAt, commission, campaigns }) {
  const rows = (campaigns || []).map((c) => ({
    campaignRef: c.campaignRef,
    startedAt: toDate(c.startedAt),
    status: c.status === 'cancelled' ? 'cancelled' : 'active',
    paidSpend: Math.max(0, Number(c.paidSpend) || 0),
    counted: false,
    rank: null,
    reason: null,
    commission: 0,
  }));
  if (!commission) {
    rows.forEach((r) => { r.reason = 'not_attributed'; });
    return rows;
  }
  const windowEnd = addMonths(signedUpAt, commission.campaignWindowMonths);
  const contenders = [];
  for (const r of rows) {
    if (r.status === 'cancelled') r.reason = 'cancelled';
    else if (!r.startedAt) r.reason = 'not_started';
    else if (r.startedAt.getTime() < signedUpAt.getTime() - DAY_MS) r.reason = 'started_before_signup';
    else if (r.startedAt > windowEnd) r.reason = 'outside_campaign_window';
    else contenders.push(r);
  }
  contenders.sort((a, b) => a.startedAt - b.startedAt || String(a.campaignRef).localeCompare(String(b.campaignRef)));
  contenders.forEach((r, i) => {
    if (i < commission.campaignsPerBrand) {
      r.counted = true;
      r.rank = i + 1;
      r.reason = 'counted';
      r.commission = round2((r.paidSpend * commission.ratePct) / 100);
    } else {
      r.reason = 'beyond_campaign_limit';
    }
  });
  return rows;
}

// ── Codes ───────────────────────────────────────────────────────────────────

function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function referralUrl(code) {
  return `${baseUrl()}/r/${encodeURIComponent(code)}`;
}

// The code to try for a creator: the one the team typed, else their handle.
function suggestedCode(creator, terms) {
  const typed = normCode(terms && terms.commission && terms.commission.promo_code);
  if (typed) return typed;
  const fromHandle = String(creator.instagram_username || creator.first_name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
  return fromHandle.length >= 2 ? fromHandle : `REF${creator.id}`;
}

// Pick the code for a new referral contract. A code the team TYPED is honoured
// exactly — if another creator already holds it the caller is told (409), since
// silently changing a code someone may already have shared is worse. An
// auto-derived code takes the first free suffix (MAYA, MAYA2, MAYA3, …).
// `q` is db.query or a transaction client's query.
async function chooseCode(q, creator, terms) {
  const typed = normCode(terms && terms.commission && terms.commission.promo_code);
  const base = suggestedCode(creator, terms);
  for (let i = 1; i <= 200; i += 1) {
    const code = i === 1 ? base : `${base.slice(0, 36)}${i}`;
    const taken = await q(`SELECT creator_id FROM referral_codes WHERE code = $1`, [code]);
    const row = taken.rows[0];
    if (!row) return code;
    // The same creator re-using their own code on a new referral contract is
    // fine only for an explicitly typed code; codes stay one-per-contract.
    if (typed && i === 1) {
      throw httpError(409, `Referral code ${code} is already taken — choose another, or leave it blank to assign one.`);
    }
  }
  throw httpError(409, 'Could not find a free referral code — type one in.');
}

// Fill the referral code into a contract's data (code, link and the commission
// wording that quotes them). `terms` are the deal's normalized terms.
function applyReferralCode(data, terms, code) {
  if (!data || !data.commission || !dealTerms.isReferral(terms)) return data;
  const withCode = { ...terms, commission: { ...terms.commission, promo_code: code } };
  const c = data.commission;
  c.promoCode = code;
  c.referralCode = code;
  c.referralUrl = referralUrl(code);
  c.summary = dealTerms.commissionSentence(withCode);
  Object.assign(c, referralContractTexts(withCode.commission, c.referralUrl));
  return data;
}

async function reserveCode(q, { code, creatorId, contractId }) {
  const res = await q(
    `INSERT INTO referral_codes (code, creator_id, contract_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING code`,
    [code, creatorId, contractId],
  );
  if (!res.rows.length) throw httpError(409, `Referral code ${code} was just taken — try again.`);
  return code;
}

// The contract rows a referral deal adds (rendered by the signing page and the
// PDF exactly as given, so the two can't drift apart).
function referralContractTexts(c, url) {
  const platform = dealTerms.platformName();
  const code = c.promo_code ? `referral code ${c.promo_code}` : 'their referral code';
  const tracking = c.attribution === 'code'
    ? `Brands are credited when they enter the creator's ${code} at sign-up`
    : c.attribution === 'link'
      ? `Brands are credited when they sign up through the creator's referral link${url ? ` (${url})` : ''}`
      : `Brands are credited when they sign up through the creator's referral link${url ? ` (${url})` : ''} or enter the creator's ${code} at sign-up`;
  return {
    tracking,
    reporting: `Commission is calculated from ${platform}'s billing records for each referred brand, shared with the creator with each payout`,
    returns: 'Campaign spend excludes taxes. Spend later refunded or cancelled is deducted from the next payout',
    rules:
      `Each referred brand is credited to one creator only, and the credit is permanent. A valid referral code entered at sign-up takes precedence; ` +
      `otherwise the most recent qualifying referral-link visit within the referral window does. A brand doesn't qualify if it was already a customer of ${platform}, ` +
      `was already referred (including through another account of the same company), or is a business the creator owns or works for. ` +
      `Referrals count only once this agreement is signed.`,
  };
}

// ── Link visits ─────────────────────────────────────────────────────────────

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.SITE_SESSION_SECRET || 'referral-touch';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

// GET /r/:code — log the visit and forward to the platform's sign-up page with
// the code and the visit id. An unknown code still forwards (without a ref) so
// a mistyped link never strands a brand.
async function handleReferralLink(req, res) {
  const target = process.env.REFERRAL_SIGNUP_URL;
  if (!target) {
    res.status(503).type('text/plain').send('Referral sign-up is not configured yet.');
    return;
  }
  const code = normCode(req.params.code);
  let url;
  try {
    url = new URL(target);
  } catch {
    res.status(503).type('text/plain').send('Referral sign-up is misconfigured.');
    return;
  }
  try {
    const known = code ? await db.one(`SELECT code FROM referral_codes WHERE code = $1`, [code]) : null;
    if (known) {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const touch = await db.one(
        `INSERT INTO referral_touches (code, ip_hash, user_agent) VALUES ($1, $2, $3) RETURNING id`,
        [code, hashIp(ip), String(req.headers['user-agent'] || '').slice(0, 300) || null],
      );
      url.searchParams.set('ref', code);
      url.searchParams.set('rt', String(touch.id));
    }
  } catch (err) {
    // Never lose the brand over a logging failure — forward with the code.
    console.error('[referrals] touch log failed:', err.message);
    if (code) url.searchParams.set('ref', code);
  }
  res.redirect(302, url.toString());
}

// ── Sign-ups ────────────────────────────────────────────────────────────────

// Turn the platform's sign-up payload into claims. Our own touch record (by id)
// wins over the code / time the payload repeats, so a client can't move a visit.
async function claimsFrom(payload) {
  const claims = [];
  const entered = normCode(payload.entered_code);
  if (payload.entered_code && !entered) claims.push({ code: null, kind: 'entered', at: null, raw: String(payload.entered_code).slice(0, 60) });
  if (entered) claims.push({ code: entered, kind: 'entered', at: null });

  const touchIds = [];
  if (payload.link_touch_id != null && payload.link_touch_id !== '') touchIds.push(payload.link_touch_id);
  for (const t of Array.isArray(payload.touches) ? payload.touches : []) {
    if (t && t.touch_id != null && t.touch_id !== '') touchIds.push(t.touch_id);
  }
  const seenTouch = new Set();
  for (const id of touchIds) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || seenTouch.has(n)) continue;
    seenTouch.add(n);
    const row = await db.one(`SELECT code, touched_at FROM referral_touches WHERE id = $1`, [n]);
    if (row) claims.push({ code: row.code, kind: 'link', at: toDate(row.touched_at), touchId: n });
  }
  // Link claims the platform kept without a touch id (e.g. it stored ?ref= only).
  const loose = [];
  if (payload.link_code && payload.link_touch_id == null) loose.push({ code: payload.link_code, at: payload.link_clicked_at });
  for (const t of Array.isArray(payload.touches) ? payload.touches : []) {
    if (t && t.touch_id == null && t.code) loose.push({ code: t.code, at: t.clicked_at });
  }
  for (const t of loose) {
    const code = normCode(t.code);
    if (code) claims.push({ code, kind: 'link', at: toDate(t.at) });
  }
  return claims;
}

// Load the referral agreement behind each code: the contract (status, signed
// date, terms) and the creator's email for the self-referral check.
async function loadAgreements(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return {};
  const rows = await db.many(
    `SELECT rc.code, rc.creator_id, rc.contract_id, ct.status AS contract_status, ct.signed_at,
            ct.data->'commission' AS commission, cr.email AS creator_email
       FROM referral_codes rc
       JOIN contracts ct ON ct.id = rc.contract_id
       JOIN creators cr ON cr.id = rc.creator_id
      WHERE rc.code = ANY($1::text[])`,
    [list],
  );
  const out = {};
  for (const r of rows) {
    const c = r.commission || {};
    out[r.code] = {
      creatorId: r.creator_id,
      contractId: r.contract_id,
      contractStatus: r.contract_status,
      signedAt: r.signed_at,
      creatorEmail: r.creator_email,
      commission: c.basis === 'referral'
        ? {
            basis: 'referral',
            ratePct: Number(c.ratePct),
            windowDays: Number(c.cookieDays) || dealTerms.REFERRAL_DEFAULTS.cookie_days,
            termMonths: c.termMonths == null ? null : Number(c.termMonths),
            campaignsPerBrand: Number(c.campaignsPerBrand) || dealTerms.REFERRAL_DEFAULTS.campaigns_per_brand,
            campaignWindowMonths: Number(c.campaignWindowMonths) || dealTerms.REFERRAL_DEFAULTS.campaign_window_months,
          }
        : { basis: c.basis || 'sales' },
    };
  }
  return out;
}

// Was this brand already a customer before it signed up? The platform's own
// flag is authoritative; as a backstop, a campaign already on file for a brand
// of the same name counts — unless that campaign is dated after the sign-up
// (then it's the new brand's own first campaign arriving early).
async function existingCustomerCheck(payload, signedUpAt) {
  if (payload.existing_customer === true) return { source: 'platform' };
  const name = normName(payload.brand_name);
  if (!name) return null;
  const rows = await db.many(`SELECT id, brand_name, data FROM campaigns`);
  for (const r of rows) {
    if (normName(r.brand_name) !== name) continue;
    const d = r.data || {};
    const created = toDate(d.createdAt || d.created_at);
    if (created && created >= signedUpAt) continue;
    return { source: 'campaigns', campaignId: r.id };
  }
  return null;
}

function validateSignup(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const brandRef = String(p.brand_id == null ? '' : p.brand_id).trim();
  if (!brandRef || brandRef.length > 200) throw httpError(400, 'brand_id is required.');
  const signedUpAt = toDate(p.signed_up_at);
  if (!signedUpAt) throw httpError(400, 'signed_up_at must be an ISO date-time.');
  if (signedUpAt.getTime() > Date.now() + CLOCK_SKEW_MS) throw httpError(400, 'signed_up_at is in the future.');
  return { p, brandRef, signedUpAt };
}

// POST /api/bot/referrals/signups — record a brand sign-up and decide its
// referral credit. Idempotent: a repeat report of the same brand returns the
// decision already made (decisions are permanent).
async function recordSignup(payload) {
  const { p, brandRef, signedUpAt } = validateSignup(payload);
  const existing = await db.one(`SELECT * FROM referral_signups WHERE brand_ref = $1`, [brandRef]);
  if (existing) return { ...publicSignup(existing), duplicate: true };

  const claims = await claimsFrom(p);
  const agreements = await loadAgreements(claims.map((c) => c.code));
  const key = brandKey({ brandDomain: p.brand_domain, contactEmail: p.contact_email, brandName: p.brand_name });
  // An earlier account of the same company decides it: if that one was
  // referred, the credit stays there; if it signed up on its own, the company
  // was already a customer before this account existed.
  const earlier = key
    ? await db.one(
        `SELECT id, brand_ref, creator_id, code, outcome FROM referral_signups
          WHERE brand_key = $1 AND signed_up_at <= $2
          ORDER BY (outcome = 'attributed') DESC, signed_up_at ASC LIMIT 1`,
        [key, signedUpAt],
      )
    : null;
  const prior = earlier && earlier.outcome === 'attributed' ? earlier : null;
  const existingCustomer = prior
    ? null
    : earlier
      ? { source: 'earlier_account', signup_id: earlier.id, brand_id: earlier.brand_ref }
      : await existingCustomerCheck(p, signedUpAt);

  const decision = decideAttribution({
    signup: { signedUpAt, contactEmail: p.contact_email },
    claims,
    agreements,
    priorReferral: prior,
    existingCustomer,
  });

  const row = await db.one(
    `INSERT INTO referral_signups
       (brand_ref, brand_name, brand_domain, brand_key, contact_email, signed_up_at, claims,
        outcome, reason, contested, code, creator_id, contract_id, candidates)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT (brand_ref) DO NOTHING
     RETURNING *`,
    [
      brandRef,
      p.brand_name ? String(p.brand_name).slice(0, 200) : null,
      normDomain(p.brand_domain),
      key,
      normEmail(p.contact_email),
      signedUpAt,
      JSON.stringify(claims.map((c) => ({ code: c.code, kind: c.kind, at: c.at ? c.at.toISOString() : null, touch_id: c.touchId || null, raw: c.raw || undefined }))),
      decision.outcome,
      decision.reason,
      decision.contested,
      decision.winner ? decision.winner.code : null,
      decision.winner ? decision.winner.creatorId : null,
      decision.winner ? decision.winner.contractId : null,
      JSON.stringify({
        claims: decision.candidates,
        prior_referral: prior ? { signup_id: prior.id, brand_id: prior.brand_ref, creator_id: prior.creator_id, code: prior.code } : null,
        existing_customer: existingCustomer || null,
      }),
    ],
  );
  // Lost a race with a concurrent report of the same brand: return that one.
  if (!row) {
    const again = await db.one(`SELECT * FROM referral_signups WHERE brand_ref = $1`, [brandRef]);
    return { ...publicSignup(again), duplicate: true };
  }
  await recomputeBrand(brandRef);
  return publicSignup(row);
}

function publicSignup(r) {
  return {
    id: r.id,
    brand_id: r.brand_ref,
    brand_name: r.brand_name,
    signed_up_at: r.signed_up_at,
    outcome: r.outcome,
    reason: r.reason,
    reason_text: REASONS[r.reason] || r.reason,
    contested: !!r.contested,
    code: r.code,
    creator_id: r.creator_id,
    candidates: r.candidates,
    overridden_at: r.overridden_at || null,
    override_note: r.override_note || null,
  };
}

// ── Campaigns ───────────────────────────────────────────────────────────────

function validateCampaign(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const campaignRef = String(p.campaign_id == null ? '' : p.campaign_id).trim();
  const brandRef = String(p.brand_id == null ? '' : p.brand_id).trim();
  if (!campaignRef || campaignRef.length > 200) throw httpError(400, 'campaign_id is required.');
  if (!brandRef || brandRef.length > 200) throw httpError(400, 'brand_id is required.');
  const status = p.status == null ? 'active' : String(p.status).toLowerCase();
  if (!['active', 'cancelled'].includes(status)) throw httpError(400, "status must be 'active' or 'cancelled'.");
  const paid = p.paid_spend == null || p.paid_spend === '' ? 0 : Number(p.paid_spend);
  if (!Number.isFinite(paid) || paid < 0 || paid > 1e9) {
    throw httpError(400, 'paid_spend must be the amount the brand has paid (excl. tax, net of refunds), 0 or more.');
  }
  const startedAt = p.started_at == null || p.started_at === '' ? null : toDate(p.started_at);
  if (p.started_at && !startedAt) throw httpError(400, 'started_at must be an ISO date-time.');
  const currency = String(p.currency || 'USD').toUpperCase().slice(0, 3);
  return { campaignRef, brandRef, status, paid, startedAt, currency, name: p.campaign_name ? String(p.campaign_name).slice(0, 200) : null };
}

// POST /api/bot/referrals/campaigns — upsert one campaign of a brand (send it
// again whenever its start, status or paid spend changes; paid_spend is the
// running total, not a delta), then recompute that brand's ledger.
async function recordCampaign(payload) {
  const v = validateCampaign(payload);
  const clash = await db.one(`SELECT brand_ref FROM referral_campaigns WHERE campaign_ref = $1`, [v.campaignRef]);
  if (clash && clash.brand_ref !== v.brandRef) {
    throw httpError(409, `Campaign ${v.campaignRef} is already recorded under brand ${clash.brand_ref}.`);
  }
  await db.query(
    `INSERT INTO referral_campaigns (campaign_ref, brand_ref, campaign_name, started_at, status, paid_spend, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (campaign_ref) DO UPDATE SET
       campaign_name = COALESCE(EXCLUDED.campaign_name, referral_campaigns.campaign_name),
       started_at = EXCLUDED.started_at, status = EXCLUDED.status,
       paid_spend = EXCLUDED.paid_spend, currency = EXCLUDED.currency, updated_at = NOW()`,
    [v.campaignRef, v.brandRef, v.name, v.startedAt, v.status, v.paid, v.currency],
  );
  const ledger = await recomputeBrand(v.brandRef);
  return { brand_id: v.brandRef, campaign_id: v.campaignRef, ledger };
}

// Re-run the ledger for one brand and store the result on its campaigns.
async function recomputeBrand(brandRef) {
  const signup = await db.one(`SELECT * FROM referral_signups WHERE brand_ref = $1`, [brandRef]);
  const campaigns = await db.many(
    `SELECT campaign_ref, started_at, status, paid_spend FROM referral_campaigns WHERE brand_ref = $1`,
    [brandRef],
  );
  if (!campaigns.length) return [];
  let commission = null;
  if (signup && signup.outcome === 'attributed' && signup.code) {
    const agreements = await loadAgreements([signup.code]);
    const a = agreements[signup.code];
    if (a && a.commission && a.commission.basis === 'referral') commission = a.commission;
  }
  const ledger = computeLedger({
    signedUpAt: signup ? toDate(signup.signed_up_at) : new Date(),
    commission,
    campaigns: campaigns.map((c) => ({
      campaignRef: c.campaign_ref, startedAt: c.started_at, status: c.status, paidSpend: c.paid_spend,
    })),
  });
  for (const r of ledger) {
    if (!signup) r.reason = 'not_attributed';
    await db.query(
      `UPDATE referral_campaigns SET counted = $2, rank = $3, reason = $4, commission = $5, updated_at = NOW()
        WHERE campaign_ref = $1`,
      [r.campaignRef, r.counted, r.rank, r.reason, r.commission],
    );
  }
  return ledger.map((r) => ({
    campaign_id: r.campaignRef, counted: r.counted, rank: r.rank, reason: r.reason,
    reason_text: REASONS[r.reason] || r.reason, commission: r.commission,
  }));
}

// ── Admin ───────────────────────────────────────────────────────────────────

// The team settles a dispute by hand: credit the brand to a code, or to no one.
// Recorded with who/why, and the ledger is recomputed.
async function overrideSignup(signupId, { code, note, by } = {}) {
  const signup = await db.one(`SELECT * FROM referral_signups WHERE id = $1`, [signupId]);
  if (!signup) throw httpError(404, 'Referral sign-up not found.');
  const why = String(note || '').trim();
  if (!why) throw httpError(400, 'Say why you are changing the credit (it is kept with the decision).');
  let creatorId = null;
  let contractId = null;
  let c = null;
  if (code != null && code !== '') {
    c = normCode(code);
    const a = c ? (await loadAgreements([c]))[c] : null;
    if (!a) throw httpError(400, `No referral agreement uses code ${code}.`);
    if (!['signed', 'completed'].includes(a.contractStatus)) throw httpError(409, `${c}'s referral agreement isn't signed.`);
    creatorId = a.creatorId;
    contractId = a.contractId;
  }
  const row = await db.one(
    `UPDATE referral_signups
        SET outcome = $2, reason = 'manual_override', code = $3, creator_id = $4, contract_id = $5,
            overridden_by = $6, override_note = $7, overridden_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [signupId, c ? 'attributed' : 'unattributed', c, creatorId, contractId, by ? String(by).slice(0, 200) : null, why.slice(0, 1000)],
  );
  await recomputeBrand(row.brand_ref);
  return publicSignup(row);
}

async function listSignups({ outcome = null, contested = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (outcome && OUTCOMES.includes(outcome)) { params.push(outcome); where.push(`outcome = $${params.length}`); }
  if (contested === true) where.push('contested');
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  const rows = await db.many(
    `SELECT * FROM referral_signups ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY signed_up_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(publicSignup);
}

// A creator's referral programme: their code(s) and link, each brand credited
// to them, and what those brands' counted campaigns have earned.
async function creatorReferrals(creatorId) {
  const codes = await db.many(
    `SELECT rc.code, rc.contract_id, ct.status AS contract_status
       FROM referral_codes rc JOIN contracts ct ON ct.id = rc.contract_id
      WHERE rc.creator_id = $1 ORDER BY rc.created_at`,
    [creatorId],
  );
  const brands = await db.many(
    `SELECT s.id, s.brand_ref, s.brand_name, s.signed_up_at, s.code, s.reason, s.contested,
            COALESCE(SUM(c.commission) FILTER (WHERE c.counted), 0) AS commission,
            COALESCE(SUM(c.paid_spend) FILTER (WHERE c.counted), 0) AS counted_spend,
            COUNT(c.id) FILTER (WHERE c.counted) AS counted_campaigns
       FROM referral_signups s
       LEFT JOIN referral_campaigns c ON c.brand_ref = s.brand_ref
      WHERE s.creator_id = $1 AND s.outcome = 'attributed'
      GROUP BY s.id ORDER BY s.signed_up_at DESC`,
    [creatorId],
  );
  const total = brands.reduce((n, b) => n + Number(b.commission), 0);
  return {
    codes: codes.map((c) => ({ code: c.code, url: referralUrl(c.code), contract_status: c.contract_status })),
    brands: brands.map((b) => ({
      signup_id: b.id,
      brand_id: b.brand_ref,
      brand_name: b.brand_name,
      signed_up_at: b.signed_up_at,
      code: b.code,
      manual: b.reason === 'manual_override',
      contested: !!b.contested,
      counted_campaigns: Number(b.counted_campaigns),
      counted_spend: Number(b.counted_spend),
      commission: Number(b.commission),
    })),
    total_commission: Math.round(total * 100) / 100,
  };
}

module.exports = {
  REASONS,
  // pure
  decideAttribution,
  computeLedger,
  claimIneligibility,
  isSelfReferral,
  brandKey,
  normCode,
  normDomain,
  normName,
  referralContractTexts,
  // codes
  referralUrl,
  suggestedCode,
  chooseCode,
  reserveCode,
  applyReferralCode,
  // routes
  handleReferralLink,
  recordSignup,
  recordCampaign,
  recomputeBrand,
  overrideSignup,
  listSignups,
  creatorReferrals,
};
