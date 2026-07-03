'use strict';

// Run with: npm test  (node --test)
//
// Covers the three reply-shaping rules the team asked for, at the deterministic
// layer (so they hold even when Claude is unavailable and the template
// fallback sends the email):
//   1. Greet whoever actually replied (a manager/agent on the creator's behalf).
//   2. Share reference accounts ONLY when the sender asked.
//   3. Bold section headers + clickable reference links in the body.
const test = require('node:test');
const assert = require('node:assert');
const negotiation = require('./negotiation');
const templates = require('./negotiationTemplates');

// ── 1. Salutation follows the sender ────────────────────────────────────────

test('salutationFor greets the manager who replied on the creator behalf', () => {
  const inbound = 'I would be interested. Share more details.\n\n- Anvith, Manager';
  assert.strictEqual(negotiation.salutationFor('Dua', inbound), 'Anvith');
});

test('salutationFor handles "this is X, Y\'s manager" self-introductions', () => {
  assert.strictEqual(
    negotiation.salutationFor('Dua', "Hi, this is Alex, Dua's manager. She's keen!"),
    'Alex',
  );
  assert.strictEqual(negotiation.salutationFor('Dua', 'Priya here, I manage Dua.'), 'Priya');
});

test('salutationFor reads a plain sign-off name ("Best, Sarah")', () => {
  assert.strictEqual(negotiation.salutationFor('Dua', 'Yes, interested!\n\nBest, Sarah'), 'Sarah');
});

test('salutationFor keeps the creator name when the creator replies themselves', () => {
  assert.strictEqual(negotiation.salutationFor('Dua', 'Sounds great, tell me more!'), 'Dua');
  assert.strictEqual(negotiation.salutationFor('Dua', "I'm in! Love it.\n- Dua"), 'Dua');
});

test('salutationFor does NOT mistake a lowercase common word for a name', () => {
  // The case-insensitive trigger match must not capture "sounds" as a name.
  assert.strictEqual(negotiation.salutationFor('Jordan', 'thanks, sounds good'), 'Jordan');
  assert.strictEqual(
    negotiation.salutationFor('Mia', 'sounds interesting, what do you have in mind?'),
    'Mia',
  );
});

test('salutationFor falls back to "there" when neither name is known', () => {
  assert.strictEqual(negotiation.salutationFor(null, 'sounds great'), 'there');
});

test('detectSenderName returns null when there is no clear sender name', () => {
  assert.strictEqual(negotiation.detectSenderName('sounds great, tell me more'), null);
  assert.strictEqual(negotiation.detectSenderName(''), null);
});

// ── 2. Reference-account gate ───────────────────────────────────────────────

test('askedForReferences is true only on an explicit portfolio/examples ask', () => {
  const yes = [
    'can you share some references?',
    'do you have examples of past work?',
    'which other creators have you worked with?',
    'got a portfolio i can look at?',
    'any samples of previous campaigns?',
  ];
  const no = [
    'sounds great, tell me more',
    'what platform is this for?',
    'when do I get paid?',
    'my rate is $1500',
  ];
  for (const t of yes) assert.strictEqual(negotiation.askedForReferences(t), true, `should ask: ${t}`);
  for (const t of no) assert.strictEqual(negotiation.askedForReferences(t), false, `should not: ${t}`);
});

test('reply1 omits the references section by default', () => {
  const { body } = templates.reply1({ firstName: 'Dua', brandName: 'Acme' });
  assert.ok(!body.includes('Past content references'), 'no references block when not asked');
  assert.ok(!body.includes('instagram.com/'), 'no reference links leak in');
});

test('reply1 includes the references section (with links) when asked', () => {
  const { body } = templates.reply1({ firstName: 'Dua', brandName: 'Acme' }, { includeRefs: true });
  assert.ok(body.includes('**Past content references**'), 'references block present');
  assert.ok(
    body.includes('[@danyel.design](https://instagram.com/danyel.design)'),
    'reference handles are markdown links',
  );
});

// ── 3. Formatting: bold headers, sender salutation ──────────────────────────

test('reply1 bolds the section headers', () => {
  const { body } = templates.reply1({ firstName: 'Dua', brandName: 'Acme' });
  for (const h of ['**Content Style**', '**Deliverables & Rates**', '**Platforms**', '**Timelines**']) {
    assert.ok(body.includes(h), `expected bold header ${h}`);
  }
});

test('reply1 greets the salutation name, not always the creator', () => {
  const { body } = templates.reply1({ firstName: 'Dua', salutation: 'Anvith', brandName: 'Acme' });
  assert.ok(body.startsWith('Hi Anvith,'), 'greets the sender');
  // The subject still identifies the collaboration by the creator.
  const { subject } = templates.reply1({ firstName: 'Dua', salutation: 'Anvith', brandName: 'Acme' });
  assert.ok(subject.includes('Dua'), 'subject keeps the creator name');
});

test('reply1 falls back to the creator name when no salutation is given', () => {
  const { body } = templates.reply1({ firstName: 'Dua', brandName: 'Acme' });
  assert.ok(body.startsWith('Hi Dua,'));
});

test('REPLY2 template bolds its offer/payment headers', () => {
  assert.ok(templates.REPLY2_BODY.includes('**Payment details**'));
  assert.ok(templates.REPLY2_BODY.includes('**Option 1'));
  assert.ok(templates.REPLY2_BODY.includes('**Option 2'));
});

test('offer email (combine) reuses REPLY1 details but never the references', () => {
  const offer = { offer_type: 'video_based', num_videos: 2, flat_fee: 1500 };
  const { body } = templates.offerEmail(offer, { firstName: 'Dua', salutation: 'Anvith', brandName: 'Acme' }, { combine: true });
  assert.ok(body.startsWith('Hi Anvith,'), 'greets the sender in combine mode');
  assert.ok(!body.includes('Past content references'), 'offer email never introduces references');
});

test('offer email renders the video_bonus structure (base fee + bonus on threshold)', () => {
  const offer = {
    offer_type: 'video_bonus',
    num_videos: 3,
    base_fee: 9000,
    flat_per_video: 3000,
    bonus_amount: 2000,
    bonus_threshold_views: 5000000,
    flat_fee: 11000, // aggregate (base + bonus)
  };
  const { body } = templates.offerEmail(offer, { firstName: 'Dua', salutation: 'Dua', brandName: 'Acme' });
  assert.ok(body.includes('$9,000 flat for 3 videos'), 'states the base fee and video count');
  assert.ok(body.includes('$3,000 per video'), 'states the per-video rate');
  assert.ok(body.includes('$2,000 bonus'), 'states the bonus amount');
  assert.ok(body.includes('5,000,000 on Instagram'), 'states the bonus view threshold');
});

// ── 4. Delegate reply offer detection ───────────────────────────────────────

test('extractOfferAmount picks up "$10k" shorthand from a delegate reply', () => {
  assert.strictEqual(
    negotiation.extractOfferAmount("We'd love to offer $10k for 1 video."),
    10000,
  );
});

test('extractOfferAmount handles decimal-k, comma-separated, and bare dollars', () => {
  assert.strictEqual(negotiation.extractOfferAmount('Our budget is $5.5k'), 5500);
  assert.strictEqual(negotiation.extractOfferAmount('Offering $10,000 total'), 10000);
  assert.strictEqual(negotiation.extractOfferAmount('$1500 per reel works'), 1500);
});

test('extractOfferAmount picks the largest amount when multiple appear', () => {
  assert.strictEqual(
    negotiation.extractOfferAmount('$10k for 1 video, or $18k for 2 videos'),
    18000,
  );
});

test('extractOfferAmount returns null when the reply has no dollar amount', () => {
  assert.strictEqual(negotiation.extractOfferAmount('Thanks! Let me get back to you.'), null);
  assert.strictEqual(negotiation.extractOfferAmount(''), null);
  assert.strictEqual(negotiation.extractOfferAmount(null), null);
});
