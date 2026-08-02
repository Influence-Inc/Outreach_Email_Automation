'use strict';

// Run with: npm test  (node --test)
//
// Guards the site password gate: which paths stay public (creator pages,
// webhooks, health), session-cookie signing/expiry, and what an unauthenticated
// request gets back (login redirect for a browser, 401 JSON for everything
// else).
const test = require('node:test');
const assert = require('node:assert');
const auth = require('./siteAuth');

const PASSWORD = 'hunter2-hunter2';

function withPassword(password, fn) {
  const prevPassword = process.env.SITE_PASSWORD;
  const prevSecret = process.env.SITE_SESSION_SECRET;
  if (password == null) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = password;
  delete process.env.SITE_SESSION_SECRET;
  auth.resetThrottle();
  try {
    return fn();
  } finally {
    if (prevPassword === undefined) delete process.env.SITE_PASSWORD;
    else process.env.SITE_PASSWORD = prevPassword;
    if (prevSecret === undefined) delete process.env.SITE_SESSION_SECRET;
    else process.env.SITE_SESSION_SECRET = prevSecret;
    auth.resetThrottle();
  }
}

function req({ path = '/', method = 'GET', headers = {}, originalUrl } = {}) {
  return { path, method, headers, originalUrl: originalUrl || path, ip: '10.0.0.1', query: {} };
}

// Minimal express-ish res: records what the handler did.
function res() {
  const out = { statusCode: 200, redirected: null, body: null, headers: {} };
  return Object.assign(out, {
    status(code) { out.statusCode = code; return this; },
    redirect(url) { out.redirected = url; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
    set(key, value) { out.headers[key] = value; return this; },
  });
}

test('creator-facing and machine paths stay public', () => {
  for (const p of [
    '/health',
    '/login',
    '/logout',
    '/styles.css',
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
    '/api/creators/5/offer',
    '/api/creator-db/search',
    '/api/settings',
    '/api/offer-review',
    '/api/debug/ig-cookie',
  ]) {
    assert.strictEqual(auth.isPublicPath(p), false, `${p} should be gated`);
  }
});

test('gate is a no-op when SITE_PASSWORD is unset', () => {
  withPassword(null, () => {
    assert.strictEqual(auth.enabled(), false);
    let called = false;
    const r = res();
    auth.gate(req({ path: '/api/campaigns' }), r, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual(r.redirected, null);
  });
});

test('unauthenticated API call gets 401 JSON, not the login HTML', () => {
  withPassword(PASSWORD, () => {
    const r = res();
    let called = false;
    auth.gate(req({ path: '/api/campaigns', headers: { accept: 'application/json' } }), r, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(r.statusCode, 401);
    assert.deepStrictEqual(r.body, { error: 'Unauthorized' });
  });
});

test('unauthenticated browser navigation redirects to /login with a next param', () => {
  withPassword(PASSWORD, () => {
    const r = res();
    auth.gate(
      req({ path: '/campaign/12', originalUrl: '/campaign/12?tab=all', headers: { accept: 'text/html' } }),
      r,
      () => assert.fail('should not pass through'),
    );
    assert.strictEqual(r.redirected, `/login?next=${encodeURIComponent('/campaign/12?tab=all')}`);
  });
});

test('a valid session cookie passes the gate', () => {
  withPassword(PASSWORD, () => {
    const cookie = `${auth.COOKIE_NAME}=${auth.createSession()}`;
    let called = false;
    auth.gate(req({ path: '/api/campaigns', headers: { cookie } }), res(), () => { called = true; });
    assert.strictEqual(called, true);
  });
});

test('sessions expire and tampered signatures are rejected', () => {
  withPassword(PASSWORD, () => {
    const now = Date.now();
    const token = auth.createSession(now);
    assert.strictEqual(auth.verifySession(token, now), true);
    assert.strictEqual(auth.verifySession(token, now + auth.SESSION_TTL_MS + 1), false);
    assert.strictEqual(auth.verifySession(`${token}x`, now), false);
    // Extending the expiry without re-signing must not validate.
    const [version, exp, sig] = token.split('.');
    assert.strictEqual(auth.verifySession(`${version}.${Number(exp) + 1000}.${sig}`, now), false);
    assert.strictEqual(auth.verifySession('', now), false);
    assert.strictEqual(auth.verifySession('garbage', now), false);
  });
});

test('rotating the password invalidates existing sessions', () => {
  const token = withPassword(PASSWORD, () => auth.createSession());
  withPassword('a-different-password', () => {
    assert.strictEqual(auth.verifySession(token), false);
  });
});

test('scripts can authenticate with a header or HTTP Basic', () => {
  withPassword(PASSWORD, () => {
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-site-password': PASSWORD } })), true);
    assert.strictEqual(auth.isAuthed(req({ headers: { 'x-site-password': 'nope' } })), false);

    const basic = Buffer.from(`team:${PASSWORD}`).toString('base64');
    assert.strictEqual(auth.isAuthed(req({ headers: { authorization: `Basic ${basic}` } })), true);

    const wrong = Buffer.from('team:nope').toString('base64');
    assert.strictEqual(auth.isAuthed(req({ headers: { authorization: `Basic ${wrong}` } })), false);
  });
});

test('POST /login sets a session cookie on the right password only', () => {
  withPassword(PASSWORD, () => {
    const good = res();
    const cookies = [];
    good.cookie = (name, value, opts) => { cookies.push({ name, value, opts }); return good; };
    auth.handleLogin({ ...req({ method: 'POST', path: '/login' }), body: { password: PASSWORD, next: '/campaign/3' } }, good);
    assert.strictEqual(good.redirected, '/campaign/3');
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].name, auth.COOKIE_NAME);
    assert.strictEqual(cookies[0].opts.httpOnly, true);
    assert.strictEqual(auth.verifySession(cookies[0].value), true);

    const bad = res();
    bad.cookie = () => assert.fail('must not issue a cookie for a wrong password');
    auth.handleLogin({ ...req({ method: 'POST', path: '/login' }), body: { password: 'wrong' } }, bad);
    assert.strictEqual(bad.statusCode, 401);
    assert.match(bad.body, /Incorrect password/);
  });
});

test('login throttles after repeated failures from one IP', () => {
  withPassword(PASSWORD, () => {
    const attempt = (password) => {
      const r = res();
      r.cookie = () => r;
      auth.handleLogin({ ...req({ method: 'POST', path: '/login' }), body: { password } }, r);
      return r;
    };
    for (let i = 0; i < 10; i += 1) assert.strictEqual(attempt('wrong').statusCode, 401);
    const blocked = attempt('wrong');
    assert.strictEqual(blocked.statusCode, 429);
    // Even the correct password is refused while the throttle window is open.
    assert.strictEqual(attempt(PASSWORD).statusCode, 429);
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

test('login page escapes the next param instead of reflecting markup', () => {
  const html = auth.loginPage({ next: '/"><script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
