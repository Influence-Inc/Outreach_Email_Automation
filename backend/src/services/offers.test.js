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
  // `waKey` fans out to Twilio's TWO required creds (SID + auth token) — both
  // must be set for a Twilio send to authenticate; either alone is a 401 in
  // production and reads as `conversationReady: false` in config.
  const VARS = [
    'TWILIO_WHATSAPP_FROM',
    'IMESSAGE_FROM_NUMBER',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'IMESSAGE_API_KEY',
  ];
  // A destructuring default (`waKey = ...`) would also fire on an explicit
  // `waKey: undefined`, so we can't tell "omitted" from "unset" that way. Use the
  // `in` operator: absent ⇒ default test key; present-but-undefined ⇒ unset.
  const { wa, im } = opts;
  const waKey = 'waKey' in opts ? opts.waKey : 'twilio_test_creds';
  const imKey = 'imKey' in opts ? opts.imKey : 'im_test_key';
  const saved = {};
  const setOrDel = (name, val) => {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  };
  try {
    for (const v of VARS) saved[v] = process.env[v];
    setOrDel('TWILIO_WHATSAPP_FROM', wa);
    setOrDel('IMESSAGE_FROM_NUMBER', im);
    // waKey === undefined ⇒ clear BOTH Twilio creds (dead-end simulated).
    setOrDel('TWILIO_ACCOUNT_SID', waKey);
    setOrDel('TWILIO_AUTH_TOKEN', waKey);
    setOrDel('IMESSAGE_API_KEY', imKey);
    return fn();
  } finally {
    for (const v of VARS) setOrDel(v, saved[v]);
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
  // Twilio SID/token isn't, so a reply on WhatsApp can't be answered. Showing it
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
  assert.strictEqual(terms.deadline, null); // no campaign deadline set → null, portal falls back
  assert.match(terms.timeline, /3 weeks/); // default
  // Only the agreed essentials — never contact or bank details.
  assert.ok(!('email' in terms) && !('phone' in terms) && !('bank' in terms) && !('paymentTerms' in terms));
});

test('miniContractTerms surfaces the campaign deadline as an accurate date when set', () => {
  const terms = offers.miniContractTerms({
    full_name: 'Sam',
    brand_name: 'Acme',
    campaign_deadline_date: '2026-11-15',
  });
  // formatDate uses en-US Sep-D-YYYY-ish output; we just check the year lands
  // in both fields so a locale tweak doesn't false-positive the test.
  assert.match(terms.deadline, /2026/);
  assert.match(terms.timeline, /posted by .*2026/);
  assert.doesNotMatch(terms.timeline, /3 weeks/);
});

test('miniContractTerms falls back to first name then "Creator", and null campaign', () => {
  assert.strictEqual(offers.miniContractTerms({ first_name: 'Sam', brand_name: 'Acme' }).creatorName, 'Sam');
  assert.strictEqual(offers.miniContractTerms({ brand_name: 'Acme' }).creatorName, 'Creator');
  assert.strictEqual(offers.miniContractTerms({ brand_name: 'Acme' }).campaignName, null);
});

test('miniContractTerms carries the creator-picked platforms when set', () => {
  const terms = offers.miniContractTerms({
    full_name: 'Sam',
    brand_name: 'Acme',
    contract_platforms: ['Instagram', 'TikTok'],
  });
  assert.deepStrictEqual(terms.platforms, ['Instagram', 'TikTok']);
});

// --- normalizeContractPlatforms (post-accept picker input hygiene) ----------

test('normalizeContractPlatforms always includes Instagram, in canonical order', () => {
  assert.deepStrictEqual(offers.normalizeContractPlatforms([]), ['Instagram']);
  assert.deepStrictEqual(offers.normalizeContractPlatforms(null), ['Instagram']);
  // Order is canonical regardless of what came in.
  assert.deepStrictEqual(
    offers.normalizeContractPlatforms(['YouTube Shorts', 'TikTok']),
    ['Instagram', 'TikTok', 'YouTube Shorts'],
  );
});

test('normalizeContractPlatforms accepts case-insensitive tokens and drops unknowns', () => {
  assert.deepStrictEqual(
    offers.normalizeContractPlatforms(['tiktok', 'YOUTUBE SHORTS']),
    ['Instagram', 'TikTok', 'YouTube Shorts'],
  );
  assert.deepStrictEqual(
    offers.normalizeContractPlatforms(['tiktok', 'Twitter', 'Facebook']),
    ['Instagram', 'TikTok'],
  );
});

test('normalizeContractPlatforms deduplicates repeated tokens', () => {
  assert.deepStrictEqual(
    offers.normalizeContractPlatforms(['TikTok', 'TikTok', 'tiktok']),
    ['Instagram', 'TikTok'],
  );
});

// --- computePostingDeadline ------------------------------------------------

test('computePostingDeadline returns 4 days per video from acceptance date', () => {
  const signed = new Date('2026-01-01T00:00:00Z');
  // 3 videos → 12 days out from signing
  const three = offers.computePostingDeadline({
    deliverables: ['3 Reels'],
    contract_signed_at: signed,
  });
  assert.strictEqual(three.toISOString().slice(0, 10), '2026-01-13');

  // 5 videos → 20 days out
  const five = offers.computePostingDeadline({
    deliverables: ['5 Reels'],
    contract_signed_at: signed,
  });
  assert.strictEqual(five.toISOString().slice(0, 10), '2026-01-21');
});

test('computePostingDeadline sums a multi-line deliverables list', () => {
  const signed = new Date('2026-01-01T00:00:00Z');
  // 2 Reels + 1 Story = 3 units → 12 days out
  const combined = offers.computePostingDeadline({
    deliverables: ['2 Reels', '1 Story'],
    contract_signed_at: signed,
  });
  assert.strictEqual(combined.toISOString().slice(0, 10), '2026-01-13');
});

test('computePostingDeadline falls back to today for a pending offer', () => {
  const before = Date.now();
  const d = offers.computePostingDeadline({ deliverables: ['3 Reels'] });
  const after = Date.now();
  // 3 videos × 4 days = 12 days; deadline must sit inside [now+12d, now+12d+ε].
  const twelveDays = 12 * 24 * 3600 * 1000;
  assert.ok(d.getTime() >= before + twelveDays);
  assert.ok(d.getTime() <= after + twelveDays + 100);
});

test('computePostingDeadline returns null when there are no deliverables', () => {
  assert.strictEqual(offers.computePostingDeadline({ deliverables: [] }), null);
  assert.strictEqual(offers.computePostingDeadline({}), null);
});

test('computePostingDeadline treats an unparseable deliverables list as 1 line = 1 unit', () => {
  // Free-text deliverables that don't start with "<n> " fall back to
  // deliverables.length as the count — one line = one video.
  const signed = new Date('2026-01-01T00:00:00Z');
  const d = offers.computePostingDeadline({
    deliverables: ['One long-form video with a hook'],
    contract_signed_at: signed,
  });
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-01-05');
});
