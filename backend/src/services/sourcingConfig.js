'use strict';

// Merge a campaign's saved scouting defaults with per-run overrides into the
// frozen config the scouting rules (services/sourcingFilters.js) consume. Coerces
// numbers, splits comma/newline keyword strings, defaults risk to 'medium' and
// the reels window to 12.

// 'all' takes every shape rather than raising a tolerance ceiling — see
// sourcingFilters.matchesRisk.
const RISKS = ['low', 'medium', 'high', 'all'];

function toKeywordList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(v) {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildConfig(defaults = {}, override = {}) {
  const merged = { ...(defaults || {}), ...(override || {}) };
  return {
    niche: merged.niche ? String(merged.niche).trim() : '',
    keywords: toKeywordList(merged.keywords),
    // Free-text description of who the brand wants to reach — fed to the Gemini
    // reel judge so it scores audience fit, not just topic.
    targetAudience: merged.targetAudience ? String(merged.targetAudience).trim() : '',
    // Optional allow-list of genres the reel judge should treat as on-brand.
    genres: toKeywordList(merged.genres),
    floor: num(merged.floor),
    // How many of the recent reels may sit BELOW the floor. Real creators have
    // quiet posts, and demanding that all twelve clear the floor rejects good
    // creators for a couple of off days — a stricter test than "min views"
    // sounds like.
    floorTolerance: num(merged.floorTolerance),
    ceiling: num(merged.ceiling),
    risk: RISKS.includes(merged.risk) ? merged.risk : 'medium',
    targetCount: num(merged.targetCount) || 0,
    reelsWindow: num(merged.reelsWindow) || 12,
    nicheThreshold: num(merged.nicheThreshold),
    // Route borderline passers (niche score just over the threshold) to a human
    // review queue instead of auto-adding. reviewBand = how far above threshold
    // still counts as "borderline".
    reviewBorderline: merged.reviewBorderline === true || merged.reviewBorderline === 'true',
    reviewBand: num(merged.reviewBand),
    // 'reels' = explore/scroll reel-feed flow (watch+hear); else search→profile.
    discovery: merged.discovery === 'reels' ? 'reels' : '',
    clipSeconds: num(merged.clipSeconds),
    // How many of the creator's reels to actually WATCH (record + judge). This
    // config is a whitelist, so a knob missing here is silently dropped no matter
    // what the dashboard sends — which is exactly what happened to these three.
    clipsPerProfile: num(merged.clipsPerProfile),
    // Ceiling on profiles opened per run, independent of targetCount.
    maxProfiles: num(merged.maxProfiles),
    // How long an unchanging screen counts as stuck rather than slow.
    stallMs: num(merged.stallMs),
    // The deterministic gate's bar (services/creatorScore.js). Raising this is
    // the single most direct quality dial: at 0.6 a creator with strong fit but
    // mediocre craft still clears, because creativity and hook are only a
    // quarter of the weighting between them.
    creatorPassThreshold: num(merged.creatorPassThreshold),
    // A hard floor on craft, checked outside the weighted blend. 0 disables it.
    minCreativity: num(merged.minCreativity),
  };
}

module.exports = { buildConfig, toKeywordList, RISKS };
