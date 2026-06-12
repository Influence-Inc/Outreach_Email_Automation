// Instagram profile data extractor
(function() {
  'use strict';

  // Curated list of common TLDs. Used to detect when an email scrape has
  // extra words glued onto the TLD with no separator — e.g. an Instagram bio
  // rendered as "cc jj@33andwest.com<br>ticket" yields a textContent of
  // "cc jj@33andwest.comticket" (the newline collapses to nothing across
  // element boundaries). The naive regex greedily grabs "comticket" as the
  // TLD because \b matches at end-of-string. We trim back to "com".
  // Lowercase, no leading dot. Mirrors backend/src/services/igScraper.js.
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

  // Trim characters glued onto the TLD with no separator (e.g.
  // "jj@33andwest.comticket" -> "jj@33andwest.com"). Conservative: only trims
  // when the matched TLD is longer than realistic (~6 chars) AND a known
  // shorter TLD prefix exists. Legit obscure TLDs are left alone.
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

  // Parse "1.2K" -> 1200, "3M" -> 3_000_000, "1,234" -> 1234. Mirrors the
  // proven Reels Analyzer reference (commas tolerated as a safe superset).
  function parseViewCount(str) {
    if (!str) return NaN;
    str = String(str).trim().toUpperCase().replace(/,/g, '');
    if (str.includes('K')) return parseFloat(str) * 1000;
    if (str.includes('M')) return parseFloat(str) * 1000000;
    return parseFloat(str);
  }

  // Read one reel's view count from its tile. Ported verbatim from the working
  // reference extension's extractViewCount: scan the spans in the link's PARENT
  // container (the count renders as a sibling of the <a>, not inside it), skip
  // engagement labels, and take the LARGEST number >= 1000. That single
  // heuristic — parent container + max >= 1000 — is what made it reliable.
  function extractViewCount(container) {
    if (!container) return null;
    let best = null;
    for (const span of container.querySelectorAll('span')) {
      const text = (span.textContent || '').trim();
      const lower = text.toLowerCase();
      if (
        lower.includes('like') ||
        lower.includes('comment') ||
        lower.includes('share') ||
        lower.includes('follow')
      ) {
        continue;
      }
      if (/^[\d.,]+[KM]?$/.test(text)) {
        const views = parseViewCount(text);
        if (Number.isFinite(views) && views >= 1000 && (best === null || views > best)) {
          best = views;
        }
      }
    }
    return best;
  }

  // Collect recent reel view counts from the reels grid, most-recent first.
  // Instagram renders each reel's view-count overlay as a SIBLING of the <a>
  // (not inside it), so for every reel we climb to the largest ancestor that
  // still wraps only that one reel — the full tile — and read the count there.
  // The "only this reel" guard means we never pick up a neighbouring tile's
  // number. Dedupes by reel id and caps at `maxReels`.
  function reelIdOf(el) {
    const href = el.getAttribute('href') || el.href || '';
    return (href.split('/reel/')[1] || '').split('/')[0] || '';
  }

  function extractReelViews(maxReels = 12) {
    const views = [];
    const seen = new Set();
    const anchors = document.querySelectorAll("a[href*='/reel/']");
    for (const a of anchors) {
      if (views.length >= maxReels) break;
      const id = reelIdOf(a);
      if (!id || seen.has(id)) continue;

      // Climb while the parent still contains only this reel (any number of
      // links, but all the same reel id — a tile can have more than one anchor
      // to the same reel). Stop the moment a different reel would be included.
      let tile = a;
      while (tile.parentElement) {
        const ids = new Set(
          [...tile.parentElement.querySelectorAll("a[href*='/reel/']")].map(reelIdOf),
        );
        ids.delete('');
        if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
        tile = tile.parentElement;
      }

      const count = extractViewCount(tile);
      if (count != null && count > 0) {
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
        // Common email patterns. {2,24} caps the TLD so the greedy match
        // can't run away; trimAppendedTld below handles the no-separator
        // case where words get glued onto the TLD.
        const emailPatterns = [
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,24}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,24}\b/g,
          /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,24}\b/gi,
          /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,24}\b/gi
        ];

        for (const pattern of emailPatterns) {
          const matches = bioText.match(pattern);
          if (matches && matches.length > 0) {
            // Clean up the email (whitespace, [at]/(at), lowercase) and trim
            // any extra word that got concatenated onto the TLD.
            const cleaned = matches[0]
              .replace(/\s+/g, '')
              .replace(/\[at\]/gi, '@')
              .replace(/\(at\)/gi, '@')
              .toLowerCase();
            result.email = trimAppendedTld(cleaned);
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
        const emailMatch = allText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,24}\b/);
        if (emailMatch) {
          result.email = trimAppendedTld(emailMatch[0].toLowerCase());
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