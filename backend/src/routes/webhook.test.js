'use strict';

// Run with: npm test  (node --test)
//
// Guards the Instantly webhook's payload parsing for the email_sent (follow-up)
// flow: the event classification and the defensive field extraction that lets
// "outreach sent" progress to "follow up sent" when Instantly sends Step 2+.
const test = require('node:test');
const assert = require('node:assert');
const webhook = require('./webhook');

test('SENT_EVENTS recognises Instantly email_sent event names', () => {
  assert.strictEqual(webhook.SENT_EVENTS.has('email_sent'), true);
  assert.strictEqual(webhook.SENT_EVENTS.has('lead_email_sent'), true);
  // A reply event must NOT be treated as a send.
  assert.strictEqual(webhook.SENT_EVENTS.has('reply_received'), false);
});

test('pickStep reads the step from the common Instantly aliases', () => {
  assert.strictEqual(webhook.pickStep({ step: 2 }), 2);
  assert.strictEqual(webhook.pickStep({ step_number: 3 }), 3);
  assert.strictEqual(webhook.pickStep({ email_seq_number: 2 }), 2);
  assert.strictEqual(webhook.pickStep({ email: { step: 2 } }), 2);
  // JSON often carries the number as a string.
  assert.strictEqual(webhook.pickStep({ step: '2' }), 2);
});

test('pickStep returns null when no step field is present', () => {
  assert.strictEqual(webhook.pickStep({ campaign_id: 'x' }), null);
  assert.strictEqual(webhook.pickStep({ step: 'not-a-number' }), null);
});

test('pickStep preserves step 1 (outreach) so it is not mistaken for a follow-up', () => {
  // markFollowupSent relies on step 1 being distinguishable from step 2+.
  assert.strictEqual(webhook.pickStep({ step: 1 }), 1);
});

test('pickSentMessageId reads the sent message id defensively', () => {
  assert.strictEqual(webhook.pickSentMessageId({ message_id: 'abc' }), 'abc');
  assert.strictEqual(webhook.pickSentMessageId({ email_id: 'def' }), 'def');
  assert.strictEqual(webhook.pickSentMessageId({ email: { id: 'ghi' } }), 'ghi');
  assert.strictEqual(webhook.pickSentMessageId({}), null);
});
