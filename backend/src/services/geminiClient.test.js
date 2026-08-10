'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gc = require('./geminiClient');

const GEMINI_ENVS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MEDIA_RESOLUTION'];
function clearEnv() { for (const k of GEMINI_ENVS) delete process.env[k]; }
test.afterEach(clearEnv);

function fakeFetch({ ok = true, status = 200, json, text } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok,
      status,
      async json() { return json; },
      async text() { return text != null ? text : JSON.stringify(json); },
    };
  };
  fn.calls = calls;
  return fn;
}

function verdictResponse(obj) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
}

test('available() reflects GEMINI_API_KEY', () => {
  clearEnv();
  assert.strictEqual(gc.available(), false);
  process.env.GEMINI_API_KEY = 'k';
  assert.strictEqual(gc.available(), true);
});

test('classifyReelVideo posts the clip inline (low res) and parses the JSON verdict', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.9, genre: 'fitness' }) });
  const out = await gc.classifyReelVideo({ videoBase64: 'AAAA', mimeType: 'video/mp4', promptText: 'judge', fetchImpl });

  assert.deepStrictEqual(out, { niche_score: 0.9, genre: 'fitness' });
  const call = fetchImpl.calls[0];
  assert.match(call.url, /models\/gemini-2\.5-flash-lite:generateContent\?key=k/);
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.contents[0].parts[0].inlineData.data, 'AAAA');
  assert.strictEqual(body.contents[0].parts[0].inlineData.mimeType, 'video/mp4');
  assert.strictEqual(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
});

test('honors GEMINI_MODEL + GEMINI_MEDIA_RESOLUTION overrides', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  process.env.GEMINI_MEDIA_RESOLUTION = 'medium';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.5 }) });
  await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl });
  const call = fetchImpl.calls[0];
  assert.match(call.url, /models\/gemini-2\.5-flash:generateContent/);
  assert.strictEqual(JSON.parse(call.opts.body).generationConfig.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
});

test('returns null (no request) when no API key is set', async () => {
  clearEnv();
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 1 }) });
  assert.strictEqual(await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl }), null);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('returns null on a non-2xx response (caller falls back)', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({ ok: false, status: 429, text: 'rate limited' });
  assert.strictEqual(await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl }), null);
});

test('skips an oversized inline clip without calling the API', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const oversized = 'A'.repeat(Math.ceil(((gc.MAX_INLINE_BYTES + 1) * 4) / 3) + 8);
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 1 }) });
  assert.strictEqual(await gc.generate({ videoBase64: oversized, promptText: 'x', fetchImpl }), null);
  assert.strictEqual(fetchImpl.calls.length, 0);
});
