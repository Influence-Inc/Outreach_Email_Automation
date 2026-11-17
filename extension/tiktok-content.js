// TikTok profile data extractor — the TikTok twin of instagram-content.js.
//
// The dashboard's scrape queue (background.js runScrapeQueue) opens a
// creator's TikTok profile (https://www.tiktok.com/@handle) in a foreground
// tab and sends { action: 'extractCreatorData' }. We reply with the same shape
// the Instagram scraper returns, so background.js PATCHes the creator row the
// same way:
//   { email, emailSource, firstName, fullName, username, reelViews,
//     latestReelDate, bioLinks, biography, category }
//
// Sources, best first:
//   1. The profile JSON TikTok server-renders into the page
//      (<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">, older pages:
//      SIGI_STATE) — nickname, bio ("signature"), bio link.
//   2. The rendered profile DOM (data-e2e hooks) as a fallback for the above.
//   3. The video grid: per-video play counts ([data-e2e="video-views"]),
//      scrolled to lazy-load ~12 recent non-pinned videos. A TikTok video id
//      carries its upload time in its top 32 bits, so the newest video's date
//      comes straight from its id — no extra fetch.
(function () {
  'use strict';
  const S = globalThis.OEAScrape;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'extractCreatorData') {
      extractTikTokProfile({ includeVideos: request.includeReels !== false })
        .then((data) => sendResponse(data))
        .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return false;
  });

  function handleFromPath() {
    const seg = window.location.pathname.split('/').filter(Boolean).find((p) => p.startsWith('@'));
    return seg ? decodeURIComponent(seg.slice(1)) : null;
  }

  function parseJsonScript(doc, id) {
    const el = doc.getElementById(id);
    if (!el || !el.textContent) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  // The profile's user object out of TikTok's server-rendered state.
  function userFromState(doc, handle) {
    const universal = parseJsonScript(doc, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const scope = universal && universal.__DEFAULT_SCOPE__;
    const detail = scope && scope['webapp.user-detail'];
    if (detail && detail.userInfo && detail.userInfo.user) {
      return { user: detail.userInfo.user, stats: detail.userInfo.stats || null };
    }
    const sigi = parseJsonScript(doc, 'SIGI_STATE');
    const users = sigi && sigi.UserModule && sigi.UserModule.users;
    if (users) {
      const key = Object.keys(users).find((k) => !handle || k.toLowerCase() === handle.toLowerCase());
      if (key) return { user: users[key], stats: (sigi.UserModule.stats || {})[key] || null };
    }
    return null;
  }

  // Same profile JSON, fetched fresh from the logged-in tab — used when the page
  // we landed on didn't carry it (TikTok sometimes hydrates client-side only).
  async function fetchUserState(handle) {
    if (!handle) return null;
    try {
      const resp = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return userFromState(doc, handle);
    } catch (e) {
      console.warn('[OEA] TikTok profile fetch failed:', e);
      return null;
    }
  }

  // Any email-looking field TikTok exposes on the user object (business
  // accounts), shallow scan only — like pickEmailFromUser on Instagram.
  function emailFromUser(user) {
    if (!user) return null;
    for (const [k, v] of Object.entries(user)) {
      if (/email/i.test(k) && typeof v === 'string') {
        const e = S.normEmail(v);
        if (e) return e;
      }
    }
    return null;
  }

  function linksFromUser(user) {
    const links = [];
    if (user && user.bioLink && user.bioLink.link) links.push(user.bioLink.link);
    return links;
  }

  function linksFromDom() {
    const links = [];
    for (const a of document.querySelectorAll('a[data-e2e="user-link"], [data-e2e="user-link"] a')) {
      const href = a.getAttribute('href');
      const target = href ? S.unwrapRedirect(href) : null;
      if (target) links.push(target);
      else if (a.textContent) links.push(a.textContent.trim());
    }
    return links;
  }

  // ---- Video grid ---------------------------------------------------------

  function isPinned(item) {
    const badge = item.querySelector('[data-e2e="video-card-badge"]');
    if (badge && /pinned/i.test(badge.textContent || '')) return true;
    for (const el of item.querySelectorAll('div, span')) {
      if (el.childElementCount === 0 && (el.textContent || '').trim().toLowerCase() === 'pinned') return true;
    }
    return false;
  }

  function videoIdOf(href) {
    const m = String(href || '').match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  // One pass over the rendered grid: record views keyed by video id, skipping
  // pinned videos (they sit first and don't reflect recent reach). The grid is
  // newest-first, so the first non-pinned id seen is the latest upload.
  function scrapeVisibleVideos(videos, ctx) {
    const items = document.querySelectorAll('[data-e2e="user-post-item"]');
    const scope = items.length ? items : document.querySelectorAll('a[href*="/video/"]');
    for (const node of scope) {
      const link = node.matches && node.matches('a[href*="/video/"]') ? node : node.querySelector('a[href*="/video/"]');
      if (!link) continue;
      const id = videoIdOf(link.getAttribute('href') || link.href);
      if (!id) continue;
      const item = node.closest('[data-e2e="user-post-item"]') || node.parentElement || node;
      if (isPinned(item)) continue;
      if (!ctx.latestId) ctx.latestId = id;
      if (videos.has(id)) continue;
      const viewsEl = item.querySelector('[data-e2e="video-views"]') || item.querySelector('strong');
      const views = viewsEl ? S.parseCount(viewsEl.textContent) : NaN;
      if (Number.isFinite(views) && views > 0) videos.set(id, views);
    }
  }

  async function collectVideoViews(maxVideos = 12, scroll = true) {
    const videos = new Map();
    const ctx = { latestId: null };
    // The grid hydrates a beat after the header — wait for it briefly. TikTok
    // sometimes shows "Something went wrong" + a Refresh button in place of
    // the grid; click it once and wait again.
    const hasGrid = () => document.querySelector('[data-e2e="user-post-item"], a[href*="/video/"]');
    for (let attempt = 0; attempt < 2 && !hasGrid(); attempt++) {
      for (let i = 0; i < 10 && !hasGrid(); i++) await S.sleep(500);
      if (hasGrid() || attempt > 0) break;
      const refresh = [...document.querySelectorAll('main button, [data-e2e="user-post-item-list"] button, button')]
        .find((b) => /^\s*refresh\s*$/i.test(b.textContent || ''));
      if (!refresh) break;
      refresh.click();
    }
    scrapeVisibleVideos(videos, ctx);
    if (scroll) {
      let stagnant = 0;
      for (let i = 0; i < 12 && videos.size < maxVideos; i++) {
        const before = videos.size;
        window.scrollBy(0, Math.round(window.innerHeight * 0.9));
        await S.sleep(800);
        scrapeVisibleVideos(videos, ctx);
        if (videos.size > before) stagnant = 0;
        else if (++stagnant >= 3) break;
      }
      window.scrollTo(0, 0);
    }
    return { views: [...videos.values()].slice(0, maxVideos), latestId: ctx.latestId };
  }

  // TikTok video ids are snowflakes: the top 32 bits are the upload time in
  // Unix seconds.
  function dateFromVideoId(id) {
    try {
      const secs = Number(BigInt(id) >> 32n);
      if (!Number.isFinite(secs) || secs < 1.4e9) return null; // before TikTok existed — not a snowflake
      return new Date(secs * 1000).toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }

  // ---- Main -----------------------------------------------------------------

  async function extractTikTokProfile({ includeVideos = true } = {}) {
    const result = {
      platform: 'tiktok',
      email: null,
      emailSource: null,
      firstName: null,
      fullName: null,
      username: handleFromPath(),
      reelViews: [],
      latestReelDate: null,
      bioLinks: [],
      biography: null,
      category: null,
    };

    try {
      let state = userFromState(document, result.username);
      if (!state) state = await fetchUserState(result.username);
      const user = state && state.user;

      if (user && user.uniqueId) result.username = user.uniqueId;
      const domName = (document.querySelector('[data-e2e="user-subtitle"]') || {}).textContent;
      S.applyName(result, (user && user.nickname) || domName, result.username);

      const domBio = (document.querySelector('[data-e2e="user-bio"]') || {}).textContent || '';
      result.biography = ((user && user.signature) || domBio || '').trim() || null;

      const apiEmail = emailFromUser(user);
      if (apiEmail) {
        result.email = apiEmail;
        result.emailSource = 'tiktok_contact';
      }
      if (!result.email) {
        const fromBio = S.findEmail([result.biography, domBio].filter(Boolean).join(' '));
        if (fromBio) {
          result.email = fromBio;
          result.emailSource = 'tiktok_bio';
        }
      }
      if (!result.email) {
        const mailto = document.querySelector('a[href^="mailto:"]');
        if (mailto) {
          result.email = S.normEmail(mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]);
          if (result.email) result.emailSource = 'tiktok_bio';
        }
      }

      result.bioLinks = S.cleanLinks([...linksFromUser(user), ...linksFromDom()], /(^|\.)tiktok\.com$/);

      try {
        const grid = await collectVideoViews(12, includeVideos);
        result.reelViews = grid.views;
        if (grid.latestId) result.latestReelDate = dateFromVideoId(grid.latestId);
      } catch (e) {
        console.warn('[OEA] TikTok video view extraction failed:', e);
      }

      console.log('[OEA] TikTok profile data extracted:', result);
    } catch (error) {
      console.error('[OEA] Error extracting TikTok data:', error);
    }
    return result;
  }

  console.log('[OEA] TikTok content script loaded');
})();
