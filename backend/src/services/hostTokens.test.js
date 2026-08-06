'use strict';

// Verifies the per-host token widening: a signed-in dashboard user or the global
// DASHBOARD_API_TOKEN both still pass; a valid per-host token from sourcing_hosts
// also passes; unknown or revoked tokens are rejected. The middleware is
// deliberately additive on top of siteAuth.isAuthed so nothing already granted
// by the top-level gate is ever tightened here.

const test = require('node:test');
const assert = require('node:assert');
const { generateToken, hashToken, makeMiddleware } = require('./hostTokens');

function fakeReq(headers = {}) { return { headers, sourcingHostId: undefined }; }
function fakeRes() {
  const state = { status: 200, body: null };
  return {
    state,
    status(n) { state.status = n; return this; },
    json(b) { state.body = b; return this; },
  };
}

function runMw(mw, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let nextErr = null;
    let nextCalled = false;
    mw(req, res, (err) => { nextErr = err; nextCalled = true; });
    // Middleware may await async lookups — give it a tick.
    setImmediate(() => resolve({ res, nextCalled, nextErr }));
  });
}

test('generateToken produces prefixed, high-entropy tokens; hashToken is deterministic', () => {
  const t = generateToken();
  assert.match(t, /^sk_/);
  assert.ok(t.length > 20);
  const h = hashToken(t);
  assert.strictEqual(h.length, 64, 'SHA-256 hex');
  assert.strictEqual(h, hashToken(t));
  assert.notStrictEqual(h, hashToken(t + 'x'));
});

test('middleware short-circuits when siteAuth.isAuthed already passes', async () => {
  const dbi = { one: async () => { throw new Error('should not query DB'); }, query: async () => {} };
  const mw = makeMiddleware({ db: dbi, isAuthed: () => true });
  const { nextCalled, nextErr, res } = await runMw(mw, fakeReq({ 'x-api-token': 'anything' }));
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(nextErr, undefined);
  assert.strictEqual(res.state.status, 200);
});

test('valid per-host token authorizes and stamps last_seen_at', async () => {
  const token = generateToken();
  const stampCalls = [];
  const dbi = {
    async one(sql, params) {
      assert.match(sql, /sourcing_hosts/);
      assert.match(sql, /status = 'active'/);
      assert.strictEqual(params[0], hashToken(token));
      return { id: 42 };
    },
    async query(sql, params) { stampCalls.push({ sql, params }); },
  };
  const mw = makeMiddleware({ db: dbi, isAuthed: () => false });
  const req = fakeReq({ 'x-api-token': token });
  const { nextCalled, nextErr } = await runMw(mw, req);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(nextErr, undefined);
  assert.strictEqual(req.sourcingHostId, 42);
  // last_seen_at bump is fire-and-forget; give it a tick to have posted.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(stampCalls.length, 1);
  assert.match(stampCalls[0].sql, /UPDATE sourcing_hosts/);
});

test('unknown token → 401', async () => {
  const dbi = { one: async () => null, query: async () => {} };
  const mw = makeMiddleware({ db: dbi, isAuthed: () => false });
  const { res, nextCalled } = await runMw(mw, fakeReq({ 'x-api-token': 'sk_bogus' }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.state.status, 401);
});

test('missing token → 401', async () => {
  const dbi = { one: async () => { throw new Error('should not query'); }, query: async () => {} };
  const mw = makeMiddleware({ db: dbi, isAuthed: () => false });
  const { res, nextCalled } = await runMw(mw, fakeReq({}));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.state.status, 401);
});

test('a revoked host (WHERE status = active filters it out) → 401', async () => {
  // The SQL filters on status='active', so a revoked row returns no result — the
  // middleware treats that the same as an unknown token.
  const dbi = { one: async () => null, query: async () => {} };
  const mw = makeMiddleware({ db: dbi, isAuthed: () => false });
  const { res } = await runMw(mw, fakeReq({ 'x-api-token': generateToken() }));
  assert.strictEqual(res.state.status, 401);
});
