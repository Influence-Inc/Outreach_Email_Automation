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

// Merge already-normalised video-link lists, keeping order (common campaign
// links first, per-creator links after), dropping duplicates by URL, capped at
// 12 — the same ceiling normalizeVideoLinks enforces.
function mergeVideoLinks(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= 12) return out;
    }
  }
  return out;
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
//   • view-based  → the contract's guaranteed COMBINED total. This is a
//                   commitment, so it reads "Minimum views target — N views"
//                   with NO "No pressure :)" reassurance.
//   • video-based → the creator's low-end average (p25) scraped reel views + 15%,
//                   rounded, shown PER VIDEO. Falls back to min_views / p50, then
//                   the campaign's admin default. This is only an estimate, so it
//                   keeps the friendly "Expected views … No pressure :)" framing.
// `label` names the line and `noPressure` tells the brief page whether to show
// the "No pressure :)" sub-note (video-based only).
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
      label: 'Minimum views target',
      display: `${fmt(guarantee)} views`,
      noPressure: false,
      basis: 'contract',
    };
  }

  const stats = creator.ig_scraped_data && typeof creator.ig_scraped_data === 'object' ? creator.ig_scraped_data : {};
  const base = numOrNull(stats.p25) || numOrNull(stats.min_views) || numOrNull(stats.p50);
  if (base) {
    const v = roundClean(base * 1.15);
    return { value: v, per: 'video', label: 'Expected views', display: `~${fmt(v)} per video`, noPressure: true, basis: 'scraped' };
  }
  if (fallback) return { value: fallback, per: 'video', label: 'Expected views', display: `~${fmt(fallback)} per video`, noPressure: true, basis: 'default' };
  return { value: null, per: null, label: null, display: null, noPressure: false, basis: 'none' };
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
function buildBrief(
  ctx,
  { contentDirection = '', videoLinks = [], trackedUrl = null, reviewUrl = null, postShareUrl = null } = {},
) {
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
  // Top-performing / example videos are common to the whole campaign
  // (content_brief.example_videos). Any per-creator links passed in the hand-off
  // are appended after them; duplicates by URL are dropped and the list capped.
  const topVideos = mergeVideoLinks(
    normalizeVideoLinks(cb.example_videos),
    normalizeVideoLinks(videoLinks),
  );

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
    screenFlowInstructions: strOrNull(cb.screen_flow_instructions),
    restrictions: strOrNull(cb.restrictions),
    expectedViews: computeExpectedViews(creator, contractData, cb),
    contentDirection: String(contentDirection || '').trim(),
    topVideos,
    rules: boilerplate || '',
    usageRights: usageRightsText(contractData, creator.usage_rights_policy),
    // Per-creator submission pages minted on the campaign dashboard
    // (campaigns.influence.technology): upload the finished video for review,
    // and share the live post link(s) after posting.
    reviewUrl: strOrNull(reviewUrl),
    postShareUrl: strOrNull(postShareUrl),
    posting: {
      caption: {
        mentionHandle: strOrNull(caption.mention_handle),
        commentWord: strOrNull(caption.comment_word || cb.dm_keyword),
        viaTag: strOrNull(caption.via_tag),
        hashtags: strOrNull(caption.hashtags),
        link,
      },
      dmAutomation: { keyword: strOrNull(cb.dm_keyword || caption.comment_word), link },
      // The tracked link is what goes in the creator's bio for this campaign.
      linkInBio: link,
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
  const prior = ctx.creator.brief_data && typeof ctx.creator.brief_data === 'object' ? ctx.creator.brief_data : {};
  const trackedUrl = prior.trackedUrl || overrides.trackedUrl || null;
  // Preview reuses the submission links from a prior publish; a first-time
  // hand-off simply shows those sections empty until publish mints them.
  const reviewUrl = prior.reviewUrl || overrides.reviewUrl || null;
  const postShareUrl = prior.postShareUrl || overrides.postShareUrl || null;
  const brief = buildBrief(ctx, { contentDirection, videoLinks, trackedUrl, reviewUrl, postShareUrl });
  return {
    ...brief,
    pending: !!ctx.creator.brief_pending,
    published: !!ctx.creator.brief_published_at,
    publishedAt: ctx.creator.brief_published_at || null,
    url: ctx.creator.brief_token ? briefUrl(ctx.creator.brief_token) : null,
  };
}

// Mint the per-creator dashboard links on influence-stats: the tracked website
// link plus the creator's unique review + post-share submission pages. Returns
// { trackedUrl, reviewUrl, postShareUrl } — each null when unavailable, so the
// brief falls back gracefully (the tracked link to the raw brand website; the
// submission links simply omit their sections). Best-effort: any failure yields
// all-null rather than blocking publish.
async function mintDashboardLinks(ctx) {
  const empty = { trackedUrl: null, reviewUrl: null, postShareUrl: null };
  try {
    if (!campaignDashboard.isConfigured || !campaignDashboard.isConfigured()) return empty;
    const website = ensureUrl(strOrNull(ctx.contentBrief.website));
    if (!website) return empty;
    const username = resolveHandle(ctx.contractData || {}, ctx.creator);
    if (!username) return empty;
    const res = await campaignDashboard.mintTrackedLink({
      campaignId: ctx.creator.campaign_id,
      username,
      destinationUrl: website,
    });
    return {
      trackedUrl: (res && (res.trackedUrl || res.url)) || null,
      reviewUrl: (res && res.submitForReviewUrl) || null,
      postShareUrl: (res && res.submitPostsUrl) || null,
    };
  } catch (err) {
    console.error('[briefs] mintDashboardLinks failed:', err.message);
    return empty;
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
  // Captured BEFORE the update below — tells the caller whether this is the
  // creator's first publish (deliver the "your brief is ready" notification)
  // or a re-publish after an edit (stay silent; they already have the link).
  const alreadyPublished = !!ctx.creator.brief_published_at;
  const cleanDir = typeof contentDirection === 'string' ? contentDirection.trim() : '';
  const cleanLinks = normalizeVideoLinks(videoLinks);
  const { trackedUrl, reviewUrl, postShareUrl } = await mintDashboardLinks(ctx);
  const token = ctx.creator.brief_token || generateToken();
  const brief = buildBrief(ctx, {
    contentDirection: cleanDir,
    videoLinks: cleanLinks,
    trackedUrl,
    reviewUrl,
    postShareUrl,
  });

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
  return { url: briefUrl(token), token, brief, alreadyPublished };
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

// Hang a { url, publishedAt } summary on each creator row once their brief is
// published (mirrors attachContracts / attachOffers) so the admin dashboard can
// show a "View brief" link. No query needed — brief_token / brief_published_at
// are already on the row (SELECT *); unpublished/never-briefed rows get null.
async function attachBriefs(rows) {
  for (const r of rows || []) {
    r.brief =
      r.brief_token && r.brief_published_at
        ? { token: r.brief_token, url: briefUrl(r.brief_token), publishedAt: r.brief_published_at }
        : null;
  }
  return rows;
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
  attachBriefs,
  briefUrl,
  // exported for tests
  computeExpectedViews,
  buildBrief,
  normalizeVideoLinks,
  roundClean,
};
