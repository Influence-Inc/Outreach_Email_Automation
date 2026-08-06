'use strict';

// Per-host token authentication for creator-sourcing runners.
//
// The dashboard mints a token per paired phone-host and stores only the SHA-256
// hash in sourcing_hosts (never the plaintext). The runner sends the plaintext
// as x-api-token on every /api/sourcing/* request. This module exposes:
//
//   generateToken()          — new plaintext token to hand back to the operator
//                              (returned exactly ONCE by the mint endpoint)
//   hashToken(plaintext)     — SHA-256 hex, stored in sourcing_hosts.token_hash
//   requireHostOrSlack(...)  — express middleware: allow if the request already
//                              carries a valid Slack session or global machine
//                              token (siteAuth.isAuthed passed), OR if the
//                              x-api-token maps to an active row in sourcing_hosts.
//
// The middleware is additive — it never rejects a request siteAuth already
// approved. This keeps siteAuth.js (a security-sensitive file) untouched.

const crypto = require('crypto');
const db = require('../db');
const siteAuth = require('./siteAuth');

// URL-safe base64 of 32 random bytes — ≈256 bits, "sk_" prefix so it's spottable
// in a log by a human. The prefix is also part of the token; hash includes it.
function generateToken() {
  const b = crypto.randomBytes(32).toString('base64url');
  return `sk_${b}`;
}

function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext || ''), 'utf8').digest('hex');
}

// Constant-time header lookup for the token — mirrors siteAuth.tokenFromHeaders
// but stays local so we don't reach into that module's private helpers.
function readToken(req) {
  const raw = req.headers['x-api-token'];
  if (typeof raw === 'string' && raw) return raw.trim();
  return null;
}

// Middleware factory. `db` is injected so tests can supply a stub; production
// callers just import `requireHostOrSlack` and mount it.
function makeMiddleware({ db: dbi = db, isAuthed = siteAuth.isAuthed } = {}) {
  return async function requireHostOrSlack(req, res, next) {
    // Fast path: signed-in dashboard user or global machine token.
    try {
      if (isAuthed(req)) return next();
    } catch (_) { /* fall through to per-host lookup */ }

    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const row = await dbi.one(
        `SELECT id FROM sourcing_hosts WHERE token_hash = $1 AND status = 'active'`,
        [hashToken(token)],
      );
      if (!row) return res.status(401).json({ error: 'Unauthorized' });
      // Best-effort last_seen_at stamp — never blocks the request.
      dbi.query(`UPDATE sourcing_hosts SET last_seen_at = NOW() WHERE id = $1`, [row.id])
        .catch(() => {});
      req.sourcingHostId = row.id;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Pre-gate middleware for /api/sourcing/*: validate the per-host token
// (async DB lookup) BEFORE siteAuth.gate runs. If valid, mark the request
// so siteAuth.isAuthed lets it through. If absent/invalid, pass through
// silently so the normal gate can still authorize a signed-in dashboard
// session on the same path — never REJECTS here, that stays the gate's job.
function makePreGate({ db: dbi = db } = {}) {
  return async function preGateHostToken(req, _res, next) {
    const token = readToken(req);
    if (!token) return next();
    try {
      const row = await dbi.one(
        `SELECT id FROM sourcing_hosts WHERE token_hash = $1 AND status = 'active'`,
        [hashToken(token)],
      );
      if (row) {
        req.sourcingHostId = row.id;
        req.__sourcingHostAuthed = true;
        dbi.query(`UPDATE sourcing_hosts SET last_seen_at = NOW() WHERE id = $1`, [row.id])
          .catch(() => {});
      }
    } catch (_) { /* swallow — the main gate still gets to decide */ }
    return next();
  };
}

module.exports = {
  generateToken,
  hashToken,
  requireHostOrSlack: makeMiddleware(),
  preGateHostToken: makePreGate(),
  makeMiddleware, // exposed for tests
  makePreGate,    // exposed for tests
};
