'use strict';

// Guards the template send path in offerPortal/whatsapp.js — the one way to
// reach a creator whose 24h free-form window is shut, and therefore the whole
// basis of Scenario 2 of the campaign-update lane (a creator who signs and never
// writes in). No network: the request body, the provider gate and the graceful
// skips are what's exercised.

const test = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

const VARS = [
  'WHATSAPP_PROVIDER',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_DISPLAY_NUMBER',
  'WHATSAPP_TEMPLATE_LANG',
  'TWILIO_WHATSAPP_FROM',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
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

const CLOUD = {
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAtoken',
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
};

// Swap global fetch for one that records the request and answers with `reply`.
async function captureFetch(reply, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return reply;
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    global.fetch = real;
  }
}

const okResponse = {
  ok: true,
  json: async () => ({ messages: [{ id: 'wamid.TEMPLATE1' }] }),
};

test('buildTemplateComponents lays out positional body variables in order', () => {
  const components = wa.buildTemplateComponents({ bodyParams: ['Sam', 'Reve'] });
  assert.deepStrictEqual(components, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Sam' },
        { type: 'text', text: 'Reve' },
      ],
    },
  ]);
});

test('buildTemplateComponents drops null/undefined params rather than sending empty slots', () => {
  // A missing variable must not become an empty {{2}} — Meta counts parameters,
  // and a blank one still renders as a gap in the approved copy.
  const components = wa.buildTemplateComponents({ bodyParams: ['Sam', null, undefined] });
  assert.strictEqual(components[0].parameters.length, 1);
});

test('buildTemplateComponents omits the body component entirely when there are no variables', () => {
  assert.deepStrictEqual(wa.buildTemplateComponents({ bodyParams: [] }), []);
});

test('buildTemplateComponents attaches a dynamic URL button as index 0', () => {
  const components = wa.buildTemplateComponents({
    bodyParams: ['Sam'],
    buttonUrlSuffix: 'brief/abc123',
  });
  const button = components.find((c) => c.type === 'button');
  assert.deepStrictEqual(button, {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: 'brief/abc123' }],
  });
});

test('sendWhatsAppTemplate posts a Cloud template message and returns its wamid', async () => {
  await withEnv(CLOUD, async () => {
    const { result, calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({
        to: '+91 98765 43210',
        name: 'campaign_brief_ready',
        bodyParams: ['Sam', 'Reve'],
      }),
    );

    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.id, 'wamid.TEMPLATE1');
    assert.strictEqual(calls.length, 1);

    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.template.name, 'campaign_brief_ready');
    // Number is normalised to bare digits, as the Cloud API requires.
    assert.strictEqual(body.to, '919876543210');
    assert.strictEqual(body.template.language.code, 'en');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer EAAtoken');
  });
});

test('sendWhatsAppTemplate honours WHATSAPP_TEMPLATE_LANG', async () => {
  await withEnv({ ...CLOUD, WHATSAPP_TEMPLATE_LANG: 'en_US' }, async () => {
    const { calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({ to: '15551234567', name: 'x', bodyParams: ['a'] }),
    );
    assert.strictEqual(JSON.parse(calls[0].init.body).template.language.code, 'en_US');
  });
});

test('an explicit languageCode overrides the env default', async () => {
  await withEnv({ ...CLOUD, WHATSAPP_TEMPLATE_LANG: 'en' }, async () => {
    const { calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({ to: '15551234567', name: 'x', languageCode: 'hi', bodyParams: ['a'] }),
    );
    assert.strictEqual(JSON.parse(calls[0].init.body).template.language.code, 'hi');
  });
});

test('templates are refused on Twilio rather than sent as something else', async () => {
  // Twilio's Content Templates are deliberately unused in this codebase. The
  // caller must be told it cannot start a conversation, so it leaves the update
  // queued instead of silently dropping it.
  await withEnv(
    { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1555' },
    async () => {
      const { result, calls } = await captureFetch(okResponse, () =>
        wa.sendWhatsAppTemplate({ to: '15551234567', name: 'x', bodyParams: ['a'] }),
      );
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, 'templates_unsupported_on_twilio');
      assert.strictEqual(calls.length, 0, 'no request should be made');
    },
  );
});

test('a missing template name skips instead of sending a nameless template', async () => {
  await withEnv(CLOUD, async () => {
    const { result, calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({ to: '15551234567', name: '', bodyParams: ['a'] }),
    );
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'no_template_configured');
    assert.strictEqual(calls.length, 0);
  });
});

test('absent Cloud credentials skip gracefully so dev never breaks', async () => {
  await withEnv({ WHATSAPP_PROVIDER: 'cloud' }, async () => {
    const { result, calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({ to: '15551234567', name: 'x', bodyParams: ['a'] }),
    );
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'not_configured');
    assert.strictEqual(calls.length, 0);
  });
});

test('an unapproved template name comes back with a pointer at WhatsApp Manager', async () => {
  // The single most common production failure: the name in the env doesn't
  // match an approved template. A bare "400" gives no clue where to fix it.
  await withEnv(CLOUD, async () => {
    const { result } = await captureFetch(
      {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { code: 132001, message: 'Template name does not exist' } }),
      },
      () => wa.sendWhatsAppTemplate({ to: '15551234567', name: 'typo_name', bodyParams: ['a'] }),
    );
    assert.strictEqual(result.sent, false);
    assert.match(result.error, /WhatsApp Manager/);
  });
});

test('a variable-count mismatch is named as such', async () => {
  await withEnv(CLOUD, async () => {
    const { result } = await captureFetch(
      {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { code: 132000, message: 'number of parameters does not match' } }),
      },
      () => wa.sendWhatsAppTemplate({ to: '15551234567', name: 'x', bodyParams: ['a'] }),
    );
    assert.match(result.error, /variable count/);
  });
});

test('an unusable recipient number is an error, not a silent no-op', async () => {
  await withEnv(CLOUD, async () => {
    const { result, calls } = await captureFetch(okResponse, () =>
      wa.sendWhatsAppTemplate({ to: 'not-a-number', name: 'x', bodyParams: ['a'] }),
    );
    assert.strictEqual(result.sent, false);
    assert.match(result.error, /invalid recipient/);
    assert.strictEqual(calls.length, 0);
  });
});

test('templatesAvailable tracks provider AND credentials together', () => {
  withEnv(CLOUD, () => assert.strictEqual(wa.templatesAvailable(), true));
  // Cloud selected but half-configured — a template send would 401.
  withEnv({ WHATSAPP_PROVIDER: 'cloud', WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAtoken' }, () =>
    assert.strictEqual(wa.templatesAvailable(), false),
  );
  withEnv({ WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }, () =>
    assert.strictEqual(wa.templatesAvailable(), false),
  );
});
