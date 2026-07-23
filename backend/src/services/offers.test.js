'use strict';

// Run with: npm test  (node --test)
//
// Guards inviteNumbersFor — decides which of our own business messaging numbers
// to show a creator in the invite email. A channel is included only when the
// creator has a number on file for it, isn't opted out, AND that channel is
// fully operational on our side (business number set AND provider API key
// present, so a reply can be answered). Env-stubbed; no DB.
const test = require('node:test');
const assert = require('node:assert');
const offers = require('./offers');

// Run `fn` with each channel's business-number AND provider-API-key env vars set
// to the given values. The API keys default to a present test value so callers
// that only care about the numbers get a fully-operational channel; pass
// waKey/imKey: undefined to simulate a half-configured channel (number set, key
// missing) — the dead-end case inviteNumbersFor must withhold.
function withBusinessNumbers(opts, fn) {
  const NAMES = {
    wa: 'AISENSY_WHATSAPP_NUMBER',
    im: 'IMESSAGE_FROM_NUMBER',
    waKey: 'AISENSY_API_KEY',
    imKey: 'IMESSAGE_API_KEY',
  };
  // A destructuring default (`waKey = ...`) would also fire on an explicit
  // `waKey: undefined`, so we can't tell "omitted" from "unset" that way. Use the
  // `in` operator: absent ⇒ default test key; present-but-undefined ⇒ unset.
  const { wa, im } = opts;
  const waKey = 'waKey' in opts ? opts.waKey : 'ai_test_key';
  const imKey = 'imKey' in opts ? opts.imKey : 'im_test_key';
  const saved = {};
  const setOrDel = (name, val) => {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  };
  try {
    for (const key of Object.keys(NAMES)) saved[key] = process.env[NAMES[key]];
    setOrDel(NAMES.wa, wa);
    setOrDel(NAMES.im, im);
    setOrDel(NAMES.waKey, waKey);
    setOrDel(NAMES.imKey, imKey);
    return fn();
  } finally {
    for (const key of Object.keys(NAMES)) setOrDel(NAMES[key], saved[key]);
  }
}

test('inviteNumbersFor returns both business numbers when both channels are usable', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: false }),
      { whatsappNumber: '+18005551234', imessageNumber: '+18005555678' },
    );
  });
});

test('inviteNumbersFor omits a channel the creator has no number on file for', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: null, messaging_opted_out: false }),
      { whatsappNumber: '+18005551234', imessageNumber: null },
    );
  });
});

test('inviteNumbersFor omits a channel whose business number is not configured', () => {
  withBusinessNumbers({ wa: undefined, im: '+18005555678' }, () => {
    // Creator has a WhatsApp number, but we have no WhatsApp business number set.
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: false }),
      { whatsappNumber: null, imessageNumber: '+18005555678' },
    );
  });
});

test('inviteNumbersFor omits a channel whose provider API key is missing (dead-end guard)', () => {
  // Production state that motivated this: the WhatsApp business number is set but
  // AISENSY_API_KEY is not, so a reply on WhatsApp can't be answered. Showing it
  // would route the creator into a dead end, so it's withheld; iMessage (fully
  // wired) is still offered.
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678', waKey: undefined }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: false }),
      { whatsappNumber: null, imessageNumber: '+18005555678' },
    );
  });
});

test('inviteNumbersFor returns nulls for an opted-out creator', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: true }),
      { whatsappNumber: null, imessageNumber: null },
    );
  });
});

test('inviteNumbersFor returns nulls when the creator has no numbers on file', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(offers.inviteNumbersFor({ whatsapp: null, imessage: null }), {
      whatsappNumber: null,
      imessageNumber: null,
    });
  });
});

// --- miniContractTerms (the fields shown on the mini contract) --------------

test('miniContractTerms builds the contract from real offer data with sensible defaults', () => {
  const terms = offers.miniContractTerms({
    full_name: 'Sam Rivera',
    first_name: 'Sam',
    brand_name: 'Acme',
    campaign_name: 'Spring Launch',
    deliverables: ['2 Reels'],
  });
  assert.strictEqual(terms.creatorName, 'Sam Rivera');
  assert.strictEqual(terms.brandName, 'Acme');
  assert.strictEqual(terms.campaignName, 'Spring Launch');
  assert.deepStrictEqual(terms.deliverables, ['2 Reels']);
  assert.deepStrictEqual(terms.platforms, ['Instagram']); // default
  assert.match(terms.timeline, /3 weeks/); // default
  // Only the agreed essentials — never contact or bank details.
  assert.ok(!('email' in terms) && !('phone' in terms) && !('bank' in terms) && !('paymentTerms' in terms));
});

test('miniContractTerms falls back to first name then "Creator", and null campaign', () => {
  assert.strictEqual(offers.miniContractTerms({ first_name: 'Sam', brand_name: 'Acme' }).creatorName, 'Sam');
  assert.strictEqual(offers.miniContractTerms({ brand_name: 'Acme' }).creatorName, 'Creator');
  assert.strictEqual(offers.miniContractTerms({ brand_name: 'Acme' }).campaignName, null);
});
