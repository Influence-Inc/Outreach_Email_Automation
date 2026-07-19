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

// Operational / support / no-reply mailboxes. A creator (or their manager) never
// hands these out as an outreach contact — they're a company's customer-support
// desk or an automated system address. When enrichment follows a creator's bio
// links onto a sponsored third-party brand, THIS is what it scrapes (e.g.
// support@higgsfield.ai, support@mail.pippit.ai), so we drop them. Note the list
// deliberately EXCLUDES hello/hi/contact/info/team/bookings/press/pr/management/
// mgmt/collab/partnerships — those ARE legitimate creator-brand / manager
// inboxes and must survive.
const ROLE_LOCAL_PARTS = new Set([
  'support', 'help', 'helpdesk', 'care', 'customercare', 'customerservice',
  'custserv', 'service', 'services', 'billing', 'accounts', 'accounting',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'feedback', 'abuse',
  'postmaster', 'webmaster', 'hostmaster', 'mailerdaemon', 'mailer-daemon',
  'mailer', 'bounce', 'bounces', 'notifications', 'notification', 'notify',
  'alerts', 'alert', 'security', 'privacy', 'legal', 'compliance', 'dpo',
  'gdpr', 'unsubscribe', 'newsletter', 'newsletters', 'subscribe', 'updates',
  'root', 'sysadmin',
]);

// Free webmail providers. An address on one of these is never "on-domain" for a
// creator's own site, so when enrichment finds one on a FOLLOWED site that isn't
// tied to the creator's name, it's almost always the site owner's (a third-party
// brand's) address rather than the creator's — e.g. pxvbusiness@gmail.com sitting
// in a promoted brand's page footer.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'ymail.com', 'rocketmail.com', 'outlook.com', 'outlook.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com',
  'gmx.net', 'zoho.com', 'zohomail.com', 'mail.com', 'yandex.com', 'yandex.ru',
  'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.com', 'hushmail.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'hotmail.fr', 'orange.fr',
]);

// Path segments that mark a link as an affiliate / referral link even without a
// query string (e.g. brand.com/affiliate/xyz). Query strings are handled
// separately — see isSponsoredLink.
const SPONSORED_PATH = /\/(?:aff|affiliate|referral)(?:\/|$)/i;

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

// Identity tokens for the creator (name words + collapsed handle), used to tell
// an email that's plausibly theirs from a third-party brand's. Words shorter
// than 3 chars are dropped as too generic to match on.
function creatorTokens(context = {}) {
  const words = new Set();
  const add = (s) => {
    if (!s) return;
    for (const w of String(s).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3) words.add(w);
    }
  };
  add(context.fullName);
  add(context.instagramUsername);
  const handle = String(context.instagramUsername || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return { words: [...words], handle };
}

// True when the creator's own name/handle shows up in an email's local part or
// domain — e.g. yushika@birdsofparadyes.com for @yushikajolly. This is what lets
// a creator's OWN site under a DIFFERENT brand name be trusted, while a
// third-party brand's address (support@higgsfield.ai) is not. Matching is by
// exact token or shared prefix (min 4 chars) so "arch" doesn't spuriously match
// "research".
function relatesToCreator(local, domain, tokens) {
  if (!tokens) return false;
  const localNorm = local.replace(/[^a-z0-9]/g, '');
  const domainRoot = (domain.split('.').slice(-2, -1)[0] || '').replace(/[^a-z0-9]/g, '');
  const hay = [localNorm, domainRoot].filter(Boolean);
  const overlaps = (a, b) => {
    if (!a || !b) return false;
    if (a === b && a.length >= 3) return true;
    if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    return false;
  };
  for (const w of tokens.words) if (hay.some((h) => overlaps(h, w))) return true;
  if (tokens.handle && hay.some((h) => overlaps(h, tokens.handle))) return true;
  return false;
}

// The gate for an enrichment-scraped email. Enrichment follows a creator's
// OFF-Instagram links, some of which are sponsored third-party brands, so a
// followed page's email is kept only when it's plausibly the creator's (or their
// manager's) real contact — not the promoted brand's support desk. Order:
//   1. drop operational/support/no-reply mailboxes outright;
//   2. keep anything carrying the creator's own name/handle (own-brand site);
//   3. drop an unrelated free-mail address found off a followed site;
//   4. otherwise keep it (a business-domain inbox — the site's own, a booking or
//      management domain, etc.).
// Applied ONLY to enrichment-scraped emails. Addresses the creator wrote into
// their Instagram bio (incl. a manager's) are trusted as-is on the IG path and
// never reach here.
function isCreatorContactEmail(email, { tokens = null } = {}) {
  if (!isUsableEmail(email)) return false;
  const at = email.indexOf('@');
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const localKey = local.replace(/\+.*$/, '').replace(/\d+$/, '');
  if (ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(localKey)) return false;
  if (relatesToCreator(local, domain, tokens)) return true;
  if (FREE_MAIL_DOMAINS.has(domain)) return false;
  return true;
}

// True when a link's own domain carries the creator's name/handle — i.e. it's
// their site (yushika-studio.com for @yushikajolly), so a tracking tail on it is
// their own UTM, not a sponsored brand's referral.
function hostRelatesToCreator(host, tokens) {
  return relatesToCreator('', String(host || '').replace(/^www\./i, ''), tokens);
}

// A bio link that points at a sponsored third-party product the creator is
// promoting (not their own site) — skip it so enrichment never scrapes the
// brand's contact email off it. The main tell is a query string: creators' OWN
// links are almost always clean bare domains (birdsofparadyes.com), whereas
// promoted brand links carry a tracking / referral / promo tail after "?"
// (?via=, ?ref=, ?utm_source=, discount codes, …). So any query string, plus an
// affiliate/referral path segment, marks the link as sponsored — UNLESS the
// link's own domain carries the creator's name/handle, in which case it's their
// site and the tail is their own tracking, so we still follow it.
function isSponsoredLink(url, tokens = null) {
  try {
    const u = new URL(url);
    if (tokens && hostRelatesToCreator(u.hostname, tokens)) return false;
    if (u.search) return true; // any "?…" tracking/referral/promo tail
    if (SPONSORED_PATH.test(u.pathname)) return true;
  } catch {
    /* unparseable -> not classified as sponsored */
  }
  return false;
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

  // Who the creator is — used to keep only emails plausibly theirs (own-brand
  // site under a different name) and drop third-party brand / support addresses.
  const tokens = creatorTokens(context);

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
    // A sponsored / affiliate / promo link points at a brand the creator is
    // promoting, not their own site — never enrich from it (unless the domain is
    // the creator's own, in which case a tracking tail doesn't disqualify it).
    if (isSponsoredLink(seed, tokens)) continue;
    if (isLinkHub(seed)) {
      const html = await fetchImpl(seed, timeoutMs);
      // A hub page can itself carry a contact email (some creators paste it there).
      for (const e of extractEmailsFromHtml(html)) {
        if (!isCreatorContactEmail(e, { tokens })) continue;
        if (verify ? (await verifyEmail(e)).valid : true) return { email: e, source: seed };
      }
      for (const dest of extractLinksFromHtml(html, seed)) {
        if (!isSponsoredLink(dest, tokens)) addSite(dest);
      }
    } else {
      addSite(seed);
    }
  }

  // 3+4) Fetch each site (and its contact/about) and pick the best verified
  // email. `source` is the EXACT page URL the address was scraped from so the
  // dashboard can show (and link to) where an off-Instagram email came from.
  for (const site of sites.slice(0, maxSites)) {
    const host = hostOf(site);
    const root = host.split('.').slice(-2).join('.');
    const pages = [site, ...contactPagesFor(site)];
    const found = []; // [{ email, url }]
    for (const page of pages) {
      const html = await fetchImpl(page, timeoutMs);
      if (!html) continue;
      for (const e of extractEmailsFromHtml(html)) {
        if (!isCreatorContactEmail(e, { tokens })) continue;
        if (!found.some((f) => f.email === e)) found.push({ email: e, url: page });
      }
      // Home page already yielded an on-domain address? Stop early.
      const emails = found.map((f) => f.email);
      if (pickBestEmail(emails, host) && emails.some((e) => e.split('@')[1].endsWith(root))) break;
    }
    if (!found.length) continue;
    // Verify in preference order (on-domain first).
    const emails = found.map((f) => f.email);
    const ordered = [];
    const best = pickBestEmail(emails, host);
    if (best) ordered.push(best);
    for (const e of emails) if (!ordered.includes(e)) ordered.push(e);
    for (const e of ordered) {
      if (!verify || (await verifyEmail(e)).valid) {
        const hit = found.find((f) => f.email === e);
        return { email: e, source: (hit && hit.url) || site };
      }
    }
  }

  // 5) Paid provider fallback (env-gated; off unless configured).
  const viaProvider = await findViaProvider(context, { sites, timeoutMs });
  if (viaProvider && viaProvider.email) {
    if (!verify || (await verifyEmail(viaProvider.email)).valid) return viaProvider;
  }

  return null;
}

// Pull the best usable email out of an Apollo /people/match `person` object.
// Prefers the professional email, then any revealed personal email, then any
// contact_emails entry. Apollo returns locked addresses as the placeholder
// "email_not_unlocked@domain.com" (no credits/permission) — those are skipped.
function pickApolloEmail(person) {
  if (!person) return null;
  const candidates = [];
  if (person.email) candidates.push(person.email);
  if (Array.isArray(person.personal_emails)) candidates.push(...person.personal_emails);
  if (Array.isArray(person.contact_emails)) {
    for (const c of person.contact_emails) if (c && c.email) candidates.push(c.email);
  }
  for (const raw of candidates) {
    const e = String(raw || '').toLowerCase().trim();
    if (/email_not_unlocked/i.test(e)) continue;
    if (isUsableEmail(e)) return e;
  }
  return null;
}

// True when an Apollo-returned person's name shares a name word with the
// creator's (name words + collapsed handle). Used to guard a name-only match
// (no domain to disambiguate) so Apollo can't hand back a loosely-related
// person — the returned name must actually line up with who we asked for.
function apolloPersonMatchesCreator(person, context) {
  if (!person) return false;
  const { words } = creatorTokens(context);
  if (!words.length) return false;
  const personName = [person.name, person.first_name, person.last_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const pWords = new Set(personName.split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  return words.some((w) => pWords.has(w));
}

// ---- Paid provider slot ---------------------------------------------------
// Off by default. Pick one with EMAIL_ENRICH_PROVIDER and set its key:
//   • apollo  — POST api.apollo.io/api/v1/people/match (X-Api-Key: APOLLO_API_KEY).
//               Apollo is a people-finder, so it matches on NAME; the creator's
//               own site domain is passed when we have one to sharpen the match,
//               but it isn't required (most creators have no site). A domain-less
//               match is only trusted when Apollo's returned name matches the
//               creator's (apolloPersonMatchesCreator).
//   • hunter  — api.hunter.io email-finder (HUNTER_API_KEY). Hunter looks up a
//               mailbox on a specific domain, so a domain IS required here.
// Other providers (influencers.club, Prospeo, …) can be added as extra branches
// with the same { email, source } return shape.
async function findViaProvider(context, { sites = [] } = {}) {
  const provider = (process.env.EMAIL_ENRICH_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;

  const name = (context.fullName || '').trim();
  if (!name) return null; // a name is the minimum identifier for any provider
  // The creator's own site domain, when we have one, sharpens the match.
  const domain = sites.map(hostOf).find(Boolean) || null;
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ');

  if (provider === 'apollo') {
    const key = process.env.APOLLO_API_KEY || process.env.EMAIL_ENRICH_API_KEY;
    if (!key) return null;
    // reveal_personal_emails surfaces the gmail-style addresses most creators use
    // (Apollo omits them by default). Consumes an Apollo credit per match.
    const payload = { name, first_name: firstName, reveal_personal_emails: true };
    if (lastName) payload.last_name = lastName;
    if (domain) payload.domain = domain;
    try {
      const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': key,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const person = data && data.person;
      if (!person) return null;
      // Without a domain to disambiguate, only trust the match if the returned
      // person's name matches the creator's — a same-name-different-person guard.
      if (!domain && !apolloPersonMatchesCreator(person, context)) return null;
      const email = pickApolloEmail(person);
      if (email) return { email, source: 'provider:apollo' };
    } catch {
      /* provider failure -> no enrichment, never throws */
    }
    return null;
  }

  if (provider === 'hunter') {
    const key = process.env.HUNTER_API_KEY || process.env.EMAIL_ENRICH_API_KEY;
    if (!key) return null;
    if (!domain) return null; // Hunter's email-finder needs a domain to search
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
    return null;
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
  creatorTokens,
  relatesToCreator,
  isCreatorContactEmail,
  isSponsoredLink,
  pickApolloEmail,
  apolloPersonMatchesCreator,
};
