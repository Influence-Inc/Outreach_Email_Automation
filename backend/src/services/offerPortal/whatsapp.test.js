'use strict';

// Run with: npm test  (node --test)
//
// Guards the WhatsApp (Twilio) channel: the exact form-encoded body Twilio
// expects, Basic-Auth header shape, graceful-skip when creds are absent,
// and how outside-24h-window errors (Twilio code 63016) surface. Uses a stubbed
// global.fetch — no network.
const test = require('node:test');
const assert = require('node:assert');
const whatsapp = require('./whatsapp');

function mockResponse(ok, status, bodyObj) {
  return {
    ok,
    status,
    json: async () => bodyObj,
    text: async () => (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)),
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

test('businessNumber reflects TWILIO_WHATSAPP_FROM (empty when unset)', () => {
  const saved = process.env.TWILIO_WHATSAPP_FROM;
  try {
    delete process.env.TWILIO_WHATSAPP_FROM;
    assert.strictEqual(whatsapp.businessNumber(), '');
    process.env.TWILIO_WHATSAPP_FROM = '+18005551234';
    assert.strictEqual(whatsapp.businessNumber(), '+18005551234');
  } finally {
    if (saved === undefined) delete process.env.TWILIO_WHATSAPP_FROM;
    else process.env.TWILIO_WHATSAPP_FROM = saved;
  }
});

test('normalizePhone strips non-digits (needed for last-10 webhook matching)', () => {
  assert.strictEqual(whatsapp.normalizePhone('+1 (800) 555-1234'), '18005551234');
  assert.strictEqual(whatsapp.normalizePhone(null), '');
});

test('buildTwilioForm prefixes both addresses with "whatsapp:+<digits>"', () => {
  const params = whatsapp.buildTwilioForm({
    from: '+1 (800) 555-1234',
    to: '5556667777',
    body: 'Hello!',
  });
  assert.strictEqual(params.get('From'), 'whatsapp:+18005551234');
  assert.strictEqual(params.get('To'), 'whatsapp:+5556667777');
  assert.strictEqual(params.get('Body'), 'Hello!');
});

test('basicAuthHeader base64-encodes SID:token', () => {
  const saved = { s: process.env.TWILIO_ACCOUNT_SID, t: process.env.TWILIO_AUTH_TOKEN };
  try {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    // Buffer.from('ACtest:tok').toString('base64') === 'QUN0ZXN0OnRvaw=='
    assert.strictEqual(whatsapp.basicAuthHeader(), 'Basic QUN0ZXN0OnRvaw==');
  } finally {
    if (saved.s === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = saved.s;
    if (saved.t === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = saved.t;
  }
});

test('messagesUrl includes the SID (URL-encoded) in the path', () => {
  const saved = process.env.TWILIO_ACCOUNT_SID;
  try {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    assert.match(whatsapp.messagesUrl(), /\/2010-04-01\/Accounts\/ACtest\/Messages\.json$/);
  } finally {
    if (saved === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = saved;
  }
});

test('sendWhatsAppText skips gracefully when any Twilio cred is missing', async () => {
  for (const missing of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM']) {
    const env = {
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_WHATSAPP_FROM: '+18005551234',
    };
    env[missing] = undefined;
    // eslint-disable-next-line no-await-in-loop
    const res = await withStub(
      { env, fetchFn: async () => { throw new Error('should not be called'); } },
      () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'x' }),
    );
    assert.deepStrictEqual(res, { sent: false, skipped: true }, `missing ${missing} should skip`);
  }
});

test('sendWhatsAppText POSTs form-encoded to Twilio with Basic Auth and returns the sid', async () => {
  let seenUrl, seenHeaders, seenBody;
  const res = await withStub(
    {
      env: {
        TWILIO_ACCOUNT_SID: 'ACtest',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_WHATSAPP_FROM: '+18005551234',
      },
      fetchFn: async (url, opts) => {
        seenUrl = url;
        seenHeaders = opts.headers;
        seenBody = opts.body;
        return mockResponse(true, 201, { sid: 'SM123', status: 'queued' });
      },
    },
    () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'hi there' }),
  );
  assert.strictEqual(res.sent, true);
  assert.strictEqual(res.id, 'SM123');
  assert.match(seenUrl, /\/Accounts\/ACtest\/Messages\.json$/);
  assert.strictEqual(seenHeaders['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(seenHeaders.Authorization, /^Basic /);
  // Form body must contain From, To, Body — URLSearchParams URL-encodes the "+"
  // and ":" in the address, so "whatsapp:+18005551234" appears as "whatsapp%3A%2B18005551234".
  assert.match(seenBody, /From=whatsapp%3A%2B18005551234/);
  assert.match(seenBody, /To=whatsapp%3A%2B15556667777/);
  assert.match(seenBody, /Body=hi\+there/);
});

test('sendWhatsAppText surfaces the Twilio outside-24h-window error (code 63016)', async () => {
  const res = await withStub(
    {
      env: {
        TWILIO_ACCOUNT_SID: 'ACtest',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_WHATSAPP_FROM: '+18005551234',
      },
      fetchFn: async () =>
        mockResponse(false, 400, {
          code: 63016,
          message: 'Failed to send freeform message because you are outside the allowed window.',
        }),
    },
    () => whatsapp.sendWhatsAppText({ to: '+15556667777', body: 'thanks!' }),
  );
  assert.strictEqual(res.sent, false);
  assert.match(res.error, /twilio code 63016/);
  assert.match(res.error, /400/);
});

test('sendWhatsAppText rejects an unparseable recipient before hitting the network', async () => {
  const res = await withStub(
    {
      env: {
        TWILIO_ACCOUNT_SID: 'ACtest',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_WHATSAPP_FROM: '+18005551234',
      },
      fetchFn: async () => { throw new Error('should not be called'); },
    },
    () => whatsapp.sendWhatsAppText({ to: 'not a number', body: 'x' }),
  );
  assert.strictEqual(res.sent, false);
  assert.match(res.error, /invalid recipient/);
});

// No greeting on these — "Hi {firstName}, this is INFLUENCE" only opens the
// FIRST message of the conversation (replies.renderBriefIntro); these are
// replies later in an already-introduced thread. See replies.buttons.test.js
// for the greeting-placement rule itself.
test('renderOfferOutreachBody names the brand and includes the link + expiry, with no greeting', () => {
  const body = whatsapp.renderOfferOutreachBody({
    brandName: 'Acme',
    offerUrl: 'https://x.test/o/tok',
    expiryDate: 'Aug 1',
  });
  assert.match(body, /Acme/);
  assert.match(body, /https:\/\/x\.test\/o\/tok/);
  assert.match(body, /Aug 1/);
  assert.doesNotMatch(body, /this is INFLUENCE/);
});

test('renderOfferOutreachIntro names the brand and expiry, with no link and no greeting', () => {
  const body = whatsapp.renderOfferOutreachIntro({ brandName: 'Acme', expiryDate: 'Aug 1' });
  assert.match(body, /Acme/);
  assert.match(body, /Aug 1/);
  assert.doesNotMatch(body, /https?:\/\//, 'the link lives on the button, not the text');
  assert.doesNotMatch(body, /this is INFLUENCE/);
});

test('renderContentBriefReadyBody names the brand and includes the brief link, with no greeting', () => {
  const body = whatsapp.renderContentBriefReadyBody({
    brandName: 'Acme',
    briefUrl: 'https://x.test/brief/tok',
  });
  assert.match(body, /Acme/);
  assert.match(body, /https:\/\/x\.test\/brief\/tok/);
  assert.doesNotMatch(body, /this is INFLUENCE/);
});
