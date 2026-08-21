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

// The five things creatorScore weighs. Named here so a typo in a saved campaign
// config ("creativty") is dropped rather than silently becoming a sixth
// component that dilutes every real one.
const WEIGHT_KEYS = ['fit', 'nicheConsistency', 'viewSteadiness', 'creativity', 'hook', 'brandFit'];

/**
 * Per-campaign scoring weights, or undefined to use creatorScore's defaults.
 *
 * Values are taken as given rather than normalised — creatorScore divides by the
 * total, so {fit: 2, hook: 1} means exactly what it looks like, and a campaign
 * can express "hook matters twice as much as craft" without doing the arithmetic.
 */
function weightsOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const k of WEIGHT_KEYS) {
    const n = num(v[k]);
    if (n != null && n >= 0) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function buildConfig(defaults = {}, override = {}) {
  const merged = { ...(defaults || {}), ...(override || {}) };
  return {
    niche: merged.niche ? String(merged.niche).trim() : '',
    keywords: toKeywordList(merged.keywords),
    // Free-text description of who the brand wants to reach — fed to the Gemini
    // reel judge so it scores audience fit, not just topic.
    targetAudience: merged.targetAudience ? String(merged.targetAudience).trim() : '',
    // What the campaign is actually selling, in the operator's own words. The
    // judge needs this to answer "could THIS creator put THIS product in a reel
    // and have it look native" — a different question from "are they in the right
    // niche", and the one that decides whether an outreach is worth sending.
    brandProduct: merged.brandProduct ? String(merged.brandProduct).trim() : '',
    // Optional allow-list of genres the reel judge should treat as on-brand.
    genres: toKeywordList(merged.genres),
    floor: num(merged.floor),
    // How many of the recent reels may sit BELOW the floor. 0 by default: the
    // floor is the campaign's minimum, and a "minimum" that eleven of twelve
    // reels satisfy is not a minimum. Raise it only for a campaign that
    // deliberately wants slack.
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
    // A hard floor on brand fit, same shape. 0 disables it.
    minBrandFit: num(merged.minBrandFit),
    // Look at the profile screenshots before recording any video, and skip a
    // creator the pictures say is plainly in another line of work. Costs one
    // small image call; saves a recording, an upload and a video call every time
    // it fires. See services/nichePrescreen.js.
    prescreenNiche: merged.prescreenNiche === true || merged.prescreenNiche === 'true',
    // How sure the prescreen must be before it drops a creator. A skipped
    // creator is never looked at again, so this is deliberately high.
    prescreenMinConfidence: num(merged.prescreenMinConfidence),
    // What THIS brand is buying. A skincare campaign is buying production
    // quality, a meme brand is buying the hook, a B2B brand is buying audience
    // fit — one set of weights cannot serve all three, and every campaign shared
    // creatorScore's defaults because these never crossed the whitelist.
    // Unknown keys are dropped; the rest fall back to DEFAULT_WEIGHTS.
    creatorWeights: weightsOf(merged.creatorWeights),
    // How far the best reel may sit above the typical one before the creator
    // counts as carried by a single outlier. Niches differ: comedy goes viral in
    // bursts, a tutorial channel does not.
    maxViewSpike: num(merged.maxViewSpike),
  };
}

module.exports = { buildConfig, toKeywordList, weightsOf, RISKS, WEIGHT_KEYS };
