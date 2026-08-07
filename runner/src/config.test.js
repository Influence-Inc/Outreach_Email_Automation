'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadConfig, assertConfig } = require('./config');

test('loadConfig applies defaults', () => {
  const cfg = loadConfig({});
  assert.strictEqual(cfg.driver, 'mock');
  assert.strictEqual(cfg.batchSize, 5);
  assert.strictEqual(cfg.pacingMs, 1800);
  assert.strictEqual(cfg.dailyCap, 200);
  assert.strictEqual(cfg.idlePollMs, 15000);
});

test('loadConfig reads RUNNER_IDLE_POLL_MS override', () => {
  const cfg = loadConfig({ RUNNER_IDLE_POLL_MS: '5000' });
  assert.strictEqual(cfg.idlePollMs, 5000);
});

test('loadConfig reads runId + trims trailing slash on backend url', () => {
  const cfg = loadConfig({
    RUNNER_BACKEND_URL: 'https://x.example/',
    RUNNER_HOST_TOKEN: 't',
    RUNNER_RUN_ID: '42',
  });
  assert.strictEqual(cfg.backendUrl, 'https://x.example');
  assert.strictEqual(cfg.runId, 42);
});

test('assertConfig throws with missing env', () => {
  assert.throws(() => assertConfig(loadConfig({})), /RUNNER_BACKEND_URL/);
});

test('assertConfig accepts a full config', () => {
  const cfg = loadConfig({
    RUNNER_BACKEND_URL: 'https://x.example',
    RUNNER_HOST_TOKEN: 't',
    RUNNER_RUN_ID: '1',
  });
  assert.doesNotThrow(() => assertConfig(cfg));
});

test('assertConfig accepts RUNNER_RUN_ID=auto (poll queued runs)', () => {
  const cfg = loadConfig({
    RUNNER_BACKEND_URL: 'https://x.example',
    RUNNER_HOST_TOKEN: 't',
    RUNNER_RUN_ID: 'auto',
  });
  assert.strictEqual(cfg.runId, null);
  assert.strictEqual(cfg.runMode, 'auto');
  assert.doesNotThrow(() => assertConfig(cfg));
});
