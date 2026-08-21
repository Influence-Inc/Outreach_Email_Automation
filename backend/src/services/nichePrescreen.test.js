'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makePrescreen, buildPrescreenPrompt } = require('./nichePrescreen');

function fakeGemini(reply, { available = true } = {}) {
  const calls = [];
  return {
    calls,
    available: () => available,
    classifyReelVideo: async (opts) => {
      calls.push(opts);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(opts) : reply;
    },
  };
}

const SHOTS = [
  { kind: 'bio', mimeType: 'image/jpeg', dataBase64: 'BIO' },
  { kind: 'reels_grid', mimeType: 'image/jpeg', dataBase64: 'GRID' },
];
const CANDIDATE = { username: 'somechef', bio: 'recipes daily' };
const CONFIG = { niche: 'running', keywords: ['marathon'] };

const quiet = { logger: { log() {} } };

// ── it saves work ───────────────────────────────────────────────────────────

test('a confident off-niche verdict stops the creator', async () => {
  const gemini = fakeGemini({ on_niche: false, confidence: 0.95, niche_guess: 'cooking', reason: 'all food' });
  const prescreen = makePrescreen({ gemini, ...quiet });

  const r = await prescreen({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
  assert.strictEqual(r.pass, false);
  assert.match(r.reason, /off-niche/);
  assert.match(r.reason, /cooking/, 'says what it looked like instead');
});

test('it sends the pictures and no video', async () => {
  const gemini = fakeGemini({ on_niche: true, confidence: 0.9 });
  await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });

  const opts = gemini.calls[0];
  assert.strictEqual(opts.videoBase64, undefined, 'no video — that is the entire point');
  assert.deepStrictEqual(opts.images.map((i) => i.data), ['BIO', 'GRID']);
  assert.ok(opts.maxOutputTokens <= 200, 'a small answer to a small question');
});

// ── the asymmetry: it may only ever save work ───────────────────────────────
//
// A creator this skips is never recorded, never judged, and never seen again.
// There is no later step that could rescue them and no way to learn we were
// wrong — so anything short of clear evidence has to pass.

test('an on-niche verdict passes', async () => {
  const gemini = fakeGemini({ on_niche: true, confidence: 0.99 });
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
  assert.strictEqual(r.pass, true);
});

test('an UNCONFIDENT off-niche verdict passes', async () => {
  const gemini = fakeGemini({ on_niche: false, confidence: 0.4, niche_guess: 'maybe food?' });
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
  assert.strictEqual(r.pass, true, 'a guess is not grounds for dropping a creator');
});

test('the confidence bar is tunable', async () => {
  const gemini = fakeGemini({ on_niche: false, confidence: 0.5 });
  const prescreen = makePrescreen({ gemini, ...quiet });
  assert.strictEqual((await prescreen({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG })).pass, true);
  assert.strictEqual(
    (await prescreen({ candidate: CANDIDATE, shots: SHOTS, config: { ...CONFIG, prescreenMinConfidence: 0.3 } })).pass,
    false,
  );
});

test('a missing confidence is treated as unsure, so it passes', async () => {
  const gemini = fakeGemini({ on_niche: false, niche_guess: 'cooking' });
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
  assert.strictEqual(r.pass, true);
});

test('a failed call passes rather than costing a creator', async () => {
  const gemini = fakeGemini(new Error('gemini is down'));
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
  assert.strictEqual(r.pass, true);
});

test('a reply that is not the documented shape passes', async () => {
  for (const junk of [null, {}, { on_niche: 'no' }, 'not json']) {
    const gemini = fakeGemini(junk);
    // eslint-disable-next-line no-await-in-loop
    const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: CONFIG });
    assert.strictEqual(r.pass, true, `junk reply ${JSON.stringify(junk)} passed through`);
  }
});

test('no screenshots means nothing to judge on, so it passes', async () => {
  const gemini = fakeGemini({ on_niche: false, confidence: 0.99 });
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: [], config: CONFIG });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(gemini.calls.length, 0, 'and does not spend a call to find that out');
});

test('no niche configured means nothing to compare against, so it passes', async () => {
  const gemini = fakeGemini({ on_niche: false, confidence: 0.99 });
  const r = await makePrescreen({ gemini, ...quiet })({ candidate: CANDIDATE, shots: SHOTS, config: {} });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(gemini.calls.length, 0);
});

// Null rather than an always-passing function, so "off" and "said yes" stay
// distinguishable at the call site.
test('no API key means no prescreen at all', () => {
  assert.strictEqual(makePrescreen({ gemini: fakeGemini(null, { available: false }) }), null);
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the prompt names the niche and describes each picture in order', () => {
  const p = buildPrescreenPrompt(CANDIDATE, { ...CONFIG, brandProduct: 'a racing shoe' }, SHOTS);
  assert.match(p, /Target niche\/genre: running/);
  assert.match(p, /Campaign keywords: marathon/);
  assert.match(p, /a racing shoe/);
  assert.match(p, /1\. A screenshot of their PROFILE HEADER/);
  assert.match(p, /2\. A screenshot of their REELS GRID/);
});

// The instruction has to carry the asymmetry too, not just the code around it.
test('the prompt tells the model to prefer letting a creator through', () => {
  const p = buildPrescreenPrompt(CANDIDATE, CONFIG, SHOTS);
  assert.match(p, /Prefer true/);
  assert.match(p, /loses this creator for/i);
});
