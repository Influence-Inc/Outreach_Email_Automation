'use strict';

// Off-Instagram email discovery.
//
// Runs ONLY as a fallback for creators whose email isn't anywhere on Instagram
// (status 'no_email'). Instagram itself is unreadable from the backend's
// datacenter IP — that's why the browser extension does the IG scrape — but a
// creator's OWN links (their website, Linktree/bio-hub, etc.) are ordinary
// public websites the backend can fetch fine. So the extension captures those
// links off the profile and hands them here; this module follows them and
// scrapes a contact email off the pages, then verifies it (syntax + MX) before
// returning it.
//
// Strategy (all best-effort, capped, timeout-guarded):
//   1. Seed candidate URLs from the creator's external_url + bio links (+ any
//      URL written into the biography).
//   2. Expand link-in-bio hubs (Linktree, Beacons, Taplink, …): fetch the hub
//      and add the real outbound destinations it points to.
//   3. Fetch each candidate site (and its /contact + /about) and collect every
//      email-shaped string, from mailto: links and page text alike.
//   4. Prefer an address whose domain matches the site's own domain (a real
//      brand mailbox like hi@theirbrand.com beats a generic gmail found in a
//      footer widget), drop obvious junk, verify, and return the first keeper.
//   5. If nothing is found AND a paid provider is configured (env), fall back
//      to it. Off by default — no key, no external call.
//
// A paid enrichment API can be slotted in behind findViaProvider() without
// touching the callers — same shape as emailVerify.js's note.

const { cleanEmail } = require('./igScraper');
const { verifyEmail } = require('./emailVerify');

// Global email matcher (the single-match regexes live in igScraper; here we
// want EVERY candidate on a page). The {2,24} TLD cap keeps a greedy match from
// running away; cleanEmail() + the junk filter below tidy the rest.
const EMAIL_GLOBAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

// Link-in-bio aggregators: a link to one of these is a hub, not a destination —
// we fetch it and follow the real links inside instead of scraping the hub page.
const LINK_HUB_HOSTS = new Set([
  'linktr.ee', 'taplink.cc', 'beacons.ai', 'beacons.page', 'bio.link', 'lnk.bio',
  'linkin.bio', 'campsite.bio', 'solo.to', 'komi.io', 'msha.ke', 'shorby.com',
  'flowcode.com', 'linkpop.com', 'about.me', 'carrd.co', 'hoo.be', 'snipfeed.co',
  'stan.store', 'many.link', 'linkfly.to', 'withkoji.com', 'tap.bio', 'url.bio',
]);

// Email domains / hosts that are never a creator's real inbox — analytics,
// asset CDNs, page builders, placeholders, and the social platforms themselves.
const JUNK_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'email.com',
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
  'squarespace.com', 'godaddy.com', 'cloudflare.com', 'shopify.com',
  'wordpress.com', 'w3.org', 'schema.org', 'sentry.wixpress.com',
  'instagram.com', 'facebook.com', 'fb.com', 'gmail.com.png', 'youtube.com',
]);
// Local-parts that mark a placeholder/example rather than a real contact.
const JUNK_LOCAL_PARTS = new Set([
  'you', 'your', 'name', 'email', 'yourname', 'youremail', 'user', 'username',
  'example', 'test', 'someone', 'firstname', 'lastname', 'no-reply', 'noreply',
]);
// Image/asset extensions the naive regex can pick up from srcset/URLs
// ("logo@2x.png" → local "logo", domain "2x.png"). Reject these outright.
const ASSET_EXTS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|css|js|woff2?|ttf)$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

// Turn a raw href/bio string into a fetchable absolute http(s) URL, or null.
function normalizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    // Bare domains like "birdsofparadyes.com" — assume https.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return null;
    s = 'https://' + s;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isLinkHub(url) {
  const h = hostOf(url);
  return h ? LINK_HUB_HOSTS.has(h) : false;
}

// A scraped string is a usable email only if it cleans up, isn't an asset file,
// isn't a placeholder local-part, and isn't a known non-inbox domain.
function isUsableEmail(email) {
  if (!email || ASSET_EXTS.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (JUNK_LOCAL_PARTS.has(local)) return false;
  if (JUNK_EMAIL_DOMAINS.has(domain)) return false;
  // Domain must have a dot and a plausible 2+ char alpha TLD.
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(domain)) return false;
  return true;
}

// Every distinct, cleaned, usable email on a page — from mailto: hrefs first
// (highest intent) then anywhere in the raw text.
function extractEmailsFromHtml(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const cleaned = cleanEmail(raw);
    if (cleaned && isUsableEmail(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  };
  // mailto: links (decode %40 etc.).
  const mailtoRe = /mailto:([^"'?\s>]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    let addr = m[1];
    try { addr = decodeURIComponent(addr); } catch {}
    push(addr);
  }
  // Bare addresses in text/attributes.
  const text = String(html).match(EMAIL_GLOBAL) || [];
  for (const t of text) push(t);
  return out;
}

// Outbound http(s) links on a page (used to expand a link-in-bio hub into the
// real destinations). Deduped, hub self-links and asset URLs dropped.
function extractLinksFromHtml(html, baseUrl) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html))) {
    let href = m[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      href = baseUrl ? new URL(href, baseUrl).toString() : href;
    } catch {
      continue;
    }
    const norm = normalizeUrl(href);
    if (!norm) continue;
    if (ASSET_EXTS.test(new URL(norm).pathname)) continue;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// Choose the best email from a page's candidates: prefer one whose domain
// matches the page's own domain (a real brand mailbox), else the first usable.
function pickBestEmail(emails, siteHost) {
  if (!emails || !emails.length) return null;
  if (siteHost) {
    const root = siteHost.split('.').slice(-2).join('.'); // theirbrand.com
    const onDomain = emails.find((e) => {
      const d = e.split('@')[1];
      return d === siteHost || d === root || d.endsWith('.' + root);
    });
    if (onDomain) return onDomain;
  }
  return emails[0];
}

// ---- Network (best-effort, timeout-guarded) -------------------------------

const FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0 Safari/537.36';

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': FETCH_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (ct && !/text\/html|application\/xhtml|text\/plain|xml/i.test(ct)) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Sibling contact/about pages that commonly hold the email even when the home
// page doesn't. Built from a page URL's origin.
function contactPagesFor(url) {
  try {
    const origin = new URL(url).origin;
    return ['/contact', '/contact-us', '/about', '/about-us'].map((p) => origin + p);
  } catch {
    return [];
  }
}

// ---- Orchestrator ---------------------------------------------------------

// enrichEmail(context, options)
//   context: { fullName, instagramUsername, externalUrl, bioLinks, biography }
//   options: { fetchImpl, timeoutMs, maxSites, verify } (verify default true)
// Returns { email, source } or null. `source` is 'web:<host>' or
// 'provider:<name>'. Never throws — discovery failures resolve to null.
async function enrichEmail(context = {}, options = {}) {
  const {
    fetchHtml: fetchImpl = fetchHtml,
    timeoutMs = 8000,
    maxSites = 8,
    verify = true,
  } = options;

  // 1) Seed candidate URLs.
  const seeds = [];
  const pushSeed = (u) => {
    const n = normalizeUrl(u);
    if (n) seeds.push(n);
  };
  pushSeed(context.externalUrl);
  for (const l of context.bioLinks || []) pushSeed(typeof l === 'string' ? l : l && l.url);
  if (context.biography) {
    const urlsInBio = String(context.biography).match(/https?:\/\/[^\s)]+/g) || [];
    for (const u of urlsInBio) pushSeed(u);
  }

  // 2) Expand link-in-bio hubs into their destinations; keep non-hub seeds.
  const sites = [];
  const seenHost = new Set();
  const addSite = (url) => {
    const host = hostOf(url);
    if (!host || seenHost.has(host) || LINK_HUB_HOSTS.has(host)) return;
    seenHost.add(host);
    sites.push(url);
  };
  for (const seed of dedupe(seeds)) {
    if (sites.length >= maxSites) break;
    if (isLinkHub(seed)) {
      const html = await fetchImpl(seed, timeoutMs);
      // A hub page can itself carry a contact email (some creators paste it there).
      for (const e of extractEmailsFromHtml(html)) {
        if (verify ? (await verifyEmail(e)).valid : true) return { email: e, source: `web:${hostOf(seed)}` };
      }
      for (const dest of extractLinksFromHtml(html, seed)) addSite(dest);
    } else {
      addSite(seed);
    }
  }

  // 3+4) Fetch each site (and its contact/about) and pick the best verified email.
  for (const site of sites.slice(0, maxSites)) {
    const host = hostOf(site);
    const pages = [site, ...contactPagesFor(site)];
    const found = [];
    for (const page of pages) {
      const html = await fetchImpl(page, timeoutMs);
      if (!html) continue;
      for (const e of extractEmailsFromHtml(html)) if (!found.includes(e)) found.push(e);
      // Home page already yielded an on-domain address? Stop early.
      if (pickBestEmail(found, host) && found.some((e) => e.split('@')[1].endsWith(host.split('.').slice(-2).join('.')))) break;
    }
    // Verify in preference order (on-domain first).
    const ordered = [];
    const best = pickBestEmail(found, host);
    if (best) ordered.push(best);
    for (const e of found) if (!ordered.includes(e)) ordered.push(e);
    for (const e of ordered) {
      if (!verify || (await verifyEmail(e)).valid) return { email: e, source: `web:${host}` };
    }
  }

  // 5) Paid provider fallback (env-gated; off unless configured).
  const viaProvider = await findViaProvider(context, { sites, timeoutMs });
  if (viaProvider && viaProvider.email) {
    if (!verify || (await verifyEmail(viaProvider.email)).valid) return viaProvider;
  }

  return null;
}

// ---- Paid provider slot ---------------------------------------------------
// Off by default. Set EMAIL_ENRICH_PROVIDER=hunter and HUNTER_API_KEY=... to
// enable the Hunter.io email-finder (name + a domain derived from the creator's
// own site). Other providers (influencers.club, Prospeo, …) can be added as
// extra branches with the same { email, source } return shape.
async function findViaProvider(context, { sites = [] } = {}) {
  const provider = (process.env.EMAIL_ENRICH_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;

  if (provider === 'hunter') {
    const key = process.env.HUNTER_API_KEY || process.env.EMAIL_ENRICH_API_KEY;
    if (!key) return null;
    // Hunter finds by name + domain. Use the creator's own site domain (their
    // brand mailbox is what we want); skip if we have neither name nor domain.
    const domain = sites.map(hostOf).find(Boolean);
    const name = (context.fullName || '').trim();
    if (!domain || !name) return null;
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ');
    const params = new URLSearchParams({ domain, first_name: firstName, api_key: key });
    if (lastName) params.set('last_name', lastName);
    try {
      const resp = await fetch(`https://api.hunter.io/v2/email-finder?${params.toString()}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const email = data && data.data && data.data.email;
      if (email && isUsableEmail(String(email).toLowerCase())) {
        return { email: String(email).toLowerCase(), source: 'provider:hunter' };
      }
    } catch {
      /* provider failure -> no enrichment, never throws */
    }
  }

  return null;
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = {
  enrichEmail,
  // exported for tests / reuse
  normalizeUrl,
  hostOf,
  isLinkHub,
  isUsableEmail,
  extractEmailsFromHtml,
  extractLinksFromHtml,
  pickBestEmail,
  contactPagesFor,
};
