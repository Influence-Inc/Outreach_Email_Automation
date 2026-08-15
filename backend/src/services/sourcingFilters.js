'use strict';

// Pure scouting-rule logic for automated creator sourcing.
//
// Given a candidate captured off the Instagram app (handle, follower count, bio,
// and the recent-reels window as [{views, likes?, comments?, caption?}, ...]) and
// the admin's run config, these functions decide whether the creator matches the
// campaign. The five rules from the spec map to:
//
//   Rule 1  niche/genre match      -> nicheMatch()   (AI, keyword fallback)
//   Rule 2  minimum view floor     -> passesViewFloor()
//   Rule 3  caption-keyword search -> keywordNicheScore() feeds Rule 1 + discovery
//   Rule 4  stable growth          -> stability() + growthTrend()
//   Rule 5  risk profile           -> classifyRisk() + matchesRisk()
//
// Everything here is deterministic and side-effect-free EXCEPT nicheMatch(), which
// optionally calls Claude and degrades to the deterministic keyword score when no
// ANTHROPIC_API_KEY is configured — so the whole module is unit-testable offline.

const { callClaudeMessages, parseJsonLoose } = require('./claudeClient');

const DEFAULTS = {
  reelsWindow: 12,   // how many recent reels to measure
  minReels: 6,       // fewer than this and we can't judge the creator
  nicheThreshold: 0.5,
  // Risk-classification knobs (tunable). See classifyRisk().
  lowCv: 0.4,        // coefficient-of-variation ceiling for a "stable" (low) creator
  mediumCv: 0.9,     // ...and for "moderate swings" (medium)
  viralMultiple: 3,  // a reel is "viral" at > viralMultiple x median when no ceiling is set
  trendBand: 0.03,   // |per-step fractional slope| within this = "flat"
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
  return { score: clamp01(parsed.score), reason: parsed.reason || 'ai' };
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
function decide(candidate, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const views = reelViews(candidate.reels);
  const evalResult = {
    views,
    reelCount: views.length,
    viewFloorPass: passesViewFloor(views, cfg.floor, cfg.floorTolerance || 0),
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
  if (evalResult.reelCount < cfg.minReels) {
    evalResult.rejectReason = `only ${evalResult.reelCount} reels (need ${cfg.minReels})`;
  } else if (!evalResult.viewFloorPass) {
    const low = views.filter((v) => v < cfg.floor).length;
    evalResult.rejectReason = `${low} of ${views.length} reels below floor ${cfg.floor}`;
  } else if (!matchesRisk(evalResult.riskProfile, cfg.risk)) {
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
  DEFAULTS,
  parseCount,
  reelViews,
  mean,
  median,
  stdev,
  cv,
  passesViewFloor,
  stability,
  growthTrend,
  classifyRisk,
  matchesRisk,
  normalizeKeywords,
  keywordNicheScore,
  nicheMatch,
  defaultClassify,
  decide,
  decideReel,
  clamp01,
  round3,
};
