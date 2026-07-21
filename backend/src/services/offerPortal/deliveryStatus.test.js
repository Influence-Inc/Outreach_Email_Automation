'use strict';

// Run with: npm test  (node --test)
//
// Guards the delivery-status plumbing: extracting the provider message id from a
// send response, and classifying delivery/read/failed status callbacks across
// the Linq (message.<status> event) and AiSensy/Meta (status field) shapes,
// without mistaking an inbound reply for a status update.
const test = require('node:test');
const assert = require('node:assert');
const ds = require('./deliveryStatus');

// --- extractProviderMessageId ---------------------------------------------

test('extractProviderMessageId reads Linq-style nested message id', () => {
  assert.strictEqual(ds.extractProviderMessageId({ data: { message: { id: 'm_1' } } }), 'm_1');
});

test('extractProviderMessageId reads flat id / message_id aliases', () => {
  assert.strictEqual(ds.extractProviderMessageId({ id: 'm_2' }), 'm_2');
  assert.strictEqual(ds.extractProviderMessageId({ message_id: 'm_3' }), 'm_3');
  assert.strictEqual(ds.extractProviderMessageId({ data: { id: 'm_4' } }), 'm_4');
});

test('extractProviderMessageId returns null when absent / not an object', () => {
  assert.strictEqual(ds.extractProviderMessageId(null), null);
  assert.strictEqual(ds.extractProviderMessageId({ nope: true }), null);
});

// --- parseStatusEvent ------------------------------------------------------

test('parseStatusEvent classifies a Linq message.<status> event', () => {
  assert.deepStrictEqual(
    ds.parseStatusEvent({ event_type: 'message.delivered', data: { message: { id: 'm_1' } } }),
    { providerMessageId: 'm_1', status: 'delivered' },
  );
  assert.deepStrictEqual(
    ds.parseStatusEvent({ event_type: 'message.read', data: { message_id: 'm_2' } }),
    { providerMessageId: 'm_2', status: 'read' },
  );
  assert.deepStrictEqual(
    ds.parseStatusEvent({ event_type: 'message.failed', data: { id: 'm_3' } }),
    { providerMessageId: 'm_3', status: 'failed' },
  );
});

test('parseStatusEvent classifies an AiSensy/Meta status field', () => {
  assert.deepStrictEqual(ds.parseStatusEvent({ status: 'delivered', id: 'm_4' }), {
    providerMessageId: 'm_4',
    status: 'delivered',
  });
  assert.deepStrictEqual(ds.parseStatusEvent({ data: { status: 'read', messageId: 'm_5' } }), {
    providerMessageId: 'm_5',
    status: 'read',
  });
});

test('parseStatusEvent returns null for an inbound reply (not a status update)', () => {
  // Linq new-message event
  assert.strictEqual(
    ds.parseStatusEvent({ event_type: 'message.created', data: { message: { parts: [{ type: 'text', value: 'yes' }] } } }),
    null,
  );
  // Flat AiSensy reply
  assert.strictEqual(ds.parseStatusEvent({ from: '919812345670', message: 'yes' }), null);
  // A reaction with no status field
  assert.strictEqual(ds.parseStatusEvent({ event_type: 'reaction.created', data: {} }), null);
});
