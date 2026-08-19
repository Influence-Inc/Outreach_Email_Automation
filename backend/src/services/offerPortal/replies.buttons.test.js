'use strict';

// Meta echoes a tapped reply button's TITLE back as the inbound message body, so
// a button's wording IS the input to the classifier. Rewording one without
// checking is how "Not right now" would quietly start reading as interest. These
// pin every title to the intent it promises, and guard Meta's hard limits (3
// buttons, 20-character titles) which reject the whole send when exceeded.

const test = require('node:test');
const assert = require('node:assert');

const {
  INTEREST_BUTTONS,
  INTEREST_FALLBACK_HINT,
  OFFER_BUTTONS,
  OFFER_FALLBACK_HINT,
  classifyInterest,
  classifyReply,
  renderMessagingBrief,
  startsWithGreeting,
} = require('./replies');
const { MAX_BUTTONS, BUTTON_TITLE_MAX } = require('./whatsapp');

test('every button title fits Meta\'s limits', () => {
  for (const set of [INTEREST_BUTTONS, OFFER_BUTTONS]) {
    assert.ok(set.length <= MAX_BUTTONS, `at most ${MAX_BUTTONS} buttons`);
    for (const b of set) {
      assert.ok(b.id, 'each button needs an id');
      assert.ok(
        b.title.length <= BUTTON_TITLE_MAX,
        `"${b.title}" is ${b.title.length} chars, over the ${BUTTON_TITLE_MAX} limit`,
      );
    }
  }
});

test('interest buttons classify as the intent they promise', () => {
  const [yes, no] = INTEREST_BUTTONS;
  assert.strictEqual(classifyInterest(yes.title), 'accept');
  assert.strictEqual(classifyInterest(no.title), 'decline');
});

test('offer buttons classify as a binding accept / decline', () => {
  const [accept, decline] = OFFER_BUTTONS;
  assert.strictEqual(classifyReply(accept.title), 'accept');
  assert.strictEqual(classifyReply(decline.title), 'decline');
});

test('the written-out fallbacks classify the same way as the buttons', () => {
  // Twilio and iMessage get the hint instead of buttons, so a creator typing the
  // words it names must land on the same branch as a tap.
  assert.ok(/yes/i.test(INTEREST_FALLBACK_HINT) && /no/i.test(INTEREST_FALLBACK_HINT));
  assert.strictEqual(classifyInterest('Yes'), 'accept');
  assert.strictEqual(classifyInterest('No'), 'decline');
  assert.ok(/accept/i.test(OFFER_FALLBACK_HINT) && /decline/i.test(OFFER_FALLBACK_HINT));
  assert.strictEqual(classifyReply('Accept'), 'accept');
  assert.strictEqual(classifyReply('Decline'), 'decline');
});

// --- brief copy -------------------------------------------------------------

test('a campaign brief that already greets the creator is not greeted twice', () => {
  const custom = 'Hi Himanshu,\nNetflix is running a paid collaboration.\n\nJennifer\nHead of Partnerships';
  const out = renderMessagingBrief('Himanshu', custom);
  assert.strictEqual(out.match(/Hi Himanshu/g).length, 1, 'exactly one greeting');
  assert.ok(!out.includes('this is INFLUENCE'), 'the custom copy owns the opener');
});

test('a bare blurb still gets our greeting, on its own line', () => {
  const out = renderMessagingBrief('Sam', 'Netflix is running a paid collaboration.');
  assert.ok(out.startsWith('Hi Sam, this is INFLUENCE.'));
  assert.ok(out.includes('INFLUENCE.\n\nNetflix'), 'greeting and blurb are separate blocks');
});

test('the interest question is never glued onto the end of a sign-off', () => {
  const out = renderMessagingBrief('Sam', 'Netflix is hiring creators.\n\nJennifer\nHead of Partnerships');
  assert.ok(out.includes('Partnerships\n\nInterested in hearing more?'));
  assert.ok(!/Partnerships Interested/.test(out));
});

test('the yes/no prompt is left to the buttons, not baked into the brief', () => {
  const out = renderMessagingBrief('Sam', 'Netflix is hiring creators.');
  assert.ok(out.endsWith('Interested in hearing more?'));
  assert.ok(!/reply yes or no/i.test(out), 'the hint is added only where buttons are unavailable');
});

test('startsWithGreeting recognises the common openers and nothing else', () => {
  for (const open of ['Hi Sam,', 'Hey there', 'Hello!', 'Dear Sam', 'Good morning Sam', 'Sam — quick one']) {
    assert.strictEqual(startsWithGreeting(open, 'Sam'), true, open);
  }
  assert.strictEqual(startsWithGreeting('Netflix is running a campaign.', 'Sam'), false);
});
