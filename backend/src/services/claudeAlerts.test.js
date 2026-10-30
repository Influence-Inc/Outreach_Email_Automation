'use strict';

// Run with: npm test  (node --test)
// Covers the Claude credits alert: which Anthropic errors post to Slack, how
// often, and that the wrapped client still throws the original error.
const test = require('node:test');
const assert = require('node:assert');

const alerts = require('./claudeAlerts');

function withSlack(fn) {
  return async () => {
    const sent = [];
    const realFetch = global.fetch;
    process.env[alerts.WEBHOOK_ENV] = 'https://hooks.slack.com/services/T/B/x';
    global.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body).text);
      return { ok: true };
    };
    alerts._reset();
    try {
      await fn(sent);
    } finally {
      global.fetch = realFetch;
      delete process.env[alerts.WEBHOOK_ENV];
    }
  };
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

test('a low credit balance alerts once, and the caller still gets the error', withSlack(async (sent) => {
  const err = apiError(400, 'Your credit balance is too low to access the Anthropic API.');
  const client = alerts.watch({ messages: { create: async () => { throw err; } } });
  await assert.rejects(client.messages.create({}), (e) => e === err);
  await assert.rejects(client.messages.create({}), (e) => e === err);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /: out of credits\*/);
  assert.match(sent[0], /credit balance is too low/);
}));

test('a rejected key alerts', withSlack(async (sent) => {
  assert.strictEqual(await alerts.report(apiError(401, 'invalid x-api-key')), true);
  assert.match(sent[0], /: key refused\*/);
}));

test('passing errors say nothing', withSlack(async (sent) => {
  for (const err of [apiError(429, 'rate_limit_error'), apiError(529, 'Overloaded'), new Error('ECONNRESET')]) {
    assert.strictEqual(await alerts.report(err), false);
  }
  assert.deepStrictEqual(sent, []);
}));

test('a successful call is returned untouched', withSlack(async (sent) => {
  const client = alerts.watch({ messages: { create: async (a) => ({ echo: a }) } });
  assert.deepStrictEqual(await client.messages.create({ x: 1 }), { echo: { x: 1 } });
  assert.deepStrictEqual(sent, []);
}));

test('nothing is sent without a webhook, and a failing webhook never throws', async () => {
  delete process.env[alerts.WEBHOOK_ENV];
  alerts._reset();
  assert.strictEqual(await alerts.notify('k', 'x'), false);
  const realFetch = global.fetch;
  process.env[alerts.WEBHOOK_ENV] = 'https://hooks.slack.com/services/T/B/x';
  global.fetch = async () => { throw new Error('slack down'); };
  try {
    assert.strictEqual(await alerts.notify('k2', 'x'), false);
  } finally {
    global.fetch = realFetch;
    delete process.env[alerts.WEBHOOK_ENV];
  }
});
