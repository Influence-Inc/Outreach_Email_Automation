'use strict';

// Automated CPM + creator rate estimation, ported from the influence-creator-list
// repo (services/enrichment/enrichment/economics/estimated_cpm.py, market.py and
// fee.py's "estimated_cpm" method; the bio word matcher is apps/bench/topics.mjs).
// The reference tables in ./cpmReference are copied verbatim from
// services/enrichment/reference so the two repos price a creator identically —
// re-copy them, don't edit them here.
//
//   Estimated CPM = topic base range   (niche -> its group -> parent topic -> its group
//                                       -> average of all groups)
//                 x country index      (country -> region -> tier -> default market)
//                 x clamp(size x format x genre x brands, 0.5, 2.0)
//
//   Estimated rate = the creator's own fees (accepted single-Reel offers, else quoted rates,
//                    last 18 months), else expected ad views / 1000 x Estimated CPM
//
// The inputs come from the creator's analysed Reels (services/reelAnalysis, creator-list's
// P1-P5 pipeline: Apify -> OCR + Whisper -> Jev): every Reel's topic / niche / genre / format,
// the brand deals detected and their brands' sizes, Instagram's "Account based in" country,
// and the views behind P6-P9. Until a creator's Reels are analysed, the topic is read from the
// words of the Instagram bio and category (each matched word standing in for one labelled
// Reel) and the country from the bio. An admin can set the topic, country or CPM by hand.

const path = require('path');

const REF = path.join(__dirname, 'cpmReference');
// eslint-disable-next-line import/no-dynamic-require, global-require
const load = (f) => require(path.join(REF, f));

const BENCHMARKS = load('cpm_benchmarks.json');
const FACTORS = load('cpm_factors.json');
const MARKET = load('cpm_market_index.json');
const COUNTRY_CODES = load('country_codes.json');
const TOPIC_RULES = load('creator_topics.json');
const PARENTS = load('content_taxonomy.json').questions.niche.parents;

const IGNORED = new Set(['unclear', 'other', '']);
const FORMULA = 'topic_base x country x clamp(size x format x genre x brands, 0.5, 2.0)';

const isIgnored = (v) => v == null || IGNORED.has(v);
// Python's str.capitalize(): first letter upper, the rest lower.
const label = (key) => {
  const s = String(key).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};
const round = (x, nd) => Number(x.toFixed(nd));
// f"{round(n):,}" — Python rounds half to even (277,734.5 -> 277,734).
const fmtInt = (n) => require('./reelAnalysis/pyre').pyRound(n).toLocaleString('en-US'); // eslint-disable-line global-require

// --- Main value of a set of labels (estimated_cpm._main) ----------------------------------

// [main value or null when mixed, counts (insertion-ordered Map), total]. Ties keep the
// first-seen value, as Python's Counter.most_common does.
function mainOf(values, shareMin) {
  const counts = new Map();
  for (const v of values) if (!isIgnored(v)) counts.set(v, (counts.get(v) || 0) + 1);
  let total = 0;
  let top = null;
  let n = 0;
  for (const [k, c] of counts) {
    total += c;
    if (c > n) {
      top = k;
      n = c;
    }
  }
  if (!total) return [null, counts, 0];
  return [n / total >= shareMin ? top : null, counts, total];
}

const mostCommon = (counts, k) =>
  [...counts.entries()].map((e, i) => [...e, i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, k);

function weighted(parts) {
  const n = parts.reduce((a, [, w]) => a + w, 0);
  return [
    round(parts.reduce((a, [r, w]) => a + r[0] * w, 0) / n, 4),
    round(parts.reduce((a, [r, w]) => a + r[1] * w, 0) / n, 4),
  ];
}

// --- Topic: the base range ----------------------------------------------------------------

function groupRow(group) {
  const b = BENCHMARKS.benchmarks.find((x) => x.id === group);
  return b ? { range: [b.low, b.high], label: b.niche_group, source: `${b.id} (${BENCHMARKS.version})` } : null;
}

function topicRow(topic) {
  const own = (FACTORS.topic.own_rows || {})[topic];
  if (own) return { range: [Number(own.low), Number(own.high)], level: 'topic', label: label(topic), source: own.source };
  const row = groupRow((FACTORS.topic.groups || {})[topic]);
  return row ? { range: row.range, level: 'group', label: row.label, source: row.source } : null;
}

function nicheRow(niche) {
  const own = (FACTORS.topic.own_rows || {})[niche];
  if (own) return { range: [Number(own.low), Number(own.high)], level: 'niche', label: label(niche), source: own.source };
  const g = groupRow((FACTORS.topic.niche_groups || {})[niche]);
  if (g) return { range: g.range, level: 'niche group', label: `${label(niche)} → ${g.label}`, source: g.source };
  const parent = PARENTS[niche];
  const p = parent ? topicRow(parent) : null;
  if (p) {
    const chain = `${label(niche)} → ${label(parent)}${p.level === 'group' ? ` → ${p.label}` : ''}`;
    return { range: p.range, level: p.level, label: chain, source: p.source };
  }
  return null;
}

// A labelled item's niche when it belongs to its topic (creator_topics.niche_of).
function nicheOf(topic, niche) {
  if (isIgnored(niche)) return null;
  if (isIgnored(topic)) return niche;
  return PARENTS[niche] === topic ? niche : null;
}

const itemTopic = (c) => (!isIgnored(c.topic) ? c.topic : PARENTS[c.niche || ''] || null);

function allGroups() {
  const rows = BENCHMARKS.benchmarks;
  return [
    round(rows.reduce((a, b) => a + b.low, 0) / rows.length, 4),
    round(rows.reduce((a, b) => a + b.high, 0) / rows.length, 4),
  ];
}

// `content` is [{topic, niche}], one entry per labelled item; `unit` names the items in the
// evidence ("Reels" in creator-list, "profile keywords" here).
function topicSticker(content, unit = 'Reels') {
  const avg = allGroups();
  const avgSrc = `average of all niche groups (${BENCHMARKS.version})`;
  const sticker = (value, lbl, level, range, source, evidence) => ({
    name: 'topic', value, label: lbl, level, low: range[0], high: range[1], source, evidence,
  });

  let [niche, nCounts, nTotal] = mainOf(content.map((c) => nicheOf(c.topic, c.niche)), FACTORS.main_share_min);
  const mainTopic = mainOf(content.map(itemTopic), FACTORS.main_share_min)[0];
  if (niche != null && mainTopic && PARENTS[niche] !== mainTopic) niche = null;
  if (niche != null) {
    const row = nicheRow(niche);
    const evidence = `${nCounts.get(niche)} of ${nTotal} ${unit}`;
    if (!row) return sticker(niche, `${label(niche)} (no niche group)`, 'all', avg, avgSrc, evidence);
    return sticker(niche, row.label, row.level, row.range, row.source, evidence);
  }

  const [main, counts, total] = mainOf(content.map(itemTopic), FACTORS.main_share_min);
  if (!total) return sticker(null, 'No topic detected', 'all', avg, avgSrc, `no ${unit.replace(/s$/, '')} had a clear topic`);
  if (main != null) {
    const row = topicRow(main);
    const evidence = `${counts.get(main)} of ${total} ${unit}`;
    if (!row) return sticker(main, `${label(main)} (no niche group)`, 'all', avg, avgSrc, evidence);
    const lbl = row.level === 'group' ? `${label(main)} → ${row.label}` : row.label;
    return sticker(main, lbl, row.level, row.range, row.source, evidence);
  }
  const parts = [...counts.entries()].map(([t, n]) => {
    const row = topicRow(t);
    return [row ? row.range : avg, n];
  });
  const mix = mostCommon(counts, 4).map(([t, n]) => `${label(t)} ${n}`).join(', ');
  return sticker('mixed', 'Mixed topics', 'mixed', weighted(parts), BENCHMARKS.version,
    `no topic in ${Math.round(FACTORS.main_share_min * 100)}% of ${unit} (${mix})`);
}

// --- Country (market.py) ------------------------------------------------------------------

const INDEX_LEVELS = [
  ['country', Object.fromEntries(Object.entries(MARKET.countries).map(([k, v]) => [k, { ...v, countries: [k] }]))],
  ['region', MARKET.regions],
  ['tier', MARKET.tiers],
];

function percentile(values, q) {
  const xs = [...values].sort((a, b) => a - b);
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return lo + 1 >= xs.length ? xs[lo] : xs[lo] + (xs[lo + 1] - xs[lo]) * frac;
}

// An unknown market: the 25th percentile of the sourced country and region lows to the
// 75th percentile of their highs — never the US price.
function defaultMarket() {
  const rows = [...Object.values(MARKET.countries), ...Object.values(MARKET.regions)];
  return [round(percentile(rows.map((r) => r.low), 0.25), 3), round(percentile(rows.map((r) => r.high), 0.75), 3)];
}

const COUNTRY_NAMES = {
  US: 'United States', GB: 'United Kingdom', IN: 'India', SG: 'Singapore', AE: 'United Arab Emirates',
  VN: 'Vietnam', ID: 'Indonesia', PH: 'Philippines', TH: 'Thailand', MY: 'Malaysia', BR: 'Brazil',
  MX: 'Mexico', CA: 'Canada', AU: 'Australia', DE: 'Germany', FR: 'France', NL: 'Netherlands',
  ES: 'Spain', IT: 'Italy', JP: 'Japan', KR: 'South Korea', SA: 'Saudi Arabia', PK: 'Pakistan',
  BD: 'Bangladesh', NG: 'Nigeria',
};

function countryName(code) {
  if (!code) return null;
  return COUNTRY_NAMES[code] || COUNTRY_CODES.codes[code] || null;
}

function resolveMarket(country) {
  const code = country ? String(country).toUpperCase() : null;
  if (code) {
    for (const [level, rows] of INDEX_LEVELS) {
      for (const [key, row] of Object.entries(rows)) {
        if ((row.countries || []).includes(code)) {
          const src = MARKET.sources[row.source] || {};
          return {
            country: code, level, key, name: row.name, low: row.low, high: row.high,
            source: row.source, source_url: src.url || null, table_version: MARKET.version,
          };
        }
      }
    }
  }
  const [low, high] = defaultMarket();
  const where = code ? `no CPM data for ${countryName(code) || code}` : 'market unknown';
  return {
    country: code, level: 'default', key: null, name: `${where}: middle of the sourced markets`,
    low, high, source: 'default', source_url: null, table_version: MARKET.version,
  };
}

// Country names and well-known places, matched as whole words in a lowercased bio. Short or
// ambiguous names are left out on purpose: a wrong market is worse than an unknown one.
const PLACES = {
  US: ['usa', 'united states', 'new york', 'nyc', 'los angeles', 'san francisco', 'chicago', 'miami', 'austin', 'seattle', 'boston', 'brooklyn'],
  GB: ['uk', 'united kingdom', 'england', 'london', 'manchester', 'scotland'],
  IN: ['india', 'delhi', 'new delhi', 'mumbai', 'bombay', 'bangalore', 'bengaluru', 'blr', 'hyderabad', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'jaipur', 'gurgaon', 'gurugram', 'noida', 'kochi', 'chandigarh', 'lucknow', 'goa', 'kerala'],
  SG: ['singapore'],
  AE: ['uae', 'dubai', 'abu dhabi'],
  VN: ['vietnam', 'viet nam', 'hanoi', 'ha noi', 'saigon', 'ho chi minh'],
  ID: ['indonesia', 'jakarta', 'bali'],
  PH: ['philippines', 'manila'],
  TH: ['thailand', 'bangkok'],
  MY: ['malaysia', 'kuala lumpur'],
  BR: ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio de janeiro'],
  MX: ['mexico', 'méxico', 'cdmx'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal'],
  AU: ['australia', 'sydney', 'melbourne'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg'],
  FR: ['france', 'paris'],
  NL: ['netherlands', 'amsterdam'],
  ES: ['spain', 'españa', 'madrid', 'barcelona'],
  IT: ['italy', 'italia', 'milan', 'milano', 'rome'],
  JP: ['japan', 'tokyo', 'osaka'],
  KR: ['korea', 'seoul'],
  SA: ['saudi arabia', 'riyadh', 'jeddah'],
  PK: ['pakistan', 'karachi', 'lahore'],
  BD: ['bangladesh', 'dhaka'],
  NG: ['nigeria', 'lagos'],
  PL: ['warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk', 'gdańsk'],
  CZ: ['prague', 'praha', 'brno'],
  SK: ['bratislava', 'košice', 'kosice'],
  UA: ['kyiv', 'kiev', 'kharkiv', 'odesa', 'odessa', 'lviv'],
  RU: ['moscow', 'москва', 'st petersburg', 'saint petersburg'],
  HU: ['budapest'],
  RO: ['bucharest', 'bucurești', 'cluj'],
  RS: ['belgrade', 'beograd'],
  HR: ['zagreb', 'split croatia'],
  AT: ['vienna', 'wien', 'salzburg'],
  CH: ['zurich', 'zürich', 'geneva', 'genève', 'basel'],
  BE: ['brussels', 'bruxelles', 'antwerp'],
  IE: ['dublin', 'cork ireland'],
  PT: ['lisbon', 'lisboa'],
  GR: ['athens', 'αθήνα', 'thessaloniki'],
  SE: ['stockholm', 'gothenburg', 'göteborg'],
  NO: ['oslo', 'bergen norway'],
  DK: ['copenhagen', 'københavn'],
  FI: ['helsinki'],
  TR: ['türkiye', 'istanbul', 'i̇stanbul', 'ankara', 'izmir', 'antalya'],
  IL: ['tel aviv', 'jerusalem'],
  EG: ['cairo', 'alexandria egypt'],
  MA: ['casablanca', 'marrakech', 'marrakesh', 'rabat'],
  KE: ['nairobi', 'mombasa'],
  GH: ['accra', 'kumasi'],
  ZA: ['south africa', 'johannesburg', 'joburg', 'cape town', 'durban', 'pretoria'],
  AR: ['buenos aires', 'córdoba argentina'],
  CO: ['bogota', 'bogotá', 'medellin', 'medellín', 'cali colombia'],
  QA: ['doha'],
  OM: ['muscat'],
  JO: ['amman'],
  LB: ['beirut'],
  LK: ['sri lanka', 'colombo'],
  NP: ['kathmandu'],
  CN: ['beijing', 'shanghai', 'shenzhen', 'guangzhou'],
  HK: ['hong kong'],
  TW: ['taipei'],
  NZ: ['new zealand', 'auckland'],
  KZ: ['almaty', 'astana'],
  UZ: ['tashkent'],
};

// Country names that are also everyday words or names, left out of the bio match on purpose.
const AMBIGUOUS_NAMES = new Set(['georgia', 'jordan', 'chad', 'jersey', 'guinea', 'niger', 'turkey', 'mali', 'congo']);

// Python's \w and \b are Unicode-aware; JS's are ASCII-only even with /u, so spell them out.
const W = '[\\p{L}\\p{N}_]';
const WB = `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function allPlaces() {
  const out = new Map(Object.entries(PLACES).map(([code, places]) => [code, [...places]]));
  const names = [
    ...Object.entries(COUNTRY_CODES.codes).map(([c, n]) => [n, c]),
    ...Object.entries(COUNTRY_CODES.aliases),
  ];
  for (const [name, code] of names) {
    const n = name.toLowerCase();
    if (/[&()]/.test(n) || ` ${n} `.includes(' sar ') || AMBIGUOUS_NAMES.has(n)) continue;
    if (!out.has(code)) out.set(code, []);
    const list = out.get(code);
    if ([...n].length > 3 && !list.includes(n)) list.push(n);
  }
  return out;
}

const PLACE_RE = [...allPlaces()].map(([code, places]) => [
  code,
  new RegExp(`(?<![\\p{L}\\p{N}_@.])(${places.map(escapeRe).join('|')})(?!${W})`, 'gu'),
]);
const HANDLE_OR_URL = new RegExp(
  `@[\\p{L}\\p{N}_.]+|https?://\\S+|${WB}[\\p{L}\\p{N}_.-]+\\.(?:com|in|co|io|me|ai|link)\\S*`,
  'gu',
);
const PIN = '\u{1F4CD}';
const KNOWN_CODES = new Set(Object.keys(COUNTRY_CODES.codes));

// ISO codes of flag emojis (pairs of regional indicator symbols), in order.
function flags(text) {
  const out = [];
  let pending = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      const letter = String.fromCharCode(cp - 0x1f1e6 + 65);
      if (pending == null) pending = letter;
      else {
        out.push(pending + letter);
        pending = null;
      }
    } else pending = null;
  }
  return out;
}

function places(text) {
  const found = [];
  for (const [code, rx] of PLACE_RE) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) found.push([m.index, code, m[1]]);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return found.sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]) || cmp(a[2], b[2]));
}

// A country from an Instagram bio, or unknown. Order: a flag, a place after 📍, the only place
// named. Two different countries named without a flag or pin -> unknown.
function countryFromBio(bio) {
  if (!bio) return { country: null, source: 'unknown', evidence: null };
  const fl = flags(String(bio)).filter((f) => KNOWN_CODES.has(f));
  if (new Set(fl).size === 1) return { country: fl[0], source: 'bio', evidence: `flag ${fl[0]}` };
  const text = String(bio).replace(HANDLE_OR_URL, ' ').normalize('NFC').toLowerCase();
  if (text.includes(PIN)) {
    const after = [...text.split(PIN).slice(1).join(PIN)].slice(0, 40).join('');
    const hits = places(after);
    if (hits.length) return { country: hits[0][1], source: 'bio', evidence: `📍 ${hits[0][2]}` };
  }
  const hits = places(text);
  if (new Set(hits.map((h) => h[1])).size === 1) {
    return { country: hits[0][1], source: 'bio', evidence: hits[0][2] };
  }
  return { country: null, source: 'unknown', evidence: null };
}

// --- Topic from profile words (apps/bench/topics.mjs + query.mjs) -------------------------

const tokens = (text) => String(text == null ? '' : text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const SUFFIXES = ['ings', 'ing', 'ers', 'ors', 'er', 'or', 'ed', 'es', 's'];

// A word's stem: editing/editor/edits -> edit. Stems are at least 4 letters.
function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  for (const s of SUFFIXES) {
    if (!w.endsWith(s) || w.length - s.length < 4) continue;
    if (s === 's' && /(ss|us|is)$/.test(w)) continue;
    if (s === 'es' && !/(ss|sh|ch|x|z)es$/.test(w)) continue;
    return w.slice(0, -s.length);
  }
  return w;
}

let WORDS = null;
// stem -> {kind, key, topic}: topic and genre words, then the words of niche names (a niche
// is more specific than its topic; a word in niches of several topics names none of them).
function words() {
  if (WORDS) return WORDS;
  WORDS = new Map();
  const genre = new Set();
  const lbl = (kind, key) => ({ kind, key, topic: kind === 'topic' ? key : kind === 'niche' ? PARENTS[key] : null });
  for (const [kind, table] of [['topic', TOPIC_RULES.topics], ['genre', TOPIC_RULES.genres]]) {
    for (const [key, r] of Object.entries(table)) {
      for (const w of r.words) {
        WORDS.set(stem(w), lbl(kind, key));
        if (kind === 'genre') genre.add(stem(w));
      }
    }
  }
  const skip = new Set(TOPIC_RULES.not_niche.map(stem));
  const niches = new Map();
  for (const key of Object.keys(PARENTS)) {
    for (const w of new Set(tokens(key.replace(/_/g, ' ')))) {
      const s = stem(w);
      if (w.length < 3 || skip.has(s) || genre.has(s)) continue;
      niches.set(s, [...(niches.get(s) || []), key]);
    }
  }
  for (const [s, keys] of niches) {
    const parents = new Set(keys.map((k) => PARENTS[k]));
    if (keys.length === 1) WORDS.set(s, lbl('niche', keys[0]));
    else if (parents.size === 1) WORDS.set(s, lbl('topic', [...parents][0]));
  }
  return WORDS;
}

const labelOf = (word) => words().get(stem(String(word).toLowerCase())) || null;

// The topic/niche labels named in a creator's Instagram category and bio — one entry per
// distinct matched word, standing in for the per-Reel labels creator-list's model produces.
function contentFromProfile({ bio, category } = {}) {
  const seen = new Set();
  const out = [];
  for (const w of [...tokens(category), ...tokens(bio)]) {
    const l = labelOf(w);
    if (!l || l.kind === 'genre' || seen.has(stem(w))) continue;
    seen.add(stem(w));
    out.push({ topic: l.topic, niche: l.kind === 'niche' ? l.key : null, word: w });
  }
  return out;
}

// --- The other stickers -------------------------------------------------------------------

const factor = (raw) => (raw == null ? null : typeof raw === 'number' ? [raw, raw] : [Number(raw[0]), Number(raw[1])]);

// `views` is a typical-views Derived ({value, method}) or a plain number (median recent views).
function sizeSticker(views) {
  const v = views != null && typeof views === 'object' ? Number(views.value) : Number(views);
  if (!(v > 0)) {
    return { name: 'size', value: null, label: 'Typical views unknown', level: 'none', low: 1, high: 1, source: null, evidence: 'not enough Reels with views' };
  }
  const tiers = FACTORS.size.tiers;
  const tier = tiers.find((t) => t.max_views == null || v < t.max_views) || tiers[tiers.length - 1];
  const fac = factor(tier.factor);
  const basis = views && typeof views === 'object' && String(views.method || '').startsWith('median_last') ? 'typical views' : 'median recent views';
  return {
    name: 'size', value: tier.key, label: tier.name, level: fac ? 'tier' : 'none',
    low: fac ? fac[0] : 1, high: fac ? fac[1] : 1, source: fac ? FACTORS.version : null,
    evidence: `${fmtInt(v)} ${basis}`,
  };
}

// A format's or genre's own factor, else its family's (e.g. tips_hacks -> informative).
function familyFactor(table, name, value) {
  const own = factor((table.values || {})[value]);
  if (own) return [own, name];
  for (const fam of Object.values(table.families || {})) {
    const fac = fam.members.includes(value) ? factor(fam.factor) : null;
    if (fac) return [fac, 'family'];
  }
  return null;
}

// estimated_cpm._attribute_sticker: the creator's main format (or genre) across their Reels.
function attributeSticker(name, values) {
  const lookup = (v) => familyFactor(FACTORS[name], name, v);
  const [main, counts, total] = mainOf(values, FACTORS.main_share_min);
  if (!total) {
    return { name, value: null, label: `No ${name} detected`, level: 'none', low: 1, high: 1, source: null, evidence: `no Reel had a clear ${name}` };
  }
  if (main != null) {
    const hit = lookup(main);
    return {
      name, value: main, label: label(main), level: hit ? hit[1] : 'none',
      low: hit ? hit[0][0] : 1, high: hit ? hit[0][1] : 1, source: hit ? FACTORS.version : null,
      evidence: `${counts.get(main)} of ${total} Reels`,
    };
  }
  let anyData = false;
  const parts = [...counts.entries()].map(([v, n]) => {
    const hit = lookup(v);
    anyData = anyData || hit != null;
    return [hit ? hit[0] : [1, 1], n];
  });
  const [lo, hi] = weighted(parts);
  const mix = mostCommon(counts, 4).map(([v, n]) => `${label(v)} ${n}`).join(', ');
  return {
    name, value: 'mixed', label: `Mixed ${name}s`, level: anyData ? 'mixed' : 'none', low: lo, high: hi,
    source: anyData ? FACTORS.version : null,
    evidence: `no ${name} in ${Math.round(FACTORS.main_share_min * 100)}% of Reels (${mix})`,
  };
}

// estimated_cpm.brands_sticker. `deals` = [{brand, followers}] for the brand deals detected in
// the creator's recent Reels; null = brand deals not checked.
function brandsSticker(deals) {
  const cfg = FACTORS.brands;
  const threshold = Number(cfg.major_min_followers);
  if (deals == null) return { name: 'brands', value: null, label: 'Brand deals not checked', level: 'none', low: 1, high: 1, source: null, evidence: null };
  const named = deals.filter((d) => d.brand);
  const major = [...new Set(named.filter((d) => d.followers != null && d.followers >= threshold).map((d) => d.brand))].sort();
  let key;
  let lbl;
  let evidence = null;
  if (major.length) {
    [key, lbl] = ['major', 'Worked with major brands'];
    evidence = major.slice(0, 4).join(', ') + (major.length > 4 ? ` +${major.length - 4}` : '');
  } else if (deals.length && !named.length) {
    [key, lbl, evidence] = ['unknown', 'Brands not identified', `${deals.length} brand deals`];
  } else if (named.length && named.every((d) => d.followers == null)) {
    [key, lbl] = ['unknown', 'Brand sizes not looked up'];
  } else if (named.length) {
    [key, lbl] = ['other', 'Smaller brands only'];
    evidence = `${new Set(named.map((d) => d.brand)).size} brands, none with ${fmtInt(threshold)}+ followers`;
  } else {
    [key, lbl] = ['none', 'No brand deals detected'];
  }
  const fac = factor((cfg.tiers || {})[key]);
  const provisional = (cfg.provisional || []).includes(key);
  return {
    name: 'brands', value: key, label: lbl,
    level: fac ? (provisional ? 'provisional' : 'brand_tier') : 'none',
    low: fac ? fac[0] : 1, high: fac ? fac[1] : 1, source: fac ? FACTORS.version : null, evidence,
  };
}

// --- Estimated CPM ------------------------------------------------------------------------

// estimated_cpm.estimate_cpm. `content` = [{topic, niche}]; `market` = resolveMarket(...).
// `content` = [{topic, niche, format, genre}], one per labelled Reel; `typicalViews` = the
// typical-views Derived (or a number); `brandDeals` = [{brand, followers}] or null.
function estimateCpm({ content = [], unit = 'Reels', market, countryEvidence = null, typicalViews = null, brandDeals = null, topicSticker: topicOverride = null }) {
  const topic = topicOverride || topicSticker(content, unit);
  const country = {
    name: 'country', value: market.country, label: market.name, level: market.level,
    low: market.low, high: market.high, source: market.source_url || market.source, evidence: countryEvidence,
  };
  const rest = [
    sizeSticker(typicalViews),
    attributeSticker('format', content.map((c) => c.format)),
    attributeSticker('genre', content.map((c) => c.genre)),
    brandsSticker(brandDeals),
  ];
  const [capLo, capHi] = FACTORS.combined_cap;
  const clamp = (x) => Math.min(Math.max(x, capLo), capHi);

  let rawLo = 1;
  let rawHi = 1;
  let rawMid = 1;
  for (const s of rest) {
    rawLo *= s.low;
    rawHi *= s.high;
    rawMid *= (s.low + s.high) / 2;
  }
  const comb = [clamp(rawLo), clamp(rawHi)];
  const capped = comb[0] !== rawLo || comb[1] !== rawHi;
  const low = round(topic.low * country.low * comb[0], 2);
  const high = round(topic.high * country.high * comb[1], 2);
  // Middle = product of the middles ($20 x 0.225 x ...), not the middle of the range.
  const mid = ((topic.low + topic.high) / 2) * ((country.low + country.high) / 2) * clamp(rawMid);

  const notes = [];
  if (country.level === 'default') notes.push(`country: ${country.label} (not the US price)`);
  if (topic.level === 'all' || topic.level === 'mixed') notes.push(`topic: ${topic.label.toLowerCase()}, so an average of niche groups is used`);
  const noData = rest.filter((s) => s.level === 'none').map((s) => s.name);
  const assumed = rest.filter((s) => s.level === 'provisional').map((s) => s.name);
  if (assumed.length) notes.push(`${assumed.join(', ')}: a provisional number set by INFLUENCE, not measured`);
  if (noData.length) notes.push(`no data yet for ${noData.join(', ')}: 1.0 (filled from campaigns later)`);
  if (capped) notes.push(`size x format x genre x brands capped to ${capLo}-${capHi}`);

  return {
    metric: 'estimated_cpm',
    value: round(mid, 4),
    low,
    high,
    unit: 'cpm',
    currency: 'USD',
    confidence: 'low',
    method: 'sticker_hierarchy',
    formula: FORMULA,
    stickers: [topic, country, ...rest],
    combined_factor: [round(comb[0], 4), round(comb[1], 4)],
    capped,
    tables: { factors: FACTORS.version, market: MARKET.version, benchmarks: BENCHMARKS.version },
    notes,
  };
}

// fee.py, "estimated_cpm" method: expected ad views / 1000 x Estimated CPM (low / mid / high).
function estimateRate(cpm, adViews) {
  const v = Number(adViews);
  if (!cpm || !(v > 0)) return null;
  const lo = cpm.low != null ? cpm.low : cpm.value;
  const hi = cpm.high != null ? cpm.high : cpm.value;
  return {
    metric: 'estimated_fee',
    value: round((v / 1000) * cpm.value, 2),
    low: round((v / 1000) * lo, 2),
    high: round((v / 1000) * hi, 2),
    unit: 'fee_per_deliverable',
    currency: cpm.currency,
    confidence: 'low',
    method: 'estimated_cpm',
    formula: 'expected_ad_views / 1000 * estimated_cpm (low / mid / high)',
  };
}

// --- Country of the creator (market.creator_country) ---------------------------------------

const fold = (name) => String(name).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
let countryLookup = null;
// ISO code for a country name ('Vietnam' -> 'VN', 'United States' -> 'US'), or null.
function countryCode(name) {
  if (!name) return null;
  const t = String(name).trim();
  if (/^[A-Za-z]{2}$/.test(t)) return KNOWN_CODES.has(t.toUpperCase()) ? t.toUpperCase() : null;
  if (!countryLookup) {
    countryLookup = new Map(Object.entries(COUNTRY_CODES.codes).map(([code, n]) => [fold(n), code]));
    for (const [n, code] of Object.entries(COUNTRY_CODES.aliases || {})) countryLookup.set(fold(n), code);
  }
  return countryLookup.get(fold(t)) || null;
}

// Best evidence first: reported (here: set by the admin), Instagram's "Account based in", the
// bio, unknown.
function creatorCountry(reported, bio, instagram) {
  if (reported) return { country: String(reported).toUpperCase(), source: 'admin', evidence: 'set by admin' };
  const code = countryCode(instagram);
  if (code) return { country: code, source: 'instagram', evidence: `Account based in ${instagram}` };
  return countryFromBio(bio);
}

// --- Deal Studio: one creator row ---------------------------------------------------------

const TOPIC_KEYS = Object.keys(TOPIC_RULES.topics);
const isTopicKey = (k) => TOPIC_KEYS.includes(k) || Object.prototype.hasOwnProperty.call(PARENTS, k);
const isCountryCode = (c) => KNOWN_CODES.has(String(c || '').toUpperCase());

// Lazily required: reelAnalysis/economics has no dependency back on this file.
const econ = () => require('./reelAnalysis/economics'); // eslint-disable-line global-require

const analysisOf = (row) => {
  let a = row && row.reel_analysis;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  return a && Array.isArray(a.reels) && a.reels.length ? a : null;
};

// The analysed Reels as the economics see them: views = plays, observed when collected, and the
// commercial status P3 decided (COLLABORATED -> sponsored, NOT_COLLABORATED -> organic).
function postsOf(analysis) {
  const observed = new Date(analysis.as_of);
  return analysis.reels.filter((p) => p.published_at).map((p) => ({
    post_id: p.post_id,
    published_at: new Date(p.published_at),
    views: Number.isFinite(p.plays) ? p.plays : null,
    views_observed_at: observed,
    status: econ().STATUS[p.p3.decision] || 'UNKNOWN',
    classification_confidence: 1,
  }));
}

const contentOf = (analysis) => analysis.reels.map((p) => {
  const a = p.p5 || {};
  const v = (k) => (a[k] ? a[k].value : null);
  return { topic: v('topic'), niche: v('niche'), genre: v('genre'), format: v('format') };
});

// Detected brand deals (P3) with the brand (P4) and its follower count, when looked up.
const brandDealsOf = (analysis) => analysis.reels
  .filter((p) => p.p3.decision === 'COLLABORATED')
  .map((p) => {
    const b = (p.p4 && p.p4.sponsor_brand) || '';
    const key = b.toLowerCase().replace(/^@/, '');
    const size = (analysis.brand_sizes || {})[key];
    return { brand: b, followers: b && size != null ? Number(size) : null };
  });

// Shares of each label across the analysed Reels ('unclear' and 'other' left out).
function shares(values) {
  const kept = values.filter((v) => !isIgnored(v));
  const counts = new Map();
  for (const v of kept) counts.set(v, (counts.get(v) || 0) + 1);
  return mostCommon(counts, 50).map(([k, n]) => ({ key: k, label: label(k), share: round(n / kept.length, 2) }));
}

// Without analysed Reels: typical views = the median of the creator's scraped recent Reels.
function scrapedTypicalViews(row) {
  const stats = row && row.ig_scraped_data && typeof row.ig_scraped_data === 'object' ? row.ig_scraped_data : null;
  const v = stats && Number(stats.p50);
  if (!(v > 0)) return null;
  return {
    metric: 'typical_views', value: v, low: null, high: null, unit: 'views', confidence: 'low', method: 'median_recent',
    formula: 'median(views of recent Reels, brand deals included)', inputs: { sample_size: Number(stats.reel_count) || null },
    notes: ['Reels not analysed yet: median views of the recent Reels the extension scraped'],
  };
}

const VIEW_BASIS = {
  baseline_x_multiplier: 'typical views x this creator\'s brand-deal views ratio',
  median_brand_deal_reels: 'median views of their brand-deal Reels',
  median_last_10: 'typical views of a normal Reel (no brand-deal ratio yet)',
  median_recent: 'median views of recent Reels',
};

// Expected ad views in the shape the panel and routes use.
function viewsSummary(d) {
  if (!d || d.value == null) return null;
  return {
    value: d.value, low: d.low, high: d.high, method: d.method, confidence: d.confidence,
    basis: VIEW_BASIS[d.method] || d.method, sample_size: (d.inputs && d.inputs.sample_size) || null, notes: d.notes || [],
  };
}

// The full estimate for a creators row — creator-list's P5 -> P11 on the row's analysed Reels
// (row.reel_analysis), or the profile-only fallback before the Reels are analysed. Admin
// overrides: cpm_topic_override, cpm_country_override. `rateEvidence` = the creator's own
// fees (services/rateEvidence.js) for the fee cascade.
function estimateForCreator(row = {}, { rateEvidence = [], now = new Date() } = {}) {
  const E = econ();
  const analysis = analysisOf(row);
  const asOf = analysis ? new Date(analysis.as_of) : now;
  const posts = analysis ? postsOf(analysis) : [];
  const content = analysis ? contentOf(analysis) : [];

  let typical;
  let adViews;
  let expected = null;
  if (analysis) {
    typical = E.typicalViews(posts, { asOf });
    expected = E.expectedSponsoredViews(E.currentOrganicBaseline(posts, { asOf }), E.sponsoredMultiplier(posts, { asOf }));
    adViews = E.expectedAdViews(expected, posts, typical, { asOf });
  } else {
    typical = scrapedTypicalViews(row);
    adViews = typical ? { ...typical, metric: 'expected_ad_views', notes: [...typical.notes, 'no brand deals seen: assumes an ad gets as many views as a normal Reel'] } : null;
  }

  let topic;
  let topicSource;
  let words = [];
  const topicKey = row.cpm_topic_override;
  if (topicKey && isTopicKey(topicKey)) {
    const isNiche = !TOPIC_KEYS.includes(topicKey);
    topic = { ...topicSticker([{ topic: isNiche ? PARENTS[topicKey] : topicKey, niche: isNiche ? topicKey : null }]), evidence: 'set by admin' };
    topicSource = 'admin';
  } else if (analysis) {
    topic = topicSticker(content, 'Reels');
    topicSource = 'reels';
  } else {
    const fromProfile = contentFromProfile({ bio: row.ig_biography, category: row.ig_category });
    words = fromProfile.map((c) => c.word);
    topic = topicSticker(fromProfile, 'profile keywords');
    topicSource = fromProfile.length ? 'profile' : 'none';
  }

  const override = row.cpm_country_override && isCountryCode(row.cpm_country_override) ? row.cpm_country_override : null;
  const guess = creatorCountry(override, row.ig_biography, analysis && analysis.account ? analysis.account.instagram_country : null);
  const market = resolveMarket(guess.country);

  const cpm = estimateCpm({
    content,
    market,
    countryEvidence: guess.evidence,
    typicalViews: typical && typical.value != null ? typical : null,
    brandDeals: analysis ? brandDealsOf(analysis) : null,
    topicSticker: topic,
  });
  const cpmDerived = { ...cpm, value: cpm.value };
  const fee = E.estimateFee({ asOf: now, rateEvidence, estimatedCpm: cpmDerived, adViews: adViews || E.unknown('expected_ad_views', { reason: 'no views' }) });
  const realised = analysis ? E.realisedCpm(fee, posts, { asOf }) : null;

  return {
    cpm,
    rate: fee.value != null ? fee : null,
    rate_unknown_reason: fee.value == null ? fee.reason : null,
    expected_views: viewsSummary(adViews),
    typical_views: viewsSummary(typical),
    realised_cpm: realised && realised.value != null ? realised : null,
    inputs: {
      topic: { key: topic.value, source: topicSource, words },
      country: { code: market.country, source: guess.source, evidence: guess.evidence },
    },
    reels: analysis ? {
      as_of: analysis.as_of,
      counts: analysis.counts || null,
      topics: shares(content.map((c) => (!isIgnored(c.topic) ? c.topic : null))),
      niches: shares(content.map((c) => nicheOf(c.topic, c.niche))),
      formats: shares(content.map((c) => c.format)),
      genres: shares(content.map((c) => c.genre)),
      brands: [...new Set(brandDealsOf(analysis).map((d) => d.brand).filter(Boolean))].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())),
      instagram_country: analysis.account ? analysis.account.instagram_country : null,
    } : null,
  };
}

// Kept for callers that only need the median-recent-views fallback.
function expectedViewsOf(row) {
  const est = estimateForCreator(row);
  return est.expected_views;
}

// The CPM Deal Studio prices this creator's deals at: the admin's own number first, else the
// Estimated CPM exactly as creator-list computes it (no Deal Studio cap: a campaign's max CPM
// is shown next to it as a warning, never folded into the estimate). Returns { cpm, source }.
function dealCpmFor(row = {}, { campaignMaxCpm } = {}) {
  const capRaw = campaignMaxCpm !== undefined ? campaignMaxCpm : row.max_cpm;
  const cap = capRaw != null && capRaw !== '' && Number(capRaw) > 0 ? round(Number(capRaw), 2) : null;
  const override = row.deal_cpm != null ? Number(row.deal_cpm) : null;
  let out;
  if (override != null && Number.isFinite(override) && override > 0) out = { cpm: round(override, 2), source: 'admin' };
  else {
    const est = round(estimateForCreator(row).cpm.value, 2);
    out = { cpm: est, source: 'estimate', estimate: est };
  }
  if (cap != null) {
    out.campaign_max_cpm = cap;
    out.above_campaign_max = out.cpm > cap;
  }
  return out;
}

// What the extension panel shows: the estimate, the CPM + rate deals use, and the choices for
// the topic and country selectors.
function panelEstimate(row = {}, { rateEvidence = [] } = {}) {
  const est = estimateForCreator(row, { rateEvidence });
  const deal = dealCpmFor(row);
  const views = est.expected_views && est.expected_views.value;
  return {
    ...est,
    deal: { ...deal, rate: views ? round((views / 1000) * deal.cpm, 2) : null },
    overrides: {
      deal_cpm: row.deal_cpm != null ? Number(row.deal_cpm) : null,
      topic: row.cpm_topic_override || null,
      country: row.cpm_country_override || null,
    },
  };
}

const OPTIONS = {
  topics: TOPIC_KEYS.filter((k) => k !== 'other').map((k) => {
    const row = topicRow(k);
    return { key: k, label: label(k), group: row ? row.label : 'Average of all groups' };
  }),
  countries: Object.entries(COUNTRY_CODES.codes)
    .map(([code, name]) => ({ code, name: COUNTRY_NAMES[code] || name }))
    .sort((a, b) => a.name.localeCompare(b.name)),
};

module.exports = {
  FORMULA,
  OPTIONS,
  // Ports, exposed for the parity tests.
  topicSticker,
  resolveMarket,
  defaultMarket,
  countryFromBio,
  labelOf,
  stem,
  tokens,
  estimateCpm,
  estimateRate,
  sizeSticker,
  attributeSticker,
  brandsSticker,
  countryCode,
  creatorCountry,
  // Deal Studio.
  contentFromProfile,
  expectedViewsOf,
  estimateForCreator,
  dealCpmFor,
  panelEstimate,
  isTopicKey,
  isCountryCode,
};
