// Headless-browser Instagram scraper.
//
// Why we need this: Instagram's public profile pages are rendered by client-
// side React. The raw HTML response from a server-side fetch is a logged-out
// shell that contains no bio/name/email — those are populated by authenticated
// XHRs after hydration. The only way to read them server-side is to actually
// boot a browser, inject the user's sessionid cookie, let the SPA hydrate,
// then query the DOM.
//
// The DOM-extraction logic in extractProfileData() below is adapted from the
// user's Chrome extension (Creator email automation extension/instagram-content.js).

const puppeteer = require('puppeteer');

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      })
      .catch((err) => {
        // Reset so a subsequent call can retry.
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {}
  browserPromise = null;
}

process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);

// Parse IG_SESSION_COOKIE the same way the HTTP scraper does, but emit
// individual cookie records that puppeteer can setCookie() with.
function parseSessionCookies() {
  const raw = (process.env.IG_SESSION_COOKIE || '').trim();
  if (!raw) return [];
  const out = [];
  const pairs = raw.includes('=') ? raw.split(/;\s*/) : [`sessionid=${raw}`];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({
      name,
      value,
      domain: '.instagram.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return out;
}

// This runs INSIDE the page context — no node globals, no closures.
// Ported from instagram-content.js in the extension.
function extractProfileData() {
  const result = { email: null, firstName: null, fullName: null, username: null };

  try {
    const urlMatch = window.location.pathname.match(/^\/([^/]+)\/?$/);
    if (urlMatch) result.username = urlMatch[1];

    const nameSelectors = [
      'header section div span.x1lliihq.x1plvlek.xryxfnj',
      'header section span.x1lliihq.x1plvlek.xryxfnj',
      'header section > div > div > span',
      'section > div > div > div > span.x1lliihq',
      'section > div span.-vDIg span',
      'header section span.-vDIg',
      'header section span',
    ];

    let foundName = false;
    for (const selector of nameSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent.trim();
        if (text === result.username) continue;
        if (text.startsWith('@')) continue;
        if (text.length < 2) continue;
        if (['Posts', 'Followers', 'Following', 'Reels', 'Tagged'].includes(text)) continue;
        if (text.length >= 2 && text.length < 100) {
          result.fullName = text;
          result.firstName = text.split(/\s+/)[0];
          foundName = true;
          break;
        }
      }
      if (foundName) break;
    }

    if (!foundName) {
      const header = document.querySelector('header section');
      const headerText = header ? header.innerText : '';
      const lines = headerText.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line === result.username) continue;
        if (line.startsWith('@')) continue;
        if (/^\d+$/.test(line)) continue;
        const lower = line.toLowerCase();
        if (['posts', 'followers', 'following', 'reels', 'tagged'].includes(lower)) continue;
        if (line.length >= 2 && line.length <= 50 && /[a-zA-Z]/.test(line)) {
          result.fullName = line;
          result.firstName = line.split(/\s+/)[0];
          break;
        }
      }
    }

    if (!result.firstName && result.username) {
      result.firstName = result.username.charAt(0).toUpperCase() + result.username.slice(1);
    }

    // Build a bio text blob from spans in the header section.
    const bioSelectors = [
      'header section div.-vDIg span',
      'div._aa_c span',
      'header section span',
      'div[class*="x1lliihq"] span',
      'section span',
    ];
    let bioText = '';
    for (const selector of bioSelectors) {
      const bioElements = document.querySelectorAll(selector);
      for (const element of bioElements) {
        const text = element.textContent;
        if (text && text.length > 10 && text.length < 500) bioText += text + ' ';
      }
      if (bioText.length > 0) break;
    }

    const metaEmail = document.querySelector('meta[property="og:email"]');
    if (metaEmail) result.email = metaEmail.getAttribute('content');

    if (!result.email && bioText) {
      const patterns = [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/g,
        /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/gi,
        /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/gi,
      ];
      for (const pattern of patterns) {
        const matches = bioText.match(pattern);
        if (matches && matches.length) {
          result.email = matches[0]
            .replace(/\s+/g, '')
            .replace(/\[at\]/gi, '@')
            .replace(/\(at\)/gi, '@')
            .replace(/\[dot\]/gi, '.')
            .replace(/\(dot\)/gi, '.')
            .toLowerCase();
          break;
        }
      }
    }

    if (!result.email) {
      const mailto = document.querySelector('a[href^="mailto:"]');
      if (mailto) result.email = mailto.getAttribute('href').replace(/^mailto:/, '');
    }

    if (!result.email) {
      const allText = document.body.innerText;
      const m = allText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
      if (m) result.email = m[0].toLowerCase();
    }
  } catch (err) {
    return { error: String(err && err.message), partial: result };
  }
  return result;
}

async function scrapeWithPuppeteer(username) {
  if (!username) throw new Error('username required');
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/121.0 Safari/537.36',
    );
    const cookies = parseSessionCookies();
    if (cookies.length) await browser.setCookie(...cookies);

    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const status = resp ? resp.status() : 0;

    // Give the SPA a moment to populate the header after networkidle.
    await page.waitForSelector('header section', { timeout: 10000 }).catch(() => {});

    const data = await page.evaluate(extractProfileData);

    // Tell the caller whether the page hydrated as a real profile.
    const pageState = await page.evaluate((u) => {
      const titleEl = document.querySelector('title');
      const header = document.querySelector('header section');
      return {
        title: titleEl ? titleEl.textContent : null,
        hasHeader: Boolean(header),
        loggedIn: /"viewer":\s*\{\s*"id"\s*:\s*"\d+"/.test(document.documentElement.outerHTML),
        usernameInBody: document.body.innerText.toLowerCase().includes(u.toLowerCase()),
      };
    }, username);

    return { status, data, pageState };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = { scrapeWithPuppeteer, closeBrowser };
