'use strict';

// The offer message used to be plain text with a bare link ("Tap to view the
// full details and accept it here: https://..."). On WhatsApp Cloud it now
// arrives as a tappable "View Offer" button (a cta_url interactive message)
// instead — distinct from sendCloudButtons' quick-reply buttons, since a link
// isn't something Meta can usefully echo back as the creator's next message.
// Twilio, and a body too long for an interactive message, still get the link
// written into the text so it's never silently dropped. Uses a stubbed
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

const CLOUD_ENV = {
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'test-token',
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
};

test('sendCloudLinkButton posts a cta_url interactive message carrying the URL', async () => {
  let captured;
  await withStub(
    { env: CLOUD_ENV, fetchFn: async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return mockResponse(true, 200, { messages: [{ id: 'wamid.abc' }] });
    } },
    async () => {
      const result = await whatsapp.sendCloudLinkButton({
        to: '+919812345670',
        body: "Hi Sam, here's your Netflix offer.",
        buttonText: 'View Offer',
        url: 'https://deals.influence.technology/o/tok_abc',
      });
      assert.strictEqual(result.sent, true);
      assert.strictEqual(result.id, 'wamid.abc');
      assert.strictEqual(captured.body.type, 'interactive');
      assert.strictEqual(captured.body.interactive.type, 'cta_url');
      assert.strictEqual(captured.body.interactive.action.parameters.url, 'https://deals.influence.technology/o/tok_abc');
      assert.strictEqual(captured.body.interactive.action.parameters.display_text, 'View Offer');
      assert.match(captured.body.interactive.body.text, /Netflix offer/);
      // The button carries the link — the body text must not repeat it.
      assert.doesNotMatch(captured.body.interactive.body.text, /https:\/\//);
    },
  );
});

test('sendCloudLinkButton truncates a button label over the 20-char limit', async () => {
  let captured;
  await withStub(
    { env: CLOUD_ENV, fetchFn: async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return mockResponse(true, 200, { messages: [{ id: 'wamid.x' }] });
    } },
    async () => {
      await whatsapp.sendCloudLinkButton({
        to: '+919812345670',
        body: 'body',
        buttonText: 'View the full offer details',
        url: 'https://example.com/o/x',
      });
      assert.ok(captured.interactive.action.parameters.display_text.length <= whatsapp.BUTTON_TITLE_MAX);
    },
  );
});

test('sendCloudLinkButton skips gracefully when credentials are absent', async () => {
  await withStub(
    { env: { ...CLOUD_ENV, WHATSAPP_CLOUD_ACCESS_TOKEN: undefined }, fetchFn: async () => {
      throw new Error('must not call fetch without credentials');
    } },
    async () => {
      const result = await whatsapp.sendCloudLinkButton({ to: '+919812345670', body: 'x', buttonText: 'View', url: 'https://x' });
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.skipped, true);
    },
  );
});

test('sendCloudLinkButton surfaces the Graph API error on a non-2xx response', async () => {
  await withStub(
    { env: CLOUD_ENV, fetchFn: async () => mockResponse(false, 400, { error: { message: 'outside 24h window' } }) },
    async () => {
      const result = await whatsapp.sendCloudLinkButton({ to: '+919812345670', body: 'x', buttonText: 'View', url: 'https://x' });
      assert.strictEqual(result.sent, false);
      assert.match(result.error, /400/);
      assert.match(result.error, /outside 24h window/);
    },
  );
});

test('sendWhatsAppLink uses the button on Cloud', async () => {
  let usedCtaUrl = false;
  await withStub(
    { env: CLOUD_ENV, fetchFn: async (_url, opts) => {
      usedCtaUrl = JSON.parse(opts.body).interactive.type === 'cta_url';
      return mockResponse(true, 200, { messages: [{ id: 'wamid.y' }] });
    } },
    async () => {
      const result = await whatsapp.sendWhatsAppLink({
        to: '+919812345670',
        body: 'intro text',
        buttonText: 'View Offer',
        url: 'https://example.com/o/y',
        fallbackBody: 'intro text https://example.com/o/y',
      });
      assert.strictEqual(result.sent, true);
      assert.strictEqual(usedCtaUrl, true);
    },
  );
});

test('sendWhatsAppLink falls back to the link written in the text on Twilio', async () => {
  let capturedForm;
  await withStub(
    {
      env: { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'ACxxx', TWILIO_AUTH_TOKEN: 'secret', TWILIO_WHATSAPP_FROM: '+18005551234' },
      fetchFn: async (_url, opts) => {
        capturedForm = opts.body;
        return mockResponse(true, 200, { sid: 'SMxxx' });
      },
    },
    async () => {
      const result = await whatsapp.sendWhatsAppLink({
        to: '+919812345670',
        body: 'intro text (never sent to Twilio)',
        buttonText: 'View Offer',
        url: 'https://example.com/o/z',
        fallbackBody: 'Tap here to view your offer: https://example.com/o/z',
      });
      assert.strictEqual(result.sent, true);
      const params = new URLSearchParams(capturedForm);
      assert.strictEqual(params.get('Body'), 'Tap here to view your offer: https://example.com/o/z');
    },
  );
});

test('sendWhatsAppLink falls back to text when the body exceeds the interactive limit', async () => {
  let usedText = false;
  await withStub(
    { env: CLOUD_ENV, fetchFn: async (_url, opts) => {
      usedText = JSON.parse(opts.body).type === 'text';
      return mockResponse(true, 200, { messages: [{ id: 'wamid.z' }] });
    } },
    async () => {
      await whatsapp.sendWhatsAppLink({
        to: '+919812345670',
        body: 'x'.repeat(whatsapp.INTERACTIVE_BODY_MAX + 1),
        buttonText: 'View Offer',
        url: 'https://example.com/o/w',
        fallbackBody: 'fallback with link https://example.com/o/w',
      });
      assert.strictEqual(usedText, true);
    },
  );
});
