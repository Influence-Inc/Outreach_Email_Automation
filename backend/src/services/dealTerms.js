'use strict';

// How a deal pays the creator. Until now every deal was a dollar fee, and the
// fee WAS the deal: the stage machine, acceptance, the contract and both syncs
// all read one number. Affiliate deals break that — a commission-only pitch has
// no fee at all, and an empty fee used to fall back to the creator's own asking
// rate (contracts.agreedFeeFor → quoted_rate), signing a commission deal as a
// flat payment of whatever they first quoted.
//
// So an offer carries TERMS, and the fee is just one part of them:
//
//   model       'flat'       a fixed fee                      (the three priced cards)
//               'commission' a share of the sales they drive  (affiliate)
//               'hybrid'     an upfront fee + commission
//               'product'    product / gifting only, no cash
//   fee         flat fee, or the hybrid's upfront fee; null otherwise
//   commission  { rate_pct, attribution, promo_code, cookie_days, term_months,
//                 payout_net_days } for commission + hybrid; null otherwise
//   product     what they receive, for product deals; null otherwise
//
// Pay model is deliberately separate from the deal SHAPE (offer_type: view /
// video / bonus / composed), so a structured card can grow a commission later
// without another redesign. Offers that predate this (no `terms`) read as flat.
//
// Shared by the composer send path, acceptance, the AI prompt, the contract and
// the Creator-DB sync — one definition so they always agree.

const MODELS = ['flat', 'commission', 'hybrid', 'product'];
const ATTRIBUTION = ['link', 'code', 'link_and_code'];
const DEFAULTS = Object.freeze({ cookie_days: 30, term_months: 6, payout_net_days: 30, attribution: 'link' });

function badTerms(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const hasCommission = (t) => !!t && (t.model === 'commission' || t.model === 'hybrid');

function intIn(v, lo, hi, fallback, label) {
  const n = num(v);
  if (n == null) return fallback;
  if (!Number.isFinite(n) || n < lo || n > hi) throw badTerms(`${label} must be between ${lo} and ${hi}.`);
  return Math.round(n);
}

// Validate + canonicalise terms from a request (the composer's terms picker).
// Returns null for "no terms" (a plain reply). Throws status-400 errors whose
// messages are shown to the admin as-is.
function normalizeTerms(raw) {
  if (raw == null || raw === '' || raw === 'none') return null;
  if (typeof raw !== 'object') throw badTerms('Deal terms are malformed.');
  const model = String(raw.model || '').toLowerCase();
  if (model === 'none' || model === '') return null;
  if (!MODELS.includes(model)) throw badTerms(`Unknown pay model "${raw.model}".`);

  const out = { model, fee: null, commission: null, product: null };

  if (model === 'flat' || model === 'hybrid') {
    const fee = num(raw.fee);
    if (fee == null || !Number.isFinite(fee) || fee <= 0) {
      throw badTerms(model === 'hybrid' ? 'Enter the upfront fee (or switch to Commission).' : 'Enter the fee.');
    }
    if (fee > 10000000) throw badTerms('That fee looks wrong — check the amount.');
    out.fee = Math.round(fee);
  }

  if (hasCommission(out)) {
    const c = raw.commission && typeof raw.commission === 'object' ? raw.commission : {};
    const rate = num(c.rate_pct);
    if (rate == null || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
      throw badTerms('Enter the commission rate (a percentage between 0 and 100).');
    }
    const attribution = ATTRIBUTION.includes(c.attribution) ? c.attribution : DEFAULTS.attribution;
    let promo = c.promo_code == null ? '' : String(c.promo_code).trim();
    if (promo && !/^[A-Za-z0-9_-]{2,40}$/.test(promo)) {
      throw badTerms('Promo codes can only use letters, numbers, "-" and "_" (2–40 characters).');
    }
    if (attribution === 'link') promo = '';
    out.commission = {
      rate_pct: Math.round(rate * 100) / 100,
      attribution,
      promo_code: promo ? promo.toUpperCase() : null,
      cookie_days: intIn(c.cookie_days, 1, 365, DEFAULTS.cookie_days, 'The attribution window (days)'),
      // null = no end date ("ongoing"): only when the picker explicitly sends it.
      term_months: c.term_months === null ? null : intIn(c.term_months, 1, 60, DEFAULTS.term_months, 'The term (months)'),
      payout_net_days: intIn(c.payout_net_days, 0, 120, DEFAULTS.payout_net_days, 'Payout days'),
    };
  }

  if (model === 'product') {
    const p = String(raw.product || '').replace(/\s+/g, ' ').trim();
    if (!p) throw badTerms('Describe the product they receive.');
    if (p.length > 300) throw badTerms('Keep the product description under 300 characters.');
    out.product = p;
  }
  return out;
}

// Terms for ANY stored offer object: its own `terms` when it has them, else a
// legacy priced offer read as a flat fee.
function termsFromOffer(offer) {
  if (!offer || typeof offer !== 'object') return null;
  if (offer.terms && typeof offer.terms === 'object' && MODELS.includes(offer.terms.model)) return offer.terms;
  const fee = num(offer.flat_fee);
  return Number.isFinite(fee) && fee > 0 ? { model: 'flat', fee: Math.round(fee), commission: null, product: null } : null;
}

// Terms recorded on a timeline event's detail (rate_offer_sent / rate_accepted).
function termsFromDetail(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.terms && typeof d.terms === 'object' && MODELS.includes(d.terms.model)) return d.terms;
  return null;
}

const isFlat = (t) => !t || t.model === 'flat';

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const pct = (n) => `${Number(n)}%`;

// Short label — timeline rows, the send bar, the Rate column.
function describeTerms(t) {
  if (!t) return '';
  switch (t.model) {
    case 'flat': return money(t.fee);
    case 'commission': return `${pct(t.commission.rate_pct)} commission`;
    case 'hybrid': return `${money(t.fee)} + ${pct(t.commission.rate_pct)} commission`;
    case 'product': return 'Product only';
    default: return '';
  }
}

function attributionPhrase(c) {
  const code = c.promo_code ? `promo code ${c.promo_code}` : 'a personal promo code';
  if (c.attribution === 'code') return `the creator's ${code}`;
  if (c.attribution === 'link_and_code') return `the creator's tracked link or ${code}`;
  return "the creator's tracked link";
}

// One plain-English sentence of the commission terms — the contract's
// Commission row, the Creator-DB sync text, and the AI prompt all use it.
function commissionSentence(t) {
  if (!hasCommission(t)) return '';
  const c = t.commission;
  const term = c.term_months ? `for ${c.term_months} month${c.term_months === 1 ? '' : 's'} from signing` : 'until either party ends it in writing';
  return (
    `${pct(c.rate_pct)} commission on net sales (excluding taxes, shipping, refunds and returns) attributed to ${attributionPhrase(c)}` +
    ` within ${c.cookie_days} day${c.cookie_days === 1 ? '' : 's'} of a click or code use, paid monthly within ${c.payout_net_days} days` +
    ` of each month's end against the brand's sales report, ${term}.`
  );
}

// The whole deal in one line, for prompts and plain-text syncs.
function termsSummary(t) {
  if (!t) return '';
  switch (t.model) {
    case 'flat': return `A flat fee of ${money(t.fee)}.`;
    case 'commission': return `Commission only (no upfront fee): ${commissionSentence(t)}`;
    case 'hybrid': return `An upfront fee of ${money(t.fee)}, plus ${commissionSentence(t)}`;
    case 'product': return `Product only, no cash payment: ${t.product}.`;
    default: return '';
  }
}

module.exports = {
  MODELS,
  ATTRIBUTION,
  DEFAULTS,
  normalizeTerms,
  termsFromOffer,
  termsFromDetail,
  hasCommission,
  isFlat,
  describeTerms,
  commissionSentence,
  termsSummary,
};
