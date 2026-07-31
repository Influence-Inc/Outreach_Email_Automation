'use strict';

// Guards the Meta WhatsApp Cloud API webhook plumbing added to offerWebhook.js:
// normalizeMetaWebhook (flatten Meta's nested payload into the shared flat shape)
// and verifyMetaSignature (X-Hub-Signature-256 HMAC over the raw body). Pure —
// no express, no network.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const router = require('./offerWebhook');

// --- normalizeMetaWebhook --------------------------------------------------

test('normalizeMetaWebhook flattens an inbound text message to { from, body, id }', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: 'Sam' }, wa_id: '15551234567' }],
              messages: [{ from: '15551234567', id: 'wamid.ABC', timestamp: '1', type: 'text', text: { body: 'Hi' } }],
            },
          },
        ],
      },
    ],
  };
  assert.deepStrictEqual(router.normalizeMetaWebhook(payload), {
    from: '15551234567',
    body: 'Hi',
    id: 'wamid.ABC',
  });
});

test('normalizeMetaWebhook flattens a delivery status into Twilio-shaped fields', () => {
  const payload = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.ABC', status: 'delivered', recipient_id: '1555' }] } }] }],
  };
  assert.deepStrictEqual(router.normalizeMetaWebhook(payload), { MessageStatus: 'delivered', MessageSid: 'wamid.ABC' });
});

test('normalizeMetaWebhook labels a non-text message instead of dropping it', () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [{ from: '1555', id: 'wamid.X', type: 'image', image: {} }] } }] }],
  };
  const flat = router.normalizeMetaWebhook(payload);
  assert.strictEqual(flat.from, '1555');
  assert.match(flat.body, /non-text message: image/);
});

test('normalizeMetaWebhook returns null when there is neither a message nor a status', () => {
  assert.strictEqual(router.normalizeMetaWebhook({ entry: [{ changes: [{ value: { contacts: [] } }] }] }), null);
  assert.strictEqual(router.normalizeMetaWebhook({}), null);
  assert.strictEqual(router.normalizeMetaWebhook(null), null);
});

// --- verifyMetaSignature ---------------------------------------------------

function withSecret(secret, fn) {
  const prev = process.env.WHATSAPP_CLOUD_APP_SECRET;
  if (secret === undefined) delete process.env.WHATSAPP_CLOUD_APP_SECRET;
  else process.env.WHATSAPP_CLOUD_APP_SECRET = secret;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WHATSAPP_CLOUD_APP_SECRET;
    else process.env.WHATSAPP_CLOUD_APP_SECRET = prev;
  }
}

test('verifyMetaSignature accepts a correct X-Hub-Signature-256 over the raw body', () => {
  withSecret('s3cret', () => {
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
    assert.strictEqual(router.verifyMetaSignature({ headers: { 'x-hub-signature-256': sig }, rawBody: raw }), true);
  });
});

test('verifyMetaSignature rejects a wrong or missing signature', () => {
  withSecret('s3cret', () => {
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    assert.strictEqual(
      router.verifyMetaSignature({ headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, rawBody: raw }),
      false,
    );
    assert.strictEqual(router.verifyMetaSignature({ headers: {}, rawBody: raw }), false);
  });
});

test('verifyMetaSignature is disabled (returns true) when no app secret is set', () => {
  withSecret(undefined, () => {
    assert.strictEqual(router.verifyMetaSignature({ headers: {}, rawBody: Buffer.from('x') }), true);
  });
});
