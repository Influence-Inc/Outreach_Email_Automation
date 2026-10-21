'use strict';

// P3 stages 1-3: cheap, deterministic collaboration signals, ported from creator-list's
// services/enrichment/enrichment/classify/rules.py. A Reel with any signal is a candidate for
// stage 4 (Jev). Signals are evidence, not labels. Keep the patterns identical to the Python.

const { py, finditer, cut, strip, rstrip, split, isUpper } = require('./pyre');
const { coauthored, otherAccounts } = require('./reels');

const STRONG = 'strong';
const MEDIUM = 'medium';
const WEAK = 'weak';

const signal = (stage, kind, strength, value) => ({ stage, kind, strength, value });

const DISCLOSURE_TAG = py(
  '^(?:ad|ads|advert|advertisement|sponsored|sponsor|paidpartnership|partner|partnership|'
  + 'gifted|giftedby|collab|brandpartner|affiliate|\\w+partner|\\w+ambassador|\\w+creator|'
  + '\\w+sponsored)$',
  'i',
);
const NOT_DISCLOSURE_TAG = py(
  '^(?:content|ugc|digital|video|food|beauty|fashion|lifestyle|tech|fitness|travel|'
  + 'small|black|female|latina|mom|dad|music|youtube|tiktok|instagram|reel|reels)?creators?$'
  + '|^(?:not|non|no|un)(?:an)?(?:sponsored|ad|ads|paid|partner|partnership)$',
  'i',
);
const DISCLOSURE_TEXT = py(
  '\\b(?:paid partnership|sponsored by|in partnership with|partnered with|partnering with|'
  + 'teamed up with|teaming up with|thanks to \\S+ for (?:sponsoring|partnering)|'
  + 'brought to you by|ad\\s*[|:]\\s|#ad\\b|gifted by|pr package|'
  + '(?:use|with) (?:my |the )?code\\b|discount code|promo code|affiliate|commission)',
  'i',
);
const SOFT_COMMERCIAL_TEXT = py(
  '\\b(?:link in (?:my )?bio|shop (?:now|my|the)|available (?:now )?at|get yours|'
  + 'pre-?order|now available|check out @?\\w+|go to \\w+\\.com)\\b',
  'i',
);
const SPOKEN_DISCLOSURE = py(
  "\\b(?:sponsored by|this (?:video|episode|reel) is (?:sponsored|brought to you) by|"
  + 'thanks to \\w+(?: \\w+)? for (?:sponsoring|partnering)|partnered with|in partnership with|'
  + '(?:use|with) (?:my |the )?code|discount code|promo code|link in (?:my )?bio|'
  + "paid partnership|today's sponsor|our sponsor)\\b",
  'i',
);
// A business the Reel features by name. Group 1 is the business name. Python's inline (?i:...)
// groups are spelled out as character classes (JavaScript has no inline flags before Node 23).
const FEATURE_PATTERNS = [
  py("\\b[Aa][Pp][Pp]\\s*[:\\-\\u2013]\\s*@?([\\w&']+(?:\\.\\w+)*(?: [A-Z][\\w&']+)?)"),
  py('\\bmade (?:in|with|using) @?([\\w.]+)', 'i'),
  py('\\b(?:made|created) (?:mine|it|this) (?:in|with|using) @?([\\w.]+)', 'i'),
  py('\\b(?:[Ii][Nn][Ss][Tt][Aa][Ll][Ll]|[Dd][Oo][Ww][Nn][Ll][Oo][Aa][Dd]) (?:[Tt][Hh][Ee] )?([A-Z][\\w.]+)'),
  py('\\b(?:[Ww][Ii][Tt][Hh]|[Uu][Ss][Ii][Nn][Gg]|[Oo][Nn]) ([A-Z][\\w.]+) (?:[Aa][Pp][Pp]|[Pp][Ll][Uu][Gg][Ii][Nn]|[Tt][Oo][Oo][Ll])\\b'),
  py('\\u{1F4CD}\\s*([^\\n#,|.]{2,40})'),
  py(
    "\\b((?:[A-Z][\\w'&]+ ){0,3}[A-Z][\\w'&]+) (?:is|are) an? (?:[\\w,-]+ ){0,8}"
    + '(?:restaurant|caf[eé]|bar|bakery|bistro|store|shop|boutique|brand|label|app|hotel|'
    + 'resort|salon|studio|gym|map|platform|website|service|company|startup)\\b',
  ),
];
const COMMENT_KEYWORD = py(
  '\\bcomment ["\'\\u201c\\u201d\\u2018\\u2019\\u00ab]?(\\w+)["\'\\u201c\\u201d\\u2018\\u2019\\u00bb]?'
  + ' (?:for|to get|and|below)',
  'i',
);
const NAMED_HASHTAG = py('#([A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]{2,})');
const VENUE = py("\\b((?:[A-Z][\\w'&]+ ){0,3}[A-Z][\\w'&]+) in ([A-Z][a-z]{3,})");
const NOT_A_BUSINESS = new Set([
  'best', 'here', 'this', 'the', 'my', 'our', 'your', 'new', 'top', 'first', 'episode', 'worth',
  'unlimited', 'food', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'india', 'london', 'nyc',
]);
const DOMAIN = py(
  '\\b(?:https?://)?(?:www\\.)?([a-z0-9][a-z0-9-]{1,40}\\.(?:com|in|co|io|ai|app|sh|shop|store|net|org|me|so|gg|tv|xyz)(?:\\.[a-z]{2})?)\\b',
  'i',
);
const PROPER = py('\\b([A-Z][a-zA-Z0-9]{2,}(?:[ .][A-Z][a-zA-Z0-9]{2,})?)\\b');
const NOT_A_NAME = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Here', 'There', 'And', 'But', 'You', 'Your', 'Its',
  'Our', 'They', 'What', 'When', 'Why', 'How', 'Who', 'Now', 'Then', 'Just', 'Also', 'Yes',
  'Okay', 'Hey', 'Hello', 'Thank', 'Thanks', 'Follow', 'Comment', 'Save', 'Share', 'Link',
  'Episode', 'Part', 'Day', 'Today', 'Instagram', 'Reel', 'Reels', 'Bio', 'Free', 'New', 'Made',
  'Best', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'India', 'Bangalore', 'Mumbai', 'Delhi', 'America', 'USA',
]);
const OCR_DISCLOSURE = py(
  '\\b(?:paid partnership|sponsored|#ad\\b|ad\\b|use code|promo code|partner(?:ed)? with)',
  'i',
);

const norm = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

// Domains and capitalised names in the caption, on-screen text and speech, most frequent first.
function mentionedNames(r, limit = 12) {
  const counts = new Map();
  const first = new Map();
  for (const text of [r.caption, r.ocr_text, r.transcript || '']) {
    for (const m of finditer(DOMAIN, text)) {
      const name = m[1].toLowerCase();
      counts.set(name, (counts.get(name) || 0) + 3);
      if (!first.has(name)) first.set(name, 'domain');
    }
    for (const m of finditer(PROPER, text)) {
      const name = m[1];
      const before = rstrip(text.slice(0, m.index), ' \t"\u201c\'*');
      if (!before || '.!?:\n'.includes(before[before.length - 1]) || NOT_A_NAME.has(split(name)[0])) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
      if (!first.has(name)) first.set(name, 'mentioned_name');
    }
  }
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, limit);
  return ranked.map((n) => [n, first.get(n)]);
}

// Businesses named in the caption or speech: [name, source]. Candidates for P4, not labels.
function namedBusinesses(r) {
  const found = [];
  for (const [text, source] of [[r.caption, 'named_in_caption'], [r.transcript || '', 'named_in_speech']]) {
    for (const pat of FEATURE_PATTERNS) {
      for (const m of finditer(pat, text)) found.push([strip(m[1], " .'"), source]);
    }
  }
  for (const m of finditer(VENUE, r.caption)) {
    const name = strip(m[1]);
    if (!NOT_A_BUSINESS.has(split(name)[0].toLowerCase()) && !NOT_A_BUSINESS.has(name.toLowerCase())) {
      found.push([name, 'venue_in_caption']);
    }
  }
  const seen = [];
  const out = [];
  for (const [name, source] of found) {
    const key = norm(name);
    if (key.length >= 3 && !seen.some((k) => k.startsWith(key) || key.startsWith(k))) {
      seen.push(key);
      out.push([name, source]);
    }
  }
  return out;
}

// Lower-cased words the viewer is asked to comment ('Comment TEAM for the deets').
function codeWords(r) {
  const out = new Set();
  for (const text of [r.caption, r.ocr_text, r.transcript || '']) {
    for (const m of finditer(COMMENT_KEYWORD, text)) out.add(m[1].toLowerCase());
  }
  return out;
}

// Words the speech says as a name of its own ('Compose on Morphic' -> morphic).
function spokenNames(r) {
  const out = new Set();
  const text = r.transcript || '';
  for (const m of finditer(py('\\b[A-Z][a-z][\\w]*\\b'), text)) {
    const before = rstrip(text.slice(0, m.index));
    const parts = split(before);
    const prev = parts.length ? parts[parts.length - 1] : '';
    if (before && !'.!?:'.includes(before[before.length - 1]) && !isUpper(prev.slice(0, 1))) {
      out.add(m[0].toLowerCase());
    }
  }
  return out;
}

// Hashtags the caption writes with capitals, as written: brand, app or product candidates.
function hashtagNames(r) {
  const out = [];
  for (const m of finditer(NAMED_HASHTAG, r.caption)) {
    const name = m[1];
    if (name.length >= 3 && name.length <= 14 && !NOT_A_NAME.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function stage1(r) {
  const out = [];
  if (r.paid_partnership) out.push(signal(1, 'paid_partnership_label', STRONG, 'Instagram paid partnership label'));
  for (const tag of r.hashtags) {
    if (new RegExp(DISCLOSURE_TAG.source, 'iu').test(tag) && !new RegExp(NOT_DISCLOSURE_TAG.source, 'iu').test(tag)) {
      out.push(signal(1, 'disclosure_hashtag', STRONG, `#${tag}`));
    }
  }
  if (coauthored(r)) out.push(signal(1, 'collab_post_owner', WEAK, r.owner));
  for (const acct of otherAccounts(r)) if (acct !== r.owner) out.push(signal(1, 'account_tagged_or_mentioned', WEAK, acct));
  return out;
}

function stage2(r) {
  const out = [];
  for (const m of finditer(DISCLOSURE_TEXT, r.caption)) out.push(signal(2, 'caption_disclosure_phrase', MEDIUM, cut(m[0], 60)));
  for (const m of finditer(SOFT_COMMERCIAL_TEXT, r.caption)) out.push(signal(2, 'caption_commercial_phrase', WEAK, cut(m[0], 60)));
  for (const m of finditer(OCR_DISCLOSURE, r.ocr_text)) out.push(signal(2, 'on_screen_disclosure', MEDIUM, cut(m[0], 60)));
  return out;
}

function stage3(r) {
  if (!r.transcript) return [];
  return finditer(SPOKEN_DISCLOSURE, r.transcript).map((m) => signal(3, 'spoken_disclosure', MEDIUM, cut(m[0], 60)));
}

function featured(r) {
  return [
    ...namedBusinesses(r).map(([name, source]) => signal(
      source === 'named_in_speech' ? 3 : 2,
      'featured_business',
      source === 'venue_in_caption' ? WEAK : MEDIUM,
      cut(name, 60),
    )),
    ...[...codeWords(r)].sort().map((w) => signal(2, 'comment_for_link', MEDIUM, cut(w, 60))),
  ];
}

function signals(r) {
  return [...stage1(r), ...stage2(r), ...stage3(r), ...featured(r)];
}

// 'wholefoodspartner' -> 'wholefoods' (a brand-name candidate, matched to accounts later).
function brandFromHashtag(tag) {
  const m = /^([\p{L}\p{N}_]+?)(?:partner|ambassador|creator|sponsored)$/iu.exec(tag);
  if (!m || ['paidpartner', 'brandpartner'].includes(tag.toLowerCase())) return null;
  return m[1].length >= 3 ? m[1].toLowerCase() : null;
}

function strongest(sig) {
  for (const s of [STRONG, MEDIUM, WEAK]) if (sig.some((x) => x.strength === s)) return s;
  return null;
}

module.exports = {
  STRONG, MEDIUM, WEAK,
  mentionedNames, namedBusinesses, codeWords, spokenNames, hashtagNames,
  stage1, stage2, stage3, featured, signals, brandFromHashtag, strongest, norm,
};
