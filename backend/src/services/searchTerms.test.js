'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeTerms, expandTerms, splitTerms, MAX_TERMS } = require('./searchTerms');

// ── normalizeTerms ──────────────────────────────────────────────────────────

// A comma separates keywords; a space does not. "iphone photos" is the phrase
// the operator meant to search for, not two separate searches.
test('a comma separates keywords, a space does not', () => {
  assert.deepStrictEqual(
    normalizeTerms({ keywords: ['iphone photos, instagram story ideas'] }),
    ['iphone photos', 'instagram story ideas'],
  );
});

test('a multi-word keyword stays one search', () => {
  assert.deepStrictEqual(
    normalizeTerms({ keywords: ['home gym workout'] }),
    ['home gym workout'],
  );
});

test('spacing around the comma does not leak into the term', () => {
  assert.deepStrictEqual(
    normalizeTerms({ keywords: ['  iphone photos   ,instagram   story ideas  '] }),
    ['iphone photos', 'instagram story ideas'],
  );
});

test('handles and hashtags stay whole — splitting them searches for nothing', () => {
  assert.deepStrictEqual(
    normalizeTerms({ hashtags: ['#homegym'], seedAccounts: ['@home.gym.co'] }),
    ['homegym', 'home.gym.co'],
  );
});

test('operator terms are searched before anything derived', () => {
  const terms = normalizeTerms({
    hashtags: ['#calisthenics'],
    keywords: ['kettlebell'],
    seedAccounts: ['@ironmaster'],
    extraTerms: ['mobility'],
  });
  assert.deepStrictEqual(terms, ['calisthenics', 'kettlebell', 'ironmaster', 'mobility']);
});

test('duplicates across sources collapse, case-insensitively', () => {
  assert.deepStrictEqual(
    normalizeTerms({ hashtags: ['#HomeGym'], keywords: ['homegym', 'HOMEGYM'] }),
    ['homegym'],
  );
});

// Filtering applies to single words WE derived, never to a phrase that was
// typed in — an operator who wrote it meant it.
test('a configured phrase is taken exactly as typed', () => {
  assert.deepStrictEqual(
    normalizeTerms({ keywords: ['the best gym for you'] }),
    ['the best gym for you'],
  );
});

test('a derived single word that is pure noise is dropped', () => {
  assert.deepStrictEqual(normalizeTerms({ niche: 'the, reels, yoga' }), ['yoga']);
});

// A run may legitimately be created with a niche and no keywords (routes/sourcing.js
// only requires one of the two). That used to search nothing at all.
test('a niche-only run still produces search terms', () => {
  assert.deepStrictEqual(
    normalizeTerms({ niche: 'iphone photos, instagram story ideas' }),
    ['iphone photos', 'instagram story ideas'],
  );
});

test('the niche is not mixed in when explicit keywords exist', () => {
  assert.deepStrictEqual(
    normalizeTerms({ keywords: ['kettlebell'], niche: 'home fitness' }),
    ['kettlebell'],
  );
});

test('the term list is capped so one run cannot search forever', () => {
  const keywords = Array.from({ length: 100 }, (_, i) => `term${i}xx`);
  assert.strictEqual(normalizeTerms({ keywords }).length, MAX_TERMS);
});

test('empty and malformed input degrade to an empty list, not a crash', () => {
  assert.deepStrictEqual(normalizeTerms(), []);
  assert.deepStrictEqual(normalizeTerms({ keywords: ['', '   ', '#', '@'] }), []);
});

test('punctuation around a term is stripped, inner spaces kept', () => {
  assert.deepStrictEqual(splitTerms('  yoga , iphone photos! '), ['yoga', 'iphone photos']);
});

// ── expandTerms ─────────────────────────────────────────────────────────────

function stubGemini(text, { available = true } = {}) {
  return {
    available: () => available,
    generate: async () => text,
  };
}

test('with no API key expansion is a no-op', async () => {
  const out = await expandTerms(
    { niche: 'home fitness' },
    { gemini: stubGemini(null, { available: false }) },
  );
  assert.deepStrictEqual(out, []);
});

test('suggested terms come back normalized', async () => {
  const out = await expandTerms(
    { niche: 'home fitness' },
    { gemini: stubGemini('{"terms":["Kettlebell","MOBILITY","calisthenics"]}') },
  );
  assert.deepStrictEqual(out, ['kettlebell', 'mobility', 'calisthenics']);
});

test('a suggested phrase is kept whole', async () => {
  const out = await expandTerms(
    { niche: 'photography' },
    { gemini: stubGemini('{"terms":["iphone photography tips"]}') },
  );
  assert.deepStrictEqual(out, ['iphone photography tips']);
});

// A model that ignores the "no commas" instruction would otherwise inject one
// unsearchable mega-query.
test('a comma-joined reply contributes its first term, not the whole string', async () => {
  const out = await expandTerms(
    { niche: 'home fitness' },
    { gemini: stubGemini('{"terms":["home gym setup, kettlebell flows"]}') },
  );
  assert.deepStrictEqual(out, ['home gym setup']);
});

test('terms already being searched are not suggested again', async () => {
  const out = await expandTerms(
    { niche: 'home fitness', existing: ['kettlebell'] },
    { gemini: stubGemini('{"terms":["kettlebell","rowing"]}') },
  );
  assert.deepStrictEqual(out, ['rowing']);
});

test('the limit is honoured', async () => {
  const out = await expandTerms(
    { niche: 'home fitness', limit: 2 },
    { gemini: stubGemini('{"terms":["one1","two2","three3","four4"]}') },
  );
  assert.deepStrictEqual(out, ['one1', 'two2']);
});

test('malformed model output degrades to no extra terms', async () => {
  for (const reply of ['not json at all', '{"terms":"nope"}', '{}', null]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await expandTerms({ niche: 'x' }, { gemini: stubGemini(reply) });
    assert.deepStrictEqual(out, [], `reply ${JSON.stringify(reply)} should yield []`);
  }
});

test('a thrown Gemini error never propagates into the run', async () => {
  const gemini = {
    available: () => true,
    generate: async () => { throw new Error('network down'); },
  };
  assert.deepStrictEqual(await expandTerms({ niche: 'x' }, { gemini }), []);
});

test('with no niche or genres there is nothing to expand from', async () => {
  const out = await expandTerms({}, { gemini: stubGemini('{"terms":["nope"]}') });
  assert.deepStrictEqual(out, []);
});
