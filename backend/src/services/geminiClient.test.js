'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gc = require('./geminiClient');

const GEMINI_ENVS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MEDIA_RESOLUTION', 'GEMINI_TIMEOUT_MS'];
function clearEnv() { for (const k of GEMINI_ENVS) delete process.env[k]; }
// mediaResolution support is remembered process-wide once probed, so a test that
// makes the model reject it must not decide the outcome of the next test.
test.afterEach(() => { clearEnv(); gc._resetMediaResolutionSupport(); });

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

// A model that rejects generationConfig.mediaResolution answers with a bare 400
// INVALID_ARGUMENT naming no field — the exact failure that silently killed every
// video judgement in production while the text-only health ping kept succeeding.
function fetch400ThenOk(json) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    const sentMediaRes = body.generationConfig.mediaResolution != null;
    if (sentMediaRes) {
      return {
        ok: false,
        status: 400,
        async text() { return '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'; },
        async json() { return {}; },
      };
    }
    return { ok: true, status: 200, async json() { return json; }, async text() { return ''; } };
  };
  fn.calls = calls;
  return fn;
}

test('a 400 on mediaResolution is retried without it, and the verdict still comes back', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fetch400ThenOk(verdictResponse({ niche_score: 0.8, genre: 'fitness' }));
  const out = await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'judge', fetchImpl });

  assert.deepStrictEqual(out, { niche_score: 0.8, genre: 'fitness' });
  assert.strictEqual(fetchImpl.calls.length, 2, 'tried with the field, then without');
  assert.strictEqual(fetchImpl.calls[0].body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.strictEqual(fetchImpl.calls[1].body.generationConfig.mediaResolution, undefined);
  // Everything else about the request must survive the retry — notably the video.
  assert.strictEqual(fetchImpl.calls[1].body.contents[0].parts[0].inlineData.data, 'AAAA');
});

test('once the model has rejected mediaResolution, later calls skip it entirely', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const probe = fetch400ThenOk(verdictResponse({ niche_score: 0.5 }));
  await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl: probe });

  const after = fetch400ThenOk(verdictResponse({ niche_score: 0.6 }));
  const out = await gc.classifyReelVideo({ videoBase64: 'BBBB', promptText: 'x', fetchImpl: after });
  assert.deepStrictEqual(out, { niche_score: 0.6 });
  assert.strictEqual(after.calls.length, 1, 'no second probe — the answer is remembered');
  assert.strictEqual(after.calls[0].body.generationConfig.mediaResolution, undefined);
});

test('GEMINI_MEDIA_RESOLUTION=off never sends the field at all', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MEDIA_RESOLUTION = 'off';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.4 }) });
  await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl });
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].opts.body).generationConfig.mediaResolution, undefined);
});

test('images ride along as inline parts after the video', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.7 }) });
  await gc.classifyReelVideo({
    videoBase64: 'VVVV',
    images: [{ data: 'VVV1', mimeType: 'image/png' }, { data: 'VVV2', mimeType: 'image/png' }],
    promptText: 'judge the profile',
    fetchImpl,
  });
  const parts = JSON.parse(fetchImpl.calls[0].opts.body).contents[0].parts;
  assert.strictEqual(parts[0].inlineData.data, 'VVVV');
  assert.strictEqual(parts[1].inlineData.data, 'VVV1');
  assert.strictEqual(parts[2].inlineData.mimeType, 'image/png');
  assert.strictEqual(parts[3].text, 'judge the profile');
});

test('a 200 with no text (safety block / truncation) returns null', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({ json: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] } });
  assert.strictEqual(await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'x', fetchImpl }), null);
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

// ── the call is bounded ─────────────────────────────────────────────────────

// Without a bound, a Gemini request that never answers blocks the creator being
// judged and with it the whole run — the phone sits idle on a socket.
test('a request that never answers is aborted rather than hanging the run', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_TIMEOUT_MS = '20';

  // Never resolves on its own; only the abort signal ends it.
  const hangingFetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });

  const started = Date.now();
  const out = await gc.classifyReelVideo({
    videoBase64: 'AAAA', promptText: 'judge', fetchImpl: hangingFetch,
  });

  assert.strictEqual(out, null, 'degrades to null so the caller falls to the next tier');
  assert.ok(Date.now() - started < 2000, 'gave up promptly instead of waiting forever');
});

test('the timeout is configurable and 0 disables the bound', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_TIMEOUT_MS = '0';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.7 }) });

  const out = await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'judge', fetchImpl });
  assert.strictEqual(out.niche_score, 0.7);
  assert.strictEqual(fetchImpl.calls[0].opts.signal, undefined, 'no abort signal attached');
});

test('a bounded call still passes a signal through', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const fetchImpl = fakeFetch({ json: verdictResponse({ niche_score: 0.7 }) });
  await gc.classifyReelVideo({ videoBase64: 'AAAA', promptText: 'judge', fetchImpl });
  assert.ok(fetchImpl.calls[0].opts.signal, 'the default timeout is in force');
});
