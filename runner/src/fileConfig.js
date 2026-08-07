'use strict';

// Persistent runner config file — the last piece of "single-time setup".
//
// Instead of re-exporting RUNNER_* env vars every session (or baking them into a
// shell profile), the setup wizard writes them once to `.runnerrc.json` and the
// runner reads them at boot. Real environment variables always WIN over the file,
// so a one-off override (`RUNNER_RUN_ID=42 npm start`) still works.
//
// The file lives next to the runner package and is gitignored (it holds the host
// token). Path is overridable with RUNNER_CONFIG for tests / non-default installs.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '.runnerrc.json');

function configPath(env = process.env) {
  return env.RUNNER_CONFIG || DEFAULT_PATH;
}

// Read the config file into a flat { RUNNER_*: value } object. Missing / invalid
// file => {} (the runner then relies purely on real env, same as before).
function readConfigFile(p = configPath(), readFileSync = fs.readFileSync) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (_) {
    return {}; // no file yet
  }
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {}; // corrupt file shouldn't crash the runner
  }
}

// Persist a { RUNNER_*: value } object with owner-only perms (it holds a token).
function writeConfigFile(obj, p = configPath(), writeFileSync = fs.writeFileSync) {
  writeFileSync(p, `${JSON.stringify(obj || {}, null, 2)}\n`, { mode: 0o600 });
  return p;
}

// Merge file config UNDER the real environment (env wins), returning an env-shaped
// object suitable for loadConfig(). Only string values are carried from the file.
function mergeEnv(fileObj = {}, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(fileObj)) {
    if (v != null) out[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) {
    if (v != null) out[k] = v;
  }
  return out;
}

// Convenience: the merged env the runner should actually use at boot.
function resolveEnv(env = process.env) {
  return mergeEnv(readConfigFile(configPath(env)), env);
}

module.exports = { DEFAULT_PATH, configPath, readConfigFile, writeConfigFile, mergeEnv, resolveEnv };
