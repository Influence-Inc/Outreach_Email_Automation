'use strict';

// Guards the AiSensy provider path + its place in provider selection. No network:
// only the pure/config surface is exercised (provider dispatch, display number,
// graceful skip, session-template fallback gating).

const test = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

const VARS = [
  'WHATSAPP_PROVIDER',
  'AISENSY_API_KEY',
  'AISENSY_WHATSAPP_NUMBER',
  'AISENSY_SESSION_CAMPAIGN',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
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

test('whatsappProvider auto-detects aisensy from the API key, and it outranks cloud', () => {
  withEnv({ AISENSY_API_KEY: 'k' }, () => assert.strictEqual(wa.whatsappProvider(), 'aisensy'));
  // Both AiSensy and Cloud creds present → AiSensy wins the auto-detect order.
  withEnv({ AISENSY_API_KEY: 'k', WHATSAPP_CLOUD_ACCESS_TOKEN: 't' }, () =>
    assert.strictEqual(wa.whatsappProvider(), 'aisensy'),
  );
  // An explicit flag still wins over auto-detect.
  withEnv({ AISENSY_API_KEY: 'k', WHATSAPP_PROVIDER: 'twilio' }, () =>
    assert.strictEqual(wa.whatsappProvider(), 'twilio'),
  );
});

test('businessNumber returns the AiSensy number under the aisensy provider', () => {
  withEnv({ WHATSAPP_PROVIDER: 'aisensy', AISENSY_WHATSAPP_NUMBER: '+13322879678', TWILIO_WHATSAPP_FROM: '+19998887777' }, () => {
    assert.strictEqual(wa.businessNumber(), '+13322879678');
  });
});

test('sendWhatsAppText skips gracefully (aisensy) when the API key is absent', async () => {
  const r = await withEnv({ WHATSAPP_PROVIDER: 'aisensy' }, () =>
    wa.sendWhatsAppText({ to: '+15551234567', body: 'hi' }),
  );
  assert.deepStrictEqual(r, { sent: false, skipped: true });
});

test('aisensySendViaSessionTemplate returns null when no session campaign is configured', async () => {
  // Null (not an error) lets the caller keep the original free-form send error.
  const r = await withEnv({ AISENSY_API_KEY: 'k' }, () =>
    wa.aisensySendViaSessionTemplate({ to: '+15551234567', body: 'hi' }),
  );
  assert.strictEqual(r, null);
});
