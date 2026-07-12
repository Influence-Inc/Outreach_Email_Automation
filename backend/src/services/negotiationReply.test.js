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

// A creator's first_name can be more than one word (e.g. a compound name, a
// nickname phrase, an admin-typed override) — the greeting must use it
// VERBATIM, never truncated to its first token.
test('salutationFor greets a multi-word first_name verbatim when the creator replies themselves', () => {
  assert.strictEqual(negotiation.salutationFor('Anvith K', 'Sounds great, tell me more!'), 'Anvith K');
  assert.strictEqual(negotiation.salutationFor('Anvith K', ''), 'Anvith K');
});

test('salutationFor still recognizes the creator signing with just their first token of a multi-word name', () => {
  // first_name = "Anvith K", but the creator signs with only "Anvith" — this
  // must still be read as the SAME person, greeted by the FULL stored name,
  // not the single-token signature.
  assert.strictEqual(
    negotiation.salutationFor('Anvith K', "Sounds great, let's do it!\n- Anvith"),
    'Anvith K',
  );
});

test('salutationFor still detects a distinct sender when the creator has a multi-word first_name', () => {
  assert.strictEqual(
    negotiation.salutationFor('Anvith K', "Hi, this is Priya, Anvith's manager. He's interested!"),
    'Priya',
  );
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
    'do you have any case studies?',
    'brands you\'ve worked with?',
    'have you partnered with other creators before?',
    // Loose verb tense: no "'ve"/"have", present tense "collaborated" — a
    // creator asking to see who we've worked with, phrased as a question.
    'what are the previous creators you collaborated with?',
    'can I get some reference videos for content creativity and ideas?',
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

// Regression: a prior version of askedForReferences had bare-word triggers
// (standalone "reference", "other creators", "showcase", "samples of" with no
// object) that fired on completely unrelated replies — leaking the reference
// list into emails that never asked for it. Each of these phrases contains one
// of those old trigger words/phrases in a context that is NOT a references ask.
test('askedForReferences does NOT fire on unrelated mentions of its old bare-word triggers', () => {
  const shouldNotFire = [
    // bare "other creators" with no "worked with" tied to US
    "I've worked with other creators before, this looks fun!",
    'we\'ve worked with brands before and loved it',
    // bare "reference" with no share/send/provide ask
    'she referenced your work ethic in her review',
    'my manager can be a good reference for communication',
    // bare "showcase" describing the creator's OWN content, not asking for ours
    'I love to showcase brands I genuinely use in my content',
    // "sample/samples of" attached to something that isn't our past work
    "here's a sample of what I usually charge",
    // "any work you" with no "worked with" — talking about OUR needs, not
    // asking to see our past work
    'let me know if there is any work you need from me before we start',
  ];
  for (const t of shouldNotFire) {
    assert.strictEqual(negotiation.askedForReferences(t), false, `should NOT ask: ${t}`);
  }
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

// ── References-only reply (shared directly, no full details re-send) ───────

test('referencesReply shares the reference accounts with clickable links', () => {
  const { body } = templates.referencesReply({ firstName: 'Dua', managerName: 'Jennifer' });
  assert.ok(body.includes('**Past content references**'), 'references block present');
  assert.ok(
    body.includes('[@danyel.design](https://instagram.com/danyel.design)'),
    'reference handles are markdown links',
  );
  assert.ok(body.includes('- Jennifer'), 'signed by the manager');
});

test('referencesReply does NOT re-send the REPLY 1 details pitch', () => {
  const { body } = templates.referencesReply({ firstName: 'Dua', brandName: 'Acme' });
  // The whole point: answer the reference ask WITHOUT dumping the details again.
  assert.ok(!body.includes('**Deliverables & Rates**'), 'no deliverables pitch');
  assert.ok(!body.includes('**Platforms**'), 'no platforms section');
  assert.ok(!body.includes('**Timelines**'), 'no timelines section');
});

// ── Contract email personalization (optional ackLine) ──────────────────────

test('contractEmail is the plain fixed copy when no ackLine is given', () => {
  const { body } = templates.contractEmail({ firstName: 'Dua', managerName: 'Jennifer', url: 'https://x/c/1' });
  assert.ok(body.startsWith('Hi Dua,\n\nHere\'s the contract'), 'greeting flows straight into the contract line');
  assert.ok(body.includes('https://x/c/1'), 'the signing link is present');
});

test('contractEmail inserts the acknowledgment line after the greeting, keeping the link/terms', () => {
  const { body } = templates.contractEmail({
    firstName: 'Dua',
    managerName: 'Jennifer',
    url: 'https://x/c/1',
    ackLine: 'So glad the timeline works for you!',
  });
  assert.ok(
    body.startsWith('Hi Dua,\n\nSo glad the timeline works for you!\n\nHere\'s the contract'),
    'the ack line sits between the greeting and the contract line',
  );
  assert.ok(body.includes('https://x/c/1'), 'the signing link is unchanged');
  assert.ok(body.includes('- Jennifer'), 'the sign-off is unchanged');
});

test('contractEmail ignores a blank ackLine (no stray blank lines)', () => {
  const plain = templates.contractEmail({ firstName: 'Dua', url: 'u' }).body;
  const blanked = templates.contractEmail({ firstName: 'Dua', url: 'u', ackLine: '   ' }).body;
  assert.strictEqual(blanked, plain, 'a whitespace-only ackLine leaves the email identical');
});

// ── Usage Rights section (campaign usage_rights_policy) ────────────────────

test('reply1 includes the Usage Rights section by default (no_rights policy)', () => {
  const { body } = templates.reply1({ firstName: 'Dua', brandName: 'Acme' });
  assert.ok(body.includes('**Usage Rights**'), 'usage rights block present by default');
  assert.ok(
    body.includes('No exclusivity or ad rights are required'),
    'states no ad rights required',
  );
  assert.ok(body.includes('Acme cannot use it for paid ads'), 'names the brand');
});

test('reply1 omits the Usage Rights section when includeUsageRights is false (free_only / required policy)', () => {
  const { body } = templates.reply1(
    { firstName: 'Dua', brandName: 'Acme' },
    { includeUsageRights: false },
  );
  assert.ok(!body.includes('**Usage Rights**'), 'no usage rights header');
  assert.ok(!body.includes('No exclusivity or ad rights are required'), 'no disclaimer leaks in');
});

test('reply1 keeps other sections intact when Usage Rights is stripped', () => {
  const { body } = templates.reply1(
    { firstName: 'Dua', brandName: 'Acme' },
    { includeUsageRights: false },
  );
  for (const h of ['**Content Style**', '**Deliverables & Rates**', '**Platforms**', '**Timelines**']) {
    assert.ok(body.includes(h), `expected bold header ${h} to survive stripping Usage Rights`);
  }
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

// ── 3.5. Multi-rate extraction — the creator quotes a tiered menu ──────────
// Creators frequently list several rates in one reply. We store every rate
// they name, with the surrounding text as a label, so the dashboard's Status
// column can show every option instead of collapsing to one number.

test('parseRateOptionsFromText captures each tier of a bulleted view-based ladder', () => {
  const inbound = [
    "I'm open to a viewership-based structure, but I would need more upside:",
    '- $3,500 for 300,000 combined views',
    '- $5,000 for 600,000 combined views',
    '- $7,500 for 1,000,000 combined views',
    '',
    'Let me know if this could work on your end.',
  ].join('\n');
  const options = negotiation.parseRateOptionsFromText(inbound);
  assert.deepStrictEqual(
    options.map((o) => o.amount),
    [3500, 5000, 7500],
    'all three tier amounts extracted in order',
  );
  assert.ok(options[0].label.includes('300,000'), 'first label carries "300,000 views" context');
  assert.ok(options[2].label.includes('1,000,000'), 'third label carries "1,000,000 views" context');
  // The list marker "- " must be stripped from the labels.
  assert.ok(!options.some((o) => o.label.startsWith('-')), 'labels do not carry list markers');
});

test('parseRateOptionsFromText captures inline "$X per reel, $Y for a package" phrasing', () => {
  const inbound =
    "My rate is $900 per reel, but for a package of 3 this month I can work at $2,500 total. Let's do it!";
  const options = negotiation.parseRateOptionsFromText(inbound);
  assert.deepStrictEqual(
    options.map((o) => o.amount),
    [900, 2500],
    'both the per-reel and the package rate are captured',
  );
  assert.ok(/per reel/i.test(options[0].label), 'per-reel label preserved');
  assert.ok(/package of 3|2,500 total/i.test(options[1].label), 'package label preserved');
});

test('parseRateOptionsFromText returns [] when no dollar amount appears', () => {
  assert.deepStrictEqual(negotiation.parseRateOptionsFromText('Sounds great, tell me more!'), []);
  assert.deepStrictEqual(negotiation.parseRateOptionsFromText(''), []);
  assert.deepStrictEqual(negotiation.parseRateOptionsFromText(null), []);
});

test('parseRateOptionsFromText dedupes exact repeats of the same amount + label', () => {
  const inbound = 'My rate is $1,500. My rate is $1,500.';
  const options = negotiation.parseRateOptionsFromText(inbound);
  assert.strictEqual(options.length, 1, 'duplicates collapse to a single entry');
});

test('parseRateOptionsFromText caps very long labels so the dropdown stays compact', () => {
  const long = 'X'.repeat(300);
  const inbound = `${long} $500 ${long}`;
  const options = negotiation.parseRateOptionsFromText(inbound);
  assert.strictEqual(options.length, 1);
  assert.ok(options[0].label.length <= 120, `label capped at 120 chars, got ${options[0].label.length}`);
});

test('parseRateOptionsFromText ignores rates buried in the quoted reply history', () => {
  // A single-rate reply from the creator with our earlier offers quoted below
  // in the mail client's history block. Only the creator's own $3,500 should be
  // extracted — the two quoted $3,000 lines are ours, not a rate menu.
  const inbound = [
    'Would you be open to meeting at $3,500 for 500,000 combined Instagram views?',
    '',
    'Best,',
    'Joe',
    '',
    'On Wed, Jul 8, 2026 at 10:40 AM Jennifer wrote:',
    '> *View-Based Offer ($3,000)*',
    '> - $3,000 for a minimum of 500,000 combined total views on Instagram.',
  ].join('\n');
  const options = negotiation.parseRateOptionsFromText(inbound);
  assert.deepStrictEqual(
    options.map((o) => o.amount),
    [3500],
    'only the creator-stated rate is captured, not the quoted offers',
  );
  assert.ok(!options.some((o) => o.label.includes('>')), 'no quoted-line markers leak into labels');
  // The single-rate parser must also skip the quoted amounts.
  assert.strictEqual(negotiation.parseRateFromText(inbound), 3500);
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

// ── 5. "Creator asks us to quote first" detection ───────────────────────────

test('asksUsToQuoteFirst detects the creator turning the rate question back on us', () => {
  const yes = [
    'Thanks for the details. Can you quote a fair rate yourself first?',
    "What's your budget for this?",
    'What are you offering?',
    'Make me an offer and we can go from there.',
    'What do you usually pay for a reel like this?',
    'You tell me a number that works for you.',
    'Could you propose a rate first?',
  ];
  for (const t of yes) assert.strictEqual(negotiation.asksUsToQuoteFirst(t), true, `should detect: ${t}`);
});

test('asksUsToQuoteFirst does NOT fire when the creator states their own rate or just chats', () => {
  const no = [
    'My rate is $1500 per video.',
    'Sounds great, tell me more about the deliverables!',
    'When do I get paid?',
    'That offer is too low for me.',
    '',
    null,
  ];
  for (const t of no) assert.strictEqual(negotiation.asksUsToQuoteFirst(t), false, `should not fire: ${t}`);
});

// ── Offer email formatting (the "Reply 2" the user meant) ───────────────────

test('describeOffer bolds the offer-type header for a view-based offer', () => {
  const out = templates.describeOffer(
    { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 500000 },
    'Acme',
  );
  assert.ok(out.includes('**View-Based Offer ($1,500)**'), 'bold view-based header');
});

// View-based deals are priced by TOTAL guaranteed views — the creator decides
// how many posts to publish. The email must not name a specific video count
// or use per-video framing anywhere ("the first video", "further videos",
// "N-video package"), or the deal reads as bounded to a fixed post count
// when it isn't.
test('describeOffer view_based body does NOT mention any video count', () => {
  const out = templates.describeOffer(
    { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 500000 },
    'Acme',
  );
  assert.ok(!/first video/i.test(out), 'no "first video" language');
  assert.ok(!/further videos/i.test(out), 'no "further videos" language');
  assert.ok(!/\b\d+\s*video/i.test(out), 'no "N video(s)" count language');
});

test('offerEmail combine mode for view_based does NOT use the video-package REPLY 1', () => {
  const offer = { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 500000 };
  const { body } = templates.offerEmail(
    offer,
    { firstName: 'Dua', salutation: 'Dua', brandName: 'Acme' },
    { combine: true },
  );
  // The default REPLY 1 body says "we'd love to do a 2 or more video package"
  // — for a view-based offer this is exactly the wrong framing.
  assert.ok(!/\d+\s*or more video package/i.test(body), 'no "N or more video package" copy');
  assert.ok(!/\bvideo package\b/i.test(body), 'no "video package" copy at all in view_based combine');
  // But it must still cover the collab details (single, combined email).
  assert.ok(body.includes('**Content Style**'), 'view_based combine still opens with content-style details');
  assert.ok(body.includes('**View-Based Offer'), 'view_based combine still presents the approved offer');
});

test('describeOffer bolds the offer-type header for a flat package', () => {
  const out = templates.describeOffer({ offer_type: 'video_based', num_videos: 2, flat_fee: 1600 }, 'Acme');
  assert.ok(out.includes('**Flat Package ($1,600)**'), 'bold flat-package header');
});

test('offer email keeps the bold Payment details header', () => {
  const { body } = templates.offerEmail(
    { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 500000 },
    { firstName: 'Dua', brandName: 'Acme' },
  );
  assert.ok(body.includes('**Payment details**'), 'bold payment header present in the sent offer');
});

test('describeOffer bolds the header for a video_bonus offer', () => {
  const out = templates.describeOffer(
    { offer_type: 'video_bonus', num_videos: 3, base_fee: 9000, flat_per_video: 3000, bonus_amount: 2000, bonus_threshold_views: 5000000, flat_fee: 11000 },
    'Acme',
  );
  assert.ok(out.includes('**Flat Package + Performance Bonus**'), 'bold bonus header');
  // Main's structural facts still intact after adding the header.
  assert.ok(out.includes('$9,000 flat for 3 videos'));
  assert.ok(out.includes('$2,000 bonus'));
});
