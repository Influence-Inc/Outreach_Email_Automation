'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('./fileConfig');

test('readConfigFile parses JSON, tolerating missing / corrupt files', () => {
  const ok = fc.readConfigFile('/x', () => '{"RUNNER_HOST_ID":"7"}');
  assert.deepStrictEqual(ok, { RUNNER_HOST_ID: '7' });

  const missing = fc.readConfigFile('/x', () => { throw new Error('ENOENT'); });
  assert.deepStrictEqual(missing, {});

  const corrupt = fc.readConfigFile('/x', () => 'not json');
  assert.deepStrictEqual(corrupt, {});

  const arr = fc.readConfigFile('/x', () => '[1,2]');
  assert.deepStrictEqual(arr, {}); // arrays aren't a config object
});

test('writeConfigFile serializes with 0600 perms and returns the path', () => {
  let wrote = null;
  const p = fc.writeConfigFile({ RUNNER_MODE: 'agent' }, '/tmp/rc.json', (path, data, opts) => {
    wrote = { path, data, opts };
  });
  assert.strictEqual(p, '/tmp/rc.json');
  assert.strictEqual(wrote.path, '/tmp/rc.json');
  assert.match(wrote.data, /"RUNNER_MODE": "agent"/);
  assert.strictEqual(wrote.opts.mode, 0o600);
});

test('mergeEnv lets real env override the file, stringifying file values', () => {
  const merged = fc.mergeEnv(
    { RUNNER_HOST_ID: 7, RUNNER_BACKEND_URL: 'https://file' },
    { RUNNER_BACKEND_URL: 'https://env', PATH: '/usr/bin' },
  );
  assert.strictEqual(merged.RUNNER_HOST_ID, '7'); // from file, stringified
  assert.strictEqual(merged.RUNNER_BACKEND_URL, 'https://env'); // env wins
  assert.strictEqual(merged.PATH, '/usr/bin'); // real env carried through
});

test('configPath honors RUNNER_CONFIG override, else defaults next to the package', () => {
  assert.strictEqual(fc.configPath({ RUNNER_CONFIG: '/custom/rc.json' }), '/custom/rc.json');
  assert.match(fc.configPath({}), /\.runnerrc\.json$/);
});
