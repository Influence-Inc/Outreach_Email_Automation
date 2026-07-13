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

test('pickIsFirst reads the is_first flag defensively and only true is truthy', () => {
  assert.strictEqual(webhook.pickIsFirst({ is_first: true }), true);
  assert.strictEqual(webhook.pickIsFirst({ isFirst: true }), true);
  assert.strictEqual(webhook.pickIsFirst({ email: { is_first: true } }), true);
  assert.strictEqual(webhook.pickIsFirst({ is_first: false }), false);
  assert.strictEqual(webhook.pickIsFirst({}), false);
  // Truthy-but-not-boolean-true values must not accidentally hard-block.
  assert.strictEqual(webhook.pickIsFirst({ is_first: 'true' }), false);
});

test('pickSentMessageId reads the sent message id defensively', () => {
  assert.strictEqual(webhook.pickSentMessageId({ message_id: 'abc' }), 'abc');
  assert.strictEqual(webhook.pickSentMessageId({ email_id: 'def' }), 'def');
  assert.strictEqual(webhook.pickSentMessageId({ email: { id: 'ghi' } }), 'ghi');
  assert.strictEqual(webhook.pickSentMessageId({}), null);
});

// email_opened webhooks are read receipts for the Deal Studio outreach ticks
// (see outreachTicksFor in app.js). They must NOT be confused with an actual
// send or a reply, or the tick would jump straight from single-gray to something
// misleading.
test('OPEN_EVENTS recognises Instantly email_opened event names', () => {
  assert.strictEqual(webhook.OPEN_EVENTS.has('email_opened'), true);
  assert.strictEqual(webhook.OPEN_EVENTS.has('lead_opened'), true);
  assert.strictEqual(webhook.OPEN_EVENTS.has('opened'), true);
});

test('OPEN_EVENTS is disjoint from send + reply event sets', () => {
  // A send is not an open, and an open is not a send / reply. If any of these
  // overlapped, the same webhook would fire two handlers on the same event.
  for (const t of webhook.OPEN_EVENTS) {
    assert.strictEqual(webhook.SENT_EVENTS.has(t), false, `${t} must not be a send event`);
    assert.strictEqual(webhook.REPLY_EVENTS.has(t), false, `${t} must not be a reply event`);
  }
});

// isCreatorPastInitialOutreach flips the email_sent handler between "this is a
// campaign follow-up" and "this is a manual reply someone just typed" — the
// distinction that turns an otherwise-silent send into a timeline entry.
test('isCreatorPastInitialOutreach: outreach_sent with no negotiation is still the initial send', () => {
  assert.strictEqual(
    webhook.isCreatorPastInitialOutreach({ status: 'outreach_sent', negotiation_status: null }),
    false,
  );
});

test('isCreatorPastInitialOutreach: creator has replied → manual reply territory', () => {
  assert.strictEqual(
    webhook.isCreatorPastInitialOutreach({ status: 'replied', negotiation_status: null }),
    true,
  );
});

test('isCreatorPastInitialOutreach: follow-up already sent → manual reply territory', () => {
  assert.strictEqual(
    webhook.isCreatorPastInitialOutreach({ status: 'followup_sent', negotiation_status: null }),
    true,
  );
});

test('isCreatorPastInitialOutreach: any negotiation stage past outreach counts', () => {
  for (const stage of ['AWAITING_RATE', 'AWAITING_APPROVAL', 'AWAITING_DECISION', 'ACCEPTED']) {
    assert.strictEqual(
      webhook.isCreatorPastInitialOutreach({ status: 'outreach_sent', negotiation_status: stage }),
      true,
      stage,
    );
  }
});

// pickSentBody is the defensive alias reader for a manual reply's plain-text
// body — same posture as pickReplyText for inbound replies.
test('pickSentBody reads the sent body from the common Instantly aliases', () => {
  assert.strictEqual(webhook.pickSentBody({ body_text: 'hi' }), 'hi');
  assert.strictEqual(webhook.pickSentBody({ body: 'hi' }), 'hi');
  assert.strictEqual(webhook.pickSentBody({ text: 'hi' }), 'hi');
  assert.strictEqual(webhook.pickSentBody({ email: { text: 'hi' } }), 'hi');
  assert.strictEqual(webhook.pickSentBody({ email: { body: 'hi' } }), 'hi');
  assert.strictEqual(webhook.pickSentBody({}), null);
});

test('pickSentSubject reads the subject from the common Instantly aliases', () => {
  assert.strictEqual(webhook.pickSentSubject({ subject: 'Re: X' }), 'Re: X');
  assert.strictEqual(webhook.pickSentSubject({ email_subject: 'Re: X' }), 'Re: X');
  assert.strictEqual(webhook.pickSentSubject({ email: { subject: 'Re: X' } }), 'Re: X');
  assert.strictEqual(webhook.pickSentSubject({}), null);
});
