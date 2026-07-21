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

test('thankYouMessage and politeCloseMessage include the creator name', () => {
  assert.match(replies.thankYouMessage('Sam'), /Sam/);
  assert.match(replies.politeCloseMessage('Sam'), /Sam/);
});
