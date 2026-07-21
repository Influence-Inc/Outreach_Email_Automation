'use strict';

// Run with: npm test  (node --test)
//
// Guards the needs-review inbox API's response shaping: the display name
// fallback chain and the row → JSON mapping the dashboard renders.
const test = require('node:test');
const assert = require('node:assert');
const review = require('./offerReview');

test('displayName prefers first name, then full name, then @handle', () => {
  assert.strictEqual(review.displayName({ first_name: 'Sam', full_name: 'Sam Lee', instagram_username: 'sammy' }), 'Sam');
  assert.strictEqual(review.displayName({ full_name: 'Sam Lee', instagram_username: 'sammy' }), 'Sam Lee');
  assert.strictEqual(review.displayName({ instagram_username: 'sammy' }), '@sammy');
  assert.strictEqual(review.displayName({}), 'Creator');
});

test('formatRow maps a flagged message row to the inbox shape', () => {
  const row = {
    id: 7,
    creator_id: 42,
    channel: 'whatsapp',
    body: 'can you do $500?',
    sent_at: '2026-07-21T10:00:00Z',
    offer_id: 3,
    first_name: 'Sam',
    full_name: null,
    instagram_username: 'sammy',
    offer_token: 'tok123',
    offer_status: 'pending',
    offer_rate: '300.00',
    offer_currency: 'USD',
  };
  const out = review.formatRow(row);
  assert.strictEqual(out.id, 7);
  assert.strictEqual(out.creatorId, 42);
  assert.strictEqual(out.name, 'Sam');
  assert.strictEqual(out.handle, '@sammy');
  assert.strictEqual(out.channel, 'whatsapp');
  assert.strictEqual(out.body, 'can you do $500?');
  assert.strictEqual(out.offer.status, 'pending');
  assert.strictEqual(out.offer.rate, 300); // numeric, not "300.00"
  assert.strictEqual(out.offer.currency, 'USD');
  assert.match(out.offer.url, /\/o\/tok123$/);
});

test('formatRow tolerates a message with no linked offer', () => {
  const out = review.formatRow({
    id: 8,
    creator_id: 1,
    channel: 'imessage',
    body: 'hello?',
    sent_at: '2026-07-21T10:00:00Z',
    instagram_username: 'x',
    offer_token: null,
  });
  assert.strictEqual(out.offer, null);
});
