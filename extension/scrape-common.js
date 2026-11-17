// Shared helpers for the TikTok + YouTube profile scrapers (tiktok-content.js,
// youtube-content.js). Loaded first in the same content-script world, so the
// platform scripts read these off `globalThis.OEAScrape`.
//
// The email + name helpers mirror instagram-content.js (and the backend's
// igScraper.js / nameFormat.js) so a scraped TikTok / YouTube profile lands in
// the dashboard exactly as clean as an Instagram one.
(function () {
  'use strict';
  if (globalThis.OEAScrape) return;

  const COMMON_TLDS = new Set([
    'com','net','org','edu','gov','mil','int','arpa',
    'info','biz','name','pro','mobi','asia','xxx','tel','jobs','aero','coop','museum',
    'io','co','ai','app','dev','me','tv','cc','ly','to','sh','fm','ws','xyz','one','team',
    'tech','online','store','site','space','world','cloud','website','press',
    'live','life','love','news','club','today','company','agency','studio',
    'group','design','digital','global','media','network','systems','solutions',
    'services','consulting','business','community','education','center','school',
    'academy','email','social','art','blog','shop','fashion','finance','health',
    'marketing','events','photos','travel','tours','hotel','restaurant','cafe',
    'inc','llc','ltd','foundation','industries','engineering','engineer',
    'photography','games','movies','music','beauty','vip','rocks','cool','plus',
    'works','work','careers','market','bar','coffee','wine','pizza',
    'us','uk','ca','au','nz','de','fr','it','es','nl','be','ch','at','se','no',
    'fi','dk','pl','cz','pt','ie','gr','tr','ru','ua','ro','hu','bg','hr','rs',
    'si','sk','ee','lt','lv','is','lu','mt','cy','mk','md','al','ba',
    'in','jp','cn','kr','hk','tw','sg','my','th','id','vn','ph','pk','bd','lk','np',
    'br','mx','ar','cl','pe','ve','uy','py','bo','ec','cr','pa','do','gt','sv','hn',
    'ni','jm','tt','bs','bb','ht','cu','pr',
    'za','eg','ng','ke','gh','tn','ma','et','zm','zw','sn','ci','ug','rw','tz','mz',
    'ae','sa','il','ir','iq','jo','kw','lb','om','qa','sy','ye','bh',
  ]);

  // "jj@33andwest.comticket" -> "jj@33andwest.com" (words glued onto the TLD
  // when a bio's line break collapses). Same rule as instagram-content.js.
  function trimAppendedTld(email) {
    if (!email) return email;
    const at = email.indexOf('@');
    if (at < 1) return email;
    const domain = email.slice(at + 1);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot < 1) return email;
    const tail = domain.slice(lastDot + 1);
    if (!/^[a-z]+$/.test(tail)) return email;
    if (COMMON_TLDS.has(tail) || tail.length <= 6) return email;
    for (let len = Math.min(tail.length - 1, 10); len >= 2; len--) {
      const cand = tail.slice(0, len);
      if (COMMON_TLDS.has(cand)) {
        return email.slice(0, at + 1) + domain.slice(0, lastDot + 1) + cand;
      }
    }
    return email;
  }

  const EMAIL_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    /\b[A-Za-z0-9._%+-]+@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,24}\b/g,
    /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*(?:\.|\[\s*dot\s*\])\s*[A-Za-z]{2,24}\b/gi,
    /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*(?:\.|\(\s*dot\s*\))\s*[A-Za-z]{2,24}\b/gi,
  ];

  // First email-shaped string in free text (a bio / channel description),
  // cleaned and lowercased, or null.
  function findEmail(text) {
    if (!text) return null;
    for (const pattern of EMAIL_PATTERNS) {
      pattern.lastIndex = 0;
      const m = String(text).match(pattern);
      if (m && m.length) {
        const cleaned = m[0]
          .replace(/\s+/g, '')
          .replace(/\[at\]|\(at\)/gi, '@')
          .replace(/\[dot\]|\(dot\)/gi, '.')
          .toLowerCase();
        return trimAppendedTld(cleaned);
      }
    }
    return null;
  }

  function normEmail(v) {
    if (!v || typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
  }

  // Display name -> greeting-ready first-name form. Mirrors formatFirstName in
  // instagram-content.js / backend services/nameFormat.js.
  const SMALL_CAPS = {
    'ᴀ':'A','ʙ':'B','ᴄ':'C','ᴅ':'D','ᴇ':'E','ꜰ':'F','ɢ':'G','ʜ':'H','ɪ':'I',
    'ᴊ':'J','ᴋ':'K','ʟ':'L','ᴍ':'M','ɴ':'N','ᴏ':'O','ᴘ':'P','ꞯ':'Q','ʀ':'R',
    'ꜱ':'S','ᴛ':'T','ᴜ':'U','ᴠ':'V','ᴡ':'W','ʏ':'Y','ᴢ':'Z',
  };
  function titleCasePart(part) {
    const chars = [...part];
    if (chars.length === 0) return part;
    const mixed = /\p{Lu}/u.test(part) && /\p{Ll}/u.test(part);
    const rest = mixed ? chars.slice(1).join('') : chars.slice(1).join('').toLocaleLowerCase();
    return chars[0].toLocaleUpperCase() + rest;
  }
  function titleCaseWord(w) {
    return w.split(/([-'])/).map((seg) => (seg === '-' || seg === "'" ? seg : titleCasePart(seg))).join('');
  }
  function formatName(raw) {
    if (raw == null) return '';
    let s = String(raw).replace(/[︀-️​-‍⁠﻿]/g, '');
    let mapped = '';
    for (const ch of s) mapped += SMALL_CAPS[ch] || ch;
    s = mapped.normalize('NFKC').replace(/[^\p{L}\p{M}\s'-]/gu, ' ');
    return s
      .split(/\s+/)
      .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
      .filter((w) => /\p{L}/u.test(w))
      .map(titleCaseWord)
      .join(' ');
  }

  // Fill fullName / firstName on `result` from a raw display name, falling
  // back to the handle (as instagram-content.js does).
  function applyName(result, rawName, handle) {
    const raw = rawName && String(rawName).trim();
    if (raw) result.fullName = raw;
    const cleaned = formatName(raw || '');
    if (cleaned) result.firstName = cleaned.split(' ')[0];
    else if (handle) result.firstName = handle.charAt(0).toUpperCase() + handle.slice(1);
  }

  // "1.2K" -> 1200, "3.4M" -> 3400000, "1B" -> 1e9, "12,345" -> 12345,
  // "1.2M views" / "1.2 million views" -> 1200000. NaN when there's no number.
  function parseCount(str) {
    if (str == null) return NaN;
    const s = String(str).trim().toUpperCase().replace(/,/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(THOUSAND|MILLION|BILLION|K|M|B)?/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    const u = (m[2] || '')[0];
    const mult = u === 'K' || u === 'T' ? 1e3 : u === 'M' ? 1e6 : u === 'B' ? 1e9 : 1;
    return Math.round(n * mult);
  }

  // "3 days ago" / "2 weeks ago" / "Streamed 1 month ago" / compact "12d ago",
  // "3w ago", "5mo ago", "1y ago" -> "YYYY-MM-DD" (approximate, relative to
  // now). null when it isn't a relative time.
  const AGE_UNITS = [
    [/^(mo|mos|month|months)$/, 30 * 864e5],
    [/^(y|yr|yrs|year|years)$/, 365 * 864e5],
    [/^(w|wk|wks|week|weeks)$/, 7 * 864e5],
    [/^(d|day|days)$/, 864e5],
    [/^(h|hr|hrs|hour|hours)$/, 36e5],
    [/^(m|min|mins|minute|minutes)$/, 6e4],
    [/^(s|sec|secs|second|seconds)$/, 1e3],
  ];
  function relativeAgeToDate(text) {
    const m = String(text || '').toLowerCase().match(/(\d+)\s*([a-z]+)\s+ago\b/);
    if (!m) return null;
    const unit = AGE_UNITS.find(([re]) => re.test(m[2]));
    if (!unit) return null;
    const d = new Date(Date.now() - Number(m[1]) * unit[1]);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  // Unwrap a platform redirect link (youtube.com/redirect?q=…,
  // tiktok.com/link/v2?target=…) to the creator's real destination URL.
  function unwrapRedirect(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.href);
      for (const key of ['q', 'target', 'url', 'u']) {
        const v = u.searchParams.get(key);
        if (v && /^https?:\/\//i.test(v)) return v;
      }
      return u.href;
    } catch {
      return null;
    }
  }

  // Off-platform links only (the creator's site / Linktree), deduped.
  function cleanLinks(links, ownHostRe) {
    const out = [];
    for (const l of links || []) {
      if (!l) continue;
      let url = String(l).trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (ownHostRe && ownHostRe.test(host)) continue;
      } catch {
        continue;
      }
      out.push(url);
    }
    return [...new Set(out)].slice(0, 25);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  globalThis.OEAScrape = {
    trimAppendedTld,
    findEmail,
    normEmail,
    formatName,
    applyName,
    parseCount,
    relativeAgeToDate,
    unwrapRedirect,
    cleanLinks,
    sleep,
  };
})();
