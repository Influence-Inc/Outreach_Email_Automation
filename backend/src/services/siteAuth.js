'use strict';

// Sign-in gate for the Deal Studio dashboard.
//
// The dashboard (/, /app.js, every /api/* admin route) is internal-only. Access
// is granted by "Sign in with Slack" (Slack's OpenID Connect flow): a team
// member signs in with their Slack account, we check they're in the right
// workspace / on the right email domain, and issue a signed, HttpOnly session
// cookie. No password is ever typed or stored.
//
// The genuinely public surfaces stay open — they're resolved by unguessable
// token, or authenticated by their own secret, and creators/webhooks hit them
// without ever seeing the dashboard:
//
//   /contract/:token, /contracts/:token   creator contract signing page
//   /o/:token                             creator offer page
//   /go/imessage                          iMessage deep-link redirect
//   /api/contracts/*, /api/offers/*       the data those two pages fetch
//   /webhook/*                            Instantly / Twilio / Meta / Linq
//   /api/bot/*                            server-to-server, x-bot-token
//   /health                               Railway health check
//   /login, /logout, /auth/slack*         the sign-in flow itself
//
// The Chrome extension can't ride the HttpOnly session cookie on its
// extension-origin fetches, so it reuses the team member's existing dashboard
// sign-in: it reads the `io_session` cookie via the browser's cookies API and
// forwards the same signed token in the `x-io-session` header. No per-user
// setup, and extension access is automatically tied to being signed in to the
// dashboard.
//
// Truly headless clients (curl, cron scripts) have no Slack session at all, so
// they authenticate with a shared machine token instead — DASHBOARD_API_TOKEN,
// sent as `x-api-token` (or the legacy `x-site-password` header, or HTTP Basic).
// This is a service credential, distinct from the human Slack sign-in.
//
// If SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are unset the gate is OFF (with a
// loud boot warning) so a fresh clone / local `npm start` still works and so
// deploying this doesn't lock the live dashboard out before the vars are set.

const crypto = require('crypto');

const COOKIE_NAME = 'io_session';
// Header the Chrome extension uses to forward the session token it read from the
// dashboard's cookie (extension-origin fetches can't send the cookie itself).
const SESSION_HEADER = 'x-io-session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_TTL_MS = 15 * 60 * 1000; // OAuth round-trip window
const SESSION_VERSION = 'v2';
const STATE_VERSION = 's1';

const SLACK_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_TEAM_CLAIM = 'https://slack.com/team_id';
const SLACK_TEAM_NAME_CLAIM = 'https://slack.com/team_name';

// --- config ---------------------------------------------------------------

function envStr(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function slackClientId() {
  return envStr('SLACK_CLIENT_ID');
}

function slackClientSecret() {
  return envStr('SLACK_CLIENT_SECRET');
}

// The gate is only active once Slack is configured. Until then the dashboard is
// open (fresh clone / local dev), matching the old "SITE_PASSWORD unset" default.
function enabled() {
  return slackClientId() !== null && slackClientSecret() !== null;
}

// Optional shared machine credential for non-browser clients (extension, curl).
function machineToken() {
  return envStr('DASHBOARD_API_TOKEN');
}

// Comma/space-separated list → Set (empty Set = "no restriction"). `lower`
// controls case-folding: on for email domains (case-insensitive), off for Slack
// team IDs (case-sensitive identifiers we must hand back to Slack verbatim).
function envList(name, { lower = false } = {}) {
  const raw = process.env[name];
  const set = new Set();
  if (typeof raw !== 'string') return set;
  for (const part of raw.split(/[\s,]+/)) {
    const v = part.trim();
    if (v) set.add(lower ? v.toLowerCase() : v);
  }
  return set;
}

// Restrict who may sign in. Both optional; when set, the Slack account must
// match. Leaving both unset means "anyone with a Slack account can sign in",
// which is why the boot log warns about it.
function allowedTeamIds() {
  return envList('SLACK_ALLOWED_TEAM_ID');
}

function allowedEmailDomains() {
  return envList('SLACK_ALLOWED_EMAIL_DOMAINS', { lower: true });
}

// Signing key for session + OAuth-state tokens. Prefer an explicit secret so
// sessions survive across credential rotations; otherwise derive a stable key
// from the Slack client secret. If neither is available (gate off) fall back to
// a per-process random key.
const EPHEMERAL_KEY = crypto.randomBytes(32).toString('hex');
function signingKey() {
  const explicit = envStr('SITE_SESSION_SECRET');
  if (explicit) return explicit;
  const secret = slackClientSecret();
  if (secret) return crypto.createHash('sha256').update(`io-slack-auth:${secret}`).digest('hex');
  return EPHEMERAL_KEY;
}

// The OAuth callback must resolve to THIS backend's own origin (the dashboard
// is served from here directly — only creator pages go through the campaigns
// proxy, so PUBLIC_BASE_URL is deliberately NOT used here). Prefer an explicit
// SLACK_REDIRECT_URI; otherwise derive it from the incoming request.
function redirectUri(req) {
  const explicit = envStr('SLACK_REDIRECT_URI');
  if (explicit) return explicit;
  return `${originFromReq(req)}/auth/slack/callback`;
}

function originFromReq(req) {
  const proto = isSecure(req)
    ? 'https'
    : String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

// --- public (ungated) paths ----------------------------------------------

// Prefix match. `/contract` also covers `/contracts/:token`, `/contract.html`
// and `/contract.js`; `/auth/slack` covers the begin + callback endpoints.
const PUBLIC_PREFIXES = [
  '/webhook',
  '/api/bot',
  '/api/contracts',
  '/api/offers',
  '/contract',
  '/o/',
  '/go/',
  '/auth/slack',
];

// Exact match: the sign-in flow itself, the health check, and the assets the two
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

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function parseB64urlJson(segment) {
  try {
    return JSON.parse(Buffer.from(String(segment), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// --- session cookie (identity-carrying) -----------------------------------

// Token layout: v2.<exp>.<base64url(user)>.<sig>. `user` is { e: email,
// n: name, t: teamId }. Anyone can read the identity, but the HMAC signature
// (keyed by signingKey) means it can't be forged or extended.
function createSession(user = {}, now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  const claims = { e: user.email || '', n: user.name || '', t: user.teamId || '' };
  const payload = `${SESSION_VERSION}.${exp}.${b64urlJson(claims)}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the decoded user ({ email, name, teamId }) for a valid, unexpired,
// correctly-signed token; otherwise null.
function readSession(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, expRaw, body, sig] = parts;
  if (version !== SESSION_VERSION) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return null;
  if (!safeEqual(sig, sign(`${version}.${expRaw}.${body}`))) return null;
  const claims = parseB64urlJson(body);
  if (!claims) return null;
  return { email: claims.e || '', name: claims.n || '', teamId: claims.t || '' };
}

// --- OAuth state (CSRF) ---------------------------------------------------

// Signed, short-lived token round-tripped through Slack to defeat CSRF and to
// carry the post-login redirect target. Layout: s1.<exp>.<base64url({n,x})>.<sig>
// where n = random nonce, x = safe next path.
function createState(next = '/', now = Date.now()) {
  const exp = now + STATE_TTL_MS;
  const data = { n: crypto.randomBytes(12).toString('base64url'), x: safeNext(next) };
  const payload = `${STATE_VERSION}.${exp}.${b64urlJson(data)}`;
  return `${payload}.${sign(payload)}`;
}

// Returns { next } for a valid state token, otherwise null.
function verifyState(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, expRaw, body, sig] = parts;
  if (version !== STATE_VERSION) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return null;
  if (!safeEqual(sig, sign(`${version}.${expRaw}.${body}`))) return null;
  const data = parseB64urlJson(body);
  if (!data) return null;
  return { next: safeNext(data.x) };
}

// Only same-origin, non-protocol-relative paths are safe to bounce back to
// after login (`//evil.com` is a protocol-relative URL, not a local path).
function safeNext(next) {
  const value = typeof next === 'string' ? next.trim() : '';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

// --- Slack claims ---------------------------------------------------------

// Slack signs the id_token, and we receive it directly from Slack's token
// endpoint over TLS authenticated with our client secret — so decoding the
// payload (without re-verifying the JWT signature) is safe for the auth-code
// flow. We only need the identity claims out of it.
function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length < 2) return null;
  return parseB64urlJson(parts[1]);
}

function claimsToUser(claims) {
  if (!claims || typeof claims !== 'object') return null;
  return {
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
    emailVerified: claims.email_verified !== false, // absent → treat as verified
    name: (claims.name || claims.given_name || '').toString().trim(),
    teamId: (claims[SLACK_TEAM_CLAIM] || '').toString().trim(),
    teamName: (claims[SLACK_TEAM_NAME_CLAIM] || '').toString().trim(),
  };
}

// Decide whether a signed-in Slack user is allowed onto the dashboard. Returns
// { ok, user } or { ok: false, reason } with a message safe to show the user.
function validateUser(user) {
  if (!user || !user.email) {
    return { ok: false, reason: 'Slack did not return an email address for your account.' };
  }
  if (!user.emailVerified) {
    return { ok: false, reason: 'Your Slack email address is not verified.' };
  }
  const teams = allowedTeamIds();
  if (teams.size > 0) {
    const tid = String(user.teamId || '');
    const match = [...teams].some((t) => t === tid || t.toLowerCase() === tid.toLowerCase());
    if (!match) {
      return { ok: false, reason: 'This Slack workspace is not allowed to access the Deal Studio.' };
    }
  }
  const domains = allowedEmailDomains();
  if (domains.size > 0) {
    const domain = user.email.split('@')[1] || '';
    if (!domains.has(domain.toLowerCase())) {
      return { ok: false, reason: 'Your Slack email domain is not allowed to access the Deal Studio.' };
    }
  }
  return { ok: true, user: { email: user.email, name: user.name, teamId: user.teamId } };
}

function authorizeUrl({ clientId, redirectUri: redirect, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    scope: 'openid email profile',
    client_id: clientId,
    redirect_uri: redirect,
    state,
  });
  // If the workspace is pinned to a single team, hint it so Slack pre-selects
  // the right workspace on the consent screen.
  const teams = allowedTeamIds();
  if (teams.size === 1) params.set('team', [...teams][0]);
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

// Exchange an authorization code for tokens. Isolated so tests can stub it.
async function exchangeCode(code, redirect) {
  const body = new URLSearchParams({
    client_id: slackClientId(),
    client_secret: slackClientSecret(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });
  const resp = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  return resp.json();
}
// Swappable seam for tests (avoids a real network round-trip).
let tokenExchanger = exchangeCode;
function setTokenExchanger(fn) {
  tokenExchanger = typeof fn === 'function' ? fn : exchangeCode;
}

// --- request auth ---------------------------------------------------------

function tokenFromHeaders(req) {
  const direct = req.headers['x-api-token'] || req.headers['x-site-password'];
  if (typeof direct === 'string' && direct) return direct;
  const authz = req.headers.authorization;
  if (typeof authz === 'string' && /^basic /i.test(authz)) {
    const decoded = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    // Any username is accepted — this is a single shared token, so the username
    // half of Basic auth carries no meaning.
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  }
  return null;
}

// Resolve the signed-in user from the session token. Browsers carry it in the
// HttpOnly `io_session` cookie; the Chrome extension can't send that cookie on
// its extension-origin fetches, so it reads the cookie via the browser's cookies
// API and forwards the same token in the `x-io-session` header instead. Both are
// the identical signed token — a custom header is not auto-attached by the
// browser, so accepting it here adds no CSRF exposure the cookie didn't have.
function sessionUser(req) {
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const fromCookie = readSession(cookie);
  if (fromCookie) return fromCookie;
  const header = req.headers[SESSION_HEADER];
  if (typeof header === 'string' && header) return readSession(header);
  return null;
}

function isAuthed(req) {
  if (!enabled()) return true; // gate disabled
  if (sessionUser(req)) return true;
  const token = machineToken();
  if (token) {
    const supplied = tokenFromHeaders(req);
    if (supplied != null && safeEqual(supplied, token)) return true;
  }
  return false;
}

// A browser navigation gets bounced to the login page; anything else (fetch,
// curl, webhook) gets a plain 401 so it fails loudly instead of receiving HTML.
function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return String(req.headers.accept || '').includes('text/html');
}

function setSessionCookie(req, res, user) {
  res.cookie(COOKIE_NAME, createSession(user), {
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
  const authHref = `/auth/slack?next=${encodeURIComponent(safeNext(next))}`;
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
      box-shadow: 0 1px 2px rgba(20, 18, 15, 0.03); text-align: center;
    }
    .logo { width: 132px; height: auto; display: block; margin: 0 auto; fill: var(--ink); }
    h1 { font-size: 15px; font-weight: 600; margin: 18px 0 4px; letter-spacing: -0.01em; }
    p.sub { font-size: 13px; color: var(--muted); margin: 0 0 22px; }
    .slack-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; font: inherit; font-size: 14px; font-weight: 600;
      color: var(--ink); background: var(--surface);
      border: 1px solid var(--line-2); border-radius: 10px;
      padding: 12px; cursor: pointer; text-decoration: none;
    }
    .slack-btn:hover { border-color: var(--ink); background: var(--surface-2); }
    .slack-btn svg { width: 20px; height: 20px; flex: none; }
    .error {
      font-size: 13px; color: var(--danger); background: rgba(255, 49, 64, 0.06);
      border: 1px solid rgba(255, 49, 64, 0.18); border-radius: 10px;
      padding: 9px 11px; margin: 0 0 16px; text-align: left;
    }
  </style>
</head>
<body>
  <main class="card">
    <svg class="logo" viewBox="0 0 793 70" role="img" aria-label="Influence">
      <path d="M20.01 68.6729H1.35348e-05V1.03334H20.01V68.6729ZM126.221 69.8941L55.1993 29.4044V68.6729H42.5169V-4.03086e-05L113.538 40.3018V1.03334H126.221V69.8941ZM209.764 44.2475H168.992V68.6729H148.794V1.03334H219.816V11.9308H169.086V33.35H209.764V44.2475ZM306.528 68.6729H236.54V1.03334H256.738V57.7754H306.528V68.6729ZM389.07 34.6652V1.03334H401.847V34.6652C401.847 40.8029 400.813 46.1577 398.747 50.7296C396.742 55.3015 393.861 58.934 390.104 61.6271C386.409 64.3201 382.15 66.3243 377.327 67.6395C372.505 68.9547 367.119 69.6123 361.169 69.6123C348.706 69.6123 338.81 66.7627 331.483 61.0634C324.218 55.3642 320.585 46.6274 320.585 34.8531V1.03334H341.065V34.6652C341.065 38.8614 341.754 42.4939 343.132 45.5627C344.51 48.6315 346.357 51.0114 348.675 52.7024C351.054 54.3934 353.591 55.646 356.284 56.4602C359.04 57.2117 361.983 57.5875 365.115 57.5875C368.246 57.5875 371.158 57.2117 373.851 56.4602C376.607 55.646 379.144 54.3934 381.461 52.7024C383.841 51.0114 385.688 48.6315 387.004 45.5627C388.381 42.4939 389.07 38.8614 389.07 34.6652ZM494.814 68.6729H423.041V1.03334H494.814V11.9308H443.238V28.7468H484.386V39.6442H443.238V57.7754H494.814V68.6729ZM596.325 69.8941L525.303 29.4044V68.6729H512.621V-4.03086e-05L583.643 40.3018V1.03334H596.325V69.8941ZM702.321 52.6085V63.7878C692.989 67.796 681.778 69.8002 668.689 69.8002C657.917 69.8002 648.428 68.4536 640.224 65.7606C632.082 63.0049 625.694 58.9653 621.059 53.6418C616.425 48.3184 614.108 42.0555 614.108 34.8531C614.108 24.0809 619.087 15.6259 629.045 9.48828C639.003 3.28799 652.217 0.187845 668.689 0.187845C681.966 0.187845 693.177 2.19198 702.321 6.20025V18.5069C693.302 13.4965 682.78 10.9914 670.756 10.9914C659.545 10.9914 650.84 13.246 644.639 17.7553C638.439 22.202 635.339 27.9013 635.339 34.8531C635.339 41.8676 638.439 47.6294 644.639 52.1387C650.902 56.648 659.796 58.9027 671.319 58.9027C682.029 58.9027 692.363 56.8046 702.321 52.6085ZM792.821 68.6729H721.048V1.03334H792.821V11.9308H741.246V28.7468H782.393V39.6442H741.246V57.7754H792.821V68.6729Z" />
    </svg>
    <h1>Deal Studio</h1>
    <p class="sub">This dashboard is private. Sign in with your team Slack account to continue.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <a class="slack-btn" href="${escapeHtml(authHref)}">
      <svg viewBox="0 0 122.8 122.8" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/>
        <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/>
        <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/>
        <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/>
      </svg>
      Sign in with Slack
    </a>
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

// GET /login — show the Slack sign-in page (or bounce through if already in).
function showLogin(req, res) {
  if (!enabled() || isAuthed(req)) return res.redirect(safeNext(req.query?.next));
  sendLoginPage(res, 200, { next: safeNext(req.query?.next) });
}

// GET /auth/slack — kick off the OAuth dance: mint a signed state carrying the
// post-login target and redirect to Slack's consent screen.
function beginSlackLogin(req, res) {
  const next = safeNext(req.query?.next);
  if (!enabled()) return res.redirect(next);
  if (isAuthed(req)) return res.redirect(next);
  const state = createState(next);
  const url = authorizeUrl({
    clientId: slackClientId(),
    redirectUri: redirectUri(req),
    state,
  });
  res.redirect(url);
}

// GET /auth/slack/callback — Slack redirects here with ?code&state (or ?error).
async function handleSlackCallback(req, res) {
  if (!enabled()) return res.redirect('/');
  const query = req.query || {};

  if (query.error) {
    return sendLoginPage(res, 401, { error: `Slack sign-in was cancelled (${query.error}).` });
  }

  const stateData = verifyState(query.state);
  if (!stateData) {
    return sendLoginPage(res, 400, { error: 'Sign-in session expired. Please try again.' });
  }
  const next = stateData.next;

  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) {
    return sendLoginPage(res, 400, { next, error: 'Slack did not return an authorization code.' });
  }

  let data;
  try {
    data = await tokenExchanger(code, redirectUri(req));
  } catch (err) {
    console.error('Slack token exchange failed:', err.message);
    return sendLoginPage(res, 502, { next, error: 'Could not reach Slack to complete sign-in. Please try again.' });
  }

  if (!data || data.ok === false || !data.id_token) {
    const reason = data && data.error ? ` (${data.error})` : '';
    return sendLoginPage(res, 401, { next, error: `Slack sign-in failed${reason}. Please try again.` });
  }

  const user = claimsToUser(decodeIdToken(data.id_token));
  const verdict = validateUser(user);
  if (!verdict.ok) {
    return sendLoginPage(res, 403, { next, error: verdict.reason });
  }

  setSessionCookie(req, res, verdict.user);
  res.redirect(next);
}

// GET|POST /logout
function handleLogout(req, res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/' });
  res.redirect('/login');
}

// GET /api/me — who's signed in (for the topbar). Behind the gate, so it only
// answers for an authenticated request; a machine-token caller has no identity.
function handleMe(req, res) {
  const user = sessionUser(req);
  res.set('Cache-Control', 'no-store').json({
    email: user?.email || null,
    name: user?.name || null,
  });
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
  if (!enabled()) {
    console.warn(
      'Slack sign-in: OFF — SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are not set, the dashboard is ' +
        'publicly reachable. Set them to require Sign in with Slack.',
    );
    return;
  }
  const bits = [];
  const teams = allowedTeamIds();
  const domains = allowedEmailDomains();
  if (teams.size) bits.push(`workspace ${[...teams].join(', ')}`);
  if (domains.size) bits.push(`domain ${[...domains].join(', ')}`);
  const scope = bits.length ? ` (restricted to ${bits.join(' + ')})` : ' (WARNING: no workspace/domain restriction — any Slack account can sign in)';
  console.log(`Slack sign-in: ON — dashboard + admin API require Sign in with Slack${scope}`);
  if (machineToken()) {
    console.log('Machine token: ON — non-browser clients may authenticate with DASHBOARD_API_TOKEN');
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_HEADER,
  SESSION_TTL_MS,
  gate,
  showLogin,
  beginSlackLogin,
  handleSlackCallback,
  handleLogout,
  handleMe,
  logSiteAuthConfig,
  // exported for tests / server wiring
  enabled,
  machineToken,
  allowedTeamIds,
  allowedEmailDomains,
  isPublicPath,
  isAuthed,
  sessionUser,
  createSession,
  readSession,
  createState,
  verifyState,
  authorizeUrl,
  redirectUri,
  decodeIdToken,
  claimsToUser,
  validateUser,
  setTokenExchanger,
  safeEqual,
  safeNext,
  parseCookies,
  loginPage,
};
