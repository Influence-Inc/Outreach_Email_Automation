'use strict';

const test = require('node:test');
const assert = require('node:assert');
const a = require('./audienceEstimate');
const PARITY = require('./__fixtures__/audienceEstimate.parity.json');

// The port must give creator-list's answer exactly, to the cent and the word.
test('the estimate matches creator-list\'s audience.py on recorded cases', () => {
  for (const [i, c] of PARITY.cases.entries()) {
    const out = a.estimate(c.reels, { country: c.country, countrySource: c.source });
    for (const k of ['calibrated', 'reels', 'gender', 'age', 'geography']) {
      assert.deepStrictEqual(out[k], c.expected[k], `case ${i}: ${k}`);
    }
  }
});

test('rounding follows Python: exact ties go to even', () => {
  assert.strictEqual(a.pyRound(0.625, 2), 0.62);
  assert.strictEqual(a.pyRound(0.635, 2), 0.64, '0.635 is a little over in binary');
  assert.strictEqual(a.pyRound(0.125, 2), 0.12);
  assert.strictEqual(a.pyRound(62.5, 0), 62);
  assert.strictEqual(a.pyRound(63.5, 0), 64);
  assert.strictEqual(a.mean([0.8, 0.45]), 0.625);
});

test('currencies and places named in a Reel', () => {
  assert.deepStrictEqual(
    a.textSignals({ caption: 'Best street food in Mumbai under ₹200!', language: 'Hindi' }),
    { language: 'hindi', currencies: ['IN', 'LK', 'NP', 'PK'], places: ['IN'] },
  );
  assert.deepStrictEqual(a.textSignals({ caption: 'no places here' }), { language: null, currencies: [], places: [] });
});

test('answers below the confidence floor, and unclear, are left out', () => {
  const r = a.reelInputs({
    labels: {
      topic: { value: 'beauty', confidence: 0.9 },
      audience_gender: { value: 'women', confidence: 0.8 },
      audience_life_stage: { value: 'students', confidence: 0.3 },
      audience_scope: { value: 'unclear', confidence: 0.9 },
    },
    usedSpeech: true,
    signals: { language: 'english', currencies: [], places: ['US'] },
  });
  assert.deepStrictEqual(r, {
    topic: 'beauty', has_speech: true, language: 'english', currencies: [], places: ['US'], addressed_to: 'women', life_stage: null, scope: null,
  });
});

test('country names map to codes as creator-list does, and the summary reads', () => {
  assert.strictEqual(a.countryCode('United States'), 'US');
  assert.strictEqual(a.countryCode('Bosnia'), 'BA');
  assert.strictEqual(a.countryCode('Narnia'), null);
  const est = a.estimate(PARITY.cases[0].reels, { country: PARITY.cases[0].country, countrySource: PARITY.cases[0].source });
  assert.match(a.summarise(est), /^(mostly female|female-leaning|balanced|male-leaning|mostly male) · \d/);
});
