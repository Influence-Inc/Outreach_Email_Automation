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
  assert.match(call.url, /models\/gemini-flash-lite-latest:generateContent\?key=k/);
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.contents[0].parts[0].inlineData.data, 'AAAA');
  assert.strictEqual(body.contents[0].parts[0].inlineData.mimeType, 'video/mp4');
  assert.strictEqual(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
});

test('model() defaults to the rolling flash-lite alias, not a pinned generation', () => {
  clearEnv();
  // A pinned generation string (e.g. "gemini-2.5-flash-lite") can 404 later when
  // Google retires it for "new" keys, even with zero code changes. The default
  // must be the "-latest" alias so that never happens silently.
  assert.strictEqual(gc.model(), 'gemini-flash-lite-latest');
  assert.strictEqual(gc.DEFAULT_MODEL, 'gemini-flash-lite-latest');
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

test('strips quotes/whitespace from env values so a mistyped model/key still resolves', async () => {
  // The exact Railway mistake: values pasted WITH quotes / a leading space.
  process.env.GEMINI_API_KEY = ' "k" ';
  process.env.GEMINI_MODEL = '"gemini-2.5-flash-lite"';
  assert.strictEqual(gc.available(), true);
  assert.strictEqual(gc.model(), 'gemini-2.5-flash-lite');
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.7 }) });
  await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl });
  // The URL must carry the clean model + clean key — no %22 (quote) or %20 (space).
  assert.match(fetchImpl.calls[0].url, /models\/gemini-2\.5-flash-lite:generateContent\?key=k$/);
});

test('ping() surfaces the real HTTP status/error (e.g. a 404 for a bad model)', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
  const bad = fakeFetch({ ok: false, status: 404, text: '{"error":{"message":"models/x is not found"}}' });
  const r = await gc.ping({ fetchImpl: bad });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.model, 'gemini-2.5-flash-lite');
  assert.match(r.error, /not found/);
  assert.ok(Array.isArray(r.availableModels), 'a failed ping lists what the key can use');

  const good = fakeFetch({ json: verdictResponse({ ok: true }) });
  assert.deepStrictEqual(await gc.ping({ fetchImpl: good }), { available: true, model: 'gemini-2.5-flash-lite', ok: true, status: 200 });
});

test('ping() on 404 reports the models the key can actually use', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
  // First call (generateContent) 404s; second call (ListModels) succeeds.
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 404, async text() { return 'not found'; }, async json() { return {}; } };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, // filtered out
          ],
        };
      },
      async text() { return ''; },
    };
  };
  const r = await gc.ping({ fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.availableModels, ['gemini-2.5-flash']);
});

test('listModels returns generateContent-capable bare ids', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({
    json: {
      models: [
        { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    },
  });
  assert.deepStrictEqual(await gc.listModels({ fetchImpl }), ['gemini-2.5-flash-lite']);
});

test('ping() reports the missing key without a request', async () => {
  clearEnv();
  const fetchImpl = fakeFetch({ json: verdictResponse({ ok: true }) });
  const r = await gc.ping({ fetchImpl });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fetchImpl.calls.length, 0);
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
