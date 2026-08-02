'use strict';

// Site password gate for the Deal Studio dashboard.
//
// The dashboard (/, /app.js, every /api/* admin route) is internal-only, but it
// was reachable by anyone who knew the Railway URL. This module puts a single
// shared password in front of it while leaving the genuinely public surfaces
// open — those are resolved by unguessable token, or authenticated by their own
// secret, and creators/webhooks hit them without ever seeing the dashboard:
//
//   /contract/:token, /contracts/:token   creator contract signing page
//   /o/:token                             creator offer page
//   /go/imessage                          iMessage deep-link redirect
//   /api/contracts/*, /api/offers/*       the data those two pages fetch
//   /webhook/*                            Instantly / Twilio / Meta / Linq
//   /api/bot/*                            server-to-server, x-bot-token
//   /health                               Railway health check
//
// Auth is a signed, HttpOnly session cookie: the password itself is never
// stored client-side, and rotating SITE_PASSWORD invalidates every session
// because the signing key is derived from it. Scripts and curl can skip the
// login form with `x-site-password:` or HTTP Basic instead.
//
// If SITE_PASSWORD is unset the gate is OFF (with a loud boot warning) so a
// fresh clone / local `npm start` still works and so deploying this doesn't
// lock the live dashboard out before the var is set.

const crypto = require('crypto');

const COOKIE_NAME = 'io_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_VERSION = 'v1';

// Login throttle: per-IP failed attempts, to make the shared password
// impractical to guess online. In-memory (single process, resets on deploy) —
// enough to stop scripted guessing, not a substitute for a strong password.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

// --- config ---------------------------------------------------------------

function sitePassword() {
  const raw = process.env.SITE_PASSWORD;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function enabled() {
  return sitePassword() !== null;
}

// Signing key for session cookies. Derived from the password by default so
// changing SITE_PASSWORD logs everyone out; set SITE_SESSION_SECRET to keep
// sessions alive across a password rotation instead.
function signingKey() {
  const explicit = process.env.SITE_SESSION_SECRET;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return crypto.createHash('sha256').update(`io-site-auth:${sitePassword()}`).digest('hex');
}

// --- public (ungated) paths ----------------------------------------------

// Prefix match. `/contract` also covers `/contracts/:token`, `/contract.html`
// and `/contract.js` — all three are part of the creator-facing signing page.
const PUBLIC_PREFIXES = [
  '/webhook',
  '/api/bot',
  '/api/contracts',
  '/api/offers',
  '/contract',
  '/o/',
  '/go/',
];

// Exact match: the login flow itself, the health check, and the assets the two
// creator-facing pages load.
const PUBLIC_EXACT = new Set([
  '/health',
  '/login',
  '/logout',
  '/styles.css',
  '/offer.html',
  '/offer.js',
  '/favicon.ico',
]);

function isPublicPath(pathname) {
  const p = String(pathname || '');
  if (PUBLIC_EXACT.has(p)) return true;
  return PUBLIC_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

// --- primitives -----------------------------------------------------------

// Length-independent constant-time compare (timingSafeEqual throws on a length
// mismatch, which would itself leak the length).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function createSession(now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  const payload = `${TOKEN_VERSION}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifySession(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts;
  if (version !== TOKEN_VERSION) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return false;
  return safeEqual(sig, sign(`${version}.${expRaw}`));
}

// Only same-origin, non-protocol-relative paths are safe to bounce back to
// after login (`//evil.com` is a protocol-relative URL, not a local path).
function safeNext(next) {
  const value = typeof next === 'string' ? next.trim() : '';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

// --- request auth ---------------------------------------------------------

function passwordFromHeaders(req) {
  const header = req.headers['x-site-password'];
  if (typeof header === 'string' && header) return header;
  const authz = req.headers.authorization;
  if (typeof authz === 'string' && /^basic /i.test(authz)) {
    const decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    // Any username is accepted — this is a single shared password, so the
    // username half of Basic auth carries no meaning.
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  }
  return null;
}

function isAuthed(req) {
  const password = sitePassword();
  if (!password) return true; // gate disabled
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (verifySession(cookie)) return true;
  const supplied = passwordFromHeaders(req);
  return supplied != null && safeEqual(supplied, password);
}

// A browser navigation gets bounced to the login page; anything else (fetch,
// curl, webhook) gets a plain 401 so it fails loudly instead of receiving HTML.
function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return String(req.headers.accept || '').includes('text/html');
}

function setSessionCookie(req, res) {
  res.cookie(COOKIE_NAME, createSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(req),
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function isSecure(req) {
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// --- throttle -------------------------------------------------------------

function attemptKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function throttled(req, now = Date.now()) {
  const entry = attempts.get(attemptKey(req));
  if (!entry) return false;
  if (entry.resetAt <= now) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(req, now = Date.now()) {
  const key = attemptKey(req);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearFailures(req) {
  attempts.delete(attemptKey(req));
}

function resetThrottle() {
  attempts.clear();
}

// --- login page -----------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Self-contained so the page renders identically whether or not the dashboard
// bundle loaded; palette mirrors public/styles.css.
function loginPage({ next = '/', error = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Influence — Deal Studio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      --bg: #f5f4f0; --surface: #fff; --surface-2: #faf9f6;
      --ink: #191817; --ink-2: #4d4b46; --muted: #8a8880;
      --line: #e6e4de; --line-2: #dcdad3; --danger: #FF3140;
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font); color: var(--ink); background: var(--bg);
      -webkit-font-smoothing: antialiased; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      width: 100%; max-width: 380px; background: var(--surface);
      border: 1px solid var(--line); border-radius: 16px; padding: 32px 28px;
      box-shadow: 0 1px 2px rgba(20, 18, 15, 0.03);
    }
    .logo { width: 132px; height: auto; display: block; fill: var(--ink); }
    h1 { font-size: 15px; font-weight: 600; margin: 18px 0 4px; letter-spacing: -0.01em; }
    p.sub { font-size: 13px; color: var(--muted); margin: 0 0 22px; }
    label { display: block; font-size: 12px; font-weight: 500; color: var(--ink-2); margin-bottom: 6px; }
    input[type="password"] {
      width: 100%; font: inherit; font-size: 14px; color: var(--ink);
      background: var(--surface-2); border: 1px solid var(--line-2);
      border-radius: 10px; padding: 11px 12px; outline: none;
    }
    input[type="password"]:focus { border-color: var(--ink); box-shadow: 0 0 0 3px rgba(25, 24, 23, 0.12); }
    button {
      width: 100%; margin-top: 16px; font: inherit; font-size: 14px; font-weight: 600;
      color: #fff; background: var(--ink); border: 0; border-radius: 10px;
      padding: 12px; cursor: pointer;
    }
    button:hover { background: #000; }
    .error {
      font-size: 13px; color: var(--danger); background: rgba(255, 49, 64, 0.06);
      border: 1px solid rgba(255, 49, 64, 0.18); border-radius: 10px;
      padding: 9px 11px; margin: 0 0 16px;
    }
  </style>
</head>
<body>
  <main class="card">
    <svg class="logo" viewBox="0 0 793 70" role="img" aria-label="Influence">
      <path d="M20.01 68.6729H1.35348e-05V1.03334H20.01V68.6729ZM126.221 69.8941L55.1993 29.4044V68.6729H42.5169V-4.03086e-05L113.538 40.3018V1.03334H126.221V69.8941ZM209.764 44.2475H168.992V68.6729H148.794V1.03334H219.816V11.9308H169.086V33.35H209.764V44.2475ZM306.528 68.6729H236.54V1.03334H256.738V57.7754H306.528V68.6729ZM389.07 34.6652V1.03334H401.847V34.6652C401.847 40.8029 400.813 46.1577 398.747 50.7296C396.742 55.3015 393.861 58.934 390.104 61.6271C386.409 64.3201 382.15 66.3243 377.327 67.6395C372.505 68.9547 367.119 69.6123 361.169 69.6123C348.706 69.6123 338.81 66.7627 331.483 61.0634C324.218 55.3642 320.585 46.6274 320.585 34.8531V1.03334H341.065V34.6652C341.065 38.8614 341.754 42.4939 343.132 45.5627C344.51 48.6315 346.357 51.0114 348.675 52.7024C351.054 54.3934 353.591 55.646 356.284 56.4602C359.04 57.2117 361.983 57.5875 365.115 57.5875C368.246 57.5875 371.158 57.2117 373.851 56.4602C376.607 55.646 379.144 54.3934 381.461 52.7024C383.841 51.0114 385.688 48.6315 387.004 45.5627C388.381 42.4939 389.07 38.8614 389.07 34.6652ZM494.814 68.6729H423.041V1.03334H494.814V11.9308H443.238V28.7468H484.386V39.6442H443.238V57.7754H494.814V68.6729ZM596.325 69.8941L525.303 29.4044V68.6729H512.621V-4.03086e-05L583.643 40.3018V1.03334H596.325V69.8941ZM702.321 52.6085V63.7878C692.989 67.796 681.778 69.8002 668.689 69.8002C657.917 69.8002 648.428 68.4536 640.224 65.7606C632.082 63.0049 625.694 58.9653 621.059 53.6418C616.425 48.3184 614.108 42.0555 614.108 34.8531C614.108 24.0809 619.087 15.6259 629.045 9.48828C639.003 3.28799 652.217 0.187845 668.689 0.187845C681.966 0.187845 693.177 2.19198 702.321 6.20025V18.5069C693.302 13.4965 682.78 10.9914 670.756 10.9914C659.545 10.9914 650.84 13.246 644.639 17.7553C638.439 22.202 635.339 27.9013 635.339 34.8531C635.339 41.8676 638.439 47.6294 644.639 52.1387C650.902 56.648 659.796 58.9027 671.319 58.9027C682.029 58.9027 692.363 56.8046 702.321 52.6085ZM792.821 68.6729H721.048V1.03334H792.821V11.9308H741.246V28.7468H782.393V39.6442H741.246V57.7754H792.821V68.6729Z" />
    </svg>
    <h1>Deal Studio</h1>
    <p class="sub">This dashboard is private. Enter the team password to continue.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Log in</button>
    </form>
  </main>
</body>
</html>`;
}

function sendLoginPage(res, status, opts) {
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(loginPage(opts));
}

// --- handlers -------------------------------------------------------------

// GET /login
function showLogin(req, res) {
  if (!enabled() || isAuthed(req)) return res.redirect(safeNext(req.query?.next));
  sendLoginPage(res, 200, { next: safeNext(req.query?.next) });
}

// POST /login — form post from the page above, or a JSON body from a client.
function handleLogin(req, res) {
  const body = req.body || {};
  const next = safeNext(body.next || req.query?.next);
  if (!enabled()) return res.redirect(next);

  if (throttled(req)) {
    return sendLoginPage(res, 429, { next, error: 'Too many attempts. Try again in a few minutes.' });
  }

  const supplied = typeof body.password === 'string' ? body.password : '';
  if (!supplied || !safeEqual(supplied, sitePassword())) {
    recordFailure(req);
    return sendLoginPage(res, 401, { next, error: 'Incorrect password.' });
  }

  clearFailures(req);
  setSessionCookie(req, res);
  res.redirect(next);
}

// GET|POST /logout
function handleLogout(req, res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/' });
  res.redirect('/login');
}

// --- middleware -----------------------------------------------------------

function gate(req, res, next) {
  if (!enabled()) return next();
  if (isPublicPath(req.path)) return next();
  if (isAuthed(req)) return next();

  if (wantsHtml(req)) {
    const target = req.originalUrl && req.originalUrl.startsWith('/') ? req.originalUrl : '/';
    return res.redirect(`/login?next=${encodeURIComponent(target)}`);
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function logSiteAuthConfig() {
  if (enabled()) {
    console.log('Site password gate: ON (dashboard + admin API require SITE_PASSWORD)');
  } else {
    console.warn(
      'Site password gate: OFF — SITE_PASSWORD is not set, the dashboard is publicly reachable. ' +
        'Set SITE_PASSWORD to protect it.',
    );
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  gate,
  showLogin,
  handleLogin,
  handleLogout,
  logSiteAuthConfig,
  // exported for tests
  enabled,
  sitePassword,
  isPublicPath,
  isAuthed,
  createSession,
  verifySession,
  safeEqual,
  safeNext,
  parseCookies,
  loginPage,
  resetThrottle,
};
