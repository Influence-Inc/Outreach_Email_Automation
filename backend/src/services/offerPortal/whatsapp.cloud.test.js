'use strict';

// Guards the Meta WhatsApp Cloud API send path + provider selection in
// offerPortal/whatsapp.js. No network: only the pure/config surface is exercised
// (URL building, message-id extraction, provider dispatch, graceful skip).

const test = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

const VARS = [
  'WHATSAPP_PROVIDER',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_DISPLAY_NUMBER',
  'WHATSAPP_CLOUD_API_BASE',
  'WHATSAPP_CLOUD_API_VERSION',
  'TWILIO_WHATSAPP_FROM',
];
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  try {
    for (const k of VARS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('whatsappProvider auto-detects cloud from the access token, twilio otherwise', () => {
  withEnv({}, () => assert.strictEqual(wa.whatsappProvider(), 'twilio'));
  withEnv({ WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAG' }, () => assert.strictEqual(wa.whatsappProvider(), 'cloud'));
  // Explicit flag wins over auto-detect.
  withEnv({ WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAG', WHATSAPP_PROVIDER: 'twilio' }, () =>
    assert.strictEqual(wa.whatsappProvider(), 'twilio'),
  );
});

test('extractCloudMessageId reads the wamid from a Cloud API send response', () => {
  assert.strictEqual(
    wa.extractCloudMessageId({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgL' }] }),
    'wamid.HBgL',
  );
  assert.strictEqual(wa.extractCloudMessageId({}), null);
  assert.strictEqual(wa.extractCloudMessageId(null), null);
});

test('cloudMessagesUrl builds the Graph endpoint from version + phone number id', () => {
  withEnv({ WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890', WHATSAPP_CLOUD_API_VERSION: 'v21.0' }, () => {
    assert.strictEqual(wa.cloudMessagesUrl(), 'https://graph.facebook.com/v21.0/1234567890/messages');
  });
});

test('businessNumber returns the Cloud display number under the cloud provider', () => {
  withEnv(
    { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_CLOUD_DISPLAY_NUMBER: '+18005551234', TWILIO_WHATSAPP_FROM: '+19998887777' },
    () => {
      assert.strictEqual(wa.businessNumber(), '+18005551234');
    },
  );
});

test('sendWhatsAppText skips gracefully (cloud) when the access token is absent', async () => {
  // env read happens synchronously before the first await, so withEnv is safe here.
  const r = await withEnv({ WHATSAPP_PROVIDER: 'cloud' }, () =>
    wa.sendWhatsAppText({ to: '+15551234567', body: 'hi' }),
  );
  assert.deepStrictEqual(r, { sent: false, skipped: true });
});
