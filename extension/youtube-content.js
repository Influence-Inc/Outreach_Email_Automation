// YouTube channel data extractor — the YouTube twin of instagram-content.js.
//
// The dashboard's scrape queue (background.js runScrapeQueue) opens a
// creator's channel on its Shorts tab (https://www.youtube.com/@handle/shorts)
// in a foreground tab and sends { action: 'extractCreatorData' }. We reply
// with the same shape the Instagram scraper returns, so background.js PATCHes
// the creator row the same way:
//   { email, emailSource, firstName, fullName, username, reelViews,
//     latestReelDate, bioLinks, biography, category }
//
// Sources:
//   • ytInitialData — the JSON YouTube server-renders into the channel page.
//     Its channelMetadataRenderer carries the channel name + full description
//     (the "bio"); the selected tab's grid carries each item's view count.
//   • Shorts are the Reels equivalent, so they're the views baseline. A
//     channel with no Shorts falls back to its Videos tab (fetched from this
//     logged-in tab, same-origin).
//   • The newest item's upload date: from its "N days ago" label on the
//     Videos tab, or by fetching the newest Short's watch page for its
//     publishDate (like the Instagram scraper does for the newest reel).
//   • YouTube hides the channel's business email behind a captcha, so the
//     email comes from the description (and its links feed the dashboard's
//     off-platform enrichment, exactly as Instagram bio links do).
(function () {
  'use strict';
  const S = globalThis.OEAScrape;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'extractCreatorData') {
      extractYouTubeChannel()
        .then((data) => sendResponse(data))
        .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return false;
  });

  // The channel's base path: /@handle, /channel/UC…, /c/name or /user/name.
  function channelBasePath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    if (parts[0].startsWith('@')) return `/${parts[0]}`;
    if (['channel', 'c', 'user'].includes(parts[0].toLowerCase()) && parts[1]) return `/${parts[0]}/${parts[1]}`;
    return `/${parts[0]}`;
  }

  function handleFromPath() {
    const base = channelBasePath();
    if (!base) return null;
    const last = base.split('/').filter(Boolean).pop();
    return decodeURIComponent(last.replace(/^@/, ''));
  }

  // ytInitialData out of an HTML document's inline scripts. The script reads
  // `var ytInitialData = {...};` (or window["ytInitialData"] = …); the JSON
  // runs from the first "{" to the last "}".
  function ytInitialDataFrom(doc) {
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';
      const at = text.indexOf('ytInitialData');
      if (at < 0 || at > 200) continue;
      const start = text.indexOf('{', at);
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* not the one — keep looking */
      }
    }
    return null;
  }

  async function fetchHtml(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  }

  async function fetchInitialData(path) {
    try {
      const html = await fetchHtml(`https://www.youtube.com${path}${path.includes('?') ? '&' : '?'}hl=en`);
      return ytInitialDataFrom(new DOMParser().parseFromString(html, 'text/html'));
    } catch (e) {
      console.warn(`[OEA] YouTube fetch ${path} failed:`, e);
      return null;
    }
  }

  // Every string inside a (renderer) object, depth-limited.
  function stringsIn(obj, out = [], depth = 0, maxDepth = 12) {
    if (obj == null || depth > maxDepth) return out;
    if (typeof obj === 'string') {
      out.push(obj);
    } else if (Array.isArray(obj)) {
      for (const v of obj) stringsIn(v, out, depth + 1, maxDepth);
    } else if (typeof obj === 'object') {
      for (const v of Object.values(obj)) stringsIn(v, out, depth + 1, maxDepth);
    }
    return out;
  }

  // The content of the channel tab that's selected (Shorts / Videos), so the
  // walk below only reads that grid — not the header or a sidebar.
  function selectedTabContent(data) {
    const tabs =
      data && data.contents && data.contents.twoColumnBrowseResultsRenderer &&
      data.contents.twoColumnBrowseResultsRenderer.tabs;
    if (!Array.isArray(tabs)) return null;
    for (const t of tabs) {
      const r = t && (t.tabRenderer || t.expandableTabRenderer);
      if (r && r.selected) return r.content || null;
    }
    return null;
  }

  function selectedTabTitle(data) {
    const tabs =
      data && data.contents && data.contents.twoColumnBrowseResultsRenderer &&
      data.contents.twoColumnBrowseResultsRenderer.tabs;
    if (!Array.isArray(tabs)) return null;
    for (const t of tabs) {
      const r = t && t.tabRenderer;
      if (r && r.selected) return String(r.title || '').toLowerCase();
    }
    return null;
  }

  const ITEM_KEYS = ['shortsLockupViewModel', 'reelItemRenderer', 'videoRenderer', 'gridVideoRenderer', 'lockupViewModel'];
  const VIEWS_RE = /^\s*([\d.,]+\s*[KMB]?|No)\s+views?\s*$/i;

  function videoIdOf(key, item) {
    if (item.videoId) return item.videoId;
    if (item.contentId) return item.contentId;
    if (typeof item.entityId === 'string') {
      const m = item.entityId.match(/([A-Za-z0-9_-]{11})$/);
      if (m) return m[1];
    }
    const reel = item.onTap && item.onTap.innertubeCommand && item.onTap.innertubeCommand.reelWatchEndpoint;
    if (reel && reel.videoId) return reel.videoId;
    return null;
  }

  // Grid items in page order (newest first): { id, views, ageDate }.
  function gridItems(data) {
    const content = selectedTabContent(data);
    if (!content) return [];
    const items = [];
    const seen = new Set();
    (function walk(node, depth) {
      if (node == null || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      for (const key of ITEM_KEYS) {
        if (node[key] && typeof node[key] === 'object') {
          const item = node[key];
          const id = videoIdOf(key, item);
          if (id && !seen.has(id)) {
            seen.add(id);
            const strs = stringsIn(item);
            const viewStr = strs.find((s) => VIEWS_RE.test(s)) ||
              strs.find((s) => /^\s*[\d.,]+\s*(thousand|million|billion)?\s+views?\s*$/i.test(s)) ||
              strs.find((s) => /\bviews?\b/i.test(s) && /\d/.test(s) && s.length < 40);
            let views = NaN;
            if (viewStr) views = /^\s*no\s+views?/i.test(viewStr) ? 0 : S.parseCount(viewStr);
            const ageStr = strs.find((s) => /\bago\s*$/i.test(s) && s.length < 40);
            items.push({ id, views, ageDate: ageStr ? S.relativeAgeToDate(ageStr) : null });
          }
          return; // don't descend into an item we've already read
        }
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    })(content, 0);
    return items;
  }

  // Rendered-grid fallback when ytInitialData couldn't be read.
  function domItems() {
    const items = [];
    const seen = new Set();
    const tiles = document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer, ytm-shorts-lockup-view-model, ytd-reel-item-renderer');
    for (const tile of tiles) {
      const a = tile.querySelector('a[href*="/shorts/"], a[href*="/watch?v="]');
      const href = a ? a.getAttribute('href') || '' : '';
      const m = href.match(/(?:\/shorts\/|[?&]v=)([A-Za-z0-9_-]{11})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const text = tile.innerText || '';
      const vm = text.match(/([\d.,]+\s*[KMB]?)\s+views?/i);
      const am = text.match(/\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago/i);
      items.push({
        id: m[1],
        views: vm ? S.parseCount(vm[1]) : NaN,
        ageDate: am ? S.relativeAgeToDate(am[0]) : null,
      });
    }
    return items;
  }

  // A video's upload date from its watch page (publishDate / uploadDate in
  // the embedded microformat), "YYYY-MM-DD" or null. Best-effort.
  async function fetchUploadDate(videoId) {
    if (!videoId) return null;
    try {
      const html = await fetchHtml(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`);
      const m =
        html.match(/"publishDate"\s*:\s*"([^"]+)"/) ||
        html.match(/"uploadDate"\s*:\s*"([^"]+)"/) ||
        html.match(/itemprop="(?:datePublished|uploadDate)"\s+content="([^"]+)"/);
      if (!m) return null;
      const d = new Date(m[1]);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    } catch (e) {
      console.warn('[OEA] YouTube upload-date fetch failed:', e);
      return null;
    }
  }

  function channelMeta(data) {
    return (data && data.metadata && data.metadata.channelMetadataRenderer) || null;
  }

  // The links YouTube shows under the channel header ("example.com and 3 more
  // links"). They're redirect URLs (youtube.com/redirect?q=…) — unwrap them.
  function headerLinks(data) {
    const links = [];
    for (const s of stringsIn(data && data.header)) {
      if (/^https?:\/\/(www\.)?youtube\.com\/redirect\?/i.test(s)) {
        const target = S.unwrapRedirect(s);
        if (target) links.push(target);
      }
    }
    return links;
  }

  // Links written into the description: full URLs, plus scheme-less
  // Instagram / TikTok profile links ("instagram.com/foo", "tiktok.com/@foo").
  function descriptionLinks(text) {
    const s = String(text || '');
    const full = s.match(/\bhttps?:\/\/[^\s)]+/gi) || [];
    const bare = (s.match(/(?<![\w/.])(?:www\.)?(?:instagram\.com\/[A-Za-z0-9._]+|tiktok\.com\/@[A-Za-z0-9._]+)/gi) || [])
      .map((l) => `https://${l}`);
    return [...full, ...bare];
  }

  // Every link on the channel's About panel. The header only shows the first
  // one ("example.com and 3 more links"); the About page's ytInitialData has
  // them all, as youtube.com/redirect?q=… URLs. These are how a YouTube
  // creator without an email gets reached: the dashboard DMs the Instagram /
  // TikTok account linked here.
  async function aboutLinks(base) {
    if (!base) return [];
    const about = await fetchInitialData(`${base}/about`);
    if (!about) return [];
    const links = [];
    // The About panel nests its links deep inside the page JSON.
    for (const s of stringsIn(about, [], 0, 80)) {
      if (/^https?:\/\/(www\.)?youtube\.com\/redirect\?/i.test(s)) {
        const target = S.unwrapRedirect(s);
        if (target) links.push(target);
      }
    }
    return links;
  }

  async function extractYouTubeChannel() {
    const result = {
      platform: 'youtube',
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
      const base = channelBasePath();
      let data = ytInitialDataFrom(document);
      // Landed somewhere without the channel JSON (consent interstitial, SPA
      // hop) — fetch the Shorts tab directly.
      if (!channelMeta(data) && base) data = await fetchInitialData(`${base}/shorts`);

      const meta = channelMeta(data);
      if (meta && meta.vanityChannelUrl) {
        const m = String(meta.vanityChannelUrl).match(/\/@([^/?#]+)/);
        if (m) result.username = decodeURIComponent(m[1]);
      }
      S.applyName(result, meta && meta.title, result.username);
      result.biography = (meta && meta.description && String(meta.description).trim()) || null;

      const fromBio = S.findEmail(result.biography);
      if (fromBio) {
        result.email = fromBio;
        result.emailSource = 'youtube_bio';
      }

      let about = [];
      try {
        about = await aboutLinks(base);
      } catch (e) {
        console.warn('[OEA] YouTube About links fetch failed:', e);
      }
      // Instagram / TikTok profile links first: the list is capped at 25 and a
      // big channel's About panel is full of sponsor links, while the linked
      // social account is what the dashboard DMs when there's no email.
      const allLinks = [...headerLinks(data), ...about, ...descriptionLinks(result.biography)];
      const isSocial = (l) => /^https?:\/\/([a-z]+\.)?(instagram\.com\/|tiktok\.com\/@)/i.test(l);
      result.bioLinks = S.cleanLinks(
        [...allLinks.filter(isSocial), ...allLinks.filter((l) => !isSocial(l))],
        /(^|\.)(youtube\.com|youtu\.be)$/,
      );

      // Views: the Shorts grid (Reels equivalent); a channel without Shorts
      // falls back to its Videos tab.
      let onShorts = selectedTabTitle(data) === 'shorts';
      let items = onShorts ? gridItems(data) : [];
      if (!items.length && onShorts) items = domItems();
      if (!items.length && base) {
        const shorts = onShorts ? null : await fetchInitialData(`${base}/shorts`);
        if (shorts && selectedTabTitle(shorts) === 'shorts') items = gridItems(shorts);
        onShorts = items.length > 0;
      }
      if (!items.length && base) {
        const videos = await fetchInitialData(`${base}/videos`);
        if (videos) items = gridItems(videos);
        onShorts = false;
      }

      const recent = items.slice(0, 12);
      result.reelViews = recent.map((i) => i.views).filter((n) => Number.isFinite(n) && n > 0);
      const newest = recent[0];
      if (newest) {
        result.latestReelDate = newest.ageDate || (await fetchUploadDate(newest.id));
      }
      result.viewsSource = onShorts ? 'shorts' : 'videos';

      console.log('[OEA] YouTube channel data extracted:', result);
    } catch (error) {
      console.error('[OEA] Error extracting YouTube data:', error);
    }
    return result;
  }

  console.log('[OEA] YouTube content script loaded');
})();
