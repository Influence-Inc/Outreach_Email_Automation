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

// How long to wait for one generateContent call. Video analysis is genuinely slow,
// so this is generous — it exists to stop a hung socket stalling a run, not to
// rush the model. 0 disables the bound.
const DEFAULT_TIMEOUT_MS = 90_000;

function timeoutMs() {
  const raw = clean(process.env.GEMINI_TIMEOUT_MS);
  if (raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}

function mediaResolution() {
  const r = (clean(process.env.GEMINI_MEDIA_RESOLUTION) || 'low').toLowerCase();
  if (r === 'off' || r === 'none') return null; // never send the field
  if (r === 'medium') return 'MEDIA_RESOLUTION_MEDIUM';
  if (r === 'high') return 'MEDIA_RESOLUTION_HIGH';
  if (r === 'default') return 'MEDIA_RESOLUTION_MEDIUM'; // API has no explicit "default" enum; medium is the middle
  return 'MEDIA_RESOLUTION_LOW';
}

// `mediaResolution` is a per-MODEL capability, not a universal one: the models
// this key can reach reject it with a bare 400 INVALID_ARGUMENT ("Request
// contains an invalid argument") that names no field, which is what silently
// killed every video judgement while the identical text-only /gemini/health ping
// — which never sends the field — kept succeeding.
//
// It is worth sending when accepted (media_resolution=low is the difference
// between 66 and 258 tokens per frame), so we try it once and, if that exact
// request works without it, stop sending it for the life of the process. Reset
// between tests via _resetMediaResolutionSupport().
let mediaResolutionSupported = true;
function _resetMediaResolutionSupport() { mediaResolutionSupported = true; }

// Base64 length -> approximate decoded byte count (4 base64 chars ≈ 3 bytes).
function approxBytes(b64) {
  return Math.floor((String(b64 || '').length * 3) / 4);
}

function kb(bytes) { return `${Math.round(bytes / 1024)}KB`; }

// Low-level call. Returns the model's text (a JSON string, per responseMimeType)
// or null on any failure so callers degrade gracefully. `fetchImpl` is injectable
// for tests.
//
// Every call logs what went out and what came back (`[gemini] ->` / `<-`), because
// the graceful null makes a failing judge indistinguishable from a creator with
// no clip — the pipeline just quietly scores on bio text instead, and nothing in
// the logs says why. `label` names the caller in those lines.
async function generate({
  videoBase64,
  mimeType = 'video/mp4',
  promptText,
  images = [],
  maxOutputTokens = 500,
  label = 'judge',
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = apiKey();
  if (!key) return null;
  if (!fetchImpl) throw new Error('fetch is not available');
  const videoBytes = videoBase64 ? approxBytes(videoBase64) : 0;
  const imgList = (images || []).filter((i) => i && i.data);
  const imageBytes = imgList.reduce((n, i) => n + approxBytes(i.data), 0);
  if (videoBytes + imageBytes > MAX_INLINE_BYTES) {
    console.error(
      `[gemini] ${label}: media too large for an inline request `
      + `(video ${kb(videoBytes)} + images ${kb(imageBytes)} > ${kb(MAX_INLINE_BYTES)}); skipping`,
    );
    return null;
  }

  const parts = [];
  if (videoBase64) parts.push({ inlineData: { mimeType, data: videoBase64 } });
  for (const img of imgList) {
    parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
  }
  parts.push({ text: promptText || '' });

  const mdl = model();
  const url = `${BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`;
  const buildBody = (withMediaRes) => {
    const generationConfig = { temperature: 0, maxOutputTokens, responseMimeType: 'application/json' };
    const res = withMediaRes ? mediaResolution() : null;
    if (res) generationConfig.mediaResolution = res;
    return JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });
  };
  // A bounded call. Without this a Gemini request that never answers blocks the
  // creator being judged, and with it the whole run — the phone sits idle waiting
  // on a socket. A judgement we waited too long for is worth less than moving on:
  // the caller degrades to the next classifier tier, which is exactly what it
  // does for any other failure.
  const post = (withMediaRes) => {
    const ms = timeoutMs();
    if (!ms) {
      return fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildBody(withMediaRes),
      });
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    return fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildBody(withMediaRes),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
  };

  console.log(
    `[gemini] -> ${label} model=${mdl} video=${videoBytes ? kb(videoBytes) : 'none'} `
    + `images=${imgList.length}${imageBytes ? ` (${kb(imageBytes)})` : ''} prompt=${(promptText || '').length}ch`,
  );

  const startedAt = Date.now();
  let res;
  let usedMediaRes = mediaResolutionSupported;
  try {
    res = await post(usedMediaRes);
    // A 400 with the field is the signature of a model that doesn't take it.
    // Retry once without it: if that works, the field was the whole problem, so
    // stop sending it rather than failing every remaining judgement identically.
    if (res && res.status === 400 && usedMediaRes && mediaResolution()) {
      const first = await res.text().catch(() => '');
      console.warn(
        `[gemini] ${label}: 400 with mediaResolution=${mediaResolution()} — retrying without it. `
        + `First error: ${String(first).slice(0, 300)}`,
      );
      usedMediaRes = false;
      res = await post(false);
      if (res && res.ok) {
        mediaResolutionSupported = false;
        console.warn(
          `[gemini] model ${mdl} does not accept mediaResolution — dropping it for the rest of `
          + 'this process (set GEMINI_MEDIA_RESOLUTION=off to skip the probe entirely)',
        );
      }
    }
  } catch (err) {
    // An abort here is our own timeout firing, not a network fault — worth saying
    // plainly, because the fix for one is a bigger GEMINI_TIMEOUT_MS and the fix
    // for the other is not.
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    console.error(
      `[gemini] ${label}: ${aborted ? `timed out after ${timeoutMs()}ms` : 'request failed'} `
      + `(${Date.now() - startedAt}ms):`,
      err.message,
    );
    return null;
  }
  const ms = Date.now() - startedAt;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // Full body, not a 200-char slice: Google puts the actionable part (which
    // field, which limit) at the end of the message.
    console.error(`[gemini] <- ${label} ${res.status} in ${ms}ms: ${String(t).slice(0, 1200)}`);
    return null;
  }
  const json = await res.json().catch(() => null);
  const cand = json && json.candidates && json.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.filter((p) => p.text).map((p) => p.text).join('').trim()
    : '';
  if (!text) {
    // A 200 with no text is usually a safety block or a truncation, and both are
    // invisible without saying so — the caller only sees null.
    const reason = (cand && (cand.finishReason || cand.finish_reason)) || 'no text in response';
    console.warn(`[gemini] <- ${label} 200 in ${ms}ms but empty (${reason})`);
    return null;
  }
  console.log(`[gemini] <- ${label} 200 in ${ms}ms, ${text.length}ch`);
  return text;
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
  _resetMediaResolutionSupport,
  MAX_INLINE_BYTES,
  DEFAULT_MODEL,
};
