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
//   Estimated rate = expected ad views / 1000 x Estimated CPM
//
// The creator-list pipeline labels every Reel's topic with a model. Deal Studio has
// no per-Reel labels, so the topic is read from the words of the Instagram bio and
// category instead (each matched word stands in for one labelled Reel), and the
// country from the bio's flag / 📍 / place names. An admin can set either by hand.

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
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

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

function sizeSticker(typicalViews) {
  if (!(Number(typicalViews) > 0)) {
    return { name: 'size', value: null, label: 'Typical views unknown', level: 'none', low: 1, high: 1, source: null, evidence: 'not enough Reels with views' };
  }
  const v = Number(typicalViews);
  const tiers = FACTORS.size.tiers;
  const tier = tiers.find((t) => t.max_views == null || v < t.max_views) || tiers[tiers.length - 1];
  const fac = factor(tier.factor);
  return {
    name: 'size', value: tier.key, label: tier.name, level: fac ? 'tier' : 'none',
    low: fac ? fac[0] : 1, high: fac ? fac[1] : 1, source: fac ? FACTORS.version : null,
    evidence: `${fmtInt(v)} median recent views`,
  };
}

// Format and genre come from per-Reel labels Deal Studio doesn't have: no data (1.0), the same
// sticker creator-list shows for a creator with no labelled Reels.
const noDataSticker = (name) => ({
  name, value: null, label: `No ${name} detected`, level: 'none', low: 1, high: 1, source: null, evidence: `no Reel had a clear ${name}`,
});

// Brand deals aren't detected from a Deal Studio scrape: "not checked" (1.0).
const brandsSticker = () => ({ name: 'brands', value: null, label: 'Brand deals not checked', level: 'none', low: 1, high: 1, source: null, evidence: null });

// --- Estimated CPM ------------------------------------------------------------------------

// estimated_cpm.estimate_cpm. `content` = [{topic, niche}]; `market` = resolveMarket(...).
function estimateCpm({ content = [], unit = 'Reels', market, countryEvidence = null, typicalViews = null, topicSticker: topicOverride = null }) {
  const topic = topicOverride || topicSticker(content, unit);
  const country = {
    name: 'country', value: market.country, label: market.name, level: market.level,
    low: market.low, high: market.high, source: market.source_url || market.source, evidence: countryEvidence,
  };
  const rest = [sizeSticker(typicalViews), noDataSticker('format'), noDataSticker('genre'), brandsSticker()];
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

// --- Deal Studio: one creator row ---------------------------------------------------------

const TOPIC_KEYS = Object.keys(TOPIC_RULES.topics);
const isTopicKey = (k) => TOPIC_KEYS.includes(k) || Object.prototype.hasOwnProperty.call(PARENTS, k);
const isCountryCode = (c) => KNOWN_CODES.has(String(c || '').toUpperCase());

// Expected ad views: the median of the creator's scraped recent Reels (creator-list's
// typical-views fallback). No brand deals are detected here, so an ad is assumed to do as
// well as a normal Reel.
function expectedViewsOf(row) {
  const stats = row && row.ig_scraped_data && typeof row.ig_scraped_data === 'object' ? row.ig_scraped_data : null;
  const v = stats && Number(stats.p50);
  if (!(v > 0)) return null;
  return { value: v, basis: 'median recent views', sample_size: Number(stats.reel_count) || null };
}

// The full estimate for a creators row: inputs as read (or overridden), CPM, rate.
function estimateForCreator(row = {}) {
  const views = expectedViewsOf(row);

  let topic;
  let content = [];
  const topicKey = row.cpm_topic_override;
  if (topicKey && isTopicKey(topicKey)) {
    const isNiche = !TOPIC_KEYS.includes(topicKey);
    content = [{ topic: isNiche ? PARENTS[topicKey] : topicKey, niche: isNiche ? topicKey : null }];
    topic = { ...topicSticker(content), evidence: 'set by admin' };
  } else {
    content = contentFromProfile({ bio: row.ig_biography, category: row.ig_category });
    topic = topicSticker(content, 'profile keywords');
  }

  let guess;
  if (row.cpm_country_override && isCountryCode(row.cpm_country_override)) {
    guess = { country: String(row.cpm_country_override).toUpperCase(), source: 'admin', evidence: 'set by admin' };
  } else {
    guess = countryFromBio(row.ig_biography);
  }
  const market = resolveMarket(guess.country);

  const cpm = estimateCpm({ market, countryEvidence: guess.evidence, typicalViews: views && views.value, topicSticker: topic });
  const rate = views ? estimateRate(cpm, views.value) : null;
  return {
    cpm,
    rate,
    expected_views: views,
    inputs: {
      topic: { key: topic.value, source: topicKey && isTopicKey(topicKey) ? 'admin' : content.length ? 'profile' : 'none', words: content.map((c) => c.word).filter(Boolean) },
      country: { code: market.country, source: guess.source, evidence: guess.evidence },
    },
  };
}

// The CPM Deal Studio prices this creator's deals at: the admin's own number first, then the
// estimate — held to the campaign's CPM ceiling when the campaign set one. Returns
// { cpm, source, estimate }.
function dealCpmFor(row = {}, { campaignMaxCpm } = {}) {
  const override = row.deal_cpm != null ? Number(row.deal_cpm) : null;
  if (override != null && Number.isFinite(override) && override > 0) return { cpm: round(override, 2), source: 'admin' };
  const estimate = estimateForCreator(row);
  const est = round(estimate.cpm.value, 2);
  const capRaw = campaignMaxCpm !== undefined ? campaignMaxCpm : row.max_cpm;
  const cap = capRaw != null && capRaw !== '' ? Number(capRaw) : null;
  if (cap != null && Number.isFinite(cap) && cap > 0 && est > cap) {
    return { cpm: round(cap, 2), source: 'estimate_capped', estimate: est, cap };
  }
  return { cpm: est, source: 'estimate', estimate: est };
}

// What the extension panel shows: the estimate, the CPM + rate deals use, and the choices for
// the topic and country selectors.
function panelEstimate(row = {}) {
  const est = estimateForCreator(row);
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
  // Deal Studio.
  contentFromProfile,
  expectedViewsOf,
  estimateForCreator,
  dealCpmFor,
  panelEstimate,
  isTopicKey,
  isCountryCode,
};
