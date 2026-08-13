'use strict';

// Search terms for the Instagram scout: normalisation, plus optional AI expansion.
//
// Two separate problems, both of which made keyword scouting unreliable:
//
// 1. WHAT COUNTS AS ONE KEYWORD. A COMMA separates keywords; spaces inside one
//    do not. "iphone photos, instagram story ideas" is two searches — "iphone
//    photos" and then "instagram story ideas" — each typed with its spaces
//    intact, because that is the phrase the operator meant to search for.
//
//    (This module briefly split on whitespace too, to stop queries compounding
//    into nonsense like "fitnesshomegym". That was the wrong fix for the right
//    symptom: the compounding came from typeText appending to a search box that
//    still held the previous query, and is fixed there.)
//
// 2. A NICHE WITH NO KEYWORDS. `POST /runs` accepts a run with only a `niche`
//    (see routes/sourcing.js), but the navigator only ever searched
//    hashtags/keywords/seedAccounts — so such a run opened Instagram, searched
//    nothing, and finished with zero captures. The niche is now used as a
//    fallback source of terms.
//
// [expandTerms] adds the optional AI layer: given the campaign's niche/genres,
// ask Gemini for additional terms real creators actually tag themselves with.
// It is key-optional — with no GEMINI_API_KEY it returns [] and the caller just
// scouts the configured terms, same as before.

const { parseJsonLoose } = require('./claudeClient');
const geminiClient = require('./geminiClient');

// Words that are never worth a search on their own. Searching "the" or "for"
// burns a whole scout iteration on noise. Only applied to SINGLE words we
// derived ourselves — a configured keyword is taken as typed.
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

// Below this a single derived word is too generic to be a useful query.
const MIN_LENGTH = 3;

// Hard ceiling on how many searches one run will perform. Each term is a full
// search → results → profiles pass, so an unbounded list would run for hours.
const MAX_TERMS = 24;

/**
 * Tidy one keyword without breaking it up: strip a leading #/@, trim
 * surrounding punctuation, collapse runs of whitespace, lowercase. Internal
 * spaces survive — they are part of the phrase.
 */
function clean(token) {
  return String(token || '')
    .trim()
    .replace(/^[#@]+/, '')
    .replace(/^[^\p{L}\p{N}_.]+|[^\p{L}\p{N}_.]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Any letter or digit at all — the bar for a term the operator typed. */
function hasContent(term) {
  return !!term && /[\p{L}\p{N}]/u.test(term);
}

/** Is this single word worth spending a search on? */
function usable(term) {
  if (!term || term.length < MIN_LENGTH) return false;
  if (STOPWORDS.has(term)) return false;
  return /[\p{L}\p{N}]/u.test(term);
}

/**
 * Split a field into keywords on COMMAS (and newlines, for pasted lists).
 *
 * Never on spaces: "iphone photos" is one keyword, not two.
 */
function splitTerms(value) {
  return String(value || '')
    .split(/[,\n]+/)
    .map(clean)
    .filter(Boolean);
}

/** Keywords exactly as configured — each comma-separated phrase, kept whole. */
function toConfigured(value) {
  return splitTerms(value).filter(hasContent);
}

/**
 * Terms WE derive — from the niche, or suggested by a model — where a stray
 * stopword is a real possibility, so single-word noise is dropped. Multi-word
 * phrases are kept whole, same as configured keywords.
 */
function toDerived(value) {
  return splitTerms(value).filter((t) => (t.includes(' ') ? hasContent(t) : usable(t)));
}

/**
 * Build the ordered, de-duplicated list of searches for a run.
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

  for (const h of opts.hashtags || []) push(splitTerms(h).filter(hasContent));
  for (const k of opts.keywords || []) push(toConfigured(k));
  for (const a of opts.seedAccounts || []) push(splitTerms(a).filter(hasContent));

  // Only fall back to the niche when nothing explicit was configured — a run
  // may legitimately be created with a niche and no keywords at all.
  if (!out.length) push(toDerived(opts.niche));

  // Extra terms (AI-suggested) always come last.
  push((opts.extraTerms || []).flatMap(toDerived));

  return out;
}

/**
 * Ask Gemini for additional Instagram search terms for this niche.
 *
 * Returns [] on every failure path — no API key, a refused request, malformed
 * JSON — so scouting always proceeds on the configured terms. Model output goes
 * back through the same normalisation as operator input, so a comma-joined reply
 * contributes one usable term rather than a single unsearchable mega-query.
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
    'Rules: each term is one to three words (a phrase is fine, a comma is not);',
    'lowercase; no "#" or "@"; no generic words like "content", "creator",',
    '"reels"; do not repeat any term already being searched.',
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
    // A model that ignores the instruction and returns a comma-joined list
    // contributes its first term rather than one unusable mega-query.
    const [term] = toDerived(candidate);
    if (!term || known.has(term) || out.includes(term)) continue;
    out.push(term);
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
  splitTerms,
  STOPWORDS,
  MIN_LENGTH,
  MAX_TERMS,
};
