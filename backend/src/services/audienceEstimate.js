'use strict';

// Estimated target audience from a creator's own content — a port of creator-list's
// services/enrichment/enrichment/audience.py (docs/AUDIENCE_PLAN.md there), with its
// reference table copied as cpmReference/audience_priors.json (keep the two identical).
//
//   per Reel   Jev:   who it is made for (women / men / everyone), life stage, how local —
//                     three questions asked in the same call as topic / niche / genre / format
//              free:  the language Whisper detected, home-country currencies and places named
//   creator    the table turns those, the topic mix and the creator's country into shares
//              (gender, age, country), with a confidence per dimension.
//
// It is not Instagram's audience data: the table is set by hand, and the result says so
// (`calibrated: false`), exactly as on creator-list.

const TABLE = require('./cpmReference/audience_priors.json');
const COUNTRIES = require('./cpmReference/country_codes.json');

const QUESTION_KEYS = {
  audience_gender: 'addressed_to',
  audience_life_stage: 'life_stage',
  audience_scope: 'scope',
};

// Python 3.12's sum() of floats is compensated (Neumaier); a plain running sum drifts by an
// ulp (1.0000000000000002 for a spillover table), which moves a share by a cent.
function sum(values) {
  let total = 0;
  let c = 0;
  for (const x of values) {
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
    total = t;
  }
  return total + c;
}

/** A double as an exact m * 2^e (m a BigInt). */
function decompose(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp === 0) return [sign * m, -1074];
  m |= 1n << 52n;
  return [sign * m, exp - 1075];
}

const bitLength = (n) => (n === 0n ? 0 : n.toString(2).length);

/**
 * Python's statistics.mean: the exact average of the values, rounded once to the nearest
 * double (ties to even). A plain sum-then-divide is off by an ulp often enough to move a
 * share by a cent from creator-list's.
 */
function mean(values) {
  const parts = values.map(decompose);
  const emin = Math.min(...parts.map(([, e]) => e));
  let num = 0n;
  for (const [m, e] of parts) num += m << BigInt(e - emin);
  if (num === 0n) return 0;
  const neg = num < 0n;
  if (neg) num = -num;
  const n = BigInt(values.length);
  const k = Math.max(0, 56 + bitLength(n) - bitLength(num));
  let q = (num << BigInt(k)) / n;
  const sticky = (num << BigInt(k)) % n !== 0n;
  const shift = bitLength(q) - 53;
  let exponent = emin - k;
  if (shift > 0) {
    const mask = (1n << BigInt(shift)) - 1n;
    const drop = q & mask;
    const half = 1n << BigInt(shift - 1);
    q >>= BigInt(shift);
    exponent += shift;
    if (drop > half || (drop === half && (sticky || (q & 1n) === 1n))) q += 1n;
  }
  const v = Number(q) * 2 ** exponent;
  return neg ? -v : v;
}

/**
 * Python's round(x, 2): the exact binary value rounded, ties to even (0.625 -> 0.62).
 * Math.round sends ties up, which drifted these shares a cent from creator-list's.
 */
function pyRound(x, digits) {
  if (!Number.isFinite(x)) return x;
  const exact = Math.abs(x).toFixed(60); // the double's exact decimal expansion
  const [int, frac] = exact.split('.');
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  const scale = 10n ** BigInt(digits);
  let units = BigInt(int) * scale + (digits ? BigInt(kept) : 0n);
  const half = rest[0] === '5' && /^0*$/.test(rest.slice(1));
  if ((rest[0] > '5') || (rest[0] === '5' && !half) || (half && units % 2n === 1n)) units += 1n;
  const v = Number(units) / Number(scale);
  return x < 0 ? -v : v;
}
const round2 = (x) => pyRound(x, 2);
/** Python's f"{x:.0%}". */
const pct = (x) => `${pyRound(x * 100, 0)}%`;
const countryName = (code) => (COUNTRIES.codes && COUNTRIES.codes[code]) || code;

// creator-list's economics/market.country_code: 'United States' -> 'US', 'Vietnam' -> 'VN'.
const fold = (name) => String(name || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
  .toLowerCase().replace(/[^a-z]+/g, ' ').trim();
let lookup = null;
function countryCode(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return COUNTRIES.codes[s.toUpperCase()] ? s.toUpperCase() : null;
  if (!lookup) {
    lookup = {};
    for (const [code, n] of Object.entries(COUNTRIES.codes)) lookup[fold(n)] = code;
    for (const [n, code] of Object.entries(COUNTRIES.aliases || {})) lookup[fold(n)] = code;
  }
  return lookup[fold(s)] || null;
}

/** The three audience questions, in the shape jevJudge.callJev takes. */
function questions(guard = '', table = TABLE) {
  const out = {};
  for (const [key, q] of Object.entries(table.questions)) {
    out[key] = { type: 'choice', instructions: guard + q.question, criteria: { ...q.options, unclear: 'Not enough information to decide' } };
  }
  return out;
}

let patterns = null;
function compiled(table = TABLE) {
  if (patterns && table === TABLE) return patterns;
  const geo = table.geo;
  const money = Object.entries(geo.currencies).map(([p, codes]) => [new RegExp(p, 'i'), codes]);
  const places = [];
  for (const [code, words] of Object.entries(geo.places)) {
    for (const w of words) {
      places.push([new RegExp(`(?<![\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu'), [code]]);
    }
  }
  const out = { money, places };
  if (table === TABLE) patterns = out;
  return out;
}

/**
 * {language, currencies, places}: the spoken language Whisper detected and the countries whose
 * currencies or places the Reel names (audience.text_signals).
 */
function textSignals({ caption = '', transcript = '', onScreenText = '', language = null } = {}, table = TABLE) {
  const text = [caption, transcript || '', onScreenText].filter(Boolean).join(' ');
  const { money, places } = compiled(table);
  const hit = (list) => [...new Set(list.filter(([rx]) => rx.test(text)).flatMap(([, codes]) => codes))].sort();
  return {
    language: language ? String(language).trim().toLowerCase() : null,
    currencies: hit(money),
    places: hit(places),
  };
}

/**
 * What the estimate reads from one Reel (audience.reel_inputs): its topic, the three answers
 * (left out below the confidence floor, and 'unclear'), and its text signals.
 */
function reelInputs({ labels = {}, usedSpeech = false, signals = {} } = {}, table = TABLE) {
  const floor = table.weights.min_answer_confidence;
  const answer = (key) => {
    const a = labels[key] || {};
    return a.value && a.value !== 'unclear' && (a.confidence || 0) >= floor ? a.value : null;
  };
  const out = {
    topic: (labels.topic && labels.topic.value) || null,
    has_speech: !!usedSpeech,
    language: signals.language || null,
    currencies: signals.currencies || [],
    places: signals.places || [],
  };
  for (const [key, field] of Object.entries(QUESTION_KEYS)) out[field] = answer(key);
  return out;
}

const topicPrior = (topic, table) => table.topics[topic] || table.default_topic;

function blend(vectors) {
  return vectors[0].map((_, i) => mean(vectors.map((v) => v[i])));
}

/** Two decimals that add up to exactly 1; the rounding goes to `absorb`, else the largest. */
function roundShares(values, absorb = null) {
  const total = sum(values) || 1;
  const out = values.map((v) => round2(v / total));
  const i = absorb != null ? absorb : out.indexOf(Math.max(...out));
  out[i] = round2(out[i] + 1 - sum(out));
  return out;
}

function counts(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${String(k).replace(/_/g, ' ')} ${n}`).join(', ');
}

function gender(reels, table) {
  const w = table.weights.gender;
  const n = reels.length;
  const topics = reels.map((r) => r.topic).filter((t) => t && t !== 'unclear');
  const base = topics.length ? mean(topics.map((t) => topicPrior(t, table).female)) : table.default_topic.female;
  const reasons = [topics.length
    ? `Topic mix (${counts(topics)} of ${n} Reels) starts at ${pct(base)} female`
    : 'No topic labels: starts from the average'];
  const said = reels.map((r) => r.addressed_to).filter((a) => a && a in table.addressed_to);
  let female = base;
  let heard = null;
  if (said.length >= table.weights.min_answers) {
    heard = mean(said.map((a) => table.addressed_to[a]));
    female = w.topic * base + w.addressed_to * heard;
    reasons.push(`Made for: ${counts(said)} of ${n} Reels`);
  } else {
    reasons.push("Not enough 'made for' answers yet: topic only");
  }
  female = round2(female);
  let confidence = 'low';
  if (topics.length >= 10 && heard != null && said.length >= 10 && Math.abs(base - heard) <= 0.2) confidence = 'high';
  else if (topics.length >= 5) confidence = 'medium';
  const lean = female >= 0.75 ? 'mostly female' : female >= 0.6 ? 'female-leaning'
    : female <= 0.25 ? 'mostly male' : female <= 0.4 ? 'male-leaning' : 'balanced';
  return {
    female, male: round2(1 - female), lean, band: [round2(Math.max(0.05, female - 0.1)), round2(Math.min(0.95, female + 0.1))], confidence, reasons,
  };
}

function age(reels, table) {
  const w = table.weights.age;
  const n = reels.length;
  const buckets = table.age_buckets;
  const topics = reels.map((r) => r.topic).filter((t) => t && t !== 'unclear');
  const base = topics.length ? blend(topics.map((t) => topicPrior(t, table).age)) : table.default_topic.age;
  const reasons = [topics.length ? 'Ages start from the same topic mix' : 'No topic labels'];
  const stages = reels.map((r) => r.life_stage).filter((s) => s && s in table.life_stage);
  let dist = base;
  if (stages.length >= table.weights.min_answers) {
    const heard = blend(stages.map((s) => table.life_stage[s]));
    dist = base.map((b, i) => w.topic * b + w.life_stage * heard[i]);
    reasons.push(`Life stage: ${counts(stages)} of ${n} Reels`);
  } else {
    reasons.push('Not enough life-stage answers yet: topic only');
  }
  const shares = roundShares(dist);
  // Age is the weakest signal in content: never more than medium.
  const confidence = topics.length >= 10 && stages.length >= 10 ? 'medium' : 'low';
  const ranked = buckets.map((_, i) => i).sort((a, b) => shares[b] - shares[a]).slice(0, 2).sort((a, b) => a - b);
  return {
    distribution: Object.fromEntries(buckets.map((b, i) => [b, shares[i]])),
    main: ranked.map((i) => buckets[i]),
    confidence,
    reasons,
  };
}

function homeFromContent(reels, table) {
  const geo = table.geo;
  const speech = reels.filter((r) => r.has_speech && r.language);
  const langs = speech.map((r) => r.language).filter((l) => l !== 'english');
  if (speech.length && langs.length / speech.length >= geo.thresholds.home_language) {
    const tally = new Map();
    for (const l of langs) tally.set(l, (tally.get(l) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (geo.language_home[top]) return geo.language_home[top];
  }
  const named = new Map();
  for (const r of reels) for (const c of r.places) named.set(c, (named.get(c) || 0) + 1);
  if (named.size) {
    const [code, k] = [...named.entries()].sort((a, b) => b[1] - a[1])[0];
    if (k / reels.length >= geo.thresholds.home_references) return code;
  }
  return null;
}

function geography(reels, homeIn, sourceIn, table) {
  const geo = table.geo;
  const n = reels.length;
  const th = geo.thresholds;
  const hs = geo.home_share;
  const reasons = [];
  let home = homeIn;
  let source = sourceIn;
  if (home) {
    const saidBy = { instagram: 'Instagram', bio: 'their bio' }[source] || source;
    reasons.push(`Creator based in ${countryName(home)} (from ${saidBy})`);
  } else {
    home = homeFromContent(reels, table);
    source = 'content';
    reasons.push(home
      ? `Creator country unknown; ${countryName(home)} from their language or places`
      : 'Creator country unknown: spread like English-language Instagram');
  }
  if (!home) {
    const spill = geo.spillover_default;
    const shares = roundShares(Object.values(spill));
    const top = Object.keys(spill).map((c, i) => [c, shares[i]]).slice(0, geo.top_n);
    return {
      primary_country: null,
      countries: top.map(([c, s]) => ({ country_code: c, share: s })),
      other: round2(1 - sum(top.map(([, v]) => v))),
      confidence: 'low',
      reasons,
    };
  }

  const speech = reels.filter((r) => r.has_speech && r.language);
  const local = new Set(geo.home_languages[home] || []);
  const langShare = speech.length ? speech.filter((r) => local.has(r.language)).length / speech.length : 0;
  const refShare = n ? reels.filter((r) => r.currencies.includes(home) || r.places.includes(home)).length / n : 0;
  const scopes = reels.map((r) => r.scope).filter(Boolean);
  const enough = scopes.length >= table.weights.min_answers;
  const national = scopes.length ? scopes.filter((s) => s === 'local' || s === 'national').length / scopes.length : 0;
  const international = scopes.length ? scopes.filter((s) => s === 'international').length / scopes.length : 0;

  let rule;
  let homeShare;
  if (langShare >= th.home_language) {
    rule = 'home_language';
    homeShare = hs.home_language;
    const tally = new Map();
    for (const r of speech) if (local.has(r.language)) tally.set(r.language, (tally.get(r.language) || 0) + 1);
    const topLang = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const title = topLang.replace(/\b\w/g, (ch) => ch.toUpperCase());
    reasons.push(`${title} speech in ${pyRound(langShare * speech.length, 0)} of ${speech.length} Reels with speech`);
  } else if (refShare >= th.home_references) {
    rule = 'home_references';
    homeShare = hs.home_references;
    reasons.push(`Names ${countryName(home)} prices or places in ${pyRound(refShare * n, 0)} of ${n} Reels`);
  } else if (enough && national >= th.scope) {
    rule = 'national_scope';
    homeShare = hs.national_scope;
    reasons.push(`Made for one country or city in ${pyRound(national * scopes.length, 0)} Reels`);
  } else if (enough && international >= th.scope) {
    rule = 'international_scope';
    const intl = hs.international_scope;
    homeShare = intl[home] != null ? intl[home] : intl.default;
    reasons.push(`Made for anyone anywhere in ${pyRound(international * scopes.length, 0)} Reels`);
  } else {
    rule = 'default';
    homeShare = hs.default;
    reasons.push('No strong local or international signal');
  }

  const spill = { ...(geo.spillover[home] || geo.spillover_default) };
  delete spill[home];
  const total = sum(Object.values(spill)) || 1;
  const raw = [[home, homeShare], ...Object.entries(spill).map(([c, v]) => [c, (1 - homeShare) * v / total])];
  const ranked = raw.sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, geo.top_n);
  const rest = sum(ranked.slice(geo.top_n).map(([, v]) => v));
  const shares = roundShares([...top.map(([, v]) => v), rest], top.length);
  const strong = rule === 'home_language' || rule === 'home_references' || (rule === 'national_scope' && scopes.length >= 10);
  let confidence = 'low';
  if (source === 'reported' || source === 'instagram') confidence = strong ? 'high' : 'medium';
  else if (source === 'bio') confidence = strong ? 'medium' : 'low';
  return {
    primary_country: top[0][0],
    countries: top.map(([c], i) => ({ country_code: c, share: shares[i] })),
    other: shares[shares.length - 1],
    confidence,
    reasons,
  };
}

/**
 * Creator-level estimate from their Reels (reelInputs each) and their own country
 * (reported > Instagram > bio), as audience.estimate.
 */
function estimate(reels, { country = null, countrySource = 'unknown', table = TABLE } = {}) {
  return {
    label: 'Estimated target audience (from content)',
    calibrated: !!table.calibrated,
    reels: reels.length,
    gender: gender(reels, table),
    age: age(reels, table),
    geography: geography(reels, country, countrySource, table),
    table_version: table.version,
  };
}

/** One line for the page: "female-leaning · 18-24, 25-34 · mostly US". */
function summarise(a) {
  if (!a) return '';
  const parts = [];
  if (a.gender && a.gender.lean) parts.push(a.gender.lean);
  if (a.age && a.age.main && a.age.main.length) parts.push(a.age.main.join(', '));
  const geo = a.geography || {};
  if (geo.primary_country) parts.push(`mostly ${countryName(geo.primary_country)}`);
  return parts.join(' · ');
}

module.exports = {
  questions, textSignals, reelInputs, estimate, summarise, countryName, countryCode, roundShares, pyRound, mean, TABLE,
};
