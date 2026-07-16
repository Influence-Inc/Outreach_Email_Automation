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

  // Normalize a raw Instagram display name into the way a person would write a
  // first name: plain letters, one capital per word ("PEAR" → "Pear",
  // "taoagou" → "Taoagou", "ᴠᴇʀᴍᴏꜱᴀ" → "Vermosa", "🤍 Gayatri" → "Gayatri"),
  // preserving accents ("José") and multi-word names / trailing initials
  // ("Anvith K"). Returns '' when nothing name-like survives.
  // Mirrors backend/src/services/nameFormat.js (the server re-applies it at
  // send time; this keeps the value clean when the extension patches it).
  const SMALL_CAPS = {
    'ᴀ':'A','ʙ':'B','ᴄ':'C','ᴅ':'D','ᴇ':'E','ꜰ':'F','ɢ':'G','ʜ':'H','ɪ':'I',
    'ᴊ':'J','ᴋ':'K','ʟ':'L','ᴍ':'M','ɴ':'N','ᴏ':'O','ᴘ':'P','ꞯ':'Q','ʀ':'R',
    'ꜱ':'S','ᴛ':'T','ᴜ':'U','ᴠ':'V','ᴡ':'W','ʏ':'Y','ᴢ':'Z',
  };
  // Uniform parts (ALL CAPS / all-lowercase) get title-cased; already-mixed
  // parts ("McKenzie") are intentionally styled, so keep their internal caps
  // and only ensure the first letter is capital.
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
  function formatFirstName(raw) {
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

  // Instagram truncates a long bio behind a "… more" toggle. Until it's
  // clicked, the hidden tail of the bio is not in the DOM — so an email that
  // sits below the fold is never scraped. Find the bio's "more" toggle in the
  // profile header and click it so the full bio (and any email in it) renders
  // before we read it.
  //
  // Safe + conservative: only clicks a small LEAF element whose visible text is
  // exactly "more" (after stripping a leading ellipsis), scoped to the profile
  // header so we never click "more" on a pinned-post caption or a suggested
  // profile. Two passes in case expanding reveals a second truncated block.
  async function expandBioMore() {
    const header =
      document.querySelector('header') ||
      document.querySelector('main header') ||
      document.querySelector('main') ||
      document.body;
    let clicked = 0;
    for (let pass = 0; pass < 2; pass++) {
      let found = false;
      for (const el of header.querySelectorAll('button, [role="button"], span, div, a')) {
        if (el.childElementCount > 0) continue; // leaf only — not a wrapper containing "more"
        const text = (el.textContent || '').trim().toLowerCase().replace(/^[.…\s]+/, '');
        if (text !== 'more') continue;
        try {
          el.click();
          clicked += 1;
          found = true;
        } catch {
          /* ignore a non-clickable match and keep looking */
        }
        break;
      }
      if (!found) break;
      await sleep(400); // let the bio re-render after expanding
    }
    if (clicked) console.log(`Expanded bio via "more" (${clicked} click${clicked === 1 ? '' : 's'})`);
    return clicked > 0;
  }

  // Parse "1.2K" -> 1200, "3M" -> 3_000_000, "1,234" -> 1234. Mirrors the
  // proven Reels Analyzer reference (commas tolerated as a safe superset).
  function parseViewCount(str) {
    if (!str) return NaN;
    str = String(str).trim().toUpperCase().replace(/,/g, '');
    if (str.includes('K')) return parseFloat(str) * 1000;
    if (str.includes('M')) return parseFloat(str) * 1000000;
    return parseFloat(str);
  }

  // ---- Reel view scraping --------------------------------------------------
  // Ported from the proven "Instagram Reels Analyzer" extension. For each reel
  // link we read the view count from the link's IMMEDIATE parent (the overlay
  // renders inside / right beside the <a>), scan its spans, skip engagement
  // labels, and take the largest number >= 1000. The number match is
  // case-insensitive so Instagram's lowercase "153k"/"1.5m" parse as well as
  // "153K"/"1.5M".
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
      if (/^[\d.,]+[km]?$/i.test(text)) {
        const views = parseViewCount(text);
        if (Number.isFinite(views) && views >= 1000 && (best === null || views > best)) {
          best = views;
        }
      }
    }
    return best;
  }

  // One scrape pass over the reels feed: record each reel's views keyed by reel
  // id into `reels`, reading from the link's immediate parent. Repeated passes
  // across scrolls accumulate and dedupe (reels that scrolled out of view stay
  // recorded). Scoped to the main feed so sidebar/suggested reels are ignored.
  function scrapeVisibleReels(reels) {
    const feed =
      document.querySelector('main') ||
      document.querySelector("section[role='region']") ||
      document.body;
    for (const link of feed.querySelectorAll("a[href*='/reel/']")) {
      const href = link.getAttribute('href') || link.href || '';
      const id = (href.split('/reel/')[1] || '').split('/')[0];
      if (!id || reels.has(id)) continue;
      const views = extractViewCount(link.parentElement);
      if (views != null && views > 0) reels.set(id, views);
    }
  }

  // Reels lazy-load as you scroll. Nudge the page down, accumulating into a Map
  // until we have enough or stop making progress, then return the view counts.
  async function collectReelViews(maxReels = 12) {
    const reels = new Map();
    scrapeVisibleReels(reels);
    let stagnant = 0;
    for (let i = 0; i < 12 && reels.size < maxReels; i++) {
      const before = reels.size;
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(700);
      scrapeVisibleReels(reels);
      if (reels.size > before) stagnant = 0;
      else if (++stagnant >= 3) break; // no new reels after a few nudges — stop
    }
    window.scrollTo(0, 0);
    return [...reels.values()].slice(0, maxReels);
  }

  // Quick single-pass scrape for the popup path (no scrolling).
  function extractReelViews(maxReels = 12) {
    const reels = new Map();
    scrapeVisibleReels(reels);
    return [...reels.values()].slice(0, maxReels);
  }

  // ---- Instagram private-API email lookup (the Contact-button email) -------
  // Instagram business/professional profiles expose a public contact email
  // behind the "Contact"/"Email" button. That button is a mobile-app affordance
  // — it never renders in the profile's web DOM — so scraping the page can't see
  // the email. Two logged-in JSON endpoints do carry it, and because these
  // fetches run inside the instagram.com tab they're same-origin and carry the
  // user's session (returning the contact email a cookie-less server-side scrape
  // can't): web_profile_info exposes business_email/public_email for some
  // accounts, and /users/{id}/info/ carries public_email for the rest (many
  // profiles return null in web_profile_info but a real email here). Best-effort:
  // any failure returns null and the DOM scrape takes over.
  const IG_APP_ID = '936619743392459';

  // Normalize an API-provided email; return null unless it's actually
  // email-shaped (guards against IG returning "" / a phone number / a flag).
  function normApiEmail(v) {
    if (!v) return null;
    const s = String(v).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
  }

  // Pull the public contact email out of a web_profile_info user object.
  // business_email / public_email are the usual homes for the "Email"/"Contact"
  // button address; if neither is set, fall back to ANY other key whose name
  // contains "email" (covers Instagram renaming the field). Shallow scan only —
  // we never descend into nested objects, so an unrelated address can't leak in.
  function pickEmailFromUser(user) {
    const primary = normApiEmail(user.business_email) || normApiEmail(user.public_email);
    if (primary) return primary;
    for (const [k, v] of Object.entries(user)) {
      if (/email/i.test(k) && typeof v === 'string') {
        const e = normApiEmail(v);
        if (e) return e;
      }
    }
    return null;
  }

  // Fetch an Instagram private-API JSON endpoint from the logged-in tab. Mirrors
  // the headers Instagram's own web app sends on these XHRs — X-IG-App-ID alone
  // is usually enough, but X-ASBD-ID / X-IG-WWW-Claim / X-Requested-With make it
  // look like a first-party fetch and keep it authenticated (a bare request can
  // come back 401/empty).
  async function fetchIgApi(url) {
    return fetch(url, {
      headers: {
        'X-IG-App-ID': IG_APP_ID,
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
    });
  }

  async function fetchProfileApi(username) {
    if (!username) return null;

    // 1) web_profile_info — the user id, full name, biography, and (for SOME
    //    accounts) business_email / public_email inline.
    let user = null;
    try {
      const resp = await fetchIgApi(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        user = data && data.data && data.data.user;
      } else {
        console.warn(`[OEA] web_profile_info HTTP ${resp.status} for @${username}`);
      }
    } catch (e) {
      console.warn('[OEA] web_profile_info fetch failed:', e);
    }

    const out = {
      email: user ? pickEmailFromUser(user) : null,
      biography: (user && user.biography) || null,
      fullName: (user && user.full_name) || null,
    };
    const userId = user && (user.id || user.pk);

    // 2) The "Email"/"Contact" button address commonly lives ONLY in the
    //    per-user info endpoint (as public_email), NOT in web_profile_info —
    //    which returns null there. So when we have the id but still no email,
    //    follow up with /users/{id}/info/. That's what fills these profiles in.
    if (!out.email && userId) {
      try {
        const resp = await fetchIgApi(
          `https://www.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/`,
        );
        if (resp.ok) {
          const info = await resp.json();
          const infoUser = info && info.user;
          if (infoUser) {
            out.email = pickEmailFromUser(infoUser);
            if (!out.fullName && infoUser.full_name) out.fullName = infoUser.full_name;
            if (!out.biography && infoUser.biography) out.biography = infoUser.biography;
          }
        } else {
          console.warn(`[OEA] users/${userId}/info HTTP ${resp.status} for @${username}`);
        }
      } catch (e) {
        console.warn('[OEA] users/info fetch failed:', e);
      }
    }

    if (!user && !out.email) return null;

    // Diagnostic (tab console + the queue's service-worker console): where the
    // email came from, so a miss is easy to explain.
    console.log(
      `[OEA] api resolve @${username}: ${out.email ? 'email=' + out.email : 'no email'} (id=${userId || '?'})`,
    );
    return out;
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

      // Pull the profile's web_profile_info FIRST — it carries the contact email
      // behind the "Contact"/"Email" button (business_email / public_email) that
      // the web DOM never shows. Prefer it as the authoritative email; the DOM
      // scrape below only runs when this leaves result.email unset. Also fill the
      // full name from here if the DOM couldn't find one.
      const apiData = await fetchProfileApi(result.username);
      if (apiData) {
        if (apiData.email) {
          result.email = apiData.email;
          console.log('Found contact email via web_profile_info:', result.email);
        }
        if (!result.fullName && apiData.fullName) {
          result.fullName = apiData.fullName;
          result.firstName = apiData.fullName.split(/\s+/)[0];
          console.log('Found name via web_profile_info:', apiData.fullName);
        }
      }

      // Expand a truncated bio FIRST so an email hidden below the "more" fold
      // is present in the DOM before we read it. Best-effort — a profile with a
      // short (un-truncated) bio simply has no "more" toggle to click.
      try {
        await expandBioMore();
      } catch (e) {
        console.warn('Bio expand failed (continuing with visible bio):', e);
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

      // Primary source: the (now-expanded) profile header's full text. This
      // reliably contains the whole bio — including an email that the older
      // per-span selectors below can miss when a long bio renders as a single
      // node longer than the per-element cap.
      const headerEl = document.querySelector('header') || document.querySelector('main header');
      if (headerEl && headerEl.innerText) {
        bioText += headerEl.innerText + ' ';
      }

      // Fallback/augment: per-span bio selectors (older layouts). Upper cap
      // raised from 500 to 3000 so a long expanded bio isn't filtered out.
      for (const selector of bioSelectors) {
        const bioElements = document.querySelectorAll(selector);
        for (const element of bioElements) {
          const text = element.textContent;
          if (text && text.length > 10 && text.length < 3000) {
            bioText += text + ' ';
          }
        }
        if (bioText.length > 0) break;
      }

      // Augment with the API biography (reliable, and present even when the DOM
      // bio is truncated or rendered oddly) so the regex fallback below can still
      // find an email written into the bio when business_email/public_email are
      // unset.
      if (apiData && apiData.biography) {
        bioText += ' ' + apiData.biography;
      }

      // Also check for email in meta tags (only if we still have nothing — never
      // overwrite the contact email already resolved from web_profile_info).
      if (!result.email) {
        const metaEmail = document.querySelector('meta[property="og:email"]');
        if (metaEmail) {
          result.email = metaEmail.getAttribute('content');
        }
      }

      // Extract email from bio text using regex
      if (!result.email && bioText) {
        // Common email patterns. {2,24} caps the TLD so the greedy match
        // can't run away; trimAppendedTld below handles the no-separator
        // case where words get glued onto the TLD. The local part must be
        // glued to the @ (no space before it) so an @-mention preceded by a
        // word — e.g. "1/2 of @afterthought.ca" — is never read as an email.
        const emailPatterns = [
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,24}\b/g,
          /\b[A-Za-z0-9._%+-]+@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,24}\b/g,
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

      // Derive the greeting first name from the cleaned full name so it never
      // reads like a bot ("Hi PEAR," / "Hi ᴠᴇʀᴍᴏꜱᴀ,"). Normalizing the FULL
      // name before taking the leading word is what lets an emoji/symbol prefix
      // ("🤍 Gayatri") be stripped instead of captured as the name. Falls back
      // to the raw first name if normalization strips everything.
      const cleanedName = formatFirstName(result.fullName || result.firstName);
      if (cleanedName) {
        result.firstName = cleanedName.split(' ')[0];
      }

      console.log('Instagram profile data extracted:', result);

    } catch (error) {
      console.error('Error extracting Instagram data:', error);
    }

    return result;
  }

  console.log('Instagram content script loaded');
})();