'use strict';

// Currency detection + conversion for creator rate quotes.
//
// Creators quote in their own currency ("Php 150,000", "2,500 euros",
// "₹1.5 lakh"). Every rate we store (creators.quoted_rate, the rate timeline,
// the offer maths) is in USD, so a quote is converted before it's recorded —
// otherwise "Php 150,000" lands as "$150,000". The original amount + currency
// are kept alongside so the timeline can still show what the creator wrote.
//
//   parseMoneyMentions(text) → every money amount in the text, in its ORIGINAL
//                              units, with the ISO currency when one is marked
//   contextCurrency(text)    → the single non-USD currency a message talks in
//   convertToUsd(amount, cur)→ { usd, rate, source } using live rates
//                              (open.er-api.com, cached 12h) with a static
//                              fallback table when the fetch fails
//   formatOriginal(amount, cur) → "₱150,000" / "€2,500" / "150,000 AED"

const RATES_URL = process.env.FX_RATES_URL || 'https://open.er-api.com/v6/latest/USD';
const CACHE_MS = 12 * 60 * 60 * 1000;

// Units of each currency per 1 USD. Used only when the live fetch fails —
// approximate, refreshed by hand occasionally (last: Nov 2026).
const FALLBACK_RATES = {
  USD: 1, EUR: 0.909, GBP: 0.758, INR: 93.96, PHP: 63.94, AUD: 1.53, CAD: 1.40,
  SGD: 1.31, NZD: 1.70, HKD: 7.78, AED: 3.6725, SAR: 3.75, QAR: 3.64, KWD: 0.307,
  IDR: 18273, MYR: 4.25, THB: 34.5, VND: 25400, JPY: 152, KRW: 1390, CNY: 7.15,
  TWD: 32.2, NGN: 1350, ZAR: 18.2, KES: 129, GHS: 15.5, EGP: 49.5, MAD: 9.9,
  BRL: 5.75, MXN: 18.55, ARS: 1050, COP: 4100, CLP: 950, PEN: 3.75, PKR: 278,
  BDT: 120, LKR: 295, NPR: 150, TRY: 34.5, PLN: 3.95, CHF: 0.88, SEK: 10.6,
  NOK: 10.9, DKK: 6.78, CZK: 23.3, HUF: 375, RON: 4.52, ILS: 3.72,
};

const SUPPORTED = new Set(Object.keys(FALLBACK_RATES));

// Symbol / prefix markers → ISO code. Longest first so "US$" beats "$".
const SYMBOLS = [
  ['US$', 'USD'], ['AU$', 'AUD'], ['A$', 'AUD'], ['CA$', 'CAD'], ['C$', 'CAD'],
  ['NZ$', 'NZD'], ['S$', 'SGD'], ['HK$', 'HKD'], ['MX$', 'MXN'], ['R$', 'BRL'],
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['₹', 'INR'], ['₱', 'PHP'], ['¥', 'JPY'],
  ['₦', 'NGN'], ['₩', 'KRW'], ['฿', 'THB'], ['₫', 'VND'], ['₺', 'TRY'], ['₪', 'ILS'],
  ['₵', 'GHS'], ['zł', 'PLN'], ['Rs.', 'INR'], ['Rs', 'INR'], ['Rp', 'IDR'], ['RM', 'MYR'],
];

// Currency words (case-insensitive) → ISO code.
const WORDS = [
  [/^(us\s+)?dollars?$|^bucks$|^usd$/i, 'USD'],
  [/^euros?$|^eur$/i, 'EUR'],
  [/^(british\s+)?pounds?(\s+sterling)?$|^quid$|^gbp$/i, 'GBP'],
  [/^(indian\s+)?rupees?$|^inr$/i, 'INR'],
  [/^(philippine\s+)?pesos?$|^php$/i, 'PHP'],
  [/^dirhams?$|^aed$/i, 'AED'],
  [/^ringgit$|^myr$/i, 'MYR'],
  [/^baht$|^thb$/i, 'THB'],
  [/^naira$|^ngn$/i, 'NGN'],
  [/^rand$|^zar$/i, 'ZAR'],
  [/^yen$|^jpy$/i, 'JPY'],
  [/^rupiah$|^idr$/i, 'IDR'],
  [/^riyals?$|^sar$/i, 'SAR'],
];

const WORD_ALT =
  "(?:us\\s+)?dollars?|bucks|euros?|(?:british\\s+)?pounds?(?:\\s+sterling)?|quid|(?:indian\\s+)?rupees?|(?:philippine\\s+)?pesos?|dirhams?|ringgit|baht|naira|rand|yen|rupiah|riyals?";

// Upper-case ISO codes (plus the common "Php" spelling). Case-sensitive so
// ordinary words ("try", "all") are never read as currencies.
const CODE_ALT = [...SUPPORTED].join('|') + '|Php';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const SYMBOL_ALT = SYMBOLS.map(([s]) => escapeRe(s)).join('|');
// After the number only pure symbols count ("2.500 €", "500$"), and a "$" is
// never taken as a suffix when another amount follows it ("500 $600").
const SUFFIX_SYMBOL_ALT = SYMBOLS.filter(([s]) => !/[A-Za-z]/.test(s))
  .map(([s]) => (s.endsWith('$') ? `${escapeRe(s)}(?!\\s?\\d)` : escapeRe(s)))
  .join('|');

// A number: 2500, 2,500, 1,50,000 (Indian grouping), 2.500 / 2 500 (European
// thousands), 2.500,50, 1.5.
const NUM = '\\d{1,3}(?:[,.\\u00a0 ]\\d{2,3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const MULT = 'k|K|m|M|mn|million|thousand|lakhs?|lacs?|lakh|crores?|cr';

// prefix marker? NUM multiplier? suffix marker?
const MONEY_SRC =
  `(?:(${SYMBOL_ALT})|(?<![A-Za-z])(${CODE_ALT})(?![A-Za-z])\\.?|(?<![A-Za-z])P(?=\\d))?\\s?` +
  `(${NUM})` +
  `(?:\\s?(${MULT})\\b)?` +
  `(?:\\s?(?:(${SUFFIX_SYMBOL_ALT})|(?<![A-Za-z])(${CODE_ALT})(?![A-Za-z])|\\b(${WORD_ALT})\\b))?`;

// A fresh global regex matching one money mention (see parseMoneyMentions for
// the capture groups). ISO codes are case-sensitive; currency words are
// lowercased in the input first so they match in any case.
function moneyRegex() {
  return new RegExp(MONEY_SRC, 'g');
}

function parseNumber(raw) {
  let s = String(raw).replace(/[\s ]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const last = Math.max(lastDot, lastComma);
  if (last < 0) return parseFloat(s);
  const sep = s[last];
  const other = sep === '.' ? ',' : '.';
  const tail = s.length - last - 1;
  const sepCount = s.split(sep).length - 1;
  // Decimal separator: the last one, when both kinds appear, or when it occurs
  // once with 1-2 digits after it ("2,5", "1.5"). Otherwise it's a thousands
  // separator ("2.500", "2,500", "1,50,000").
  const isDecimal = s.includes(other) ? true : sepCount === 1 && tail <= 2;
  if (isDecimal) {
    const intPart = s.slice(0, last).replace(/[.,]/g, '');
    return parseFloat(`${intPart}.${s.slice(last + 1)}`);
  }
  return parseFloat(s.replace(/[.,]/g, ''));
}

function multiplierOf(m) {
  if (!m) return 1;
  const s = m.toLowerCase();
  if (s === 'k' || s === 'thousand') return 1e3;
  if (s === 'm' || s === 'mn' || s === 'million') return 1e6;
  if (/^la(kh|c)/.test(s)) return 1e5;
  if (/^cr/.test(s)) return 1e7;
  return 1;
}

function symbolCode(sym) {
  const hit = SYMBOLS.find(([s]) => s === sym);
  return hit ? hit[1] : null;
}

function codeOf(code) {
  if (!code) return null;
  const c = code.toUpperCase();
  return SUPPORTED.has(c) ? c : null;
}

function wordCode(word) {
  if (!word) return null;
  const w = word.trim().replace(/\s+/g, ' ');
  const hit = WORDS.find(([re]) => re.test(w));
  return hit ? hit[1] : null;
}

// Every money amount in `text`, in its original units:
//   [{ amount, currency, marked, index, raw }]
// `currency` is the ISO code when a symbol / code / word marks the amount
// (null otherwise); `marked` is true when a currency marker was present.
// Unmarked plain numbers ("300,000 views") are NOT returned unless they carry
// a k/m/lakh multiplier ("2.5k") — same rule the rate parser always used.
function parseMoneyMentions(text) {
  if (!text) return [];
  const s = String(text);
  // Lowercase only the currency words (same length, so indexes still line up
  // with `s`) so "Euros" / "RUPEES" match the lowercase word group.
  const lowered = s.replace(new RegExp(`\\b(${WORD_ALT})\\b`, 'gi'), (w) => w.toLowerCase());
  const re = moneyRegex();
  const out = [];
  let m;
  while ((m = re.exec(lowered))) {
    if (!m[3]) continue;
    const [raw, preSym, preCode, num, mult, sufSym, sufCode, sufWord] = m;
    let currency =
      (preSym && symbolCode(preSym)) ||
      (preCode && codeOf(preCode)) ||
      (/^P\d/.test(raw.trim()) && !preSym && !preCode ? 'PHP' : null) ||
      (sufSym && symbolCode(sufSym)) ||
      (sufCode && codeOf(sufCode)) ||
      (sufWord && wordCode(sufWord)) ||
      null;
    const marked = !!currency;
    if (!marked && !mult) continue;
    const amount = parseNumber(num) * multiplierOf(mult);
    if (!Number.isFinite(amount)) continue;
    out.push({ amount: Math.round(amount * 100) / 100, currency, marked, index: m.index, raw: s.slice(m.index, m.index + raw.length).trim() });
  }
  return out;
}

// The one non-USD currency a message talks in, or null. Used for amounts the
// creator wrote without a symbol ("my rate is 150k, in pesos").
function contextCurrency(text) {
  const found = new Set();
  for (const mm of parseMoneyMentions(text)) if (mm.currency) found.add(mm.currency);
  const s = String(text || '');
  for (const [re, code] of WORDS) {
    const wordRe = new RegExp(`\\b(${re.source.replace(/\^|\$/g, '')})\\b`, 'i');
    if (wordRe.test(s)) found.add(code);
  }
  found.delete('USD');
  return found.size === 1 ? [...found][0] : null;
}

// ---- Conversion -----------------------------------------------------------

let cache = null; // { rates, asOf, fetchedAt }
let inflight = null;

async function fetchLiveRates() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(RATES_URL, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (!j || !j.rates || typeof j.rates !== 'object') throw new Error('no rates in response');
    return { rates: j.rates, asOf: j.time_last_update_utc || null };
  } finally {
    clearTimeout(timer);
  }
}

// { rates, source: 'live' | 'fallback', asOf }
async function usdRates() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return { ...cache, source: 'live' };
  if (process.env.FX_RATES_DISABLED === '1') return { rates: FALLBACK_RATES, source: 'fallback', asOf: null };
  if (!inflight) {
    inflight = fetchLiveRates()
      .then((r) => {
        cache = { ...r, fetchedAt: Date.now() };
        return cache;
      })
      .catch((err) => {
        console.warn('[currency] live FX rates unavailable, using fallback table:', err.message);
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const live = await inflight;
  if (live) return { ...live, source: 'live' };
  return { rates: FALLBACK_RATES, source: 'fallback', asOf: null };
}

// Convert `amount` of `currency` to whole US dollars.
//   → { usd, rate, source, asOf }   (rate = units of `currency` per 1 USD)
// USD / unknown currency → returned unchanged with rate 1.
async function convertToUsd(amount, currency) {
  const n = Number(amount);
  const cur = codeOf(currency);
  if (!Number.isFinite(n)) return null;
  if (!cur || cur === 'USD') return { usd: Math.round(n), rate: 1, source: 'none', asOf: null };
  const { rates, source, asOf } = await usdRates();
  let rate = Number(rates[cur]);
  let src = source;
  if (!Number.isFinite(rate) || rate <= 0) {
    rate = FALLBACK_RATES[cur];
    src = 'fallback';
  }
  return { usd: Math.round(n / rate), rate, source: src, asOf };
}

const DISPLAY_SYMBOL = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', PHP: '₱', JPY: '¥', NGN: '₦', KRW: '₩',
  THB: '฿', VND: '₫', TRY: '₺', ILS: '₪', AUD: 'A$', CAD: 'C$', SGD: 'S$', NZD: 'NZ$',
  HKD: 'HK$', BRL: 'R$', MXN: 'MX$', IDR: 'Rp ', MYR: 'RM ',
};

function formatOriginal(amount, currency) {
  const n = Number(amount);
  const num = Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 })
    : String(amount);
  const sym = DISPLAY_SYMBOL[currency];
  return sym ? `${sym}${num}` : `${num} ${currency}`;
}

function _resetCache() {
  cache = null;
  inflight = null;
}

module.exports = {
  SUPPORTED,
  FALLBACK_RATES,
  parseMoneyMentions,
  contextCurrency,
  parseNumber,
  convertToUsd,
  usdRates,
  formatOriginal,
  moneyRegex,
  _resetCache,
};
