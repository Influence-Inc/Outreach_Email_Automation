// Instagram profile data extractor
(function() {
  'use strict';

  // Listen for requests from popup / background queue. extractProfileData is
  // async (it scrolls to lazy-load the reels grid before reading view counts),
  // so we keep the message channel open by returning true and replying from the
  // promise.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractInstagramData') {
      // The dashboard queue sets includeReels to scroll-and-collect reel views.
      // The popup (email autofill only) omits it to stay fast and not scroll.
      extractProfileData({ includeReels: request.includeReels === true })
        .then((data) => sendResponse(data))
        .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return true;
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "1.2K" -> 1200, "3.4M" -> 3_400_000, "950" -> 950
  function parseViewCount(s) {
    if (!s) return NaN;
    s = String(s).trim().toUpperCase().replace(/,/g, '');
    const m = s.match(/([\d.]+)\s*([KM]?)/);
    if (!m) return NaN;
    let n = parseFloat(m[1]);
    if (m[2] === 'K') n *= 1e3;
    else if (m[2] === 'M') n *= 1e6;
    return n;
  }

  // A leaf's text "looks like" a view count: it has digits, no words (other
  // than a K/M unit), and isn't a duration like "0:15".
  function looksLikeCount(t) {
    if (!t || !/\d/.test(t)) return false;
    if (t.includes(':')) return false; // video duration, not a count
    if (/[a-z]/i.test(t.replace(/[KM]/gi, ''))) return false; // contains words
    return true;
  }

  // Pull a "<n> views/plays" count from any aria-label/title within `root`.
  // Instagram exposes the play count this way for screen readers even when the
  // visible number is hard to target.
  function countFromAria(root) {
    for (const el of root.querySelectorAll('[aria-label], [title]')) {
      const lab = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const m = lab.match(/([\d.,]+\s*[KM]?)\s*(?:views?|plays?)/i);
      if (m) {
        const n = parseViewCount(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  }

  // Find this reel tile's view count within `root`. Tries the accessible
  // label first, then scans leaf text nodes for a clean numeric token (the
  // reels grid overlay shows only the play count, so the first number wins).
  function countInRoot(root) {
    const aria = countFromAria(root);
    if (aria != null) return aria;
    for (const el of root.querySelectorAll('span, div')) {
      if (el.children.length) continue; // only leaf elements hold the number
      const t = (el.textContent || '').trim();
      if (!looksLikeCount(t)) continue;
      const n = parseViewCount(t);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  // Collect reel view counts from the profile grid (most-recent first). For
  // each reel anchor, read its view-count overlay — searching the anchor and,
  // if the count sits outside it, widening to ancestor containers that still
  // wrap exactly one reel (so we never read a neighbouring tile's number).
  // Dedupes by reel id and caps at `maxReels`.
  function extractReelViews(maxReels = 12) {
    const views = [];
    const seen = new Set();
    const anchors = document.querySelectorAll("a[href*='/reel/']");
    for (const a of anchors) {
      if (views.length >= maxReels) break;
      const href = a.getAttribute('href') || '';
      const idMatch = href.match(/\/reel\/([^/]+)/);
      const id = idMatch ? idMatch[1] : href;
      if (seen.has(id)) continue;

      let count = countInRoot(a);
      let node = a;
      for (let up = 0; up < 3 && count == null; up++) {
        node = node.parentElement;
        if (!node) break;
        if (node.querySelectorAll("a[href*='/reel/']").length !== 1) break; // spans >1 reel
        count = countInRoot(node);
      }

      if (count != null) {
        seen.add(id);
        views.push(count);
      }
    }
    return views;
  }

  // Reels (and their view overlays) lazy-load as you scroll. Nudge the page
  // down until we have enough reels or stop making progress, then return to the
  // top before reading the DOM.
  async function collectReelViews(maxReels = 12) {
    let best = extractReelViews(maxReels);
    let stagnant = 0;
    for (let i = 0; i < 8 && best.length < maxReels; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(700);
      const next = extractReelViews(maxReels);
      if (next.length > best.length) {
        best = next;
        stagnant = 0;
      } else if (++stagnant >= 2) {
        break; // no new reels after two nudges — stop
      }
    }
    window.scrollTo(0, 0);
    return best;
  }

  async function extractProfileData({ includeReels = true } = {}) {
    const result = {
      email: null,
      firstName: null,
      fullName: null,
      username: null,
      reelViews: []
    };

    try {
      // Extract username from the first path segment. Works on both the profile
      // root (/username/) and sub-tabs (/username/reels/, /username/tagged/).
      const segments = window.location.pathname.split('/').filter(Boolean);
      const RESERVED = new Set(['reels', 'reel', 'p', 'tagged', 'explore', 'stories', 'tv']);
      if (segments.length && !RESERVED.has(segments[0].toLowerCase())) {
        result.username = segments[0];
      }

      // Try to extract full name from profile (NOT the username header)
      // Instagram structure: username is in h2, full name is in span below it
      const nameSelectors = [
        // New Instagram layout - name is in a span with specific classes
        'header section div span.x1lliihq.x1plvlek.xryxfnj',
        'header section span.x1lliihq.x1plvlek.xryxfnj',
        // Alternative selectors for name
        'header section > div > div > span',
        'section > div > div > div > span.x1lliihq',
        // Older layouts
        'section > div span.-vDIg span',
        'header section span.-vDIg',
        // Try finding by checking text length (names are usually longer than usernames)
        'header section span'
      ];

      let foundName = false;
      
      // First pass - look for name in specific locations
      for (const selector of nameSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent.trim();
          
          // Skip if it's the username (matches URL username)
          if (text === result.username) continue;
          
          // Skip if it looks like a username (starts with @)
          if (text.startsWith('@')) continue;
          
          // Skip if it's just numbers or very short
          if (text.length < 2) continue;
          
          // Skip if it contains common UI text
          if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged'].includes(text)) continue;
          
          // This is likely the real name
          if (text.length >= 2 && text.length < 100) {
            result.fullName = text;
            result.firstName = text.split(/\s+/)[0];
            foundName = true;
            console.log('Found name:', text);
            break;
          }
        }
        if (foundName) break;
      }

      // Second pass - if no name found, look in header more carefully
      if (!foundName) {
        const headerText = document.querySelector('header section')?.innerText || '';
        const lines = headerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // The name is usually on a line by itself, after the username
        for (const line of lines) {
          // Skip username line
          if (line === result.username) continue;
          // Skip @ mentions
          if (line.startsWith('@')) continue;
          // Skip numbers (follower counts)
          if (/^\d+$/.test(line)) continue;
          // Skip common UI text
          if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged', 'posts', 'followers', 'following'].includes(line.toLowerCase())) continue;
          
          // If this line looks like a name (2-50 chars, has letters)
          if (line.length >= 2 && line.length <= 50 && /[a-zA-Z]/.test(line)) {
            result.fullName = line;
            result.firstName = line.split(/\s+/)[0];
            foundName = true;
            console.log('Found name from header text:', line);
            break;
          }
        }
      }

      // If still no name found, use username as fallback
      if (!result.firstName && result.username) {
        result.firstName = result.username.charAt(0).toUpperCase() + result.username.slice(1);
        console.log('Using username as fallback:', result.firstName);
      }

      // Extract email from bio (rest of the function remains the same)
      const bioSelectors = [
        'header section div.-vDIg span',
        'div._aa_c span',
        'header section span',
        'div[class*="x1lliihq"] span',
        'section span'
      ];

      let bioText = '';
      
      // Try multiple selectors to find bio
      for (const selector of bioSelectors) {
        const bioElements = document.querySelectorAll(selector);
        for (const element of bioElements) {
          const text = element.textContent;
          if (text && text.length > 10 && text.length < 500) {
            bioText += text + ' ';
          }
        }
        if (bioText.length > 0) break;
      }

      // Also check for email in meta tags
      const metaEmail = document.querySelector('meta[property="og:email"]');
      if (metaEmail) {
        result.email = metaEmail.getAttribute('content');
      }

      // Extract email from bio text using regex
      if (!result.email && bioText) {
        // Common email patterns
        const emailPatterns = [
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/gi,
          /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/gi
        ];

        for (const pattern of emailPatterns) {
          const matches = bioText.match(pattern);
          if (matches && matches.length > 0) {
            // Clean up the email (remove spaces, replace [at] with @)
            result.email = matches[0]
              .replace(/\s+/g, '')
              .replace(/\[at\]/gi, '@')
              .replace(/\(at\)/gi, '@')
              .toLowerCase();
            break;
          }
        }
      }

      // Try to find email in clickable links
      if (!result.email) {
        const links = document.querySelectorAll('a[href^="mailto:"]');
        if (links.length > 0) {
          result.email = links[0].getAttribute('href').replace('mailto:', '');
        }
      }

      // Look for email in any visible text on the page (last resort)
      if (!result.email) {
        const allText = document.body.innerText;
        const emailMatch = allText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
        if (emailMatch) {
          result.email = emailMatch[0].toLowerCase();
        }
      }

      // Collect reel view counts for negotiation pricing (best-effort). When
      // includeReels is set (dashboard queue) we scroll to lazy-load the reels
      // grid for the recent ~12 reels; otherwise (popup) do a quick single pass.
      try {
        result.reelViews = includeReels ? await collectReelViews(12) : extractReelViews(12);
        console.log('Reel views extracted:', result.reelViews);
      } catch (e) {
        console.warn('Reel view extraction failed:', e);
      }

      console.log('Instagram profile data extracted:', result);

    } catch (error) {
      console.error('Error extracting Instagram data:', error);
    }

    return result;
  }

  console.log('Instagram content script loaded');
})();