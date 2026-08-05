'use strict';

// Creator briefing engine. After a creator signs (either the main contract or
// the offer-portal mini-contract) we flag a personalised brief as "pending" so
// it surfaces as a Brief hand-off in the Needs-you list. An admin fills the two
// curated fields (content direction + example videos); publishing assembles the
// full brief, mints a per-creator tracked website link (via the influence-stats
// dashboard), snapshots everything into brief_data, and exposes a shareable
// /brief/:token page.
//
// The brief is assembled from three layers:
//   1. Universal boilerplate  — app_settings.brief_boilerplate (same everywhere)
//   2. Per-campaign master     — campaigns.content_brief (admin sets once)
//   3. Per-creator merge       — creator name + signed usage rights + DM
//                                automation + the tracked link + the two
//                                admin-curated fields.

const crypto = require('crypto');
const db = require('../db');
const campaignDashboard = require('./campaignDashboard');
const { resolveHandle } = require('./creatorIdentity');
const { getBriefBoilerplate } = require('./settings');

// ── URL + token helpers (mirrors contracts.js) ──────────────────────────────
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function baseUrl() {
  return String(
    process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  ).replace(/\/$/, '');
}

// Singular "/brief/" — the public-facing path (proxied through
// campaigns.influence.technology, like /contract/ and /o/).
function briefUrl(token) {
  return `${baseUrl()}/brief/${token}`;
}

// ── small utils ─────────────────────────────────────────────────────────────
const strOrNull = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const fmt = (n) => Number(n).toLocaleString('en-US');

// Prepend https:// when a bare domain (reve.com) is given rather than a URL.
function ensureUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

// Round a raw view estimate to a tidy, presentable number.
function roundClean(n) {
  if (!(n > 0)) return null;
  if (n >= 100000) return Math.round(n / 10000) * 10000;
  if (n >= 10000) return Math.round(n / 5000) * 5000;
  if (n >= 1000) return Math.round(n / 1000) * 1000;
  return Math.round(n / 100) * 100;
}

// Example-video links accept either ["url", ...] or [{label,url}, ...]; both
// normalise to [{label,url}]. Empty/invalid entries are dropped, capped at 12.
function normalizeVideoLinks(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => {
      if (typeof item === 'string') {
        const s = item.trim();
        if (!s) return null;
        // Accept "Label | https://…" as well as a bare URL (mirrors the
        // dashboard's parseVideoLines, so raw lines survive either path).
        const i = s.indexOf('|');
        if (i > -1) {
          const u = s.slice(i + 1).trim();
          return u ? { label: s.slice(0, i).trim(), url: u } : null;
        }
        return { label: '', url: s };
      }
      if (item && typeof item === 'object') {
        const url = String(item.url || '').trim();
        if (!url) return null;
        return { label: String(item.label || '').trim(), url };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 12);
}

// The offer the creator accepted (custom overrides suggested; selected id wins;
// else the first suggested). Mirrors resolveOffer in contracts.js — kept local
// so briefs never has to require the contracts engine (which requires nothing
// from here, keeping the dependency graph one-way).
function resolveAcceptedOffer(creator) {
  if (creator.custom_offer && typeof creator.custom_offer === 'object') return creator.custom_offer;
  const offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : [];
  if (creator.selected_offer_id) {
    const f = offers.find((o) => o.offer_id === creator.selected_offer_id);
    if (f) return f;
  }
  return offers[0] || null;
}

// Usage-rights sentence for the brief. Prefers the exact clause materialised on
// the signed contract; falls back to the campaign policy (used creators sign a
// portal mini-contract that has no contracts.data row). Mirrors the 3 values of
// usageRightsFor in contracts.js.
function usageRightsText(contractData, policy) {
  if (contractData && typeof contractData.usageRights === 'string' && contractData.usageRights.trim()) {
    return contractData.usageRights.trim();
  }
  if (policy === 'required') {
    return 'Paid ad rights included — the brand may use this content in paid advertising across their channels.';
  }
  if (policy === 'free_only') {
    return 'Paid ad rights included at no additional cost, alongside organic use.';
  }
  return 'Organic only — no paid ad rights required.';
}

// "Expected views" line at the top of the brief, driven by the signed deal:
//   • view-based  → the contract's guaranteed COMBINED total, shown as-is.
//   • video-based → the creator's low-end average (p25) scraped reel views + 15%,
//                   rounded, shown PER VIDEO. Falls back to min_views / p50, then
//                   the campaign's admin default.
function computeExpectedViews(creator, contractData, contentBrief) {
  const fallback = numOrNull(contentBrief && contentBrief.expected_views_default);
  const offer = resolveAcceptedOffer(creator);
  const offerType = offer && typeof offer.offer_type === 'string' ? offer.offer_type : null;

  let guarantee = null;
  if (offerType === 'view_based' && Number(offer.view_guarantee) > 0) {
    guarantee = Math.round(Number(offer.view_guarantee));
  } else if (contractData && offerType !== 'video_based' && offerType !== 'video_bonus') {
    const g = Number(contractData.guaranteedViews != null ? contractData.guaranteedViews : contractData.minTotalViews);
    if (Number.isFinite(g) && g > 0) guarantee = Math.round(g);
  }
  if (guarantee != null) {
    return {
      value: guarantee,
      per: 'total',
      display: `${fmt(guarantee)} total views across your video(s)`,
      basis: 'contract',
    };
  }

  const stats = creator.ig_scraped_data && typeof creator.ig_scraped_data === 'object' ? creator.ig_scraped_data : {};
  const base = numOrNull(stats.p25) || numOrNull(stats.min_views) || numOrNull(stats.p50);
  if (base) {
    const v = roundClean(base * 1.15);
    return { value: v, per: 'video', display: `~${fmt(v)} per video`, basis: 'scraped' };
  }
  if (fallback) return { value: fallback, per: 'video', display: `~${fmt(fallback)} per video`, basis: 'default' };
  return { value: null, per: null, display: null, basis: 'none' };
}

// ── context load ────────────────────────────────────────────────────────────
async function loadBriefContext(creatorId) {
  const creator = await db.one(
    `SELECT c.*, ca.brand_name, ca.name AS campaign_name,
            ca.usage_rights_policy, ca.content_brief
       FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
      WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return null;
  const contentBrief =
    creator.content_brief && typeof creator.content_brief === 'object' ? creator.content_brief : {};
  // Latest contract carrying deal terms — signed/completed preferred.
  const contract = await db.one(
    `SELECT token, status, data FROM contracts
      WHERE creator_id = $1 AND data IS NOT NULL
      ORDER BY (status = 'completed') DESC, (status = 'signed') DESC, created_at DESC
      LIMIT 1`,
    [creatorId],
  );
  const boilerplate = await getBriefBoilerplate();
  return { creator, contentBrief, contractData: contract ? contract.data : null, boilerplate };
}

// Assemble the full structured brief object rendered by BOTH the hand-off
// preview and the public /brief/:token page.
function buildBrief(ctx, { contentDirection = '', videoLinks = [], trackedUrl = null } = {}) {
  const { creator, contentBrief: cb, contractData, boilerplate } = ctx;
  const firstName = creator.first_name || String(creator.full_name || '').split(' ')[0] || 'there';
  const handle = creator.instagram_username ? `@${creator.instagram_username}` : null;
  const websiteRaw = strOrNull(cb.website);
  // The clickable brand link: the per-creator tracked link when we have one,
  // else the raw brand website (so an un-minted brief still shows a link).
  const link = trackedUrl || ensureUrl(websiteRaw);
  const caption = cb.caption && typeof cb.caption === 'object' ? cb.caption : {};
  // Multiple demo / screen-flow links (Drive, YouTube, …) — the page embeds the
  // ones it recognises. Accepts an array or a single string for older data.
  const demoLinks = (Array.isArray(cb.demo_links) ? cb.demo_links : cb.demo_links ? [cb.demo_links] : [])
    .map((u) => ensureUrl(strOrNull(u)))
    .filter(Boolean);

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    creator: { firstName, handle, fullName: creator.full_name || null },
    brand: {
      name: creator.brand_name || 'the brand',
      website: websiteRaw,
      websiteUrl: link,
      freeAccountLink: strOrNull(cb.free_account_link),
      demoLinks,
    },
    campaignNarrative: strOrNull(cb.campaign_narrative),
    whyViral: strOrNull(cb.why_viral),
    screenFlowInstructions: strOrNull(cb.screen_flow_instructions),
    restrictions: strOrNull(cb.restrictions),
    targetAudience: strOrNull(cb.target_audience),
    expectedViews: computeExpectedViews(creator, contractData, cb),
    contentDirection: String(contentDirection || '').trim(),
    topVideos: normalizeVideoLinks(videoLinks),
    rules: boilerplate || '',
    usageRights: usageRightsText(contractData, creator.usage_rights_policy),
    posting: {
      caption: {
        mentionHandle: strOrNull(caption.mention_handle),
        commentWord: strOrNull(caption.comment_word || cb.dm_keyword),
        viaTag: strOrNull(caption.via_tag),
        hashtags: strOrNull(caption.hashtags),
        link,
      },
      dmAutomation: { keyword: strOrNull(cb.dm_keyword || caption.comment_word), link },
    },
    trackedUrl: link,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

// Flag a personalised brief as pending for a creator who just signed. Idempotent
// — no-op (and no event) when a brief is already pending or already published.
// Best-effort: callers wrap it so a hiccup never blocks signing.
async function flagBriefPending(creatorId) {
  if (creatorId == null) return { flagged: false };
  const row = await db.one(
    `UPDATE creators
        SET brief_pending = TRUE, updated_at = NOW()
      WHERE id = $1 AND brief_pending = FALSE AND brief_published_at IS NULL
      RETURNING id`,
    [creatorId],
  );
  if (row) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'brief_requested', $2)`,
      [creatorId, {}],
    );
  }
  return { flagged: !!row };
}

// Assemble a brief for preview in the hand-off. `overrides` lets the modal show
// the admin's unsaved content direction / video links live; absent overrides
// fall back to whatever is stored on the creator row.
async function assembleBrief(creatorId, overrides = {}) {
  const ctx = await loadBriefContext(creatorId);
  if (!ctx) {
    const err = new Error('creator not found');
    err.status = 404;
    throw err;
  }
  const contentDirection =
    overrides.contentDirection != null ? overrides.contentDirection : ctx.creator.brief_content_direction || '';
  const videoLinks =
    overrides.videoLinks != null ? overrides.videoLinks : ctx.creator.brief_video_links || [];
  const trackedUrl =
    (ctx.creator.brief_data && ctx.creator.brief_data.trackedUrl) || overrides.trackedUrl || null;
  const brief = buildBrief(ctx, { contentDirection, videoLinks, trackedUrl });
  return {
    ...brief,
    pending: !!ctx.creator.brief_pending,
    published: !!ctx.creator.brief_published_at,
    publishedAt: ctx.creator.brief_published_at || null,
    url: ctx.creator.brief_token ? briefUrl(ctx.creator.brief_token) : null,
  };
}

// Mint the per-creator tracked website link on the influence-stats dashboard.
// Best-effort — returns null (and the brief falls back to the raw brand link)
// when the dashboard isn't configured, there's no website, or the call fails.
async function mintTrackedLink(ctx) {
  try {
    if (!campaignDashboard.isConfigured || !campaignDashboard.isConfigured()) return null;
    const website = ensureUrl(strOrNull(ctx.contentBrief.website));
    if (!website) return null;
    const username = resolveHandle(ctx.contractData || {}, ctx.creator);
    if (!username) return null;
    const res = await campaignDashboard.mintTrackedLink({
      campaignId: ctx.creator.campaign_id,
      username,
      destinationUrl: website,
    });
    return (res && (res.trackedUrl || res.url)) || null;
  } catch (err) {
    console.error('[briefs] mintTrackedLink failed:', err.message);
    return null;
  }
}

// Publish a brief: save the curated fields, mint the tracked link, snapshot the
// assembled brief into brief_data, clear the pending flag, and return the
// shareable URL. Idempotent on the token (a re-publish keeps the same link).
async function publishBrief(creatorId, { contentDirection, videoLinks } = {}) {
  const ctx = await loadBriefContext(creatorId);
  if (!ctx) {
    const err = new Error('creator not found');
    err.status = 404;
    throw err;
  }
  const cleanDir = typeof contentDirection === 'string' ? contentDirection.trim() : '';
  const cleanLinks = normalizeVideoLinks(videoLinks);
  const trackedUrl = await mintTrackedLink(ctx);
  const token = ctx.creator.brief_token || generateToken();
  const brief = buildBrief(ctx, { contentDirection: cleanDir, videoLinks: cleanLinks, trackedUrl });

  await db.query(
    `UPDATE creators
        SET brief_content_direction = $2,
            brief_video_links = $3::jsonb,
            brief_token = $4,
            brief_data = $5::jsonb,
            brief_published_at = NOW(),
            brief_pending = FALSE,
            updated_at = NOW()
      WHERE id = $1`,
    [creatorId, cleanDir || null, JSON.stringify(cleanLinks), token, JSON.stringify(brief)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'brief_published', $2)`,
    [creatorId, { token, trackedUrl: trackedUrl || null }],
  );
  return { url: briefUrl(token), token, brief };
}

// Dismiss a pending brief without publishing (clears the flag). Mirrors
// dismiss-delegate for the reply hand-off.
async function dismissBrief(creatorId) {
  const row = await db.one(
    `UPDATE creators SET brief_pending = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [creatorId],
  );
  if (!row) {
    const err = new Error('creator not found');
    err.status = 404;
    throw err;
  }
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'brief_dismissed', $2)`,
    [creatorId, {}],
  );
  return { dismissed: true };
}

// The published brief snapshot for the public /brief/:token page.
async function getByToken(token) {
  const row = await db.one(
    `SELECT brief_token, brief_data, brief_published_at FROM creators WHERE brief_token = $1`,
    [token],
  );
  if (!row || !row.brief_data) return null;
  return { token: row.brief_token, data: row.brief_data, publishedAt: row.brief_published_at };
}

module.exports = {
  flagBriefPending,
  assembleBrief,
  publishBrief,
  dismissBrief,
  getByToken,
  briefUrl,
  // exported for tests
  computeExpectedViews,
  buildBrief,
  normalizeVideoLinks,
  roundClean,
};
