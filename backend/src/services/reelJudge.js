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
const { defaultClassify, clamp01 } = require('./sourcingFilters');

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
    'Respond with ONLY a JSON object of exactly this shape:',
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

  return {
    score: clamp01(parsed.niche_score),
    reason: parsed.reason || 'gemini-video',
    source: 'gemini-video',
    evidence: {
      source: 'gemini-video',
      genre: parsed.genre || null,
      audienceMatch: typeof parsed.audience_match === 'number' ? clamp01(parsed.audience_match) : null,
      language: parsed.language || null,
      spokenTopic: parsed.spoken_topic || null,
      confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : null,
      reason: parsed.reason || null,
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
    const g = await classifyWithGemini(candidate, config, deps);
    if (g) return g;
    return claudeClassify(candidate, config);
  };
}

module.exports = { buildPrompt, classifyWithGemini, makeClassifier };
