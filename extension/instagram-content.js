// Instagram profile data extractor
(function() {
  'use strict';

  // Listen for requests from popup / background. extractProfileData is async
  // (it surfaces and scrolls the Reels grid), so keep the channel open.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractInstagramData') {
      extractProfileData()
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
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

  // Read the view-count overlay from a single reel anchor. On the grid the
  // overlay is just a play icon + count, so the first count-like token in the
  // anchor's text is the view count. Skip obvious label text.
  function readReelCount(a) {
    const spans = a.querySelectorAll('span');
    for (const sp of spans) {
      const t = (sp.textContent || '').trim();
      if (!t || /like|comment|share|follow|view|ago|reel/i.test(t)) continue;
      if (/^[\d][\d.,]*\s*[KM]?$/i.test(t)) {
        const n = parseViewCount(t);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    const txt = (a.innerText || '').replace(/\s+/g, ' ').trim();
    const m = txt.match(/(\d[\d.,]*\s*[KM]?)/i);
    if (m) {
      const n = parseViewCount(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  // Switch the SPA to the profile's Reels tab (no full reload) so the grid
  // shows reels with view-count overlays, newest first.
  async function ensureReelsTab(username) {
    if (/\/reels\/?$/.test(location.pathname)) return;
    const tab =
      document.querySelector(`a[href='/${username}/reels/']`) ||
      document.querySelector("a[href$='/reels/']");
    if (tab) {
      tab.click();
      await sleep(1800);
    }
  }

  // Collect view counts for the recent ~12 reels. Surfaces the Reels tab, then
  // scrolls to load the lazy grid, harvesting newest-first reel anchors.
  async function collectReelViews(username, maxReels = 12) {
    const seen = new Set();
    const views = [];
    const harvest = () => {
      for (const a of document.querySelectorAll("a[href*='/reel/']")) {
        const id = ((a.getAttribute('href') || '').match(/\/reel\/([^/?#]+)/) || [])[1];
        if (!id || seen.has(id)) continue;
        const count = readReelCount(a);
        if (count != null) {
          seen.add(id);
          views.push(count);
        }
      }
    };

    try {
      await ensureReelsTab(username);
    } catch (_) {
      /* ignore — fall back to whatever grid is showing */
    }

    for (let i = 0; i < 8 && views.length < maxReels; i++) {
      harvest();
      if (views.length >= maxReels) break;
      window.scrollBy(0, Math.round(window.innerHeight * 1.5));
      await sleep(650);
    }
    harvest();
    return views.slice(0, maxReels);
  }

  async function extractProfileData() {
    const result = {
      email: null,
      firstName: null,
      fullName: null,
      username: null,
      reelViews: []
    };

    try {
      // Extract username from URL (handles /{username}/ and /{username}/reels/)
      const seg = window.location.pathname.split('/').filter(Boolean);
      if (seg.length) {
        result.username = seg[0];
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

      // Collect recent-reel view counts for negotiation pricing.
      try {
        result.reelViews = await collectReelViews(result.username);
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