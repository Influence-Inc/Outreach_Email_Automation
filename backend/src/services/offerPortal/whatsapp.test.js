'use strict';

// Run with: npm test  (node --test)
//
// Guards the WhatsApp (AiSensy) channel's 24h-window handling: a free-form
// session send that fails (e.g. outside Meta's window) falls back to the
// pre-approved session template, and a successful free-form send never touches
// the template. Uses a stubbed global.fetch — no network.
const test = require('node:test');
const assert = require('node:assert');
const whatsapp = require('./whatsapp');

function mockResponse(ok, bodyObj) {
  return {
    ok,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  };
}

// Run `fn` with env + global.fetch stubbed, restoring both afterwards.
async function withStub({ env, fetchFn }, fn) {
  const savedFetch = global.fetch;
  const savedEnv = {};
  for (const k of Object.keys(env)) {
    savedEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  global.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    global.fetch = savedFetch;
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

test('sendWhatsAppText falls back to the session template when free-form fails', async () => {
  const res = await withStub(
    {
      env: { AISENSY_API_KEY: 'k', AISENSY_SESSION_CAMPAIGN: 'session_fallback' },
      fetchFn: async (url) => {
        if (String(url).includes('direct-apis')) return mockResponse(false, { error: 'outside 24h window' });
        if (String(url).includes('campaign/t1')) return mockResponse(true, { messageId: 'tmpl_1' });
        throw new Error(`unexpected url ${url}`);
      },
    },
    () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'thanks!' }),
  );
  assert.strictEqual(res.sent, true);
  assert.strictEqual(res.viaTemplate, true);
  assert.strictEqual(res.id, 'tmpl_1');
});

test('sendWhatsAppText uses free-form and does NOT call the template on success', async () => {
  let templateCalled = false;
  const res = await withStub(
    {
      env: { AISENSY_API_KEY: 'k', AISENSY_SESSION_CAMPAIGN: 'session_fallback' },
      fetchFn: async (url) => {
        if (String(url).includes('direct-apis')) return mockResponse(true, { messageId: 'ff_1' });
        if (String(url).includes('campaign/t1')) {
          templateCalled = true;
          return mockResponse(true, {});
        }
        throw new Error(`unexpected url ${url}`);
      },
    },
    () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'thanks!' }),
  );
  assert.strictEqual(res.sent, true);
  assert.strictEqual(res.id, 'ff_1');
  assert.strictEqual(res.viaTemplate, undefined);
  assert.strictEqual(templateCalled, false);
});

test('sendWhatsAppText reports the failure when free-form fails and no fallback is configured', async () => {
  const res = await withStub(
    {
      env: { AISENSY_API_KEY: 'k', AISENSY_SESSION_CAMPAIGN: undefined },
      fetchFn: async (url) => {
        if (String(url).includes('direct-apis')) return mockResponse(false, { error: 'nope' });
        throw new Error(`unexpected url ${url}`);
      },
    },
    () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'thanks!' }),
  );
  assert.strictEqual(res.sent, false);
  assert.match(res.error, /nope/);
});

test('sendViaSessionTemplate is a no-op (null) when no fallback campaign is set', async () => {
  const res = await withStub(
    { env: { AISENSY_API_KEY: 'k', AISENSY_SESSION_CAMPAIGN: undefined }, fetchFn: async () => mockResponse(true, {}) },
    () => whatsapp.sendViaSessionTemplate({ to: '+15556667777', body: 'x' }),
  );
  assert.strictEqual(res, null);
});
