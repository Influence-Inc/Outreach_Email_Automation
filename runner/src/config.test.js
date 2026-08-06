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
