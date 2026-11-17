'use strict';

// Creator rate quotes in other currencies are converted to USD before they're
// recorded ("Php 150,000" must never be stored as "$150,000").
//
// FX_RATES_DISABLED pins the conversion to the static fallback table, so these
// tests never touch the network and the expected numbers are fixed.
process.env.FX_RATES_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert');
const currency = require('./currency');
const negotiation = require('./negotiation');

const { FALLBACK_RATES } = currency;
const usd = (amount, cur) => Math.round(amount / FALLBACK_RATES[cur]);
const pick = (text) => currency.parseMoneyMentions(text).map((m) => [m.amount, m.currency]);

test('parseMoneyMentions reads the currency of each amount', () => {
  assert.deepStrictEqual(pick('Php 150,000 for 2 reels'), [[150000, 'PHP']]);
  assert.deepStrictEqual(pick('PHP150,000'), [[150000, 'PHP']]);
  assert.deepStrictEqual(pick('P150k per reel'), [[150000, 'PHP']]);
  assert.deepStrictEqual(pick('150k pesos'), [[150000, 'PHP']]);
  assert.deepStrictEqual(pick('My rate is 2,500 Euros'), [[2500, 'EUR']]);
  assert.deepStrictEqual(pick('€2.500,50 total'), [[2500.5, 'EUR']]);
  assert.deepStrictEqual(pick('2 500 € pour 2 vidéos'), [[2500, 'EUR']]);
  assert.deepStrictEqual(pick('₹1.5 lakh per reel'), [[150000, 'INR']]);
  assert.deepStrictEqual(pick('Rs. 50,000'), [[50000, 'INR']]);
  assert.deepStrictEqual(pick('I charge 1,50,000 INR'), [[150000, 'INR']]);
  assert.deepStrictEqual(pick('25000 rupees'), [[25000, 'INR']]);
  assert.deepStrictEqual(pick('£800'), [[800, 'GBP']]);
  assert.deepStrictEqual(pick('AED 4000'), [[4000, 'AED']]);
  assert.deepStrictEqual(pick('$3,500'), [[3500, 'USD']]);
  assert.deepStrictEqual(pick('USD900 per reel'), [[900, 'USD']]);
});

test('parseMoneyMentions ignores plain numbers and look-alike words', () => {
  assert.deepStrictEqual(pick('300,000 views'), []);
  assert.deepStrictEqual(pick('try 300 times'), []);
  assert.deepStrictEqual(pick('APP 500'), []);
  // A bare "2.5k" is kept (as before) but carries no currency.
  assert.deepStrictEqual(pick('2.5k'), [[2500, null]]);
});

test('contextCurrency finds the one currency a message talks in', () => {
  assert.strictEqual(currency.contextCurrency('my rate is 150,000 (philippine pesos)'), 'PHP');
  assert.strictEqual(currency.contextCurrency('$500 per reel'), null);
  assert.strictEqual(currency.contextCurrency('€500 or £450'), null); // ambiguous
});

test('convertToUsd converts with the rate table and leaves USD alone', async () => {
  assert.deepStrictEqual((await currency.convertToUsd(150000, 'PHP')).usd, usd(150000, 'PHP'));
  assert.deepStrictEqual((await currency.convertToUsd(2500, 'EUR')).usd, usd(2500, 'EUR'));
  const same = await currency.convertToUsd(900, 'USD');
  assert.strictEqual(same.usd, 900);
  assert.strictEqual(same.rate, 1);
});

test('formatOriginal shows what the creator wrote', () => {
  assert.strictEqual(currency.formatOriginal(150000, 'PHP'), '₱150,000');
  assert.strictEqual(currency.formatOriginal(2500, 'EUR'), '€2,500');
  assert.strictEqual(currency.formatOriginal(4000, 'AED'), '4,000 AED');
});

// ---- End to end through handleCreatorReply --------------------------------

const ctx = {
  firstName: 'Alex', brandName: 'Acme', campaignName: 'Acme Q3', cadence: '1-2 videos per week',
  managerName: 'Jennifer', refs: '@a, @b', maxCpm: 15, stage: 'AWAITING_RATE', hasStats: true,
  approvedOffer: null, guidelines: '',
};

function claudeReturning(obj) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) } };
}

test('heuristic path: "Php 150,000" is recorded in USD, not as $150,000', async () => {
  negotiation._setClient(null); // no Claude → regex fallback
  try {
    const r = await negotiation.handleCreatorReply({ id: 1 }, 'Hi! My rate is Php 150,000 for 2 reels.', ctx);
    assert.strictEqual(r.action, 'shared_rate');
    assert.strictEqual(r.quoted_rate, usd(150000, 'PHP'));
    assert.notStrictEqual(r.quoted_rate, 150000);
    assert.deepStrictEqual(
      { amount: r.quoted_rate_original.amount, currency: r.quoted_rate_original.currency },
      { amount: 150000, currency: 'PHP' },
    );
  } finally {
    negotiation._setClient(undefined);
  }
});

test('Claude path: amount + currency as written are converted ("2,500 Euros")', async () => {
  negotiation._setClient(claudeReturning({
    understanding: 'rate', action: 'shared_rate', quoted_rate: 2500, quoted_rate_currency: 'EUR',
    quoted_rate_options: null, email: null, send_now: false,
  }));
  try {
    const r = await negotiation.handleCreatorReply({ id: 1 }, 'My rate is 2,500 Euros per reel', ctx);
    assert.strictEqual(r.quoted_rate, usd(2500, 'EUR'));
    assert.strictEqual(r.quoted_rate_currency, 'EUR');
    assert.strictEqual(r.quoted_rate_original.amount, 2500);
  } finally {
    negotiation._setClient(undefined);
  }
});

test('Claude path: a currency marked in the text wins over a wrong USD claim', async () => {
  negotiation._setClient(claudeReturning({
    understanding: 'rate', action: 'shared_rate', quoted_rate: 150000, quoted_rate_currency: 'USD',
    quoted_rate_options: null, email: null, send_now: false,
  }));
  try {
    const r = await negotiation.handleCreatorReply({ id: 1 }, 'Php 150,000 for the package', ctx);
    assert.strictEqual(r.quoted_rate, usd(150000, 'PHP'));
  } finally {
    negotiation._setClient(undefined);
  }
});

test('tiered quotes in rupees: every option is converted and keeps its label', async () => {
  negotiation._setClient(null);
  try {
    const r = await negotiation.handleCreatorReply(
      { id: 1 },
      'My rates:\n- ₹50,000 for 1 reel\n- ₹1.2 lakh for 3 reels',
      ctx,
    );
    assert.strictEqual(r.quoted_rate, usd(50000, 'INR'));
    assert.deepStrictEqual(
      r.quoted_rate_options.map((o) => [o.amount, o.original_amount, o.currency, o.label]),
      [
        [usd(50000, 'INR'), 50000, 'INR', '₹50,000 for 1 reel'],
        [usd(120000, 'INR'), 120000, 'INR', '₹1.2 lakh for 3 reels'],
      ],
    );
  } finally {
    negotiation._setClient(undefined);
  }
});

test('dollar quotes are untouched', async () => {
  negotiation._setClient(null);
  try {
    const r = await negotiation.handleCreatorReply({ id: 1 }, 'My rate is $3,500 for 300k views', ctx);
    assert.strictEqual(r.quoted_rate, 3500);
    assert.strictEqual(r.quoted_rate_original, undefined);
  } finally {
    negotiation._setClient(undefined);
  }
});
