'use strict';

// Parity with the influence-creator-list estimator this module ports. The fixture holds the
// outputs of the ORIGINAL Python (estimated_cpm.py, market.py) and JS (apps/bench/topics.mjs)
// code on fixed inputs; every case here must come out of the port identically. When the
// reference tables are re-copied, regenerate the fixture rather than editing expectations.

const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./__fixtures__/cpmEstimate.parity.json');
const est = require('./cpmEstimate');

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] == null ? null : o[k]]));
const STICKER_KEYS = ['name', 'value', 'label', 'level', 'low', 'high', 'source', 'evidence'];

test('default market matches the Python percentile computation', () => {
  assert.deepStrictEqual(est.defaultMarket(), fixture.default_market);
});

for (const [name, c] of Object.entries(fixture.topic)) {
  test(`topic sticker: ${name}`, () => {
    const got = est.topicSticker(c.content.map((r) => ({ topic: r.topic || null, niche: r.niche || null })));
    assert.deepStrictEqual(pick(got, STICKER_KEYS), pick(c.sticker, STICKER_KEYS));
  });
}

for (const [code, want] of Object.entries(fixture.market)) {
  test(`market: ${code}`, () => {
    const got = est.resolveMarket(code === 'None' ? null : code);
    const keys = ['country', 'level', 'key', 'name', 'low', 'high', 'source', 'source_url', 'table_version'];
    assert.deepStrictEqual(pick(got, keys), pick(want, keys));
  });
}

for (const [bio, want] of Object.entries(fixture.bio)) {
  test(`country from bio: ${JSON.stringify(bio)}`, () => {
    const got = est.countryFromBio(bio);
    assert.deepStrictEqual(pick(got, ['country', 'source', 'evidence']), pick(want, ['country', 'source', 'evidence']));
  });
}

for (const [word, want] of Object.entries(fixture.labels)) {
  test(`word label: ${word}`, () => {
    const got = est.labelOf(word);
    assert.deepStrictEqual(got && pick(got, ['kind', 'key', 'topic']), want && pick(want, ['kind', 'key', 'topic']));
  });
}

for (const [name, c] of Object.entries(fixture.estimate)) {
  test(`estimated CPM: ${name}`, () => {
    const got = est.estimateCpm({
      content: c.content.map((r) => ({ topic: r.topic || null, niche: r.niche || null })),
      market: est.resolveMarket(c.country),
      countryEvidence: 'test',
      typicalViews: c.views,
    });
    assert.strictEqual(got.value, c.value, 'middle CPM');
    assert.strictEqual(got.low, c.low, 'low CPM');
    assert.strictEqual(got.high, c.high, 'high CPM');
    assert.deepStrictEqual(got.combined_factor, c.combined_factor);
    assert.deepStrictEqual(got.notes, c.notes);
    // Python reports the views tier's evidence with its own thousands separator; the rest of
    // every sticker must match field for field.
    got.stickers.forEach((s, i) => {
      assert.deepStrictEqual(pick(s, STICKER_KEYS), pick(c.stickers[i], STICKER_KEYS), `sticker ${s.name}`);
    });
  });
}
