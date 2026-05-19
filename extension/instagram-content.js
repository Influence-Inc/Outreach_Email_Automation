// Instagram profile data extractor.
//
// Tries three strategies in order:
//   1. web_profile_info JSON endpoint   - returns business_email / public_email
//                                         (this is the SAME data the mobile
//                                         "Email" button reads from).
//   2. DOM bio scraping with regex      - catches plain-text emails in bios.
//   3. mailto / og:email / page-text    - last-resort fallbacks.
//
// The first method handles "email button only" profiles (business / creator
// accounts) without needing a mobile user-agent spoof, because the button on
// mobile is literally a UI affordance over this same JSON field.

(function () {
  'use strict';

  const IG_APP_ID = '936619743392459'; // public web app id used by instagram.com

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'extractInstagramData') {
      extractProfileData()
        .then((data) => sendResponse(data))
        .catch((err) => {
          console.error('Extraction failed:', err);
          sendResponse({
            email: null, firstName: null, fullName: null,
            username: null, source: null, error: err.message,
          });
        });
      return true; // keep the message channel open for async sendResponse
    }
  });

  async function extractProfileData() {
    const result = {
      email: null,
      firstName: null,
      fullName: null,
      username: null,
      source: null,
      isBusiness: null,
    };

    const urlMatch = window.location.pathname.match(/^\/([^\/]+)/);
    if (urlMatch) result.username = urlMatch[1];

    // ---- Strategy 1: web_profile_info JSON (equivalent of the Email button) ----
    if (result.username) {
      try {
        const apiData = await fetchWebProfileInfo(result.username);
        if (apiData) {
          result.isBusiness = apiData.isBusiness;
          if (apiData.email) {
            result.email = apiData.email;
            result.source = apiData.emailSource; // 'business_email' or 'public_email'
          }
          if (apiData.fullName) {
            result.fullName = apiData.fullName;
            result.firstName = apiData.fullName.split(/\s+/)[0];
          }
          if (apiData.username) result.username = apiData.username;
        }
      } catch (err) {
        console.warn('[Influence] web_profile_info failed:', err.message);
      }
    }

    // ---- Strategy 2 + 3: DOM bio scraping / mailto / og:email ----
    if (!result.email || !result.fullName) {
      const dom = scrapeDom(result.username);
      if (!result.email && dom.email) {
        result.email = dom.email;
        result.source = dom.emailSource; // 'bio_regex' | 'mailto' | 'og_email' | 'body_text'
      }
      if (!result.fullName && dom.fullName) {
        result.fullName = dom.fullName;
        result.firstName = dom.fullName.split(/\s+/)[0];
      }
    }

    if (!result.firstName && result.username) {
      result.firstName = result.username.charAt(0).toUpperCase() + result.username.slice(1);
    }

    console.log('[Influence] Extracted:', result);
    return result;
  }

  async function fetchWebProfileInfo(username) {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*',
      },
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);

    const data = await resp.json();
    const user = data && data.data && data.data.user;
    if (!user) return null;

    let email = null;
    let emailSource = null;
    if (user.business_email) {
      email = String(user.business_email).trim().toLowerCase();
      emailSource = 'business_email';
    } else if (user.public_email) {
      email = String(user.public_email).trim().toLowerCase();
      emailSource = 'public_email';
    }

    return {
      email,
      emailSource,
      fullName: user.full_name || null,
      username: user.username || username,
      isBusiness: Boolean(user.is_business_account || user.is_professional_account),
    };
  }

  function scrapeDom(usernameFromUrl) {
    const out = { email: null, emailSource: null, fullName: null };

    // ---- Name ----
    const nameSelectors = [
      'header section div span.x1lliihq.x1plvlek.xryxfnj',
      'header section span.x1lliihq.x1plvlek.xryxfnj',
      'header section > div > div > span',
      'section > div > div > div > span.x1lliihq',
      'section > div span.-vDIg span',
      'header section span.-vDIg',
      'header section span',
    ];
    outer: for (const sel of nameSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent.trim();
        if (!text || text === usernameFromUrl) continue;
        if (text.startsWith('@')) continue;
        if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged'].includes(text)) continue;
        if (text.length < 2 || text.length > 100) continue;
        out.fullName = text;
        break outer;
      }
    }

    // ---- Bio text ----
    const bioSelectors = [
      'header section div.-vDIg span',
      'div._aa_c span',
      'header section span',
      'div[class*="x1lliihq"] span',
      'section span',
    ];
    let bioText = '';
    for (const sel of bioSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent;
        if (text && text.length > 10 && text.length < 500) bioText += text + ' ';
      }
      if (bioText) break;
    }

    // ---- og:email meta ----
    const meta = document.querySelector('meta[property="og:email"]');
    if (meta) {
      out.email = meta.getAttribute('content');
      out.emailSource = 'og_email';
    }

    // ---- Bio regex ----
    if (!out.email && bioText) {
      const patterns = [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/g,
        /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/gi,
        /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/gi,
      ];
      for (const p of patterns) {
        const m = bioText.match(p);
        if (m && m.length) {
          out.email = m[0]
            .replace(/\s+/g, '')
            .replace(/\[at\]/gi, '@')
            .replace(/\(at\)/gi, '@')
            .toLowerCase();
          out.emailSource = 'bio_regex';
          break;
        }
      }
    }

    // ---- mailto links ----
    if (!out.email) {
      const link = document.querySelector('a[href^="mailto:"]');
      if (link) {
        out.email = link.getAttribute('href').replace('mailto:', '').split('?')[0];
        out.emailSource = 'mailto';
      }
    }

    // ---- last resort: full page text ----
    if (!out.email) {
      const all = document.body.innerText || '';
      const m = all.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
      if (m) {
        out.email = m[0].toLowerCase();
        out.emailSource = 'body_text';
      }
    }

    return out;
  }

  console.log('[Influence] Instagram extractor loaded');
})();
