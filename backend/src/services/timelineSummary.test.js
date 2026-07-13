'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  summarizeMessage,
  deliverableFromLabel,
  deliverableForAmount,
} = require('./timelineSummary');

// ── summarizeMessage ────────────────────────────────────────────────────────

test('summarizeMessage drops the greeting and keeps the first sentence', () => {
  const s = summarizeMessage("Hi Jennifer, this sounds great! What did you have in mind?");
  assert.strictEqual(s, 'this sounds great!');
});

test('summarizeMessage strips quoted reply history', () => {
  const body = [
    'Sounds good, let us do it.',
    '',
    'On Mon, Jan 1, 2026 at 10:00 AM Jennifer wrote:',
    '> Here is our offer of $3,000',
  ].join('\n');
  assert.strictEqual(summarizeMessage(body), 'Sounds good, let us do it.');
});

test('summarizeMessage truncates a long single sentence on a word boundary', () => {
  const long =
    'I would absolutely love to collaborate with your brand on this campaign because it aligns perfectly with my audience and content style';
  const s = summarizeMessage(long, { maxLen: 40 });
  assert.ok(s.endsWith('…'), 'ends with ellipsis');
  assert.ok(s.length <= 41, `stays within cap, got ${s.length}`);
  assert.ok(!/\s\S+…$/.test(s) || !s.includes('  '), 'no mid-word cut leftovers');
});

test('summarizeMessage returns empty for a greeting-only message', () => {
  assert.strictEqual(summarizeMessage('Hi there,'), '');
  assert.strictEqual(summarizeMessage('   '), '');
  assert.strictEqual(summarizeMessage(null), '');
});

// ── deliverableFromLabel ────────────────────────────────────────────────────

test('deliverableFromLabel extracts the deliverable after the amount', () => {
  assert.strictEqual(
    deliverableFromLabel('$3,500 for 300,000 combined views', 3500),
    'for 300,000 combined views',
  );
  assert.strictEqual(deliverableFromLabel('I can do $900 per reel', 900), 'per reel');
  assert.strictEqual(deliverableFromLabel('$2,500 total for 3 reels', 2500), 'total for 3 reels');
});

test('deliverableFromLabel prefixes a bare deliverable noun phrase with "for"', () => {
  assert.strictEqual(deliverableFromLabel('$3,500, 300k views', 3500), 'for 300k views');
});

test('deliverableFromLabel returns empty when the label is just the amount', () => {
  assert.strictEqual(deliverableFromLabel('$3,500', 3500), '');
  assert.strictEqual(deliverableFromLabel('', 3500), '');
});

// ── deliverableForAmount ────────────────────────────────────────────────────

test('deliverableForAmount mines the deliverable from the reply text', () => {
  const reply = 'Thanks! My rate is $3,500 for 300,000 combined views.';
  assert.strictEqual(deliverableForAmount(reply, 3500), 'for 300,000 combined views');
});

test('deliverableForAmount matches the right tier when several rates are quoted', () => {
  const reply = [
    '$3,500 for 300,000 combined views',
    '$5,000 for 600,000 combined views',
  ].join('\n');
  assert.strictEqual(deliverableForAmount(reply, 5000), 'for 600,000 combined views');
});

test('deliverableForAmount returns empty when nothing is derivable', () => {
  assert.strictEqual(deliverableForAmount('My rate is $3,500.', 3500), '');
  assert.strictEqual(deliverableForAmount('', 3500), '');
  assert.strictEqual(deliverableForAmount('Sounds good!', null), '');
});
