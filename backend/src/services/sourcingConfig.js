'use strict';

// Merge a campaign's saved scouting defaults with per-run overrides into the
// frozen config the scouting rules (services/sourcingFilters.js) consume. Coerces
// numbers, splits comma/newline keyword strings, and fills in the defaults the
// Scout page no longer asks a scout for: 16 reels read, the viral bar, no
// profile cap, and the four safety/quality switches on.

function toKeywordList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// What a reel needs to count as viral when the campaign has not said. Deals are
// priced on views, and 100K is where a reel has clearly left its creator's own
// followers behind for most of the creators we scout.
const DEFAULT_VIRAL_VIEWS = 100000;

// How many of a creator's newest reels are read to judge whether they go viral.
const REELS_WINDOW = 16;

/** On unless explicitly switched off — for the switches every run needs. */
const onUnlessOff = (v) => v !== false && v !== 'false';

/** Keywords, with the old separate niche field folded in: they did the same job. */
function keywordsOf(merged) {
  const seen = new Set();
  return [...toKeywordList(merged.keywords), ...toKeywordList(merged.niche)].filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What the brand sells, with the old separate brand-details field folded in. */
function brandProductOf(merged) {
  const parts = [merged.brandProduct, merged.brandBrief]
    .map((v) => (v ? String(v).trim() : ''))
    .filter(Boolean);
  return [...new Set(parts)].join('\n\n');
}

function num(v) {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Split on NEWLINES only — one entry per line.
 *
 * Keywords split on commas as well, which is right for a keyword list and wrong
 * for anything written as a sentence: "films their own training, no studio
 * lighting" is one description of a creator, and comma-splitting turns it into
 * two fragments that each read as a separate demand.
 */
function toLineList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

// How long the judge actually gets to watch.
//
// The reel is the strongest single signal about what a creator makes, and 12
// seconds at 1 fps is twelve frames plus the audio — enough to see the subject,
// hear the delivery, and read the room. Shorter than this and the judge is
// guessing from a thumbnail with a soundtrack, which is the failure it exists to
// avoid, so a too-small configured value is raised rather than honoured.
const MIN_CLIP_SECONDS = 12;
const MAX_CLIP_SECONDS = 60; // the recorder's own ceiling
const DEFAULT_CLIP_SECONDS = 12;

function clipSecondsOf(v) {
  const n = num(v);
  if (n == null) return DEFAULT_CLIP_SECONDS;
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.round(n)));
}

function buildConfig(defaults = {}, override = {}) {
  const merged = { ...(defaults || {}), ...(override || {}) };
  return {
    // One field on the Scout page now. A campaign saved with a separate niche
    // has it searched and judged as one more keyword.
    niche: '',
    keywords: keywordsOf(merged),
    // Free-text description of who the brand wants to reach — fed to the Gemini
    // reel judge so it scores audience fit, not just topic.
    targetAudience: merged.targetAudience ? String(merged.targetAudience).trim() : '',
    // What the campaign is actually selling, in the operator's own words. The
    // judge needs this to answer "could THIS creator put THIS product in a reel
    // and have it look native" — a different question from "are they in the right
    // niche", and the one that decides whether an outreach is worth sending.
    //
    // One field on the Scout page, "What you're selling": the product and
    // whatever a one-liner cannot say — positioning, price, who it is for.
    brandProduct: brandProductOf(merged),
    // Who the brand IS. "A carbon-plate racing shoe" and "a £280 carbon-plate
    // racing shoe from a niche running label" call for different creators, and
    // only the second says which.
    brandName: merged.brandName ? String(merged.brandName).trim() : '',
    // Optional allow-list of genres the reel judge should treat as on-brand.
    genres: toKeywordList(merged.genres),
    // How sure Jev must be to shortlist and to reject are not set here: the
    // session learns them from the review queue (services/jevCalibration.js).
    //
    // Reach is judged on VIRAL POTENTIAL (sourcingFilters.viralPotential): how
    // many of the newest reels reached this many views. It replaces the old
    // minimum-view floor, its tolerance, the view ceiling and the risk shape,
    // which are no longer read.
    viralViews: num(merged.viralViews) || DEFAULT_VIRAL_VIEWS,
    targetCount: num(merged.targetCount) || 0,
    reelsWindow: num(merged.reelsWindow) || REELS_WINDOW,
    nicheThreshold: num(merged.nicheThreshold),
    // Route borderline passers to a human review queue instead of auto-adding.
    // Borderline means close to EITHER threshold that can reject: the quality
    // bar (creatorPassThreshold) within reviewScoreBand (default 0.05), or the
    // niche floor (nicheThreshold) within reviewBand (default 0.15).
    // On unless a campaign turns it off; it also holds creators one viral reel
    // short of the rule, instead of rejecting them.
    reviewBorderline: onUnlessOff(merged.reviewBorderline),
    reviewBand: num(merged.reviewBand),
    reviewScoreBand: num(merged.reviewScoreBand),
    // Hold a creator no model could analyse (no Gemini, no Claude, or every
    // call failed) for review rather than adding them on the reach and keyword
    // rules alone. On unless a campaign explicitly turns it off.
    reviewUnjudged: merged.reviewUnjudged !== false && merged.reviewUnjudged !== 'false',
    // 'reels' = explore/scroll reel-feed flow (watch+hear); else search→profile.
    discovery: merged.discovery === 'reels' ? 'reels' : '',
    clipSeconds: clipSecondsOf(merged.clipSeconds),
    // How many of the creator's reels to actually WATCH (record + judge). This
    // config is a whitelist, so a knob missing here is silently dropped no matter
    // what the dashboard sends — which is exactly what happened to these three.
    clipsPerProfile: num(merged.clipsPerProfile),
    // No ceiling on profiles opened: a run keeps going until it has sourced
    // targetCount creators (or its keywords run out of results). 0 = no cap.
    maxProfiles: 0,
    // How long an unchanging screen counts as stuck rather than slow.
    stallMs: num(merged.stallMs),
    // The deterministic gate's bar (services/creatorScore.js, default 0.52) —
    // the single most direct quality dial. At the default a creator judged
    // "competent" across the board is shortlisted; raise it toward 0.72 and
    // only creators judged "distinctive" on most components clear.
    creatorPassThreshold: num(merged.creatorPassThreshold),
    // A hard floor on craft, checked outside the weighted blend. 0 disables it.
    minCreativity: num(merged.minCreativity),
    // A hard floor on brand fit, same shape. 0 disables it.
    minBrandFit: num(merged.minBrandFit),
    // (likes + comments) / followers. Catches bought reach and repost farms,
    // which reach alone cannot distinguish from a real audience. 0 disables it.
    minEngagementRate: num(merged.minEngagementRate),
    // (likes + comments) / VIEWS — the bought-views check, and a different
    // question from the ratio above. A creator with a small real following and a
    // large purchased view count passes the follower ratio comfortably and fails
    // this one, which is the number a campaign is actually paying for.
    // 0 disables it. See creatorScore.DEFAULT_MIN_VIEW_ENGAGEMENT.
    minViewEngagementRate: num(merged.minViewEngagementRate),
    // Free-text taste, stated up front rather than learned from decisions that
    // do not exist yet on a new campaign. See nicheCalibration.statedTaste.
    // One per line, NOT comma-split: these are handles, links and sentences
    // describing the creators this brand wants, and a sentence may well contain
    // a comma. Fed to the judge before it sees any candidate — see
    // nicheCalibration.statedTaste.
    idealExamples: toLineList(merged.idealExamples),
    avoidExamples: toLineList(merged.avoidExamples),
    // Look at the profile screenshots before recording any video, and skip a
    // creator the pictures say is plainly in another line of work. Costs one
    // small image call; saves a recording, an upload and a video call every time
    // it fires. See services/nichePrescreen.js.
    prescreenNiche: onUnlessOff(merged.prescreenNiche),
    // Feed mode: skip a reel whose caption plainly has nothing to do with the
    // campaign, before a clip is recorded for it. On unless explicitly turned
    // off — the test is deliberately timid (a short caption is never evidence)
    // and a skipped creator is NOT marked handled, so a warmed feed brings them
    // back round. See sourcingFilters.looksOffNiche.
    skipOffNicheReels: onUnlessOff(merged.skipOffNicheReels),
    // Feed mode: like the clearly on-brand reels as we go, to steer this
    // account's Reels ranking toward the niche we are sourcing for. On unless a
    // campaign turns it off. Every safety rail (min score, per-reel
    // probability, per-session caps, stopping on "action blocked") is
    // env-tuned, not set from here.
    warmFeed: onUnlessOff(merged.warmFeed),
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

module.exports = {
  buildConfig, toKeywordList, toLineList, weightsOf, clipSecondsOf,
  WEIGHT_KEYS, MIN_CLIP_SECONDS, DEFAULT_CLIP_SECONDS, DEFAULT_VIRAL_VIEWS, REELS_WINDOW,
};
