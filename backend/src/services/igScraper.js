// Server-side Instagram profile scraper.
//
// Two strategies, tried in order:
//   1. JSON endpoint: GET /api/v1/users/web_profile_info/?username=X
//      Returns business_email / public_email / full_name for the profile.
//      Requires a logged-in IG session cookie for business_email on most
//      profiles. Cookie is read from IG_SESSION_COOKIE env var if present.
//   2. Public HTML scrape: GET /:username/ and grep the response body for
//      JSON-embedded fields ("business_email":"...", "biography":"...",
//      "full_name":"...") and any email-shaped substrings in the bio.
//
// Returns { email, firstName, fullName, username, source, isBusiness }.

const IG_APP_ID = '936619743392459';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0 Safari/537.36';

const EMAIL_REGEXES = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/,
  // The local part must be glued to the @ — no space before it — so an Instagram
  // @-mention preceded by a word (e.g. "1/2 of @afterthought.ca") is NOT read as
  // an email. Whitespace after the @ / around the dot is still tolerated.
  /\b[A-Za-z0-9._%+-]+@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,24}\b/,
  /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,24}\b/i,
  /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,24}\b/i,
];

// Curated list of common TLDs. We use it to detect when an email scrape has
// extra words glued onto the TLD with no separator — e.g. an Instagram bio
// that renders as "cc jj@33andwest.com\nticket" produces a textContent
// "jj@33andwest.comticket" (the newline collapses to nothing across element
// boundaries). The naive regex greedily grabs "comticket" as the TLD because
// \b matches at end-of-string. We use this list to trim back to "com".
// Lowercase, no leading dot.
const COMMON_TLDS = new Set([
  // generic TLDs
  'com','net','org','edu','gov','mil','int','arpa',
  'info','biz','name','pro','mobi','asia','xxx','tel','jobs','aero','coop','museum',
  // popular short newer gTLDs
  'io','co','ai','app','dev','me','tv','cc','ly','to','sh','fm','ws','xyz','one','team',
  // newer gTLDs commonly seen in creator bios
  'tech','online','store','site','space','world','cloud','website','press',
  'live','life','love','news','club','today','company','agency','studio',
  'group','design','digital','global','media','network','systems','solutions',
  'services','consulting','business','community','education','center','school',
  'academy','email','social','art','blog','shop','fashion','finance','health',
  'marketing','events','photos','travel','tours','hotel','restaurant','cafe',
  'inc','llc','ltd','foundation','industries','engineering','engineer',
  'photography','games','movies','music','beauty','vip','rocks','cool','plus',
  'works','work','careers','agency','market','bar','coffee','wine','pizza',
  // country-code TLDs (top ~100)
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
// when the matched "TLD" is longer than a realistic TLD (~6 chars) AND a
// known shorter TLD prefix exists. Legit obscure TLDs are left alone.
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
  // Search descending for the longest known-TLD prefix.
  for (let len = Math.min(tail.length - 1, 10); len >= 2; len--) {
    const cand = tail.slice(0, len);
    if (COMMON_TLDS.has(cand)) {
      return email.slice(0, at + 1) + domain.slice(0, lastDot + 1) + cand;
    }
  }
  return email;
}

function cleanEmail(raw) {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s+/g, '')
    .replace(/\[at\]/gi, '@')
    .replace(/\(at\)/gi, '@')
    .replace(/\[dot\]/gi, '.')
    .replace(/\(dot\)/gi, '.')
    .toLowerCase();
  return trimAppendedTld(cleaned);
}

function parseUsername(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}


function findEmail(text) {
  if (!text) return null;
  for (const re of EMAIL_REGEXES) {
    const m = text.match(re);
    if (m) return cleanEmail(m[0]);
  }
  return null;
}

function igCookieHeader() {
  const raw = process.env.IG_SESSION_COOKIE;
  if (!raw) return '';
  const trimmed = raw.trim();
  // Accept three formats:
  //   1. bare sessionid value: "12345%3AAbCd..."
  //   2. one named cookie: "sessionid=12345%3AAbCd..."
  //   3. full cookie header pasted from DevTools: "sessionid=...; csrftoken=...; ds_user_id=..."
  if (trimmed.includes('=')) return trimmed;
  return `sessionid=${trimmed}`;
}

function igCookieStatus() {
  const raw = process.env.IG_SESSION_COOKIE;
  if (!raw) return { present: false };
  const header = igCookieHeader();
  const cookies = header.split(/;\s*/).map((c) => c.split('=')[0]).filter(Boolean);
  return { present: true, rawLength: raw.length, cookieNames: cookies };
}

console.log('[ig-scraper] cookie status at boot:', JSON.stringify(igCookieStatus()));

async function fetchWebProfileInfo(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const headers = {
    'X-IG-App-ID': IG_APP_ID,
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    Referer: `https://www.instagram.com/${username}/`,
  };
  const cookie = igCookieHeader();
  if (cookie) headers.Cookie = cookie;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`web_profile_info ${resp.status}`);
  }
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
  } else if (user.biography) {
    const fromBio = findEmail(user.biography);
    if (fromBio) {
      email = fromBio;
      emailSource = 'bio_regex';
    }
  }

  return {
    email,
    emailSource,
    fullName: user.full_name || null,
    username: user.username || username,
    isBusiness: Boolean(user.is_business_account || user.is_professional_account),
    biography: user.biography || null,
  };
}

async function fetchHtmlProfile(username) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const cookie = igCookieHeader();
  if (cookie) headers.Cookie = cookie;

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`html ${resp.status}`);
  const html = await resp.text();

  // When IG blocks the request (datacenter IP, expired/missing cookie, etc.)
  // it serves a generic login-wall page. That page still contains structured
  // metadata for Instagram-the-brand — e.g. `"full_name":"Influence®"` — which
  // the field regexes below would happily pick up and persist as the creator's
  // name. Require the actual username to appear in the JSON blob; otherwise
  // treat the response as blocked.
  const usernameInPage = new RegExp(
    `"username":"${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    'i',
  ).test(html);
  if (!usernameInPage) {
    throw new Error('blocked or login-wall response (username not found in page)');
  }

  // The page embeds JSON in <script> tags. We don't need full parsing - grep.
  let email = null;
  let emailSource = null;
  let fullName = null;
  let biography = null;

  const biz = html.match(/"business_email":"([^"\\]+)"/);
  if (biz && biz[1]) {
    email = biz[1].toLowerCase();
    emailSource = 'business_email';
  }
  if (!email) {
    const pub = html.match(/"public_email":"([^"\\]+)"/);
    if (pub && pub[1]) {
      email = pub[1].toLowerCase();
      emailSource = 'public_email';
    }
  }

  const bio = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  if (bio && bio[1]) {
    biography = bio[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (!email) {
      const fromBio = findEmail(biography);
      if (fromBio) {
        email = fromBio;
        emailSource = 'bio_regex';
      }
    }
  }

  const name = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
  if (name && name[1]) {
    fullName = name[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
  }

  if (!email) {
    // Last resort: hunt the whole HTML.
    const m = findEmail(html);
    if (m) {
      email = m;
      emailSource = 'html_text';
    }
  }

  return { email, emailSource, fullName, biography };
}

async function scrapeProfile({ instagramUrl, instagramUsername }) {
  const username =
    instagramUsername || (instagramUrl ? parseUsername(instagramUrl) : null);
  if (!username) throw new Error('username could not be determined');

  const result = {
    username,
    email: null,
    firstName: null,
    fullName: null,
    source: null,
    isBusiness: null,
  };

  // Strategy 1: JSON endpoint.
  try {
    const api = await fetchWebProfileInfo(username);
    if (api) {
      result.isBusiness = api.isBusiness;
      if (api.fullName) result.fullName = api.fullName;
      if (api.email) {
        result.email = api.email;
        result.source = api.emailSource;
      }
    }
  } catch (err) {
    console.warn(`[ig-scraper] web_profile_info failed for ${username}: ${err.message}`);
  }

  // Strategy 2: HTML page (fills in whatever JSON couldn't).
  if (!result.email || !result.fullName) {
    try {
      const html = await fetchHtmlProfile(username);
      if (!result.email && html.email) {
        result.email = html.email;
        result.source = html.emailSource;
      }
      if (!result.fullName && html.fullName) {
        result.fullName = html.fullName;
      }
    } catch (err) {
      console.warn(`[ig-scraper] html scrape failed for ${username}: ${err.message}`);
    }
  }

  if (result.fullName) {
    result.firstName = result.fullName.split(/\s+/)[0];
  } else {
    result.firstName = username.charAt(0).toUpperCase() + username.slice(1);
  }

  return result;
}

async function probeProfile(username) {
  const result = {
    username,
    cookie: igCookieStatus(),
    web_profile_info: null,
    html: null,
  };

  try {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const headers = {
      'X-IG-App-ID': IG_APP_ID,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Referer: `https://www.instagram.com/${username}/`,
    };
    const cookie = igCookieHeader();
    if (cookie) headers.Cookie = cookie;
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    result.web_profile_info = {
      status: resp.status,
      contentType: resp.headers.get('content-type'),
      bodyLength: text.length,
      bodyPreview: text.slice(0, 300),
      hasUserBlock: Boolean(parsed && parsed.data && parsed.data.user),
    };
  } catch (err) {
    result.web_profile_info = { error: err.message };
  }

  try {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const cookie = igCookieHeader();
    if (cookie) headers.Cookie = cookie;
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    const usernameMatch = new RegExp(
      `"username":"${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
      'i',
    ).test(text);
    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    // Substring search (not JSON pattern) — catches the username regardless of
    // how IG escapes/embeds it in the response.
    const usernameAnywhere = text.toLowerCase().includes(username.toLowerCase());
    // Tell us whether IG thinks the request is authenticated.
    // Real IG pages embed { "viewer": { "id": "..." } } when logged in,
    // and { "viewer": null } (or omit viewer) when logged out.
    const viewerLoggedIn = /"viewer":\s*\{\s*"id"\s*:\s*"\d+"/i.test(text);
    const viewerNull = /"viewer":\s*null/i.test(text);
    // Login-wall sentinels.
    const hasLoginForm =
      /action="\/accounts\/login\//i.test(text) ||
      /aria-label="Log in"/i.test(text) ||
      /loginForm/.test(text);
    const respondedFinalUrl = resp.url;
    result.html = {
      status: resp.status,
      finalUrl: respondedFinalUrl,
      bodyLength: text.length,
      title: titleMatch ? titleMatch[1] : null,
      usernameFoundInBody: usernameMatch,
      usernameAnywhereInBody: usernameAnywhere,
      viewerLoggedIn,
      viewerNull,
      hasLoginForm,
    };
  } catch (err) {
    result.html = { error: err.message };
  }

  return result;
}

module.exports = {
  scrapeProfile,
  parseUsername,
  probeProfile,
  igCookieStatus,
  cleanEmail,
  findEmail,
  trimAppendedTld,
};
