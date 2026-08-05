'use strict';

// Run with: npm test  (node --test)
//
// Guards the Sign-in-with-Slack gate: which paths stay public (creator pages,
// webhooks, health, the OAuth endpoints), session-cookie signing/expiry, the
// signed OAuth state, who's allowed in (workspace + email domain), the machine
// token path, and what an unauthenticated request gets back (login redirect for
// a browser, 401 JSON for everything else).
const test = require('node:test');
const assert = require('node:assert');
const auth = require('./siteAuth');

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

// Run `fn` with Slack configured (and optional extra env), restoring afterwards.
function withEnv(extra, fn) {
  const keys = [
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_ALLOWED_TEAM_ID',
    'SLACK_ALLOWED_EMAIL_DOMAINS',
    'SLACK_REDIRECT_URI',
    'SITE_SESSION_SECRET',
    'DASHBOARD_API_TOKEN',
  ];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  const env = { SLACK_CLIENT_ID: CLIENT_ID, SLACK_CLIENT_SECRET: CLIENT_SECRET, ...extra };
  for (const [k, v] of Object.entries(env)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  // Restore AFTER an async fn settles, not the instant its promise is created —
  // otherwise the env is gone before the awaited body ever reads it.
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { restore(); return v; },
      (err) => { restore(); throw err; },
    );
  }
  restore();
  return result;
}

// Slack disabled (no client id/secret).
function withDisabled(fn) {
  return withEnv({ SLACK_CLIENT_ID: null, SLACK_CLIENT_SECRET: null }, fn);
}

function req({ path = '/', method = 'GET', headers = {}, originalUrl, query } = {}) {
  return { path, method, headers, originalUrl: originalUrl || path, ip: '10.0.0.1', query: query || {} };
}

// Minimal express-ish res: records what the handler did.
function res() {
  const out = { statusCode: 200, redirected: null, body: null, headers: {}, cookies: [] };
  return Object.assign(out, {
    status(code) { out.statusCode = code; return this; },
    redirect(url) { out.redirected = url; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
    set(key, value) { out.headers[key] = value; return this; },
    cookie(name, value, opts) { out.cookies.push({ name, value, opts }); return this; },
    clearCookie(name, opts) { out.cookies.push({ name, value: null, opts }); return this; },
  });
}

const USER = { email: 'jen@useinfluence.xyz', name: 'Jennifer', teamId: 'T123' };

// A signed id_token whose payload carries the given claims. Only the payload
// segment matters — the gate trusts it because it comes from the token endpoint.
function idToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.signature`;
}

function slackClaims(over = {}) {
  return {
    sub: 'U123',
    email: 'jen@useinfluence.xyz',
    email_verified: true,
    name: 'Jennifer',
    'https://slack.com/team_id': 'T123',
    'https://slack.com/team_name': 'Influence',
    ...over,
  };
}

test('creator-facing, machine and OAuth paths stay public', () => {
  for (const p of [
    '/health',
    '/login',
    '/logout',
    '/styles.css',
    '/auth/slack',
    '/auth/slack/callback',
    '/contract/abc123',
    '/contracts/abc123',
    '/contract.js',
    '/contract.html',
    '/o/tok123',
    '/offer.js',
    '/offer.html',
    '/go/imessage',
    '/api/contracts/abc123',
    '/api/offers/tok123/respond',
    '/api/bot/contracts',
    '/webhook/whatsapp',
  ]) {
    assert.strictEqual(auth.isPublicPath(p), true, `${p} should be public`);
  }
});

test('the dashboard and admin API are gated', () => {
  for (const p of [
    '/',
    '/index.html',
    '/app.js',
    '/campaign/12',
    '/api/campaigns',
    '/api/me',
    '/api/creators/5/offer',
    '/api/creator-db/search',
    '/api/settings',
  ]) {
    assert.strictEqual(auth.isPublicPath(p), false, `${p} should be gated`);
  }
});

test('gate is a no-op when Slack is not configured', () => {
  withDisabled(() => {
    assert.strictEqual(auth.enabled(), false);
    let called = false;
    const r = res();
    auth.gate(req({ path: '/api/campaigns' }), r, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual(r.redirected, null);
  });
});

test('unauthenticated API call gets 401 JSON, not the login HTML', () => {
  withEnv({}, () => {
    const r = res();
    let called = false;
    auth.gate(req({ path: '/api/campaigns', headers: { accept: 'application/json' } }), r, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(r.statusCode, 401);
    assert.deepStrictEqual(r.body, { error: 'Unauthorized' });
  });
});

test('unauthenticated browser navigation redirects to /login with a next param', () => {
  withEnv({}, () => {
    const r = res();
    auth.gate(
      req({ path: '/campaign/12', originalUrl: '/campaign/12?tab=all', headers: { accept: 'text/html' } }),
      r,
      () => assert.fail('should not pass through'),
    );
    assert.strictEqual(r.redirected, `/login?next=${encodeURIComponent('/campaign/12?tab=all')}`);
  });
});

test('a valid session cookie passes the gate and carries identity', () => {
  withEnv({}, () => {
    const cookie = `${auth.COOKIE_NAME}=${auth.createSession(USER)}`;
    let called = false;
    auth.gate(req({ path: '/api/campaigns', headers: { cookie } }), res(), () => { called = true; });
    assert.strictEqual(called, true);

    const user = auth.sessionUser(req({ headers: { cookie } }));
    assert.strictEqual(user.email, USER.email);
    assert.strictEqual(user.name, USER.name);
    assert.strictEqual(user.teamId, USER.teamId);
  });
});

test('the extension can forward the session token via the x-io-session header', () => {
  withEnv({}, () => {
    const token = auth.createSession(USER);
    // No cookie — just the header the extension sends after reading io_session.
    const headers = { [auth.SESSION_HEADER]: token };
    let called = false;
    auth.gate(req({ path: '/api/campaigns', headers }), res(), () => { called = true; });
    assert.strictEqual(called, true);

    const user = auth.sessionUser(req({ headers }));
    assert.strictEqual(user.email, USER.email);

    // A forged header token is rejected.
    assert.strictEqual(auth.sessionUser(req({ headers: { [auth.SESSION_HEADER]: `${token}x` } })), null);
  });
});

test('sessions expire and tampered signatures are rejected', () => {
  withEnv({}, () => {
    const now = Date.now();
    const token = auth.createSession(USER, now);
    assert.ok(auth.readSession(token, now));
    assert.strictEqual(auth.readSession(token, now + auth.SESSION_TTL_MS + 1), null);
    assert.strictEqual(auth.readSession(`${token}x`, now), null);
    // Extending the expiry without re-signing must not validate.
    const [version, exp, body, sig] = token.split('.');
    assert.strictEqual(auth.readSession(`${version}.${Number(exp) + 1000}.${body}.${sig}`, now), null);
    assert.strictEqual(auth.readSession('', now), null);
    assert.strictEqual(auth.readSession('garbage', now), null);
  });
});

test('rotating the signing secret invalidates existing sessions', () => {
  const token = withEnv({ SITE_SESSION_SECRET: 'secret-one' }, () => auth.createSession(USER));
  withEnv({ SITE_SESSION_SECRET: 'secret-two' }, () => {
    assert.strictEqual(auth.readSession(token), null);
  });
});

test('OAuth state round-trips the next path and rejects tampering', () => {
  withEnv({}, () => {
    const now = Date.now();
    const state = auth.createState('/campaign/9', now);
    assert.deepStrictEqual(auth.verifyState(state, now), { next: '/campaign/9' });
    assert.strictEqual(auth.verifyState(`${state}x`, now), null);
    assert.strictEqual(auth.verifyState(state, now + 60 * 60 * 1000), null); // expired
    // An off-origin next is scrubbed back to '/'.
    const evil = auth.createState('//evil.example.com', now);
    assert.deepStrictEqual(auth.verifyState(evil, now), { next: '/' });
  });
});

test('authorize URL carries client id, redirect, scope and state', () => {
  withEnv({ SLACK_ALLOWED_TEAM_ID: 'T123' }, () => {
    const url = new URL(
      auth.authorizeUrl({ clientId: CLIENT_ID, redirectUri: 'https://app.example.com/auth/slack/callback', state: 'st8' }),
    );
    assert.strictEqual(url.origin + url.pathname, 'https://slack.com/openid/connect/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), CLIENT_ID);
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://app.example.com/auth/slack/callback');
    assert.strictEqual(url.searchParams.get('state'), 'st8');
    // A single pinned workspace is hinted to Slack.
    assert.strictEqual(url.searchParams.get('team'), 'T123');
  });
});

test('validateUser enforces workspace and email-domain allowlists', () => {
  const decode = (over) => auth.claimsToUser(auth.decodeIdToken(idToken(slackClaims(over))));

  withEnv({ SLACK_ALLOWED_TEAM_ID: 'T123', SLACK_ALLOWED_EMAIL_DOMAINS: 'useinfluence.xyz' }, () => {
    assert.strictEqual(auth.validateUser(decode()).ok, true);
    // Wrong workspace.
    assert.strictEqual(auth.validateUser(decode({ 'https://slack.com/team_id': 'TOTHER' })).ok, false);
    // Wrong email domain.
    assert.strictEqual(auth.validateUser(decode({ email: 'someone@gmail.com' })).ok, false);
    // Unverified email.
    assert.strictEqual(auth.validateUser(decode({ email_verified: false })).ok, false);
    // Missing email.
    assert.strictEqual(auth.validateUser(decode({ email: undefined })).ok, false);
  });

  // With no restrictions any verified Slack account is allowed.
  withEnv({}, () => {
    assert.strictEqual(auth.validateUser(decode({ email: 'anyone@example.org', 'https://slack.com/team_id': 'TX' })).ok, true);
  });
});

test('handleSlackCallback signs a user in on a good code', async () => {
  await withEnv({ SLACK_ALLOWED_TEAM_ID: 'T123', SLACK_ALLOWED_EMAIL_DOMAINS: 'useinfluence.xyz' }, async () => {
    auth.setTokenExchanger(async () => ({ ok: true, id_token: idToken(slackClaims()) }));
    try {
      const state = auth.createState('/campaign/3');
      const r = res();
      await auth.handleSlackCallback(req({ path: '/auth/slack/callback', query: { code: 'good', state } }), r);
      assert.strictEqual(r.redirected, '/campaign/3');
      assert.strictEqual(r.cookies.length, 1);
      assert.strictEqual(r.cookies[0].name, auth.COOKIE_NAME);
      assert.strictEqual(r.cookies[0].opts.httpOnly, true);
      const user = auth.readSession(r.cookies[0].value);
      assert.strictEqual(user.email, 'jen@useinfluence.xyz');
    } finally {
      auth.setTokenExchanger(null);
    }
  });
});

test('handleSlackCallback refuses a disallowed workspace without a cookie', async () => {
  await withEnv({ SLACK_ALLOWED_TEAM_ID: 'T999' }, async () => {
    auth.setTokenExchanger(async () => ({ ok: true, id_token: idToken(slackClaims()) }));
    try {
      const state = auth.createState('/');
      const r = res();
      await auth.handleSlackCallback(req({ path: '/auth/slack/callback', query: { code: 'good', state } }), r);
      assert.strictEqual(r.statusCode, 403);
      assert.strictEqual(r.cookies.length, 0);
      assert.match(r.body, /workspace is not allowed/i);
    } finally {
      auth.setTokenExchanger(null);
    }
  });
});

test('handleSlackCallback rejects a forged/expired state before hitting Slack', async () => {
  await withEnv({}, async () => {
    let exchanged = false;
    auth.setTokenExchanger(async () => { exchanged = true; return { ok: true }; });
    try {
      const r = res();
      await auth.handleSlackCallback(req({ path: '/auth/slack/callback', query: { code: 'x', state: 'forged' } }), r);
      assert.strictEqual(r.statusCode, 400);
      assert.strictEqual(exchanged, false, 'must not exchange a code for an invalid state');
    } finally {
      auth.setTokenExchanger(null);
    }
  });
});

test('non-browser clients authenticate with the machine token', () => {
  withEnv({ DASHBOARD_API_TOKEN: 'svc-token-123' }, () => {
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-api-token': 'svc-token-123' } })), true);
    // Legacy header name still works so the extension keeps functioning.
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-site-password': 'svc-token-123' } })), true);
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-api-token': 'nope' } })), false);

    const basic = Buffer.from(`svc:svc-token-123`).toString('base64');
    assert.strictEqual(auth.isAuthed(req({ headers: { authorization: `Basic ${basic}` } })), true);

    const wrong = Buffer.from('svc:nope').toString('base64');
    assert.strictEqual(auth.isAuthed(req({ headers: { authorization: `Basic ${wrong}` } })), false);
  });

  // With no machine token set, a header can't authenticate.
  withEnv({}, () => {
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-api-token': 'anything' } })), false);
  });
});

test('beginSlackLogin redirects to Slack with a signed state', () => {
  withEnv({ SLACK_REDIRECT_URI: 'https://app.example.com/auth/slack/callback' }, () => {
    const r = res();
    auth.beginSlackLogin(req({ path: '/auth/slack', query: { next: '/campaign/2' } }), r);
    const url = new URL(r.redirected);
    assert.strictEqual(url.origin + url.pathname, 'https://slack.com/openid/connect/authorize');
    const state = url.searchParams.get('state');
    assert.deepStrictEqual(auth.verifyState(state), { next: '/campaign/2' });
  });
});

test('handleMe reports the signed-in user and null when anonymous', () => {
  withEnv({}, () => {
    const cookie = `${auth.COOKIE_NAME}=${auth.createSession(USER)}`;
    const signed = res();
    auth.handleMe(req({ headers: { cookie } }), signed);
    assert.deepStrictEqual(signed.body, { email: USER.email, name: USER.name });

    const anon = res();
    auth.handleMe(req({ headers: {} }), anon);
    assert.deepStrictEqual(anon.body, { email: null, name: null });
  });
});

test('next is confined to same-origin paths', () => {
  assert.strictEqual(auth.safeNext('/campaign/3'), '/campaign/3');
  assert.strictEqual(auth.safeNext('//evil.example.com'), '/');
  assert.strictEqual(auth.safeNext('https://evil.example.com'), '/');
  assert.strictEqual(auth.safeNext(''), '/');
  assert.strictEqual(auth.safeNext(undefined), '/');
});

test('parseCookies reads the session cookie out of a multi-cookie header', () => {
  const cookies = auth.parseCookies('foo=1; io_session=abc.def; bar=2');
  assert.strictEqual(cookies.io_session, 'abc.def');
  assert.strictEqual(cookies.foo, '1');
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
});

test('login page offers a Sign in with Slack link and escapes the next param', () => {
  const html = auth.loginPage({ next: '/"><script>alert(1)</script>' });
  assert.match(html, /Sign in with Slack/);
  assert.match(html, /\/auth\/slack\?next=/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
});
