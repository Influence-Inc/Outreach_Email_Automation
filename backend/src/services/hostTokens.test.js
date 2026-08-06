'use strict';

// Verifies the per-host token widening: a signed-in dashboard user or the global
// DASHBOARD_API_TOKEN both still pass; a valid per-host token from sourcing_hosts
// also passes; unknown or revoked tokens are rejected. The middleware is
// deliberately additive on top of siteAuth.isAuthed so nothing already granted
// by the top-level gate is ever tightened here.

const test = require('node:test');
const assert = require('node:assert');
const { generateToken, hashToken, makeMiddleware, makePreGate } = require('./hostTokens');

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

// --- pre-gate middleware -------------------------------------------------
// Guards against the exact bug caught during Track C: siteAuth.gate runs
// synchronously and would 401 a runner request BEFORE the sync-only isAuthed
// could consult sourcing_hosts. preGateHostToken runs first, does the async
// lookup, and stamps req.__sourcingHostAuthed so isAuthed lets it through.

test('preGate stamps a valid token and lets the request continue', async () => {
  const token = generateToken();
  const dbi = {
    async one() { return { id: 5 }; },
    async query() {},
  };
  const mw = makePreGate({ db: dbi });
  const req = fakeReq({ 'x-api-token': token });
  const { nextCalled, nextErr } = await runMw(mw, req);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(nextErr, undefined);
  assert.strictEqual(req.__sourcingHostAuthed, true);
  assert.strictEqual(req.sourcingHostId, 5);
});

test('preGate never rejects — no token or unknown token just passes through', async () => {
  const dbi = { one: async () => null, query: async () => {} };
  const mw = makePreGate({ db: dbi });
  // No token
  const req1 = fakeReq({});
  const { nextCalled: n1, res: r1 } = await runMw(mw, req1);
  assert.strictEqual(n1, true);
  assert.strictEqual(r1.state.status, 200); // untouched
  assert.strictEqual(req1.__sourcingHostAuthed, undefined);
  // Unknown token — still passes so the main gate can decide (e.g. Slack session)
  const req2 = fakeReq({ 'x-api-token': 'sk_bogus' });
  const { nextCalled: n2 } = await runMw(mw, req2);
  assert.strictEqual(n2, true);
  assert.strictEqual(req2.__sourcingHostAuthed, undefined);
});

test('preGate swallows DB failures so a transient DB blip does not block Slack users', async () => {
  const dbi = { one: async () => { throw new Error('DB down'); }, query: async () => {} };
  const mw = makePreGate({ db: dbi });
  const { nextCalled, res } = await runMw(mw, fakeReq({ 'x-api-token': generateToken() }));
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.state.status, 200);
});
