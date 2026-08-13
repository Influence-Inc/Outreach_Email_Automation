'use strict';

// Gemini multimodal client — the model that WATCHES and HEARS a reel.
//
// Gemini natively ingests a video's frames AND its audio track in one call
// (frames at 1 fps, audio at 1 kbps mono), which is exactly what judging a reel
// needs: niche/genre from the visuals, plus spoken topic / music / language from
// the audio. We talk to the REST API directly (no SDK dependency, matching the
// repo's zero-extra-deps ethos) and send SHORT clips INLINE as base64 in a single
// generateContent call — no File API upload dance needed for a few-MB clip.
//
// Key-optional: with no GEMINI_API_KEY every call returns null so the caller
// (reelJudge -> nicheMatch) falls back to Claude, then keyword scoring. Cost is
// held down with media_resolution=low (66 tokens/frame) by default — a few
// dollars per 5,000 reels on the flash-lite tier.
//
// Env:
//   GEMINI_API_KEY           enables the client (unset => disabled)
//   GEMINI_MODEL             default 'gemini-flash-lite-latest'
//   GEMINI_MEDIA_RESOLUTION  'low' (default) | 'medium' | 'default' | 'high'

const { parseJsonLoose } = require('./claudeClient');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// A pinned generation (e.g. "gemini-2.5-flash-lite") can go 404 out from under a
// deployment with no code change: Google periodically retires a generation for
// "new" API keys ("this model is no longer available to new users") while still
// serving it to older keys. Google's own rolling alias sidesteps that — it always
// points at a currently-served model in the same cost tier, no redeploy needed to
// chase deprecations. Pin a dated snapshot instead if reproducibility across a
// model upgrade matters more than never-goes-404.
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // inline request payload ceiling (~20MB API cap)

// Env values pasted through a dashboard/host UI (e.g. Railway) frequently arrive
// wrapped in quotes or with stray whitespace — `"gemini-2.5-flash-lite"` or
// ` AIza…`. Those characters get URL-encoded into the request (a model of
// `%22gemini-2.5-flash-lite%22`, a key beginning with `%20`), which Google
// rejects with a 404 NotFound / 403 that is very hard to diagnose from the
// dashboard. Strip surrounding quotes and trim so a slightly-off value still works.
function clean(v) {
  return String(v == null ? '' : v).trim().replace(/^['"]+|['"]+$/g, '').trim();
}
function apiKey() { return clean(process.env.GEMINI_API_KEY); }
function available() { return !!apiKey(); }
function model() { return clean(process.env.GEMINI_MODEL) || DEFAULT_MODEL; }

function mediaResolution() {
  const r = (clean(process.env.GEMINI_MEDIA_RESOLUTION) || 'low').toLowerCase();
  if (r === 'medium') return 'MEDIA_RESOLUTION_MEDIUM';
  if (r === 'high') return 'MEDIA_RESOLUTION_HIGH';
  if (r === 'default') return 'MEDIA_RESOLUTION_MEDIUM'; // API has no explicit "default" enum; medium is the middle
  return 'MEDIA_RESOLUTION_LOW';
}

// Base64 length -> approximate decoded byte count (4 base64 chars ≈ 3 bytes).
function approxBytes(b64) {
  return Math.floor((String(b64 || '').length * 3) / 4);
}

// Low-level call. Returns the model's text (a JSON string, per responseMimeType)
// or null on any failure so callers degrade gracefully. `fetchImpl` is injectable
// for tests.
async function generate({
  videoBase64,
  mimeType = 'video/mp4',
  promptText,
  images = [],
  maxOutputTokens = 500,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = apiKey();
  if (!key) return null;
  if (!fetchImpl) throw new Error('fetch is not available');
  if (videoBase64 && approxBytes(videoBase64) > MAX_INLINE_BYTES) {
    console.error('[gemini] clip too large for an inline request; skipping');
    return null;
  }

  const parts = [];
  if (videoBase64) parts.push({ inlineData: { mimeType, data: videoBase64 } });
  for (const img of images) {
    if (img && img.data) parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
  }
  parts.push({ text: promptText || '' });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens,
      responseMimeType: 'application/json',
      mediaResolution: mediaResolution(),
    },
  };

  const url = `${BASE}/models/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[gemini] request failed:', err.message);
    return null;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[gemini] ${res.status}: ${String(t).slice(0, 200)}`);
    return null;
  }
  const json = await res.json().catch(() => null);
  const cand = json && json.candidates && json.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.filter((p) => p.text).map((p) => p.text).join('').trim()
    : '';
  return text || null;
}

// High-level: classify a reel clip -> parsed JSON verdict (or null on any failure).
async function classifyReelVideo(opts) {
  const text = await generate(opts);
  if (!text) return null;
  return parseJsonLoose(text);
}

// The model names the key can actually use for generateContent — Google's own
// answer to a 404 ("call ListModels to see the list of available models"). Bare
// ids (no "models/" prefix), filtered to those that support generateContent, so
// the value drops straight into GEMINI_MODEL. Returns [] on any failure.
async function listModels({ fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey();
  if (!key || !fetchImpl) return [];
  const url = `${BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    return ((json && json.models) || [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Diagnostic: a tiny text-only round-trip that surfaces the REAL outcome (HTTP
// status + error body) instead of the graceful null `generate()` returns. Lets an
// admin confirm the configured key + model actually reach a live model — a 404
// here means the model name isn't served for this key on v1beta; a 403/400 means
// the key is wrong. On failure it also lists the models the key CAN use for
// generateContent, so the fix (set GEMINI_MODEL to one of them) is right there.
// Never echoes the key. Used by GET /api/sourcing/gemini/health.
async function ping({ fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey();
  const mdl = model();
  if (!key) return { available: false, model: mdl, ok: false, error: 'GEMINI_API_KEY is not set' };
  if (!fetchImpl) return { available: true, model: mdl, ok: false, error: 'fetch is not available' };
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the JSON {"ok":true} and nothing else.' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 20, responseMimeType: 'application/json' },
  };
  const url = `${BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const availableModels = await listModels({ fetchImpl });
      return { available: true, model: mdl, ok: false, status: res.status, error: String(t).slice(0, 300), availableModels };
    }
    return { available: true, model: mdl, ok: true, status: 200 };
  } catch (err) {
    return { available: true, model: mdl, ok: false, error: err.message };
  }
}

module.exports = {
  available,
  model,
  mediaResolution,
  generate,
  classifyReelVideo,
  ping,
  listModels,
  approxBytes,
  MAX_INLINE_BYTES,
  DEFAULT_MODEL,
};
