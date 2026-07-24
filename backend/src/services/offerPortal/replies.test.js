'use strict';

// Run with: npm test  (node --test)
//
// Guards the offer-portal reply bot's pure logic: intent classification, the
// counter-rate parser that routes a messaged "can you do $500?" into the CPM
// engine, and the canned reply bodies.
const test = require('node:test');
const assert = require('node:assert');
const replies = require('./replies');

// --- classifyReply ---------------------------------------------------------

test('classifyReply detects accept intent', () => {
  for (const w of ['yes', 'Yes!', 'accept', 'accepted', "I'm in", 'confirm']) {
    assert.strictEqual(replies.classifyReply(w), 'accept', `"${w}" should be accept`);
  }
});

test('classifyReply detects decline intent', () => {
  for (const w of ['no', 'No thanks', 'decline', 'pass', 'not interested']) {
    assert.strictEqual(replies.classifyReply(w), 'decline', `"${w}" should be decline`);
  }
});

test('classifyReply returns other for ambiguous / empty / both', () => {
  assert.strictEqual(replies.classifyReply('can you do $500?'), 'other');
  assert.strictEqual(replies.classifyReply(''), 'other');
  assert.strictEqual(replies.classifyReply('yes but no'), 'other'); // both → human review
});

test('classifyReply does not trip on substrings (instagram / notice)', () => {
  assert.strictEqual(replies.classifyReply('check my instagram'), 'other'); // not "in"
  assert.strictEqual(replies.classifyReply('I got your notice'), 'other'); // not "no"
});

// --- classifyInterest (lenient brief-stage yes/no) -------------------------

test('classifyInterest reads casual affirmatives as interested', () => {
  for (const w of ['yes', 'Sure!', 'ok', 'Okay', 'interested', 'tell me more', 'how much?', "I'm in", 'yeah sounds good']) {
    assert.strictEqual(replies.classifyInterest(w), 'accept', `"${w}" should be interested`);
  }
});

test('classifyInterest reads negatives as not interested', () => {
  for (const w of ['no', 'Nope', 'nah', 'pass', 'not interested', 'No thanks', 'not a fit', 'maybe later']) {
    assert.strictEqual(replies.classifyInterest(w), 'decline', `"${w}" should be not interested`);
  }
});

test('classifyInterest: "not interested" is a decline despite containing "interested"', () => {
  // The yes-word "interested" is a substring of "not interested"; the strong
  // multi-word decline must still win.
  assert.strictEqual(replies.classifyInterest('not interested'), 'decline');
});

test('classifyInterest falls to other (a safe Yes/No nudge) when ambiguous', () => {
  // A false decline would close a live deal, so mixed/unclear stays 'other'.
  assert.strictEqual(replies.classifyInterest('hmm'), 'other');
  assert.strictEqual(replies.classifyInterest('what is this'), 'other');
  assert.strictEqual(replies.classifyInterest(''), 'other');
});

// --- parseRequestedRate ----------------------------------------------------

test('parseRequestedRate reads a currency-marked amount', () => {
  assert.strictEqual(replies.parseRequestedRate('can you do $500?'), 500);
  assert.strictEqual(replies.parseRequestedRate('$1,200'), 1200);
  assert.strictEqual(replies.parseRequestedRate('500 dollars'), 500);
  assert.strictEqual(replies.parseRequestedRate('₹5000'), 5000);
  assert.strictEqual(replies.parseRequestedRate('rs 5000'), 5000);
  assert.strictEqual(replies.parseRequestedRate('$40'), 40); // explicit currency, no floor
});

test('parseRequestedRate reads a bare number or number with price intent', () => {
  assert.strictEqual(replies.parseRequestedRate('1200'), 1200);
  assert.strictEqual(replies.parseRequestedRate('how about 750'), 750);
  assert.strictEqual(replies.parseRequestedRate('do 600 for it'), 600);
});

test('parseRequestedRate returns null when there is no monetary ask', () => {
  assert.strictEqual(replies.parseRequestedRate('yes'), null);
  assert.strictEqual(replies.parseRequestedRate('2 reels sounds good'), null); // count, not a rate
  assert.strictEqual(replies.parseRequestedRate('do 40'), null); // sub-floor bare number
  assert.strictEqual(replies.parseRequestedRate(''), null);
});

// --- opt-out / opt-in (compliance) -----------------------------------------

test('isOptOut matches canonical STOP/UNSUBSCRIBE keywords', () => {
  for (const w of ['STOP', 'stop', 'Stop.', 'unsubscribe', 'please unsubscribe me', 'opt out', 'CANCEL']) {
    assert.strictEqual(replies.isOptOut(w), true, `"${w}" should opt out`);
  }
});

test('isOptOut does not trip on "stop" inside a normal sentence', () => {
  assert.strictEqual(replies.isOptOut('stop by anytime'), false);
  assert.strictEqual(replies.isOptOut('yes'), false);
  assert.strictEqual(replies.isOptOut(''), false);
});

test('isOptIn matches START/RESUME keywords', () => {
  for (const w of ['START', 'start', 'resume', 'unstop', 'opt in']) {
    assert.strictEqual(replies.isOptIn(w), true, `"${w}" should opt in`);
  }
  assert.strictEqual(replies.isOptIn('getting started with reels'), false);
});

// --- reply bodies ----------------------------------------------------------

test('tooHighReply names the creator and the current rate', () => {
  const msg = replies.tooHighReply('Sam', '$300');
  assert.match(msg, /Sam/);
  assert.match(msg, /\$300/);
});

test('renderMessagingBrief greets by name, includes the blurb, and ends with a yes/no CTA', () => {
  const msg = replies.renderMessagingBrief('Sam', 'Acme makes eco-friendly water bottles.');
  assert.match(msg, /^Hi Sam,/);
  assert.match(msg, /Acme makes eco-friendly water bottles\./);
  assert.match(msg, /Reply Yes or No/);
});

test('interestClarificationMessage nudges toward Yes/No, not the generic deflection', () => {
  const msg = replies.interestClarificationMessage('Sam');
  assert.match(msg, /Sam/);
  assert.match(msg, /Yes/);
  assert.match(msg, /No/);
  assert.doesNotMatch(msg, /jennifer@useinfluence\.xyz/); // that's DEFLECTION_MESSAGE's job, not this one
});

test('firstContactHoldingMessage is warm and does not read as a support brush-off', () => {
  const msg = replies.firstContactHoldingMessage('Sam');
  assert.match(msg, /Sam/);
  assert.match(msg, /shortly/i);
  assert.doesNotMatch(msg, /jennifer@useinfluence\.xyz/); // not the support deflection
});

test('thankYouMessage and politeCloseMessage include the creator name', () => {
  assert.match(replies.thankYouMessage('Sam'), /Sam/);
  assert.match(replies.politeCloseMessage('Sam'), /Sam/);
});
