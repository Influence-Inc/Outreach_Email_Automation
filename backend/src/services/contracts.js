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
const thread = require('./thread');

// 24 random bytes -> 32-char base64url string. Unguessable; never the DB id.
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function baseUrl() {
  return String(
    process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  ).replace(/\/$/, '');
}

// Singular "/contract/" — the public-facing path (e.g. under
// campaigns.influence.technology, which proxies it through to this backend).
// The plural "/contracts/:token" route still resolves on this backend too, so
// links already emailed out before this change keep working.
function contractUrl(token) {
  return `${baseUrl()}/contract/${token}`;
}

// ── Deal context ────────────────────────────────────────────────────────────
async function loadCreatorForContract(creatorId) {
  return db.one(
    `SELECT c.*, ca.brand_name, ca.name AS campaign_name, ca.usage_rights_policy
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

// The final agreed fee. When we accepted the creator's OWN rate (an admin
// clicked "Accept creator's rate"), that acceptance is the terminal fact and
// its fee wins over any earlier offer we sent — otherwise the last
// 'rate_offer_sent' (our lower counter) would override the number we actually
// agreed to. Failing that, prefer the most recent priced offer we sent, then
// the creator's stored quoted_rate, then the resolved offer's flat_fee.
async function agreedFeeFor(creator) {
  const accepted = await db.one(
    `SELECT detail FROM email_events
     WHERE creator_id = $1 AND type = 'rate_accepted' AND detail->>'source' = 'creator_rate'
     ORDER BY created_at DESC LIMIT 1`,
    [creator.id],
  );
  if (accepted && accepted.detail && accepted.detail.fee != null && Number.isFinite(Number(accepted.detail.fee))) {
    return Math.round(Number(accepted.detail.fee));
  }
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

// Usage-rights fields derived from the campaign's usage_rights_policy (see
// schema.sql for the 3 values):
//   no_rights  — ad rights never requested
//   free_only  — ad rights included by default ("if not [mentioned], include
//                it in all contracts"); the Claude extraction call below is
//                what flips this to false when the negotiation thread shows
//                the creator asked for separate payment for them
//   required   — ad rights always included
function usageRightsFor(policy) {
  if (policy === 'required') {
    return {
      paidAdsIncluded: true,
      usageRights: 'Paid ad rights included — the brand may use this content in paid advertising across their channels',
    };
  }
  if (policy === 'free_only') {
    return {
      paidAdsIncluded: true,
      usageRights: 'Paid ad rights included at no additional cost, alongside organic use',
    };
  }
  return {
    paidAdsIncluded: false,
    usageRights: 'Organic only — no paid ad rights required',
  };
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
  // A view-based deal is priced by TOTAL guaranteed views, not a fixed post
  // count — the creator publishes as many videos as needed to reach the total —
  // so it has no video count and no multi-video rhythm to describe.
  const isViewBased = !!(offer && offer.offer_type === 'view_based');
  // Cadence describes the rhythm across multiple videos; a single-video (or
  // view-based) deal has one drop, not a rhythm, so the contract omits it.
  const cadence = isViewBased || n <= 1
    ? null
    : (process.env.CONTENT_CADENCE || process.env.CAMPAIGN_DEADLINE || '1-2 videos per week');
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

    // Offer shape — used by the dashboard Deals column and the contract page
    // to hide video-count fields on view-based deals (there's no "N videos"
    // to talk about — it's pay-per-guaranteed-view).
    offerType: (offer && offer.offer_type) || null,
    offerLabel: (offer && offer.label) || null,

    // Deliverables + platforms. REPLY 1 proposes all three platforms
    // (Instagram, TikTok & YouTube Shorts) but the creator ultimately picks
    // which they post on — so this all-three set is only the DEFAULT, used when
    // the thread never narrows it. The Claude extraction replaces it with the
    // subset the creator actually agreed to when they specified one.
    platforms: ['Instagram', 'TikTok', 'YouTube Shorts'],
    // View-based deals state no video count (see isViewBased above); flat deals
    // name the agreed number of videos.
    deliverables: isViewBased
      ? 'Short-form video content'
      : `${n} short-form video${n === 1 ? '' : 's'}`,
    numberOfDeliverables: isViewBased ? null : n,
    numberOfVideos: isViewBased ? null : n,
    minTotalViews: minViews,
    includeDmAutomation: true,

    // Revisions.
    revisionRounds: 2,

    // Timeline.
    timeline: cadence,
    deadline: deadlineHuman,
    postingDeadline: deadlineHuman,
    postingWindows: suggestPostingWindows(n, deadlineDate),

    // Usage rights — see usageRightsFor() for the per-policy defaults.
    ...usageRightsFor(creator.usage_rights_policy),
    usageRightsList: ['ads', 'reposting', 'promotion', 'testimonials', 'paid and organic marketing across any channels'],
    usageScope: 'non exclusive, royalty free, and worldwide',
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
- Use ONLY facts supported by the EMAIL THREAD, the negotiation timeline, and the provided KNOWN VALUES. Never invent numbers.
- "platforms" are the platforms the CREATOR agreed to post the content on. REPLY 1 proposes all three — Instagram, TikTok and YouTube Shorts — but the creator decides: return only the platforms the creator actually agreed to. DEFAULT to all three ["Instagram","TikTok","YouTube Shorts"] whenever the creator never restricted them in the thread; return a subset ONLY when the creator explicitly chose or limited which platforms they'll post on. Note: a view-based deal counts guaranteed views "on Instagram" for PRICING only — that view-counting reference does NOT limit the posting platforms, so never narrow to Instagram-only because of it.
- "deliverables": when KNOWN VALUES.acceptedOffer.offer_type is "view_based", the deal is priced by TOTAL guaranteed views reached across as many posts as the creator needs — describe the content WITHOUT any video count (e.g. "Short-form video content") and set numberOfDeliverables and numberOfVideos to null. Never write "1 video" / "1 Reel" for a view-based deal. For flat (video-based) deals, state the agreed number of videos.
- "compensation" and "totalPayment" both equal the final agreed fee as a plain number (no currency symbol). If the thread is unclear, use the provided agreed fee.
- "currency" is a 3-letter ISO code (default "USD").
- "postingDeadline" is the hard "posted no later than" date as a human-readable string, e.g. "April 20, 2026".
- "postingWindows" are suggested per-video windows, e.g. [{"label":"Video 1","range":"December 11 - 14"}]. Return null if the thread doesn't specify windows.
- "usageRightsList" enumerates each usage (e.g. ["ads","reposting","promotion","testimonials","paid and organic marketing across any channels"]).
- "paidAdsIncluded" and "usageRights" are governed by KNOWN VALUES.usageRightsPolicy:
  - "no_rights" — paidAdsIncluded is ALWAYS false. usageRights: "Organic only — no paid ad rights required".
  - "required" — paidAdsIncluded is ALWAYS true. usageRights should state paid ad rights ARE included.
  - "free_only" — paidAdsIncluded is true UNLESS the negotiation timeline shows the creator explicitly asked for SEPARATE or ADDITIONAL payment specifically in exchange for granting paid-ad/usage rights (e.g. "I'd need extra for ad rights", "that's a separate fee", "usage rights cost more on top"). Only in that specific case, set it to false and write usageRights as "Organic only — no paid ad rights required". Otherwise (not mentioned, or the creator agreed to include them), paidAdsIncluded is true and usageRights should state paid ad rights are included.
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
    usageRightsPolicy: creator.usage_rights_policy || 'no_rights',
    agreedFee: fee,
    quotedRate: creator.quoted_rate != null ? Number(creator.quoted_rate) : null,
    acceptedOffer: offer || null,
    igStats: creator.ig_scraped_data || null,
    latestReply: creator.latest_inbound_text || null,
  };

  // The full stored conversation — the creator's own words are the primary
  // source for which platforms they'll post on and the terms they agreed to
  // (the structured timeline below only carries rates/actions, not prose).
  const messages = await thread.loadThread(creator.id);
  const transcript = thread.renderTranscript(messages);

  const user = [
    'KNOWN VALUES (authoritative unless the thread clearly overrides them):',
    JSON.stringify(known, null, 2),
    '',
    "EMAIL THREAD (verbatim, oldest first). The creator's own words here are the primary source for which platforms they will post on, the deliverables they agreed to, and any terms they set:",
    transcript || '(no stored messages — rely on KNOWN VALUES and the latest reply)',
    '',
    'NEGOTIATION TIMELINE (structured events, oldest first):',
    events.map((e) => `- ${e.type}: ${JSON.stringify(e.detail)}`).join('\n') || '(none logged)',
    '',
    'Extract the contract JSON now.',
  ].join('\n');

  const out = claude.parseJsonLoose(await claude.callClaudeText(CONTRACT_SYSTEM, user, 1200));
  if (!out || typeof out !== 'object') return base;
  const merged = mergeContractData(base, out);
  // Platforms follow the creator's choice: mergeContractData already keeps the
  // all-three default whenever the extraction returns nothing meaningful (the
  // creator never narrowed them), and takes the extracted subset when they did.
  // On a view-based deal the fee buys a TOTAL guaranteed-view count that can be
  // reached across multiple posts, so there is no fixed number of videos to
  // name. Never let the extraction pin a count onto it (e.g. "1 Instagram
  // Reel") — keep the count-less base deliverables and drop any video count.
  if (base.offerType === 'view_based') {
    merged.deliverables = base.deliverables;
    merged.numberOfDeliverables = null;
    merged.numberOfVideos = null;
  }
  // Cadence never applies to a single-video (or view-based) deal, no matter
  // what Claude extracted from the thread — keep it out of the stored contract.
  if (Number(merged.numberOfDeliverables || merged.numberOfVideos) <= 1) {
    merged.timeline = null;
  }
  // Paid-ad-rights inclusion is a high-stakes, policy-governed term and must NOT
  // be left to the free-form extraction, which can misfire and silently drop
  // rights the campaign is entitled to (the reported free_only bug: the creator
  // never mentioned ad rights, yet the extraction flipped them off). Re-pin it
  // deterministically from the campaign policy — see resolveUsageRights().
  Object.assign(merged, await resolveUsageRights(creator, transcript));
  return merged;
}

// Authoritative usage-rights inclusion, decided by the campaign policy rather
// than the contract extraction:
//   no_rights / required — fixed by policy; never negotiable in-thread.
//   free_only            — INCLUDED by default; only flipped off when the
//                          creator explicitly negotiated SEPARATE/ADDITIONAL
//                          payment for ad/usage rights in the thread, decided by
//                          the focused, conservative check below (not the big
//                          extraction). "Not mentioned" always keeps rights in.
async function resolveUsageRights(creator, transcript) {
  const policy = creator.usage_rights_policy;
  if (policy !== 'free_only') return usageRightsFor(policy);
  const negotiatedAway = await negotiatedSeparateUsageRightsPayment(transcript);
  return usageRightsFor(negotiatedAway ? 'no_rights' : 'free_only');
}

// Focused yes/no: did the CREATOR ask for separate/additional payment
// specifically in exchange for ad/usage rights during the thread? Mirrors
// disputesUsageRights below — a narrow decision with a conservative
// deterministic fallback, kept out of the broad contract extraction so a
// single misfire there can never drop rights the campaign is owed.
const USAGE_RIGHTS_NEGOTIATED_SYSTEM = `You read an influencer-marketing email negotiation between a brand's manager and a creator. Decide whether the CREATOR explicitly asked for SEPARATE or ADDITIONAL payment specifically in exchange for granting paid-ad / usage / whitelisting rights (e.g. "ad rights are extra", "usage rights cost more on top", "I charge separately for whitelisting", "that would be an additional fee for paid ads").

Return ONLY a JSON object: {"negotiatedSeparatePayment": boolean}
- true ONLY when the CREATOR clearly tied an extra or separate charge to granting ad/usage rights.
- false for everything else — the creator never mentioned it, mentioned it without asking for more money, or agreed to include it. A brand-side statement that rights are included at no cost is NOT the creator asking for extra.`;

async function negotiatedSeparateUsageRightsPayment(transcript) {
  if (!transcript || !String(transcript).trim()) return false;
  const out = claude.parseJsonLoose(
    await claude.callClaudeText(USAGE_RIGHTS_NEGOTIATED_SYSTEM, String(transcript), 200),
  );
  if (out && typeof out.negotiatedSeparatePayment === 'boolean') return out.negotiatedSeparatePayment;
  // Deterministic fallback when Claude is unavailable: both an ad/usage-rights
  // noun AND an extra-charge marker must appear. Conservative on purpose —
  // default false keeps rights INCLUDED, matching the free_only policy default,
  // so a missed negotiation just waits for a human to catch it (the reply is
  // delegated regardless).
  const s = String(transcript).toLowerCase();
  const mentionsRights = /\b(ad rights?|usage rights?|paid ads?|advertising rights?|whitelisting)\b/.test(s);
  const extraCharge =
    /\b(extra|additional|separate(?:ly)?|on top|surcharge|cost[s]? more|charge (?:extra|more|separately)|more for (?:the )?(?:ad|usage|paid))\b/.test(
      s,
    );
  return mentionsRights && extraCharge;
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

// ── Usage-rights dispute handling (free_only policy) ──────────────────────
// A creator on a "free_only" campaign may reply AFTER accepting (contract
// already generated, ad rights included by default) disputing/objecting to
// those rights. Detect it, then drop ad rights from their contract.
const USAGE_DISPUTE_SYSTEM = `You read one inbound message from a creator who has ALREADY accepted a paid collaboration and been sent a contract that includes paid ad/usage rights for the brand. Decide whether this message is the creator objecting to, disputing, or asking to remove those ad/usage rights (e.g. "please remove the ad rights clause", "I didn't agree to paid usage", "we need to renegotiate the usage rights", "can you take that ads section out", "I don't want you using this for paid ads").

Return ONLY a JSON object: {"disputesUsageRights": boolean}
- true only when the message is clearly about the CONTRACT'S usage/ad rights terms specifically.
- false for anything else — payment amount, timeline, general questions, thanks, silence, or unrelated topics.`;

async function disputesUsageRights(text) {
  if (!text || !String(text).trim()) return false;
  const out = claude.parseJsonLoose(await claude.callClaudeText(USAGE_DISPUTE_SYSTEM, String(text), 200));
  if (out && typeof out.disputesUsageRights === 'boolean') return out.disputesUsageRights;
  // Deterministic fallback when Claude is unavailable: both an ad/usage-rights
  // noun AND an objection/removal verb must appear — conservative on purpose,
  // a missed dispute just waits for a human to notice on the next reply.
  const s = String(text).toLowerCase();
  const mentionsUsageRights = /\b(ad rights?|usage rights?|paid ads?|advertising rights?|whitelisting)\b/.test(s);
  const objects =
    /\b(remove|don'?t agree|didn'?t agree|not okay|not ok|object|dispute|take (?:that|it) out|renegotiate|reconsider|withdraw|revoke)\b/.test(
      s,
    );
  return mentionsUsageRights && objects;
}

// Drop paid-ad-rights from an already-generated contract. Only touches a
// contract that hasn't been signed yet — amending a signed document is out of
// scope here (that needs a human; see negotiation.js's delegate() call at the
// caller). Returns null if there's no contract or it's already signed.
async function removeUsageRightsFromContract(creatorId) {
  const existing = await db.one(
    `SELECT * FROM contracts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
  if (!existing || existing.status !== 'pending') return null;
  const data = { ...existing.data, ...usageRightsFor('no_rights') };
  const row = await db.one(
    `UPDATE contracts SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [existing.id, JSON.stringify(data)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_usage_rights_removed', $2)`,
    [creatorId, { token: existing.token }],
  );
  return row;
}

// One-off repair for a single contract by token: re-pin ONLY its usage-rights
// fields to the policy-correct values (the same resolveUsageRights() the
// extraction now uses), leaving every other term untouched. This exists for
// contracts generated BEFORE the usage-rights pinning fix, whose paid ad rights
// the free-form extraction may have wrongly dropped on a free_only campaign.
// Unlike updateContractTermsFromThread it deliberately does NOT re-run the full
// extraction, so it can't shift the deadline, platforms, or any other field —
// it's the smallest safe correction. Only touches a PENDING contract; a signed
// one is executed and needs a human. Returns one of:
//   {updated:true, before, after, changed} — data re-pinned (changed=false when
//                                             it was already correct, a no-op)
//   {signed:true}   — contract exists but is signed (left untouched)
//   {missing:true}  — no contract / creator for that token
async function syncUsageRightsForContract(token) {
  const existing = await getByToken(token);
  if (!existing) return { missing: true };
  if (existing.status !== 'pending') return { signed: true, row: existing };
  const creator = await loadCreatorForContract(existing.creator_id);
  if (!creator) return { missing: true };

  const messages = await thread.loadThread(existing.creator_id);
  const transcript = thread.renderTranscript(messages);
  const after = await resolveUsageRights(creator, transcript);
  const before = {
    usageRights: existing.data ? existing.data.usageRights : undefined,
    paidAdsIncluded: existing.data ? existing.data.paidAdsIncluded : undefined,
  };
  const changed =
    before.usageRights !== after.usageRights || before.paidAdsIncluded !== after.paidAdsIncluded;

  const data = { ...existing.data, ...after };
  const row = await db.one(
    `UPDATE contracts SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [existing.id, JSON.stringify(data)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_usage_rights_repaired', $2)`,
    [existing.creator_id, { token, before, after, changed }],
  );
  return { updated: true, changed, before, after, row };
}

// ── Post-acceptance term changes ──────────────────────────────────────────
// A contract is a point-in-time snapshot taken when the creator accepts, but
// the creator can still change a deal term afterwards ("let's make it 2 videos",
// "I can also post on YouTube Shorts", "push the deadline to the 30th"). Detect
// such a message so the caller can re-sync the (unsigned) contract from the
// now-updated thread. Deliberately broad — payment, deliverables, platforms,
// timeline, views, exclusivity, usage rights — but only genuine CHANGES, not
// questions or acknowledgements.
const TERM_CHANGE_SYSTEM = `You read one inbound message from a creator who has ALREADY accepted a paid collaboration and been sent a contract. Decide whether this message CHANGES, ADDS, or REMOVES any material deal term in that contract — for example: which platforms they'll post on (Instagram / TikTok / YouTube Shorts / Reels / etc.), the number or type of deliverables, the timeline or posting deadline, the fee or payment structure/split, guaranteed views, exclusivity, or usage/ad rights.

Return ONLY a JSON object: {"changesTerms": boolean}
- true ONLY when the message actually alters a deal term, e.g. "let's make it 2 videos instead of 1", "I can also post on YouTube Shorts", "I can only do Instagram now", "can we push the deadline to the 30th", "actually my rate is $X".
- false for everything else — acknowledgements, thanks, benign logistics or payment-timing questions that do not change a term, or unrelated topics. A QUESTION about a term ("when do I get paid?") is not a change.`;

async function changesContractTerms(text) {
  if (!text || !String(text).trim()) return false;
  const out = claude.parseJsonLoose(await claude.callClaudeText(TERM_CHANGE_SYSTEM, String(text), 200));
  if (out && typeof out.changesTerms === 'boolean') return out.changesTerms;
  // Deterministic fallback when Claude is unavailable: a deal-term noun AND a
  // change marker must co-occur. Conservative — a missed change just waits for
  // a human to notice on the next reply (the reply is delegated regardless).
  const s = String(text).toLowerCase();
  const term =
    /\b(platform|instagram|tiktok|tik tok|youtube|shorts?|reels?|videos?|deliverable|deadline|timeline|rate|fee|price|pricing|payment|views?|exclusiv|usage rights?|ad rights?)\b/.test(
      s,
    );
  const change =
    /\b(instead|change[ds]?|updat(?:e|ed|ing)|revis(?:e|ed)|actually|can also|also (?:do|post)|add|drop|remove|only (?:do|post)|push (?:the|it|back)|move (?:the|it)|make it|bump|increase|decrease|lower|raise)\b/.test(
      s,
    );
  return term && change;
}

// Re-sync a creator's contract from the current (persisted) email thread after
// a post-acceptance term change. ONLY touches a contract that is still pending —
// a signed contract is executed and must never be silently altered (a human
// handles that amendment). Re-runs the same extraction used at creation, so the
// updated data flows to both the contract page and the dashboard Deals column
// (both read this row). Returns {updated, signed, row}:
//   updated:true  — the pending contract's data was refreshed
//   signed:true   — a contract exists but is already signed (left untouched)
//   both false    — no contract on file yet
async function updateContractTermsFromThread(creatorId) {
  const existing = await db.one(
    `SELECT * FROM contracts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
  if (!existing) return { updated: false, signed: false, row: null };
  if (existing.status !== 'pending') return { updated: false, signed: true, row: existing };

  const creator = await loadCreatorForContract(creatorId);
  if (!creator) return { updated: false, signed: false, row: existing };

  const data = await extractContractData(creator);
  const row = await db.one(
    `UPDATE contracts SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [existing.id, JSON.stringify(data)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_terms_updated', $2)`,
    [creatorId, { token: existing.token }],
  );
  return { updated: true, signed: false, row };
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
// routes/creators.js) so the dashboard Status column can show stage + copy-link,
// and the Deals column can show the accepted deliverables (videos, min views,
// deadline, platforms, usage rights) once a contract exists — `data` is only
// ever generated after the creator accepts (see sendContractOnAcceptance), so
// its mere presence is already an "accepted" signal for the dashboard.
async function attachContracts(rows) {
  const ids = (rows || []).map((r) => r.id).filter((x) => x != null);
  if (!ids.length) return rows;
  const contracts = await db.many(
    `SELECT DISTINCT ON (creator_id) creator_id, token, status, data
     FROM contracts WHERE creator_id = ANY($1::int[])
     ORDER BY creator_id, created_at DESC`,
    [ids],
  );
  const byCreator = new Map(contracts.map((c) => [c.creator_id, c]));
  for (const r of rows) {
    const c = byCreator.get(r.id);
    r.contract = c ? { token: c.token, status: c.status, url: contractUrl(c.token), data: c.data } : null;
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
  disputesUsageRights,
  removeUsageRightsFromContract,
  syncUsageRightsForContract,
  changesContractTerms,
  updateContractTermsFromThread,
  // exposed for tests / reuse
  resolveOffer,
  agreedFeeFor,
  mergeContractData,
  usageRightsFor,
  negotiatedSeparateUsageRightsPayment,
};
