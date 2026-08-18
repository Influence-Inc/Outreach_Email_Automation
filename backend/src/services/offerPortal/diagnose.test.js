'use strict';

// The diagnostic's whole value is that it predicts what the inbound webhook
// would ACTUALLY do, so these tests pin predictAction to the same stage ladder
// handleInbound walks in routes/offerWebhook.js. If that ladder changes and
// these still pass, the diagnostic has started lying.

const test = require('node:test');
const assert = require('node:assert');

const { predictAction } = require('./diagnose');
const { pickMatch, pickMatchDetailed, assertContactColumn } = require('./contactMatch');

test('predictAction: no offer + never messaged before → first-contact brief', () => {
  const r = predictAction({ pendingOffer: null, hasAnyOffer: false, establishedChannel: null });
  assert.strictEqual(r.action, 'brief_first_contact');
});

test('predictAction: no offer but channel already established → holding message', () => {
  const r = predictAction({ pendingOffer: null, hasAnyOffer: false, establishedChannel: 'whatsapp' });
  assert.strictEqual(r.action, 'holding_message');
});

test('predictAction: pending offer never briefed → brief the offer, not the rate', () => {
  const r = predictAction({ pendingOffer: { id: 1, messaging_stage: null }, hasAnyOffer: true, establishedChannel: 'whatsapp' });
  assert.strictEqual(r.action, 'brief_offer');
});

test('predictAction: pending offer at the briefed stage → interest gate', () => {
  const r = predictAction({
    pendingOffer: { id: 1, messaging_stage: 'briefed' },
    hasAnyOffer: true,
    establishedChannel: 'whatsapp',
  });
  assert.strictEqual(r.action, 'interest_gate');
});

test('predictAction: revealed offer → classify the reply', () => {
  const r = predictAction({
    pendingOffer: { id: 1, messaging_stage: 'revealed' },
    hasAnyOffer: true,
    establishedChannel: 'whatsapp',
  });
  assert.strictEqual(r.action, 'classify_reply');
});

// A closed/expired offer with no pending one still isn't "first contact" — the
// creator has history, so the webhook falls through to classify_reply.
test('predictAction: an old non-pending offer falls through to classify_reply', () => {
  const r = predictAction({ pendingOffer: null, hasAnyOffer: true, establishedChannel: 'whatsapp' });
  assert.strictEqual(r.action, 'classify_reply');
});

// --- contactMatch -----------------------------------------------------------

test('pickMatchDetailed reports an exact match over an earlier suffix match', () => {
  const rows = [
    { id: 1, contact: '+91 98123 45670' },
    { id: 2, contact: '919812345670' },
  ];
  const hit = pickMatchDetailed(rows, '919812345670');
  assert.strictEqual(hit.matchedOn, 'exact');
  assert.strictEqual(hit.row.id, 1); // formatting is normalised away, so row 1 is exact too
});

test('pickMatchDetailed flags a country-code-only difference as a suffix match', () => {
  const rows = [{ id: 7, contact: '9812345670' }];
  const hit = pickMatchDetailed(rows, '919812345670');
  assert.strictEqual(hit.matchedOn, 'suffix');
  assert.strictEqual(hit.row.id, 7);
});

test('pickMatch returns null when nothing matches or the number has no digits', () => {
  assert.strictEqual(pickMatch([{ id: 1, contact: '919812345670' }], '15556667777'), null);
  assert.strictEqual(pickMatch([{ id: 1, contact: '919812345670' }], 'not-a-number'), null);
});

test('assertContactColumn rejects anything outside the whitelist (SQL is interpolated)', () => {
  assert.strictEqual(assertContactColumn('whatsapp'), 'whatsapp');
  assert.strictEqual(assertContactColumn('imessage'), 'imessage');
  assert.throws(() => assertContactColumn('email; DROP TABLE creators'), /unsupported contact column/);
});
