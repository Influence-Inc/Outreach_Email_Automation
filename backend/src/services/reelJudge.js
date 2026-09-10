'use strict';

// Reel judge — turns a captured reel clip (video + audio) into a niche verdict
// using the Gemini multimodal model, and composes with the existing classifiers.
//
// It's the AI classifier the sourcing orchestrator injects as `nicheClassify`.
// The composite order is:
//   1. Gemini video (watch + hear)  — when a clip is present AND a key is set
//   2. Claude on thumbnails/captions (sourcingFilters.defaultClassify)
//   3. keyword scoring                — nicheMatch's built-in final fallback
//
// So the pipeline gets the richest available signal and always degrades cleanly.
// The Gemini verdict (genre / audience_match / language / spoken topic / reason)
// is returned as `evidence` so the orchestrator can persist WHY a creator matched.

const geminiClientDefault = require('./geminiClient');
const { statedTaste } = require('./nicheCalibration');
const { defaultClassify, clamp01, round3 } = require('./sourcingFilters');
const { reelStats } = require('./creatorScore');

// ── the two analysis shapes ─────────────────────────────────────────────────
//
// Both must come back as strict JSON — no prose, no markdown fences. The
// existing niche fields (score / genre / audienceMatch / language / spokenTopic
// / reason) keep their names, because the orchestrator and the review UI already
// read them; the richer per-clip fields are added alongside rather than
// replacing anything.

const CLIP_SCHEMA = [
  '{',
  '  "niche": "",',
  '  "sub_niche": "",',
  '  "content_format": "talking_head | vlog | skit | tutorial | review | ugc_ad | compilation | other",',
  '  "production_quality": 0,',
  '  "creativity": 0,',
  '  "hook_strength": 0,',
  '  "brand_safety": "safe | caution | unsafe",',
  '  "is_original_creator": true,',
  '  "spoken_language": "",',
  '  "on_screen_products": [],',
  '  "ugc_ad_fit": 0,',
  '  "brand_fit": 0,',
  '  "brand_fit_reason": "",',
  '  "niche_score": 0.0,',
  '  "reasoning": ""',
  '}',
].join('\n');

const CREATOR_SCHEMA = [
  '{',
  '  "primary_niche": "",',
  '  "consistency_of_niche": 0,',
  '  "audience_guess": "",',
  '  "fit_score": 0,',
  '  "reject_reason": null,',
  '  "recommended_campaign_types": []',
  '}',
].join('\n');

const CONTENT_FORMATS = new Set([
  'talking_head', 'vlog', 'skit', 'tutorial', 'review', 'ugc_ad', 'compilation', 'other',
]);
const BRAND_SAFETY = new Set(['safe', 'caution', 'unsafe']);

// Anchored levels for the craft fields, in place of a free 0-10 integer.
//
// LLM judges are well documented to be poorly calibrated on open numeric
// scales — high run-to-run variance and central-tendency compression, scores
// clustering near the scale's midpoint. A small set of NAMED levels turns the
// task into classification, which the same model does reliably, the same way
// anchored examples stabilise a human rater. Combined with PROFILE_RESPONSE_SCHEMA
// below, this is enforced at the API's decoding layer, not just suggested by
// the prompt text.
const CRAFT_LEVELS = ['derivative', 'competent', 'distinctive', 'exceptional'];

// Spread across the useful range rather than packed around the middle, so the
// four levels stay distinguishable after creatorScore.js normalises them.
const CRAFT_LEVEL_VALUE = {
  derivative: 2, competent: 5, distinctive: 8, exceptional: 10,
};

function scale10(v) {
  // Explicit null (a schema-nullable field the model was never asked about, per
  // PROFILE_RESPONSE_SCHEMA's brand_fit) means "unmeasured", same as the field
  // being absent — Number(null) is 0, which is finite, so without this check an
  // unasked question would silently score as the worst possible answer.
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(1, Math.round(n)));
}

// Accepts either an anchored level name (the schema-constrained profile prompt)
// or a raw number (the legacy per-clip prompt, which still asks for 0-10), so
// one parser serves both without either path noticing the other exists.
function scaleLevel(v) {
  if (typeof v === 'string') {
    const level = v.trim().toLowerCase();
    if (CRAFT_LEVEL_VALUE[level] != null) return CRAFT_LEVEL_VALUE[level];
  }
  return scale10(v);
}

/**
 * The LEVEL as a word, for reporting rather than scoring.
 *
 * Nothing is rejected for low craft any more (see creatorScore.js), so a plainly
 * shot creator reaches the shortlist — and the only thing that makes that useful
 * rather than confusing is being able to see, at a glance, that the pipeline
 * knows they are plainly shot. "derivative" says that; a 2 next to a 0.31 does
 * not.
 *
 * Prefers the model's own word. Falls back to the nearest level when a numeric
 * score came back instead, which is what the legacy per-clip prompt still asks
 * for, so both paths report a level either way.
 */
function levelName(v) {
  if (typeof v === 'string') {
    const level = v.trim().toLowerCase();
    if (CRAFT_LEVEL_VALUE[level] != null) return level;
  }
  const n = scale10(v);
  if (n == null) return null;
  return CRAFT_LEVELS.reduce((best, name) => (
    Math.abs(CRAFT_LEVEL_VALUE[name] - n) < Math.abs(CRAFT_LEVEL_VALUE[best] - n) ? name : best
  ), CRAFT_LEVELS[0]);
}

// The Gemini-side twin of the schema literal in buildProfilePrompt: every field
// that literal promises, typed so the model's JSON is validated at generation
// time instead of merely requested in prose. `brand_fit` / `brand_fit_reason`
// are deliberately NOT in `required` — the prompt only asks that question when
// the campaign configured a brandProduct, and creatorScore.js reads a missing
// brand_fit as "not judged", never as a fit of zero; requiring it here would
// force a guess on every campaign that never asked the question.
const PROFILE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    // Asked for FIRST so the model states what the reel IS before scoring it,
    // and kept on the verdict so a reviewer can see what the judgement was
    // actually looking at rather than only the number it produced.
    video_description: { type: 'string' },
    niche_score: { type: 'number' },
    audience_match: { type: 'number' },
    genre: { type: 'string' },
    language: { type: 'string' },
    spoken_topic: { type: 'string' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    niche: { type: 'string' },
    sub_niche: { type: 'string' },
    content_format: { type: 'string', enum: [...CONTENT_FORMATS] },
    production_quality: { type: 'string', enum: CRAFT_LEVELS },
    creativity: { type: 'string', enum: CRAFT_LEVELS },
    hook_strength: { type: 'string', enum: CRAFT_LEVELS },
    brand_safety: { type: 'string', enum: [...BRAND_SAFETY] },
    is_original_creator: { type: 'boolean' },
    spoken_language: { type: 'string' },
    on_screen_products: { type: 'array', items: { type: 'string' } },
    ugc_ad_fit: { type: 'number' },
    brand_fit: { type: 'string', enum: CRAFT_LEVELS, nullable: true },
    brand_fit_reason: { type: 'string', nullable: true },
    reasoning: { type: 'string' },
    primary_niche: { type: 'string' },
    consistency_of_niche: { type: 'string', enum: CRAFT_LEVELS },
    audience_guess: { type: 'string' },
    fit_score: { type: 'number' },
    reject_reason: { type: 'string', nullable: true },
    recommended_campaign_types: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'video_description', 'niche_score', 'genre', 'reason', 'niche', 'content_format',
    'production_quality', 'creativity', 'hook_strength', 'brand_safety',
    'consistency_of_niche', 'fit_score',
  ],
};

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * Coerce a per-clip reply into the documented shape.
 *
 * A model that drifts — a score out of range, an unlisted content_format, a
 * string where a boolean belongs — yields a normalised value rather than
 * poisoning the deterministic scorer downstream, which trusts these numbers.
 */
function parseClipAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const format = str(raw.content_format).toLowerCase().replace(/\s+/g, '_');
  const safety = str(raw.brand_safety).toLowerCase();
  return {
    niche: str(raw.niche),
    sub_niche: str(raw.sub_niche),
    content_format: CONTENT_FORMATS.has(format) ? format : 'other',
    production_quality: scaleLevel(raw.production_quality),
    creativity: scaleLevel(raw.creativity),
    // The same judgement as a word, carried alongside the number it scores as.
    // Nothing is rejected for low craft, so this is what makes a plainly-shot
    // creator legible on the shortlist instead of just a low number.
    creativity_level: levelName(raw.creativity),
    hook_strength: scaleLevel(raw.hook_strength),
    brand_safety: BRAND_SAFETY.has(safety) ? safety : 'caution',
    // Only a real boolean counts. Absent means "not judged", which the scorer
    // treats as no vote either way rather than as a repost.
    is_original_creator: typeof raw.is_original_creator === 'boolean' ? raw.is_original_creator : null,
    spoken_language: str(raw.spoken_language),
    on_screen_products: Array.isArray(raw.on_screen_products)
      ? raw.on_screen_products.map(str).filter(Boolean)
      : [],
    ugc_ad_fit: scale10(raw.ugc_ad_fit),
    // Null when the model was never asked (no brandProduct configured) — the
    // scorer treats that as "not judged", never as a fit of zero.
    brand_fit: scaleLevel(raw.brand_fit),
    brand_fit_reason: str(raw.brand_fit_reason),
    reasoning: str(raw.reasoning),
  };
}

/** Coerce a per-creator reply into the documented shape. */
function parseCreatorAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fit = Number(raw.fit_score);
  return {
    primary_niche: str(raw.primary_niche),
    consistency_of_niche: scaleLevel(raw.consistency_of_niche),
    audience_guess: str(raw.audience_guess),
    fit_score: Number.isFinite(fit) ? Math.min(100, Math.max(0, Math.round(fit))) : null,
    // Null unless the creator should actually be dropped — an empty string from
    // a chatty model is not a rejection.
    reject_reason: str(raw.reject_reason) || null,
    recommended_campaign_types: Array.isArray(raw.recommended_campaign_types)
      ? raw.recommended_campaign_types.map(str).filter(Boolean)
      : [],
  };
}

/**
 * The brand, as a brief — everything about WHO is buying, before anything about
 * who might sell for them.
 *
 * Order is the point. Asked "does this creator fit?" with the brand described
 * afterwards, a model reasons from the creator outwards and finds a way to make
 * almost anyone fit. Given the brand first, it has something concrete to measure
 * against, and "no" becomes an available answer.
 *
 * Returns '' when the campaign said nothing about itself, so a campaign that
 * never filled this in is not handed a block of "(unspecified)" to reason from.
 */
function brandBrief(config = {}) {
  const lines = [];
  if (config.brandName) lines.push(`Brand: ${config.brandName}`);
  if (config.brandProduct) lines.push(`What they sell: ${config.brandProduct}`);
  if (config.brandBrief) lines.push('About the brand and product:', config.brandBrief);
  if (config.targetAudience) lines.push(`Who they want to reach: ${config.targetAudience}`);
  if (!lines.length) return '';
  return ['── THE BRAND ─────────────────────────────', ...lines, ''].join('\n');
}

/** Is there enough brand context to ask the brand-fit question at all? */
function hasBrandContext(config = {}) {
  return !!(config.brandProduct || config.brandBrief || config.brandName);
}

/**
 * The profile prompt: what the creator's bio and grid LOOK like, what their
 * captions say, their reach, and one reel — the one our keyword actually
 * surfaced — watched and heard in full.
 *
 * This is one call where the older path spent four (three reels plus a
 * creator-level pass), and it judges the thing we actually care about: not "was
 * this one reel on-brand" but "is this creator, as a whole, on-brand". The media
 * is described in the order geminiClient appends it — video first, then each
 * screenshot — so the model knows which picture is which.
 */
function buildProfilePrompt(candidate = {}, config = {}, shots = []) {
  const captions = (candidate.reels || [])
    .map((r) => (r && r.caption ? String(r.caption).slice(0, 200) : null))
    .filter(Boolean)
    .slice(0, 12);
  const stats = reelStats(candidate.reels || []);
  const clip = candidate.clip || {};
  const media = [];
  if (clip.dataBase64) {
    media.push(
      `1. A REEL VIDEO (with audio)${candidate.sourceTerm ? ` — this is the reel that came back for the search "${candidate.sourceTerm}"` : ''}`
      + `${clip.caption ? `, captioned: "${String(clip.caption).slice(0, 200)}"` : ''}.`,
    );
  }
  shots.forEach((s) => {
    media.push(s.kind === 'reels_grid'
      ? `${media.length + 1}. A SCREENSHOT of their reels grid — the thumbnails and view counts of their recent reels.`
      : `${media.length + 1}. A SCREENSHOT of their profile header and bio.`);
  });

  return [
    'You are judging an Instagram CREATOR for a brand campaign.',
    '',
    'You are given, in this order:',
    ...(media.length ? media : ['(no media — judge from the text below alone)']),
    '',
    'FIRST, watch the video the whole way through and describe it: what happens',
    'on screen, what is being said, the setting, and anything held or worn that a',
    'brand could sit alongside. Put that in video_description BEFORE you score',
    'anything. Describing it first is not busywork — a judgement made without',
    'having said what the reel actually IS tends to fall back on the caption and',
    'the handle, which is the mistake this whole pipeline exists to avoid.',
    '',
    'THEN judge the CREATOR, not just this one reel: use the grid screenshot to',
    'see whether the reel is typical of them or an outlier, and the bio screenshot',
    'to see how they present themselves. Weigh the video, the bio and the captions',
    'TOGETHER against the brand and the target niche below — spoken topic,',
    'language and music matter as much as the visuals.',
    '',
    `Target niche/genre: ${config.niche || '(unspecified)'}`,
    `Campaign keywords: ${(config.keywords || []).join(', ') || '(none)'}`,
    `Allowed genres: ${(config.genres || []).join(', ') || '(any)'}`,
    '',
    brandBrief(config),
    // The question that actually decides whether an outreach is worth sending.
    // "Are they in the right niche" and "could they hold this product in a reel
    // without it looking bought" are different questions, and only the second
    // predicts whether a collaboration works. Asked only when the campaign said
    // what it sells — there is nothing to judge fit against otherwise.
    ...(hasBrandContext(config) ? [
      'BRAND FIT — judge this specifically: could THIS creator feature the product',
      'above in one of their own reels and have it look native rather than a paid',
      'read? Consider what they already make, who watches them, and whether the',
      'product belongs in that world. A creator in the right niche who could not',
      'plausibly hold this product scores LOW. Put the score in brand_fit (0-10)',
      'and one line of why in brand_fit_reason.',
      '',
    ] : []),
    `Creator @${candidate.username || 'unknown'}`,
    `Followers: ${candidate.followers ?? '(unknown)'}`,
    `Bio text: ${candidate.bio || '(none)'}`,
    `Reach across ${stats.count || 0} recent reels — lowest ${stats.min ?? '?'}, `
      + `typical ${stats.typical ?? '?'}, highest ${stats.max ?? '?'}.`,
    captions.length ? `Recent reel captions:\n- ${captions.join('\n- ')}` : 'Recent reel captions: (none)',
    // The brand's own past approve/reject calls, as few-shot examples. This is
    // the call that produces fit_score, so it is where taste has to land — see
    // services/nicheCalibration.js.
    (config.calibration && config.calibration.text) || '',
    // Taste the brand stated up front. Matters most on a new campaign, which has
    // no approve/reject history to learn from yet — see nicheCalibration.statedTaste.
    statedTaste(config),
    '',
    // Nothing is rejected for low craft (see creatorScore.js), so the model has
    // no reason to soften this one — and every reason not to. A "competent" put
    // on genuinely derivative work is the reading that makes the shortlist
    // useless, because it is indistinguishable from real competence.
    'creativity is a DESCRIPTION, not a bar to clear. A plainly-shot creator is',
    'still a usable one and is not dropped for it, so say "derivative" when the',
    'work is derivative — grading it kindly only hides what it is.',
    '',
    'Respond with ONLY a JSON object of exactly this shape, no prose and no',
    'markdown fences. production_quality, creativity, hook_strength, brand_fit and',
    'consistency_of_niche are each exactly one of: "derivative", "competent",',
    '"distinctive", "exceptional" — derivative = generic/templated, competent =',
    'solid but ordinary, distinctive = memorable and above the norm for this niche,',
    'exceptional = the best you would expect to see in this niche. niche_score,',
    'audience_match and confidence are 0-1. is_original_creator is false for repost',
    'pages, meme aggregators and clip farms. reject_reason is null unless the',
    'creator should be dropped outright. fit_score is 0-100.',
    '{',
    '  "video_description": "",',
    '  "niche_score": 0.0,',
    '  "audience_match": 0.0,',
    '  "genre": "",',
    '  "language": "",',
    '  "spoken_topic": "",',
    '  "confidence": 0.0,',
    '  "reason": "",',
    '  "niche": "",',
    '  "sub_niche": "",',
    '  "content_format": "talking_head | vlog | skit | tutorial | review | ugc_ad | compilation | other",',
    '  "production_quality": "competent",',
    '  "creativity": "competent",',
    '  "hook_strength": "competent",',
    '  "brand_safety": "safe | caution | unsafe",',
    '  "is_original_creator": true,',
    '  "spoken_language": "",',
    '  "on_screen_products": [],',
    '  "ugc_ad_fit": 0,',
    '  "brand_fit": "competent",',
    '  "brand_fit_reason": "",',
    '  "reasoning": "",',
    '  "primary_niche": "",',
    '  "consistency_of_niche": "competent",',
    '  "audience_guess": "",',
    '  "fit_score": 0,',
    '  "reject_reason": null,',
    '  "recommended_campaign_types": []',
    '}',
  ].join('\n');
}

/**
 * Judge a creator from the whole evidence bundle in ONE multimodal call.
 *
 * Preferred over judgeClips whenever the navigator captured profile screenshots,
 * because it answers the creator-level question directly from creator-level
 * evidence — bio, grid, captions, reach and the keyword-matched reel — instead of
 * inferring it from three reels judged in isolation.
 */
async function classifyProfile(candidate, config, deps = {}) {
  const gemini = deps.gemini || geminiClientDefault;
  if (!gemini.available || !gemini.available()) return null;

  const shots = (candidate.shots || []).filter((s) => s && s.dataBase64);
  const clip = candidate.clip && candidate.clip.dataBase64 ? candidate.clip : null;
  if (!shots.length && !clip) return null; // nothing a picture-or-video judge can add

  const parsed = await gemini.classifyReelVideo({
    videoBase64: clip ? clip.dataBase64 : undefined,
    mimeType: clip ? (clip.mimeType || 'video/mp4') : undefined,
    images: shots.map((s) => ({ data: s.dataBase64, mimeType: s.mimeType || 'image/png' })),
    promptText: buildProfilePrompt(candidate, config, shots),
    label: `profile @${candidate.username || '?'}`,
    maxOutputTokens: 800,
    responseSchema: PROFILE_RESPONSE_SCHEMA,
  });
  if (!parsed || typeof parsed.niche_score !== 'number') return null;

  const clipAnalysis = parseClipAnalysis(parsed);
  const creator = parseCreatorAnalysis(parsed);

  return {
    score: clamp01(parsed.niche_score),
    reason: parsed.reason || clipAnalysis?.reasoning || 'gemini-profile',
    source: 'gemini-profile',
    clip: clipAnalysis,
    creatorAnalysis: creator,
    evidence: {
      source: 'gemini-profile',
      // What the model said the reel actually was, before it scored
      // anything. Kept so a reviewer can check the verdict against the
      // video rather than taking the number on trust.
      videoDescription: str(parsed.video_description) || null,
      genre: parsed.genre || clipAnalysis?.niche || null,
      audienceMatch: typeof parsed.audience_match === 'number' ? clamp01(parsed.audience_match) : null,
      language: parsed.language || clipAnalysis?.spoken_language || null,
      spokenTopic: parsed.spoken_topic || null,
      confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : null,
      reason: parsed.reason || clipAnalysis?.reasoning || null,
      clip: clipAnalysis,
      creator,
      // What the verdict was actually looking at, so a review can tell a
      // full-evidence judgement from a thin one.
      evidenceUsed: {
        video: !!clip,
        shots: shots.map((s) => s.kind),
        captions: (candidate.reels || []).filter((r) => r && r.caption).length,
      },
    },
  };
}

/** The per-creator prompt: all three clip results, the profile, the reach. */
function buildCreatorPrompt({ candidate = {}, clips = [], stats = {} } = {}, config = {}) {
  return [
    'You are judging an Instagram CREATOR for a brand campaign, given the analyses',
    'of three of their reels plus their profile and reach figures.',
    '',
    `Target niche/genre: ${config.niche || '(unspecified)'}`,
    `Allowed genres: ${(config.genres || []).join(', ') || '(any)'}`,
    `Brand target audience: ${config.targetAudience || '(unspecified)'}`,
    '',
    `Creator @${candidate.username || 'unknown'}`,
    `Followers: ${candidate.followers ?? '(unknown)'}`,
    `Bio: ${candidate.bio || '(none)'}`,
    `Reach across ${stats.count || 0} recent reels — lowest ${stats.min ?? '?'}, `
      + `typical ${stats.typical ?? '?'}, highest ${stats.max ?? '?'}.`,
    '',
    'Reel analyses:',
    JSON.stringify(clips, null, 2),
    // The brand's own past approve/reject calls, as few-shot examples. Carried
    // here rather than on the per-CLIP prompt for two reasons: this is the call
    // that produces fit_score (the number the gate weighs most heavily), and it
    // runs once per creator where the clip prompt runs three times — so
    // calibration costs a third as much exactly where it matters most.
    // See services/nicheCalibration.js.
    (config.calibration && config.calibration.text) || '',
    // Taste the brand stated up front. Matters most on a new campaign, which has
    // no approve/reject history to learn from yet — see nicheCalibration.statedTaste.
    statedTaste(config),
    '',
    'reject_reason must be null unless this creator should be dropped, in which',
    'case give the reason in a few words. fit_score is 0-100.',
    '',
    'Respond with ONLY a JSON object of exactly this shape, no prose and no',
    'markdown fences:',
    CREATOR_SCHEMA,
  ].join('\n');
}

// Build the judge prompt from the campaign's scouting rules + what we captured.
// Kept deterministic + exported so the exact instruction is unit-testable.
function buildPrompt(candidate, config = {}) {
  const captions = (candidate.reels || [])
    .map((r) => (r && r.caption ? String(r.caption).slice(0, 200) : null))
    .filter(Boolean)
    .slice(0, 6);
  return [
    'You are evaluating whether an Instagram REEL fits a brand campaign. You are given the',
    'reel video WITH its audio — judge the visuals AND what is spoken/heard.',
    '',
    `Target niche/genre: ${config.niche || '(unspecified)'}`,
    `Campaign keywords: ${(config.keywords || []).join(', ') || '(none)'}`,
    `Allowed genres: ${(config.genres || []).join(', ') || '(any)'}`,
    `Brand target audience: ${config.targetAudience || '(unspecified)'}`,
    '',
    `Creator @${candidate.username || 'unknown'}`,
    `Bio: ${candidate.bio || '(none)'}`,
    captions.length ? `Recent captions:\n- ${captions.join('\n- ')}` : 'Recent captions: (none)',
    '',
    'Respond with ONLY a JSON object of exactly this shape, no prose and no',
    'markdown fences. Scores are 1-10; niche_score is 0-1. is_original_creator',
    'is false for repost pages, meme aggregators and clip farms.',
    CLIP_SCHEMA,
    '',
    'Legacy fields, also required:',
    '{',
    '  "niche_score": <0..1 how well the content matches the target niche/genre>,',
    '  "audience_match": <0..1 how well it fits the brand target audience>,',
    '  "genre": "<short genre/niche label>",',
    '  "language": "<primary spoken/caption language, or unknown>",',
    '  "spoken_topic": "<one phrase on what is said/shown, from the audio+video>",',
    '  "confidence": <0..1>,',
    '  "reason": "<one sentence>"',
    '}',
  ].join('\n');
}

// Classify with Gemini video. Returns the classifier shape nicheMatch expects
// ({ score, reason, source, evidence }) or null to fall through to the next tier.
async function classifyWithGemini(candidate, config, deps = {}) {
  const gemini = deps.gemini || geminiClientDefault;
  if (!gemini.available || !gemini.available()) return null;
  const clip = candidate.clip;
  if (!clip || !clip.dataBase64) return null;

  const parsed = await gemini.classifyReelVideo({
    videoBase64: clip.dataBase64,
    mimeType: clip.mimeType || 'video/mp4',
    promptText: buildPrompt(candidate, config),
  });
  if (!parsed || typeof parsed.niche_score !== 'number') return null;

  // The per-clip analysis rides along as `clip`. The deterministic scorer
  // (services/creatorScore.js) reads it; nothing downstream that already reads
  // score / genre / audienceMatch / language / spokenTopic / reason changes.
  const clipAnalysis = parseClipAnalysis(parsed);

  return {
    score: clamp01(parsed.niche_score),
    reason: parsed.reason || clipAnalysis?.reasoning || 'gemini-video',
    source: 'gemini-video',
    clip: clipAnalysis,
    evidence: {
      source: 'gemini-video',
      genre: parsed.genre || clipAnalysis?.niche || null,
      audienceMatch: typeof parsed.audience_match === 'number' ? clamp01(parsed.audience_match) : null,
      language: parsed.language || clipAnalysis?.spoken_language || null,
      spokenTopic: parsed.spoken_topic || null,
      confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : null,
      reason: parsed.reason || clipAnalysis?.reasoning || null,
      clip: clipAnalysis,
    },
  };
}

/**
 * Judge every clip the navigator recorded, then judge the CREATOR from them.
 *
 * A single reel answers "was this one reel on-brand". Three answer "is this
 * creator on-brand", which is the actual question — and the per-creator pass
 * (`buildCreatorPrompt`) is what turns three clip analyses plus the reach window
 * into one `fit_score` and `consistency_of_niche`, the two numbers the
 * deterministic gate weighs most heavily.
 *
 * Falls back to the single-clip path when only one clip exists, so nothing about
 * a one-clip capture changes.
 */
async function judgeClips(candidate, config, deps = {}) {
  const gemini = deps.gemini || geminiClientDefault;
  const clips = (candidate.clips || []).filter((c) => c && c.dataBase64);
  if (clips.length < 2) return classifyWithGemini(candidate, config, deps);
  if (!gemini.available || !gemini.available()) return null;

  // In parallel: three independent calls with nothing to say to each other, and
  // a creator is not worth three round-trips of waiting.
  const verdicts = (await Promise.all(
    clips.map((clip) => classifyWithGemini({ ...candidate, clip }, config, deps)),
  )).filter(Boolean);
  if (!verdicts.length) return null;

  const clipAnalyses = verdicts.map((v) => v.clip).filter(Boolean);
  const score = verdicts.reduce((sum, v) => sum + v.score, 0) / verdicts.length;
  // The strongest single clip, for the fields that describe one reel rather than
  // a body of work.
  const best = verdicts.reduce((a, b) => (b.score > a.score ? b : a));

  // Per-creator pass. Best-effort: without it the gate still has the clip
  // analyses and the reach window, it just has no fit_score to weigh.
  let creator = null;
  try {
    const raw = await gemini.classifyReelVideo({
      promptText: buildCreatorPrompt(
        { candidate, clips: clipAnalyses, stats: reelStats(candidate.reels || []) },
        config,
      ),
    });
    creator = parseCreatorAnalysis(raw);
  } catch (_) {
    /* the creator-level pass is enrichment, never a reason to drop a candidate */
  }

  return {
    score: clamp01(score),
    reason: (creator && creator.reject_reason) || best.reason,
    source: 'gemini-video',
    clip: best.clip,
    clips: clipAnalyses,
    creatorAnalysis: creator,
    evidence: {
      ...best.evidence,
      // How consistent the clips were with each other — a creator whose reels
      // score 0.9 / 0.2 / 0.85 is a different proposition from one at a steady
      // 0.65, and the mean alone hides that.
      clipScores: verdicts.map((v) => round3(v.score)),
      clip: best.clip,
      clipAnalyses,
      creator,
    },
  };
}

// The composite classifier the orchestrator injects as `nicheClassify`.
// deps.gemini / deps.claudeClassify are injectable for tests.
function makeClassifier(deps = {}) {
  const claudeClassify = deps.claudeClassify || defaultClassify;
  return async function classify(candidate, config) {
    // Reuse a verdict already computed upstream (e.g. the reels-feed navigator
    // judged the clip to decide engagement) so we never pay for Gemini twice.
    if (candidate && candidate._nicheVerdict) return candidate._nicheVerdict;
    // Whole-profile evidence (bio + grid pictures alongside the reel) answers the
    // creator-level question directly, so it wins when the navigator captured it.
    if (candidate && Array.isArray(candidate.shots) && candidate.shots.length) {
      const p = await classifyProfile(candidate, config, deps);
      if (p) return p;
    }
    const g = await judgeClips(candidate, config, deps);
    if (g) return g;
    return claudeClassify(candidate, config);
  };
}

module.exports = {
  buildPrompt,
  brandBrief,
  hasBrandContext,
  buildCreatorPrompt,
  buildProfilePrompt,
  classifyWithGemini,
  classifyProfile,
  judgeClips,
  makeClassifier,
  parseClipAnalysis,
  parseCreatorAnalysis,
  CLIP_SCHEMA,
  CREATOR_SCHEMA,
  CRAFT_LEVELS,
  PROFILE_RESPONSE_SCHEMA,
  scaleLevel,
};
