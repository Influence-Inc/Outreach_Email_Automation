'use strict';

// A cheap look before an expensive one.
//
// By the time the scout is standing on a creator's profile it has two pictures
// it already took — the bio and the reels grid — and has not yet spent anything
// on video. A grid of twelve thumbnails answers "is this person a runner or a
// chef" better than bio text does, and for a fraction of what watching a reel
// costs: one small JPEG against megabytes of video, one image call against a
// multimodal one.
//
// So this sits between the free gates (view floor, follower band — pure
// arithmetic on what the screen reader already read) and the expensive one
// (record, upload, judge). It exists only to avoid work.
//
// THE ASYMMETRY THAT MATTERS: this may only ever SAVE work, never cause a wrong
// rejection. A creator it skips is never recorded, never judged, and never seen
// again — there is no later step that could rescue them, and no way to find out
// we were wrong. A creator it lets through only costs a recording. So it rejects
// on clear evidence and nothing less: an uncertain answer, a low-confidence
// answer, a failed call, a missing key — all pass. The full judgement downstream
// is the accurate one; this is just triage.

const geminiClientDefault = require('./geminiClient');

// Below this the model is guessing, and a guess is not grounds for dropping a
// creator we will never look at again.
const DEFAULT_MIN_CONFIDENCE = 0.7;

// Small: this answers one yes/no question and returns a sentence.
const MAX_OUTPUT_TOKENS = 200;

function buildPrescreenPrompt(candidate = {}, config = {}, shots = []) {
  const kinds = shots.map((s, i) => {
    const what = s.kind === 'reels_grid'
      ? 'their REELS GRID — the thumbnails of their recent reels'
      : 'their PROFILE HEADER and bio';
    return `${i + 1}. A screenshot of ${what}.`;
  });

  return [
    'You are doing a FAST first-pass screen of an Instagram creator, from',
    'screenshots alone. The question is only whether they are worth looking at',
    'properly — not whether they are good.',
    '',
    'You are given, in this order:',
    ...(kinds.length ? kinds : ['(no screenshots)']),
    '',
    `Target niche/genre: ${config.niche || '(unspecified)'}`,
    `Campaign keywords: ${(config.keywords || []).join(', ') || '(none)'}`,
    config.brandProduct ? `What the brand sells: ${config.brandProduct}` : '',
    '',
    `Creator @${candidate.username || 'unknown'}`,
    `Bio text: ${candidate.bio || '(none)'}`,
    '',
    'Answer on_niche=false ONLY when the grid clearly shows a different line of',
    'work — a food account for a running campaign, a meme page, a shop. If they',
    'are plausibly in the target niche, or adjacent to it, or you cannot tell',
    'from these pictures, answer true. A wrong "false" loses this creator for',
    'good; a wrong "true" costs one video. Prefer true.',
    '',
    'confidence is how sure you are of on_niche, 0-1.',
    '',
    'Respond with ONLY a JSON object of exactly this shape, no prose and no',
    'markdown fences:',
    '{',
    '  "on_niche": true,',
    '  "niche_guess": "",',
    '  "confidence": 0.0,',
    '  "reason": ""',
    '}',
  ].filter((line) => line !== '').join('\n');
}

/**
 * Build the prescreen function the navigator calls, or null when it cannot run.
 *
 * Returns null (rather than a function that always passes) so the navigator can
 * skip taking the call entirely — and so "prescreen is off" and "prescreen said
 * yes" stay distinguishable in the logs.
 */
function makePrescreen({ gemini = geminiClientDefault, logger = console } = {}) {
  if (!gemini.available || !gemini.available()) return null;
  const log = (...a) => (logger.log || (() => {})).call(logger, ...a);

  return async function prescreen({ candidate = {}, shots = [], config = {} } = {}) {
    const images = (shots || [])
      .filter((s) => s && s.dataBase64)
      .map((s) => ({ mimeType: s.mimeType || 'image/jpeg', data: s.dataBase64 }));
    // Nothing to look at, or no niche to compare against — no basis to reject on.
    if (!images.length || !(config.niche || (config.keywords || []).length)) return { pass: true };

    let parsed = null;
    try {
      parsed = await gemini.classifyReelVideo({
        images,
        promptText: buildPrescreenPrompt(candidate, config, shots),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        label: 'prescreen',
      });
    } catch (_) {
      return { pass: true }; // a failed cheap check never costs us a creator
    }
    if (!parsed || typeof parsed.on_niche !== 'boolean') return { pass: true };

    const minConfidence = config.prescreenMinConfidence != null
      ? Number(config.prescreenMinConfidence)
      : DEFAULT_MIN_CONFIDENCE;
    const confidence = Number(parsed.confidence);
    const sure = Number.isFinite(confidence) ? confidence >= minConfidence : false;

    // Only a confident "no" stops a creator. Everything else goes through.
    if (parsed.on_niche === false && sure) {
      const guess = parsed.niche_guess ? ` (looks like ${parsed.niche_guess})` : '';
      const reason = `off-niche on the profile screenshots${guess}`;
      log(`[prescreen] @${candidate.username || '?'}: ${reason} — ${parsed.reason || 'no reason given'}`);
      return { pass: false, reason, confidence, nicheGuess: parsed.niche_guess || null };
    }

    return { pass: true, confidence, nicheGuess: parsed.niche_guess || null };
  };
}

module.exports = { makePrescreen, buildPrescreenPrompt, DEFAULT_MIN_CONFIDENCE };
