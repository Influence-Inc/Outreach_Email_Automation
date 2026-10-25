'use strict';

// Pure scouting-rule logic for automated creator sourcing.
//
// Given a candidate captured off the Instagram app (handle, follower count, bio,
// and the recent-reels window as [{views, likes?, comments?, caption?}, ...]) and
// the admin's run config, these functions decide whether the creator matches the
// campaign. The five rules from the spec map to:
//
//   Rule 1  niche/genre match      -> nicheMatch()   (AI, keyword fallback)
//   Rule 2  viral potential        -> viralPotential()   (the Scout page's rule;
//           the old minimum view floor, passesViewFloor(), only runs for a
//           config that still sets `floor` through the API)
//   Rule 3  caption-keyword search -> keywordNicheScore() feeds Rule 1 + discovery
//   Rule 4  stable growth          -> stability() + growthTrend()
//   Rule 5  risk profile           -> classifyRisk() + matchesRisk()  (not under
//           the viral rule, where breakout reels are the point)
//
// Everything here is deterministic and side-effect-free EXCEPT nicheMatch(), which
// optionally calls Claude and degrades to the deterministic keyword score when no
// ANTHROPIC_API_KEY is configured — so the whole module is unit-testable offline.

const { callClaudeMessages, parseJsonLoose } = require('./claudeClient');

const DEFAULTS = {
  reelsWindow: 12,   // how many recent reels to measure
  // Fewer than this and we can't judge the creator — but never more than the
  // run was asked to read. See requiredReels().
  minReels: 6,
  // How many of the window may sit below the floor. ZERO by design: the floor is
  // the campaign's minimum, and "minimum" that eleven of twelve reels satisfy is
  // not a minimum. A creator whose recent reels dip below the number the brand is
  // buying against does not clear it, and no amount of the rest being strong
  // changes that. Raise it per-run if a campaign genuinely wants slack.
  floorTolerance: 0,
  // The niche call belongs to the JUDGE, not to this number.
  //
  // At 0.5 this was the decision: half the model's scale was rejected outright
  // before anything else in the pipeline got a say, and a run's whole reject
  // column read "niche score 0.35 below 0.5" — the backend overruling a
  // judgement it is far less qualified to make than the model that watched the
  // reel, read the bio and was briefed on the brand.
  //
  // 0.1 turns it back into what it should have been all along: a floor under
  // the obviously-wrong, not a gate. A creator the judge scored at all is now
  // carried forward to the deterministic gate (services/creatorScore.js), where
  // fit, craft, brand fit and reach are weighed together. Raise it per-run for a
  // campaign that wants the blunt version back.
  nicheThreshold: 0.1,
  // Risk-classification knobs (tunable). See classifyRisk().
  lowCv: 0.4,        // coefficient-of-variation ceiling for a "stable" (low) creator
  mediumCv: 0.9,     // ...and for "moderate swings" (medium)
  viralMultiple: 3,  // a reel is "viral" at > viralMultiple x median when no ceiling is set
  trendBand: 0.03,   // |per-step fractional slope| within this = "flat"
  // Viral potential — see viralPotential().
  viralShare: 0.3,   // share of the reels read that must have gone viral
  minViralReels: 2,  // and never fewer than this: one hit is luck, not potential
  minViralWindow: 3, // reels with a readable count needed to judge it at all
};

const RISK_RANK = { low: 0, medium: 1, high: 2 };

// ── number helpers ─────────────────────────────────────────────────────────

// Parse an Instagram-style count into an integer: 45000, "45,000", "23.4K",
// "1.2M", "2.3k views", "1B". Returns null when nothing numeric is present.
function parseCount(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/([\d][\d.,]*)\s*([kmb])?/);
  if (!m) return null;
  const digits = m[1].replace(/,/g, '');
  const val = parseFloat(digits);
  if (!Number.isFinite(val)) return null;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  return Math.round(val * mult);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(a) {
  if (a.length < 2) return 0;
  const mu = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length);
}

// Coefficient of variation — spread relative to the average. 0 = perfectly flat.
function cv(a) {
  const mu = mean(a);
  return mu > 0 ? stdev(a) / mu : 0;
}

// Pull the numeric view counts out of a reels window. Accepts reels as objects
// ({views}) or as raw values, and parses abbreviated counts.
function reelViews(reels) {
  return (reels || [])
    .map((r) => (r && typeof r === 'object' ? parseCount(r.views) : parseCount(r)))
    .filter((v) => Number.isFinite(v));
}

// ── Rule 2: minimum view floor ──────────────────────────────────────────────

// Every reel in the window must clear the floor. `tolerance` (default 0) is how
// many reels are allowed below it, to absorb the odd OCR misread if the admin
// wants slack. No floor set => always passes.
function passesViewFloor(views, floor, tolerance = 0) {
  if (!floor || floor <= 0) return true;
  if (!views.length) return false;
  const below = views.filter((v) => v < floor).length;
  return below <= tolerance;
}

// ── Rule 2: viral potential ─────────────────────────────────────────────────

/**
 * Has this creator shown they can go viral?
 *
 * Our deals are paid on views, so what matters is not a creator's typical reel
 * but whether their reels break out. A creator who usually sits in a modest
 * range and keeps landing hits is worth more to a view deal than one who is
 * steady at a number that never moves, and a creator with only a handful of
 * reels can prove it as well as one with hundreds.
 *
 * A reel is VIRAL when its views reach `viralViews` (the Scout page's "a reel
 * counts as viral at"). The creator passes when roughly a third of the reels
 * read are viral, and never fewer than two:
 *
 *   needed = max(minViralReels, ceil(viralShare x reels read))
 *
 *   16 reels -> 5 viral    12 reels -> 4    7-10 reels -> 3    3-6 reels -> 2
 *
 * One short of that, with at least two hits, is BORDERLINE: a creator who has
 * clearly broken out more than once but not quite often enough. The caller
 * holds them for review when the campaign asks for borderline cases to be
 * reviewed, and rejects them otherwise.
 *
 * Returns { viralViews, reels, viral, needed, pass, borderline, reason }.
 */
function viralPotential(views, cfg = {}) {
  const bar = Number(cfg.viralViews);
  const n = views.length;
  const share = Number(cfg.viralShare) > 0 ? Number(cfg.viralShare) : DEFAULTS.viralShare;
  const least = Number(cfg.minViralReels) > 0 ? Math.round(Number(cfg.minViralReels)) : DEFAULTS.minViralReels;
  const viral = views.filter((v) => v >= bar).length;
  const needed = Math.max(least, Math.ceil(share * n));
  const pass = viral >= needed;
  const borderline = !pass && viral >= 2 && viral === needed - 1;
  const reason = `${viral} of ${n} reels went viral (${compactCount(bar)}+ views), needs ${needed}`;
  return {
    viralViews: bar, reels: n, viral, needed, pass, borderline, reason,
  };
}

/** 100000 -> "100K", 1500000 -> "1.5M": for reasons a scout reads. */
function compactCount(n) {
  if (n >= 1e6) return `${round3(n / 1e6)}M`;
  if (n >= 1e3) return `${round3(n / 1e3)}K`;
  return String(n);
}

/** Is the viral rule in force for this config? */
function viralMode(cfg = {}) {
  return Number(cfg.viralViews) > 0;
}

// ── Rule 4: stable growth ───────────────────────────────────────────────────

// Least-squares slope of y (given in chronological order).
function linSlope(y) {
  const n = y.length;
  if (n < 2) return 0;
  const xs = [...Array(n).keys()];
  const mx = mean(xs);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (y[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

// Consistency of the view counts as a 0–1 score (1 = perfectly steady). Uses the
// coefficient of variation so it's scale-free.
function stability(views) {
  if (views.length < 2) return 1;
  return round3(1 / (1 + cv(views)));
}

// Direction of the recent trend. `views` is newest-first (as captured off the
// profile), so we reverse to chronological before fitting. Returns up|flat|down.
function growthTrend(views, opts = {}) {
  const band = opts.trendBand ?? DEFAULTS.trendBand;
  if (views.length < 2) return 'flat';
  const chrono = [...views].reverse();
  const mu = mean(chrono);
  if (mu <= 0) return 'flat';
  const norm = linSlope(chrono) / mu; // fractional change per step
  if (norm > band) return 'up';
  if (norm < -band) return 'down';
  return 'flat';
}

// ── Rule 5: risk profile ────────────────────────────────────────────────────

// Classify the SHAPE of the recent-view distribution into the admin's vocabulary:
//   low    — tight, stable band, no breakout reels
//   medium — moderate ups and downs, still no true breakout
//   high   — 1–2 reels "go viral" while the rest sit near the baseline
// `ceiling` (the top of the admin's view range) defines "viral"; without one we
// fall back to a multiple of the median.
function classifyRisk(views, opts = {}) {
  if (!views.length) return 'high'; // can't verify => treat as risky
  const cfg = { ...DEFAULTS, ...opts };
  const med = median(views);
  const viralThreshold =
    cfg.ceiling && cfg.ceiling > 0 ? cfg.ceiling : cfg.viralMultiple * med;
  const viralCount = views.filter((v) => v > viralThreshold).length;
  if (viralCount >= 1) return 'high'; // one or two breakouts => high-variance strategy
  const spread = cv(views);
  if (spread <= cfg.lowCv) return 'low';
  if (spread <= cfg.mediumCv) return 'medium';
  return 'high'; // very swingy but no clean breakout — still risky
}

// Does a computed profile satisfy the admin's chosen risk appetite? Risk is an
// ordered tolerance: picking "high" accepts everything up to and including the
// viral-shaped creators, "medium" accepts low+medium, "low" is strict. So the
// admin raises the ceiling of acceptable variance, rather than demanding an exact
// shape (a rock-steady creator is never rejected for being "too safe").
function matchesRisk(computed, desired) {
  if (!desired) return true;
  // 'all' takes every shape — low, medium and high alike. Ordered tolerance
  // already means 'high' accepts everything below it, but saying "any shape is
  // fine" and "I will tolerate up to viral" are different intents, and only one
  // of them survives a future change to how the shapes are ranked.
  if (String(desired).toLowerCase() === 'all') return true;
  const c = RISK_RANK[computed];
  const d = RISK_RANK[desired];
  if (c == null || d == null) return true;
  return c <= d;
}

// ── Rule 1 / 3: niche match ─────────────────────────────────────────────────

// Split the niche + keyword config into a de-duped list of lowercase terms.
function normalizeKeywords(config = {}) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    String(v)
      .split(/[,\n#]+/)
      .forEach((w) => {
        const t = w.trim().toLowerCase();
        if (t) out.push(t);
      });
  };
  push(config.niche);
  (config.keywords || []).forEach(push);
  return [...new Set(out)];
}

// Deterministic niche score from bio + captions: 0 when no term appears, else
// 0.4–1.0 scaled by the fraction of terms matched. Returns null when there are no
// terms to match on (caller then leaves the niche gate unassessed).
function keywordNicheScore(candidate, config) {
  const kws = normalizeKeywords(config);
  if (!kws.length) return null;
  const hay = [candidate.bio || '', ...(candidate.reels || []).map((r) => (r && r.caption) || '')]
    .join(' \n ')
    .toLowerCase();
  if (!hay.trim()) return 0;
  const hits = kws.filter((k) => hay.includes(k)).length;
  if (hits === 0) return 0;
  return round3(Math.min(1, 0.4 + 0.6 * (hits / kws.length)));
}

// A caption has to say THIS much before its silence about our keywords means
// anything. "day 47 🔥" is a perfectly on-niche fitness caption that mentions no
// keyword at all; a full paragraph about something else is a different matter.
const OFF_NICHE_MIN_CAPTION_CHARS = 40;

/**
 * Is this reel CLEARLY about something else?
 *
 * Used on the reels FEED, where the caption is the only thing readable before a
 * clip is recorded, to skip reels that plainly have nothing to do with the
 * campaign — an ad-free feed still serves plenty of cooking to a running
 * campaign, and each one costs a 12-second recording and a multimodal call to
 * discover that.
 *
 * Deliberately timid, in the same spirit as nichePrescreen: it answers "clearly
 * not" or "no opinion", never "probably not".
 *   - no keywords configured  -> no opinion (nothing to compare against)
 *   - short or absent caption -> no opinion (silence is not evidence)
 *   - a substantial caption that mentions not one of our terms -> off-niche
 *
 * The caller must NOT mark a creator handled on the back of this. A skip here
 * costs one swipe and the creator gets another chance the next time one of
 * their reels comes round, which on a warmed feed is constantly.
 */
function looksOffNiche(caption, config = {}) {
  const terms = normalizeKeywords(config);
  if (!terms.length) return false;
  const text = String(caption || '').trim().toLowerCase();
  if (text.length < OFF_NICHE_MIN_CAPTION_CHARS) return false;
  return !terms.some((t) => text.includes(t));
}

// AI niche classifier. Sends bio + recent captions (and reel thumbnails as images
// when present) to Claude and asks for a 0–1 fit score. Returns null when Claude
// is unavailable (no key / SDK / failure), so callers fall back to keywords.
async function defaultClassify(candidate, config) {
  const captions = (candidate.reels || [])
    .map((r) => (r && r.caption ? `- ${String(r.caption).slice(0, 200)}` : null))
    .filter(Boolean)
    .slice(0, 12)
    .join('\n');
  const system =
    'You classify whether an Instagram creator fits a marketing campaign niche. ' +
    'Respond with ONLY a JSON object {"score": <0..1>, "reason": "<short>"} where ' +
    'score is how well the creator\'s content matches the target niche.';
  const textPart =
    `Target niche/genre: ${config.niche || '(unspecified)'}\n` +
    `Campaign keywords: ${(config.keywords || []).join(', ') || '(none)'}\n\n` +
    `Creator @${candidate.username || 'unknown'}\n` +
    `Bio: ${candidate.bio || '(none)'}\n` +
    `Recent reel captions:\n${captions || '(none)'}`;

  const content = [{ type: 'text', text: textPart }];
  // Vision: attach base64 reel thumbnails when the runner captured them.
  for (const t of (candidate.thumbnails || []).slice(0, 4)) {
    if (t && t.data) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: t.mediaType || 'image/jpeg', data: t.data },
      });
    }
  }

  const raw = await callClaudeMessages(system, [{ role: 'user', content }], 200);
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed.score !== 'number') return null;
  // Named, so a run's stats.judgedBy says "claude" rather than a generic "ai".
  return { score: clamp01(parsed.score), reason: parsed.reason || 'ai', source: 'claude' };
}

// Resolve a niche score for the candidate. Tries the AI classifier (injectable as
// deps.classify for tests), then the deterministic keyword score.
async function nicheMatch(candidate, config, deps = {}) {
  const classify = deps.classify || defaultClassify;
  try {
    const ai = await classify(candidate, config);
    if (ai && typeof ai.score === 'number') {
      // Rich provenance from a video/multimodal classifier (genre, audience
      // match, spoken topic, …) so the orchestrator can persist WHY it matched.
      // A classifier that reports its per-clip analysis at the top level keeps
      // it: `clip` is what the deterministic gate reads, so dropping it here
      // would silently disarm the gate rather than fail loudly.
      const evidence = ai.clip && !(ai.evidence && ai.evidence.clip)
        ? { ...(ai.evidence || {}), clip: ai.clip }
        : (ai.evidence || null);
      return {
        nicheScore: clamp01(ai.score),
        nicheReason: ai.reason || 'ai',
        source: ai.source || 'ai',
        evidence,
      };
    }
  } catch (_) {
    /* fall through to keywords */
  }
  const kw = keywordNicheScore(candidate, config);
  return {
    nicheScore: kw,
    nicheReason: kw == null ? 'niche not assessed' : 'keyword match',
    source: kw == null ? 'none' : 'keyword',
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ── Overall decision ────────────────────────────────────────────────────────

// Synchronous, pure verdict for a candidate against the run config. The caller
// should attach `candidate.nicheScore` (from nicheMatch) beforehand; if absent we
// fall back to the deterministic keyword score. Returns the full evaluation so it
// can be persisted on sourced_candidates and shown in the dashboard.
/**
 * The gates that need NO model call: reel count, the view floor, risk shape.
 *
 * These are pure arithmetic on view counts we already read off the grid, and they
 * reject the large majority of creators. Running them BEFORE the niche judgement
 * is what stops a run paying for a Gemini video analysis on a creator whose views
 * disqualified them before anyone watched anything — the analysis was the slowest
 * step in the pipeline and most of it was being spent on creators already out.
 *
 * `pass: true` means "worth judging", not "accepted".
 */
/**
 * How many reels with a readable view count a creator must have.
 *
 * `minReels`, but never more than the window the run was asked to read. The
 * navigator collects AT MOST `reelsWindow` reels, so a window of 3 (the
 * dashboard allows it) under a fixed minimum of 6 rejected every creator —
 * "only 3 reels (need 6)" — however good they were. A small window is a
 * deliberate choice to judge on fewer reels, and it is honoured as one.
 */
function requiredReels(cfg = {}) {
  // The viral rule judges a creator on however many reels they have: five reels
  // with three hits is a pass. It only needs enough to be more than one reel.
  if (viralMode(cfg)) {
    const least = Number(cfg.minViralWindow);
    return Number.isFinite(least) && least > 0 ? Math.round(least) : DEFAULTS.minViralWindow;
  }
  const min = Number(cfg.minReels);
  const floor = Number.isFinite(min) && min > 0 ? min : DEFAULTS.minReels;
  const window = Number(cfg.reelsWindow);
  return Number.isFinite(window) && window > 0 ? Math.min(floor, Math.round(window)) : floor;
}

function prefilter(candidate, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const views = reelViews(candidate.reels);
  const reelCount = views.length;
  const viewFloorPass = passesViewFloor(views, cfg.floor, cfg.floorTolerance || 0);
  const riskProfile = classifyRisk(views, cfg);
  const needed = requiredReels(cfg);
  const viral = viralMode(cfg) ? viralPotential(views, cfg) : null;

  let rejectReason = null;
  if (reelCount < needed) {
    rejectReason = `only ${reelCount} reels (need ${needed})`;
  } else if (viral && !viralPasses(viral, cfg)) {
    rejectReason = viral.reason;
  } else if (!viral && !viewFloorPass) {
    const low = views.filter((v) => v < cfg.floor).length;
    rejectReason = low === reelCount
      ? `all ${reelCount} reels below floor ${cfg.floor}`
      : `${low} of ${reelCount} reels below floor ${cfg.floor}`;
  } else if (!viral && !matchesRisk(riskProfile, cfg.risk)) {
    rejectReason = `risk ${riskProfile} exceeds appetite ${cfg.risk}`;
  }

  return {
    views, reelCount, viewFloorPass: viral ? viral.pass : viewFloorPass, riskProfile, viral,
    pass: !rejectReason,
    rejectReason,
  };
}

/**
 * Does the viral verdict let the creator carry on? A pass does; a borderline
 * one does only when the campaign holds borderline creators for review, and the
 * orchestrator then holds them rather than shortlisting.
 */
function viralPasses(viral, cfg = {}) {
  return viral.pass || (viral.borderline && cfg.reviewBorderline === true);
}

function decide(candidate, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const views = reelViews(candidate.reels);
  const viral = viralMode(cfg) ? viralPotential(views, cfg) : null;
  const evalResult = {
    views,
    reelCount: views.length,
    viral,
    viewFloorPass: viral ? viral.pass : passesViewFloor(views, cfg.floor, cfg.floorTolerance || 0),
    riskProfile: classifyRisk(views, cfg),
    stabilityScore: stability(views),
    growthTrend: growthTrend(views, cfg),
    nicheScore:
      typeof candidate.nicheScore === 'number'
        ? candidate.nicheScore
        : keywordNicheScore(candidate, cfg),
    nicheReason: candidate.nicheReason || null,
    pass: false,
    rejectReason: null,
  };

  // Gate order mirrors cost: cheap deterministic checks first.
  const needed = requiredReels(cfg);
  if (evalResult.reelCount < needed) {
    evalResult.rejectReason = `only ${evalResult.reelCount} reels (need ${needed})`;
  } else if (viral && !viralPasses(viral, cfg)) {
    evalResult.rejectReason = viral.reason;
  } else if (!viral && !evalResult.viewFloorPass) {
    const low = views.filter((v) => v < cfg.floor).length;
    evalResult.rejectReason = low === views.length
      ? `all ${views.length} reels below floor ${cfg.floor}`
      : `${low} of ${views.length} reels below floor ${cfg.floor}`;
  } else if (!viral && !matchesRisk(evalResult.riskProfile, cfg.risk)) {
    evalResult.rejectReason = `risk ${evalResult.riskProfile} exceeds appetite ${cfg.risk}`;
  } else if (
    evalResult.nicheScore != null &&
    evalResult.nicheScore < (cfg.nicheThreshold ?? DEFAULTS.nicheThreshold)
  ) {
    evalResult.rejectReason = `niche score ${evalResult.nicheScore} below ${cfg.nicheThreshold ?? DEFAULTS.nicheThreshold}`;
  } else {
    evalResult.pass = true;
  }

  return evalResult;
}

// Niche-only verdict for a single reel captured off the reel feed (discovery
// mode 'reels'). There's no multi-reel view window to apply the floor / risk /
// stability / minReels rules to, so we gate purely on the (Gemini) niche score;
// reach gets confirmed by a human in the review queue. Same shape as decide().
function decideReel(candidate, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const nicheScore =
    typeof candidate.nicheScore === 'number'
      ? candidate.nicheScore
      : keywordNicheScore(candidate, cfg);
  const threshold = cfg.nicheThreshold ?? DEFAULTS.nicheThreshold;
  const pass = nicheScore != null && nicheScore >= threshold;
  return {
    views: [],
    reelCount: 0,
    viewFloorPass: null,
    riskProfile: null,
    stabilityScore: null,
    growthTrend: null,
    nicheScore: nicheScore == null ? null : nicheScore,
    nicheReason: candidate.nicheReason || null,
    pass,
    rejectReason: pass
      ? null
      : `niche score ${nicheScore == null ? 'unassessed' : nicheScore} below ${threshold}`,
  };
}

module.exports = {
  prefilter,
  requiredReels,
  DEFAULTS,
  parseCount,
  reelViews,
  mean,
  median,
  stdev,
  cv,
  passesViewFloor,
  viralPotential,
  viralPasses,
  viralMode,
  stability,
  growthTrend,
  classifyRisk,
  matchesRisk,
  normalizeKeywords,
  keywordNicheScore,
  looksOffNiche,
  OFF_NICHE_MIN_CAPTION_CHARS,
  nicheMatch,
  defaultClassify,
  decide,
  decideReel,
  clamp01,
  round3,
};
