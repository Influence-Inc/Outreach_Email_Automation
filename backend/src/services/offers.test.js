'use strict';

// Run with: npm test  (node --test)
//
// Guards preferredMessagingChannel: when a creator has both a WhatsApp and
// iMessage number on file, outreach/follow-up sends must pick exactly ONE
// channel (WhatsApp preferred — broader device reach than iMessage's
// iPhone-only), never both, so a creator with both isn't double-texted.
const test = require('node:test');
const assert = require('node:assert');
const offers = require('./offers');

test('preferredMessagingChannel picks WhatsApp when both numbers are present', () => {
  assert.strictEqual(
    offers.preferredMessagingChannel({ whatsapp: '+15556667777', imessage: '+15556667777' }),
    'whatsapp',
  );
});

test('preferredMessagingChannel falls back to iMessage when only that number is present', () => {
  assert.strictEqual(offers.preferredMessagingChannel({ whatsapp: null, imessage: '+15556667777' }), 'imessage');
  assert.strictEqual(offers.preferredMessagingChannel({ imessage: '+15556667777' }), 'imessage');
});

test('preferredMessagingChannel picks WhatsApp when only that number is present', () => {
  assert.strictEqual(offers.preferredMessagingChannel({ whatsapp: '+15556667777', imessage: null }), 'whatsapp');
});

test('preferredMessagingChannel returns null when neither number is present', () => {
  assert.strictEqual(offers.preferredMessagingChannel({}), null);
  assert.strictEqual(offers.preferredMessagingChannel({ whatsapp: null, imessage: null }), null);
});
