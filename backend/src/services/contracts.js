'use strict';

// Creator Contracts engine. Once a creator accepts an offer this module:
//   1. extracts the campaign-specific contract fields (Claude, strict JSON, with
//      a deterministic fallback so it works with no ANTHROPIC_API_KEY / DRY_RUN),
//   2. stores a contract row keyed by a securely-random, unguessable token
//      (the SERIAL id is never exposed publicly),
//   3. records the signed submission and drives the pending → signed → completed
//      lifecycle, logging each step to email_events for the dashboard timeline.
//
// It deliberately does NOT require ./negotiation — negotiation requires THIS
// module for the acceptance hook, so the Claude client lives in ./claudeClient
// to keep the dependency one-way (no circular require).

const crypto = require('crypto');
const db = require('../db');
const claude = require('./claudeClient');
const templates = require('./negotiationTemplates');

// 24 random bytes -> 32-char base64url string. Unguessable; never the DB id.
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function baseUrl() {
  return String(
    process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  ).replace(/\/$/, '');
}

function contractUrl(token) {
  return `${baseUrl()}/contracts/${token}`;
}

// ── Deal context ────────────────────────────────────────────────────────────
async function loadCreatorForContract(creatorId) {
  return db.one(
    `SELECT c.*, ca.brand_name, ca.name AS campaign_name
     FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
}

// The offer the creator accepted (custom overrides suggested; selected id wins).
function resolveOffer(creator) {
  if (creator.custom_offer && typeof creator.custom_offer === 'object') return creator.custom_offer;
  const offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : [];
  if (creator.selected_offer_id) {
    const f = offers.find((o) => o.offer_id === creator.selected_offer_id);
    if (f) return f;
  }
  return offers[0] || null;
}

// The final agreed fee: prefer the most recent priced offer we logged as sent,
// then the creator's stored quoted_rate, then the resolved offer's flat_fee.
async function agreedFeeFor(creator) {
  const ev = await db.one(
    `SELECT detail FROM email_events
     WHERE creator_id = $1 AND type = 'rate_offer_sent'
     ORDER BY created_at DESC LIMIT 1`,
    [creator.id],
  );
  if (ev && ev.detail && ev.detail.fee != null && Number.isFinite(Number(ev.detail.fee))) {
    return Math.round(Number(ev.detail.fee));
  }
  if (creator.quoted_rate != null && Number.isFinite(Number(creator.quoted_rate))) {
    return Math.round(Number(creator.quoted_rate));
  }
  const offer = resolveOffer(creator);
  if (offer && offer.flat_fee != null && Number.isFinite(Number(offer.flat_fee))) {
    return Math.round(Number(offer.flat_fee));
  }
  return null;
}

function numDeliverables(offer) {
  if (offer && offer.num_videos != null && Number(offer.num_videos) > 0) return Number(offer.num_videos);
  return Number(process.env.NUM_VIDEOS || 2);
}

function guaranteedViewsOf(offer) {
  if (!offer) return null;
  if (offer.view_guarantee != null) return Number(offer.view_guarantee);
  if (offer.bonus_threshold_views != null) return Number(offer.bonus_threshold_views);
  return null;
}

function bonusOf(offer) {
  if (!offer) return { amount: null, threshold: null };
  if (offer.offer_type === 'video_bonus') {
    return {
      amount: offer.bonus_amount != null ? Number(offer.bonus_amount) : null,
      threshold: offer.bonus_threshold_views != null ? Number(offer.bonus_threshold_views) : null,
    };
  }
  return { amount: null, threshold: null };
}

// Suggested per-video posting windows derived from the total window and video
// count. The example contract lists windows like:
//   - Video 1: December 11 - 14
//   - Video 2: December 16 - 21
// This is only a suggestion — the deadline is the hard constraint.
function suggestPostingWindows(n, deadline) {
  const end = deadline instanceof Date && !Number.isNaN(deadline.getTime()) ? deadline : null;
  if (!end || !n || n < 1) return [];
  const fmt = (d) =>
    d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const oneDay = 24 * 3600 * 1000;
  const totalWindowDays = Math.max(7, n * 7);
  const startMs = end.getTime() - totalWindowDays * oneDay;
  const stepMs = (end.getTime() - startMs) / n;
  const windows = [];
  for (let i = 0; i < n; i += 1) {
    const s = new Date(startMs + i * stepMs);
    const e = new Date(s.getTime() + Math.min(stepMs, 5 * oneDay));
    windows.push({ label: `Video ${i + 1}`, range: `${fmt(s)} - ${fmt(e).split(' ').pop()}` });
  }
  return windows;
}

// Deterministic contract fields from what we already know. Always complete; used
// both as the no-Claude fallback and as the base Claude's extraction merges over.
// The shape mirrors the fields the public contract page renders — see
// public/contract.html for the layout that consumes each key.
function baseContractData(creator, fee, offer) {
  const n = numDeliverables(offer);
  const cadence =
    process.env.CONTENT_CADENCE || process.env.CAMPAIGN_DEADLINE || '1-2 videos per week';
  const brandName = creator.brand_name || process.env.BRAND_NAME || null;
  const minViews = guaranteedViewsOf(offer);
  const bonus = bonusOf(offer);
  // Best-guess hard deadline: N weeks out from today, matching the cadence.
  const weeks = Math.max(n, 3);
  const deadlineDate = new Date(Date.now() + weeks * 7 * 24 * 3600 * 1000);
  const deadlineHuman = deadlineDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  return {
    // Identity — kept for the Creator-DB sync payload mapping.
    creatorName: creator.full_name || creator.first_name || null,
    email: creator.email || null,
    instagramUsername: creator.instagram_username || null,

    // Company + brand.
    companyLegalName: process.env.COMPANY_LEGAL_NAME || 'Influence Inc.',
    companyLegalAddress:
      process.env.COMPANY_LEGAL_ADDRESS ||
      '8 The Green, STE R, Dover, Delaware, 19901, United States',
    brandName,
    brandLegalName: brandName,
    campaignName: creator.campaign_name || null,

    // Deliverables + platforms.
    platforms: ['Instagram', 'TikTok'],
    deliverables: `${n} short-form video${n === 1 ? '' : 's'}`,
    numberOfDeliverables: n,
    numberOfVideos: n,
    minTotalViews: minViews,
    includeDmAutomation: true,

    // Revisions.
    revisionRounds: 2,

    // Timeline.
    timeline: cadence,
    deadline: deadlineHuman,
    postingDeadline: deadlineHuman,
    postingWindows: suggestPostingWindows(n, deadlineDate),

    // Usage rights.
    usageRights: 'Organic only — no paid ad rights required',
    usageRightsList: ['ads', 'reposting', 'promotion', 'testimonials', 'paid and organic marketing across any channels'],
    usageScope: 'non exclusive, royalty free, and worldwide',
    paidAdsIncluded: false,
    exclusivity: 'None',

    // Content availability.
    postLiveMonths: 6,

    // Compensation.
    compensation: fee,
    totalPayment: fee,
    currency: 'USD',
    paymentTermsDays: 7,
    paymentTerms:
      'Direct bank transfer, initiated within 7 working days of completing and posting all agreed deliverables',
    upfrontPercent: 30,
    upfrontTrigger: 'upon sharing the first video draft',
    remainderPercent: 70,
    remainderTrigger:
      'after deliverables outlined in this agreement are completed, posted and confirmed live',

    // Bonus (present for video_bonus offer types).
    bonusAmount: bonus.amount,
    bonusThresholdViews: bonus.threshold,
    bonusWindowDays: 30,

    guaranteedViews: minViews,
    specialNotes: null,
    additionalTerms: [],
  };
}

const CONTRACT_SYSTEM = `You extract structured contract terms from an influencer-marketing email negotiation between a brand's manager and a creator, in the exact shape needed to populate a standard Influencer Agreement.

Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY these keys:
{
  "creatorName": string|null,
  "email": string|null,
  "instagramUsername": string|null,
  "brandName": string|null,
  "brandLegalName": string|null,
  "campaignName": string|null,

  "platforms": string[],
  "deliverables": string,
  "numberOfDeliverables": number|null,
  "numberOfVideos": number|null,
  "minTotalViews": number|null,
  "includeDmAutomation": boolean|null,
  "revisionRounds": number|null,

  "timeline": string|null,
  "deadline": string|null,
  "postingDeadline": string|null,
  "postingWindows": [{"label": string, "range": string}]|null,

  "usageRights": string|null,
  "usageRightsList": string[]|null,
  "usageScope": string|null,
  "paidAdsIncluded": boolean|null,
  "exclusivity": string|null,
  "postLiveMonths": number|null,

  "compensation": number|null,
  "totalPayment": number|null,
  "currency": string,
  "paymentTermsDays": number|null,
  "paymentTerms": string|null,
  "upfrontPercent": number|null,
  "upfrontTrigger": string|null,
  "remainderPercent": number|null,
  "remainderTrigger": string|null,
  "bonusAmount": number|null,
  "bonusThresholdViews": number|null,
  "bonusWindowDays": number|null,
  "guaranteedViews": number|null,

  "specialNotes": string|null,
  "additionalTerms": string[]
}

Rules:
- Use ONLY facts supported by the negotiation timeline and the provided KNOWN VALUES. Never invent numbers.
- "compensation" and "totalPayment" both equal the final agreed fee as a plain number (no currency symbol). If the thread is unclear, use the provided agreed fee.
- "currency" is a 3-letter ISO code (default "USD").
- "postingDeadline" is the hard "posted no later than" date as a human-readable string, e.g. "April 20, 2026".
- "postingWindows" are suggested per-video windows, e.g. [{"label":"Video 1","range":"December 11 - 14"}]. Return null if the thread doesn't specify windows.
- "usageRightsList" enumerates each usage (e.g. ["ads","reposting","promotion","testimonials","paid and organic marketing across any channels"]).
- "paidAdsIncluded" — true only if the thread explicitly includes paid advertising usage rights.
- "upfrontPercent" + "remainderPercent" should sum to 100 when split payment applies.
- If a field is genuinely unknown, use null (or [] for array fields).
- Put any extra negotiated terms (whitelisting, exclusivity windows, special timelines) into "additionalTerms" as short strings.`;

// Extract the campaign-specific contract fields. Merges Claude's structured JSON
// over the deterministic base so the result is always complete, and never lets a
// bad extraction wipe a known value.
async function extractContractData(creator) {
  const fee = await agreedFeeFor(creator);
  const offer = resolveOffer(creator);
  const base = baseContractData(creator, fee, offer);

  const events = await db.many(
    `SELECT type, detail, created_at FROM email_events
     WHERE creator_id = $1
       AND type IN ('rate_quoted','rate_offer_sent','rate_accepted','sent_negotiation','replied')
     ORDER BY created_at ASC`,
    [creator.id],
  );

  const known = {
    creatorFirstName: creator.first_name || null,
    creatorFullName: creator.full_name || null,
    email: creator.email || null,
    instagramUsername: creator.instagram_username || null,
    brandName: base.brandName,
    campaignName: base.campaignName,
    agreedFee: fee,
    quotedRate: creator.quoted_rate != null ? Number(creator.quoted_rate) : null,
    acceptedOffer: offer || null,
    igStats: creator.ig_scraped_data || null,
    latestReply: creator.latest_inbound_text || null,
  };

  const user = [
    'KNOWN VALUES (authoritative unless the thread clearly overrides them):',
    JSON.stringify(known, null, 2),
    '',
    'NEGOTIATION TIMELINE (oldest first):',
    events.map((e) => `- ${e.type}: ${JSON.stringify(e.detail)}`).join('\n') || '(none logged)',
    '',
    'Extract the contract JSON now.',
  ].join('\n');

  const out = claude.parseJsonLoose(await claude.callClaudeText(CONTRACT_SYSTEM, user, 1200));
  if (!out || typeof out !== 'object') return base;
  return mergeContractData(base, out);
}

function isMeaningful(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

function mergeContractData(base, out) {
  const merged = { ...base };
  for (const key of Object.keys(base)) {
    if (isMeaningful(out[key])) merged[key] = out[key];
  }
  // compensation must be a finite number; never let a bad extraction wipe the fee.
  merged.compensation = Number.isFinite(Number(out.compensation))
    ? Number(out.compensation)
    : base.compensation;
  return merged;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Generate (or reuse) the creator's contract. Idempotent: a creator never gets a
// second contract, so scheduler retries + the accepted hook can't duplicate.
async function createContractForCreator(creatorId) {
  const creator = await loadCreatorForContract(creatorId);
  if (!creator) throw new Error(`contracts: creator ${creatorId} not found`);

  const existing = await db.one(
    `SELECT * FROM contracts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
  if (existing) {
    return {
      token: existing.token,
      url: contractUrl(existing.token),
      data: existing.data,
      contract: existing,
      reused: true,
    };
  }

  const data = await extractContractData(creator);
  const token = generateToken();
  const contract = await db.one(
    `INSERT INTO contracts (token, creator_id, campaign_id, status, data)
     VALUES ($1, $2, $3, 'pending', $4::jsonb)
     RETURNING *`,
    [token, creatorId, creator.campaign_id, JSON.stringify(data)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_created', $2)`,
    [creatorId, { token, contract_id: contract.id }],
  );
  return { token, url: contractUrl(token), data, contract, reused: false };
}

async function getByToken(token) {
  return db.one(`SELECT * FROM contracts WHERE token = $1`, [token]);
}

// Record the creator's signed submission: pending -> signed. Idempotent — a
// second submit (or an unknown token) returns the current row without re-signing.
async function recordSubmission(token, { signerName, signerEmail, signerIp, submission } = {}) {
  const row = await db.one(
    `UPDATE contracts
     SET status = 'signed', signed_at = NOW(), submission = $2::jsonb,
         signer_name = $3, signer_email = $4, signer_ip = $5, updated_at = NOW()
     WHERE token = $1 AND status = 'pending'
     RETURNING *`,
    [token, JSON.stringify(submission || {}), signerName || null, signerEmail || null, signerIp || null],
  );
  if (!row) {
    return { row: await getByToken(token), alreadySigned: true };
  }
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_signed', $2)`,
    [row.creator_id, { token, signer_name: row.signer_name }],
  );
  return { row, alreadySigned: false };
}

// Record the outcome of the Creator-DB sync. On success -> completed; on failure
// the contract stays 'signed' (a scheduler pass can retry). Always audited.
async function markSynced(token, ok, detail = {}) {
  const row = await db.one(
    `UPDATE contracts
     SET synced_to_creator_db = $2,
         status = CASE WHEN $2 THEN 'completed' ELSE status END,
         updated_at = NOW()
     WHERE token = $1
     RETURNING *`,
    [token, !!ok],
  );
  if (row) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_synced', $2)`,
      [row.creator_id, { token, ok: !!ok, ...detail }],
    );
  }
  return row;
}

// Hang the latest contract summary on each creator row (mirrors attachRateLog in
// routes/creators.js) so the dashboard Status column can show stage + copy-link.
async function attachContracts(rows) {
  const ids = (rows || []).map((r) => r.id).filter((x) => x != null);
  if (!ids.length) return rows;
  const contracts = await db.many(
    `SELECT DISTINCT ON (creator_id) creator_id, token, status
     FROM contracts WHERE creator_id = ANY($1::int[])
     ORDER BY creator_id, created_at DESC`,
    [ids],
  );
  const byCreator = new Map(contracts.map((c) => [c.creator_id, c]));
  for (const r of rows) {
    const c = byCreator.get(r.id);
    r.contract = c ? { token: c.token, status: c.status, url: contractUrl(c.token) } : null;
  }
  return rows;
}

module.exports = {
  generateToken,
  contractUrl,
  extractContractData,
  baseContractData,
  createContractForCreator,
  getByToken,
  recordSubmission,
  markSynced,
  attachContracts,
  // exposed for tests / reuse
  resolveOffer,
  agreedFeeFor,
  mergeContractData,
};
