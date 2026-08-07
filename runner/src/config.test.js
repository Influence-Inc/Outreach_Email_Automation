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

test('loadConfig applies adb reliability defaults (usb, retries, keep-awake on)', () => {
  const cfg = loadConfig({});
  assert.strictEqual(cfg.adbMode, 'usb');
  assert.strictEqual(cfg.reconnectRetries, 3);
  assert.strictEqual(cfg.reconnectBackoffMs, 1000);
  assert.strictEqual(cfg.keepAwake, true);
});

test('loadConfig reads Wi-Fi mode, keep-awake off, and a custom retry count', () => {
  const cfg = loadConfig({
    RUNNER_ADB_MODE: 'wifi',
    RUNNER_KEEP_AWAKE: 'off',
    RUNNER_ADB_RECONNECT_RETRIES: '5',
    RUNNER_ADB_RECONNECT_BACKOFF_MS: '250',
  });
  assert.strictEqual(cfg.adbMode, 'wifi');
  assert.strictEqual(cfg.keepAwake, false);
  assert.strictEqual(cfg.reconnectRetries, 5);
  assert.strictEqual(cfg.reconnectBackoffMs, 250);
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

test('scout mode is the default; agent mode reads RUNNER_MODE + poll interval', () => {
  assert.strictEqual(loadConfig({}).mode, 'scout');
  const cfg = loadConfig({ RUNNER_MODE: 'agent', RUNNER_AGENT_POLL_MS: '250' });
  assert.strictEqual(cfg.mode, 'agent');
  assert.strictEqual(cfg.agentPollMs, 250);
});

test('agent mode requires RUNNER_HOST_ID (not RUNNER_RUN_ID)', () => {
  const missing = loadConfig({
    RUNNER_BACKEND_URL: 'https://x.example',
    RUNNER_HOST_TOKEN: 't',
    RUNNER_MODE: 'agent',
  });
  assert.throws(() => assertConfig(missing), /RUNNER_HOST_ID/);

  const ok = loadConfig({
    RUNNER_BACKEND_URL: 'https://x.example',
    RUNNER_HOST_TOKEN: 't',
    RUNNER_MODE: 'agent',
    RUNNER_HOST_ID: '4',
  });
  assert.doesNotThrow(() => assertConfig(ok));
});
