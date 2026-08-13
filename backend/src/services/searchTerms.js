'use strict';

// Search terms for the Instagram scout: normalisation, plus optional AI expansion.
//
// Two separate problems, both of which made keyword scouting unreliable:
//
// 1. MULTI-WORD QUERIES. A configured keyword like "home gym workout" was typed
//    into IG search as one long phrase, which returns far less than searching
//    the words individually — and any leftover text in the search box compounded
//    into nonsense queries ("fitnesshomegym"). Every term this module emits is a
//    SINGLE word, so each search is one clean query.
//
// 2. A NICHE WITH NO KEYWORDS. `POST /runs` accepts a run with only a `niche`
//    (see routes/sourcing.js), but the navigator only ever searched
//    hashtags/keywords/seedAccounts — so such a run opened Instagram, searched
//    nothing, and finished with zero captures. The niche is now used as a
//    fallback source of terms.
//
// [expandTerms] adds the optional AI layer: given the campaign's niche/genres,
// ask Gemini for additional single-word terms real creators actually tag
// themselves with. It is key-optional — with no GEMINI_API_KEY it returns []
// and the caller just scouts the configured terms, same as before.

const { parseJsonLoose } = require('./claudeClient');
const geminiClient = require('./geminiClient');

// Words that are never worth a search on their own. Searching "the" or "for"
// burns a whole scout iteration on noise, and splitting phrases makes it much
// easier to end up with one.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can',
  'her', 'his', 'its', 'our', 'their', 'they', 'them', 'who', 'what', 'when',
  'where', 'how', 'why', 'about', 'into', 'over', 'under', 'more', 'most',
  'some', 'such', 'than', 'then', 'these', 'those', 'been', 'being', 'other',
  'content', 'creator', 'creators', 'influencer', 'influencers', 'account',
  'accounts', 'page', 'pages', 'instagram', 'insta', 'reel', 'reels', 'post',
  'posts', 'video', 'videos',
]);

// Below this a token is too generic to be a useful Instagram query.
const MIN_LENGTH = 3;

// Hard ceiling on how many searches one run will perform. Each term is a full
// search → results → profiles pass, so an unbounded list would run for hours.
const MAX_TERMS = 24;

/** Strip the leading sigil and any surrounding punctuation from one token. */
function clean(token) {
  return String(token || '')
    .trim()
    .replace(/^[#@]+/, '')
    .replace(/^[^\p{L}\p{N}_.]+|[^\p{L}\p{N}_.]+$/gu, '')
    .toLowerCase();
}

/** Is this a term worth spending a search on? */
function usable(term) {
  if (!term || term.length < MIN_LENGTH) return false;
  if (STOPWORDS.has(term)) return false;
  return /[\p{L}\p{N}]/u.test(term);
}

function split(phrase) {
  return String(phrase || '').split(/[\s,/|]+/).map(clean).filter(Boolean);
}

/**
 * Split a phrase into individual searchable words, dropping noise.
 *
 * Used for terms WE derive — the niche, and anything a model suggested — where
 * stopwords and stray fragments are expected.
 *
 * Handles and hashtags are deliberately NOT put through this: "@home.gym" and
 * "#homegym" are single Instagram entities, and breaking them apart would search
 * for things that do not exist.
 */
function toWords(phrase) {
  return split(phrase).filter(usable);
}

/**
 * A configured keyword.
 *
 * A single token is taken at face value — an operator who typed one word meant
 * it, even if it is short or would otherwise read as a stopword. Filtering only
 * applies when we are splitting a phrase ourselves, since that is where the
 * noise words come from.
 */
function toConfigured(phrase) {
  const parts = split(phrase);
  if (parts.length <= 1) return parts.filter((t) => /[\p{L}\p{N}]/u.test(t));
  return parts.filter(usable);
}

/** A handle or hashtag stays whole; only its sigil and punctuation are stripped. */
function toWhole(token) {
  const t = clean(token);
  return usable(t) ? [t] : [];
}

/**
 * Build the ordered, de-duplicated, single-word search list for a run.
 *
 * Order is deliberate — the operator's own hashtags and keywords are searched
 * before anything derived, so an explicitly configured term is never crowded out
 * by the niche fallback or an AI suggestion.
 */
function normalizeTerms(opts = {}) {
  const out = [];
  const seen = new Set();

  const push = (terms) => {
    for (const t of terms) {
      if (out.length >= MAX_TERMS) return;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  };

  for (const h of opts.hashtags || []) push(toWhole(h));
  for (const k of opts.keywords || []) push(toConfigured(k));
  for (const a of opts.seedAccounts || []) push(toWhole(a));

  // Only fall back to the niche when nothing explicit was configured — a run
  // may legitimately be created with a niche and no keywords at all.
  if (!out.length) push(toWords(opts.niche));

  // Extra terms (AI-suggested) always come last.
  push((opts.extraTerms || []).flatMap(toWords));

  return out;
}

/**
 * Ask Gemini for additional single-word Instagram search terms for this niche.
 *
 * Returns [] on every failure path — no API key, a refused request, malformed
 * JSON — so scouting always proceeds on the configured terms. Model output is
 * pushed back through the same normalisation as operator input, so a model that
 * ignores the instruction and returns phrases cannot inject a multi-word query.
 */
async function expandTerms(
  { niche, genres = [], targetAudience = '', existing = [], limit = 8 } = {},
  { gemini = geminiClient } = {},
) {
  if (!gemini.available || !gemini.available()) return [];
  if (!niche && !genres.length) return [];

  const promptText = [
    'You pick Instagram search keywords for finding creators in a niche.',
    '',
    `Niche: ${niche || '(unspecified)'}`,
    genres.length ? `On-brand genres: ${genres.join(', ')}` : '',
    targetAudience ? `Target audience: ${targetAudience}` : '',
    existing.length ? `Already searching: ${existing.join(', ')}` : '',
    '',
    `Return up to ${limit} ADDITIONAL search terms that creators in this niche`,
    'actually use in their handles, bios and hashtags.',
    'Rules: each term is a SINGLE word with no spaces; lowercase; no "#" or "@";',
    'no generic words like "content", "creator", "reels"; do not repeat any term',
    'already being searched.',
    '',
    'Respond as JSON: {"terms": ["term1", "term2", ...]}',
  ]
    .filter(Boolean)
    .join('\n');

  let text;
  try {
    text = await gemini.generate({ promptText, maxOutputTokens: 300 });
  } catch (err) {
    console.error('[search-terms] gemini request failed:', err.message);
    return [];
  }
  if (!text) return [];

  const parsed = parseJsonLoose(text);
  const raw = parsed && Array.isArray(parsed.terms) ? parsed.terms : [];
  if (!raw.length) return [];

  const known = new Set(existing.map(clean));
  const out = [];
  for (const candidate of raw) {
    // A phrase from the model collapses to its first usable word rather than
    // being dropped outright.
    const [word] = toWords(candidate);
    if (!word || known.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** Whether AI term expansion should run at all (env kill-switch + key check). */
function expansionEnabled() {
  if (String(process.env.SOURCING_AI_SEARCH_TERMS || '').toLowerCase() === 'off') return false;
  return geminiClient.available();
}

module.exports = {
  normalizeTerms,
  expandTerms,
  expansionEnabled,
  toWords,
  STOPWORDS,
  MIN_LENGTH,
  MAX_TERMS,
};
