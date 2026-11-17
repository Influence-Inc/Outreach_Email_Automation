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
//                 payout_net_days } for commission + hybrid; null otherwise.
//               Its `basis` says what the percentage is OF:
//                 'sales'    (the default; absent on older terms) a share of the
//                            product sales the creator drives for the brand
//                 'referral' a share of the campaign spend of each NEW brand the
//                            creator refers to the platform, on that brand's
//                            first `campaigns_per_brand` campaigns started within
//                            `campaign_window_months` of its sign-up. For a
//                            referral, cookie_days is the REFERRAL window (sign-up
//                            within N days of the link visit), term_months is how
//                            long referrals keep counting, and promo_code is the
//                            creator's referral code (assigned when the contract
//                            is made if left blank — see services/referrals.js).
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
const BASES = ['sales', 'referral'];
const REFERRAL_DEFAULTS = Object.freeze({
  cookie_days: 90,
  term_months: 12,
  payout_net_days: 30,
  attribution: 'link_and_code',
  campaigns_per_brand: 2,
  campaign_window_months: 12,
});
const isReferral = (t) => !!(t && t.commission && t.commission.basis === 'referral');

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
    const basis = BASES.includes(c.basis) ? c.basis : 'sales';
    const D = basis === 'referral' ? REFERRAL_DEFAULTS : DEFAULTS;
    const rate = num(c.rate_pct);
    if (rate == null || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
      throw badTerms('Enter the commission rate (a percentage between 0 and 100).');
    }
    const attribution = ATTRIBUTION.includes(c.attribution) ? c.attribution : D.attribution;
    let promo = c.promo_code == null ? '' : String(c.promo_code).trim();
    if (promo && !/^[A-Za-z0-9_-]{2,40}$/.test(promo)) {
      throw badTerms(
        basis === 'referral'
          ? 'Referral codes can only use letters, numbers, "-" and "_" (2–40 characters).'
          : 'Promo codes can only use letters, numbers, "-" and "_" (2–40 characters).',
      );
    }
    // A sales deal tracked by link alone has no code. A referral always has
    // one: the referral link is built from it (/r/CODE).
    if (attribution === 'link' && basis === 'sales') promo = '';
    out.commission = {
      rate_pct: Math.round(rate * 100) / 100,
      attribution,
      promo_code: promo ? promo.toUpperCase() : null,
      cookie_days: intIn(
        c.cookie_days, 1, 365, D.cookie_days,
        basis === 'referral' ? 'The referral window (days)' : 'The attribution window (days)',
      ),
      // null = no end date ("ongoing"): only when the picker explicitly sends it.
      term_months: c.term_months === null ? null : intIn(c.term_months, 1, 60, D.term_months, 'The term (months)'),
      payout_net_days: intIn(c.payout_net_days, 0, 120, D.payout_net_days, 'Payout days'),
    };
    // Only a referral carries `basis` (and its two extra limits), so every
    // sales-commission shape stored before this stays byte-for-byte the same.
    if (basis === 'referral') {
      out.commission.basis = 'referral';
      out.commission.campaigns_per_brand = intIn(
        c.campaigns_per_brand, 1, 12, D.campaigns_per_brand, 'Campaigns per referred brand',
      );
      out.commission.campaign_window_months = intIn(
        c.campaign_window_months, 1, 36, D.campaign_window_months, 'The campaign window (months)',
      );
    }
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
    case 'commission': return `${pct(t.commission.rate_pct)} ${isReferral(t) ? 'referral ' : ''}commission`;
    case 'hybrid': return `${money(t.fee)} + ${pct(t.commission.rate_pct)} ${isReferral(t) ? 'referral ' : ''}commission`;
    case 'product': return 'Product only';
    default: return '';
  }
}

function attributionPhrase(c) {
  const code = c.promo_code ? `promo code ${c.promo_code}` : 'personal promo code';
  if (c.attribution === 'code') return `the creator's ${code}`;
  if (c.attribution === 'link_and_code') return `the creator's tracked link or ${code}`;
  return "the creator's tracked link";
}

// Contract wording version. Contract copy is written to lead with what the
// creator earns, then the conditions, in full (see contractTerms.js and
// public/contract.js). A contract keeps the wording it was created with, so a
// signed contract never reads differently from what was signed: data without
// a copyVersion renders the original (v1) wording.
const CONTRACT_COPY_VERSION = 2;

// One plain-English sentence of the commission terms — the contract's
// Commission row, the Creator-DB sync text, and the AI prompt all use it.
// The platform referred brands sign up to — named in the referral clause.
function platformName() {
  return process.env.PLATFORM_NAME || 'INFLUENCE';
}

function referralTrackingPhrase(c) {
  // No code on the contract (left blank, so one was assigned behind the scenes
  // for the link): name neither a code nor a link — just how brands come in.
  if (!c.promo_code) {
    return c.attribution === 'code' ? "the creator's referral code, entered at sign-up" : "the creator's referral link";
  }
  const code = `referral code ${c.promo_code}`;
  if (c.attribution === 'code') return `the creator's ${code}, entered at sign-up`;
  if (c.attribution === 'link') return `the creator's referral link`;
  return `the creator's referral link or ${code} entered at sign-up`;
}

function referralSentence(t) {
  const c = t.commission;
  const n = c.campaigns_per_brand;
  const s = (k) => (k === 1 ? '' : 's');
  const term = c.term_months
    ? `Every brand that signs up within ${c.term_months} month${s(c.term_months)} of signing counts.`
    : 'Every brand that signs up while this agreement is in force counts.';
  // Leads with what the creator earns; every limit stays, stated in full.
  return (
    `The creator earns ${pct(c.rate_pct)} of the campaign spend of every new brand that signs up to ${platformName()} through ${referralTrackingPhrase(c)},` +
    ` on that brand's first ${n === 1 ? 'campaign' : `${n} campaigns`} started within ${c.campaign_window_months} month${s(c.campaign_window_months)} of its sign-up.` +
    ` There is no limit on how many brands the creator can refer. ${term}` +
    ` A brand that uses the creator's referral link counts if it signs up within ${c.cookie_days} day${s(c.cookie_days)}.` +
    ` Paid monthly, within ${c.payout_net_days} days of each month's end, on campaign spend the brand has paid.`
  );
}

function commissionSentence(t) {
  if (!hasCommission(t)) return '';
  if (isReferral(t)) return referralSentence(t);
  const c = t.commission;
  const term = c.term_months ? `for ${c.term_months} month${c.term_months === 1 ? '' : 's'} from signing` : 'until either party ends this agreement in writing';
  // Leads with what the creator earns. "No cap" is literal: no deal type
  // carries an earnings cap — if one is ever added, this line must change.
  return (
    `The creator earns ${pct(c.rate_pct)} of net sales on every order placed through ${attributionPhrase(c)},` +
    ` up to ${c.cookie_days} day${c.cookie_days === 1 ? '' : 's'} after a click or code use, ${term}, with no cap on earnings.` +
    ` Net sales exclude taxes, shipping, refunds and returns.` +
    ` Paid monthly, within ${c.payout_net_days} days of each month's end, against the brand's sales report.`
  );
}

// The whole deal in one line, for prompts and plain-text syncs.
function termsSummary(t) {
  if (!t) return '';
  switch (t.model) {
    case 'flat': return `A flat fee of ${money(t.fee)}.`;
    case 'commission': return `${isReferral(t) ? 'Referral commission only' : 'Commission only'} (no upfront fee): ${commissionSentence(t)}`;
    case 'hybrid': return `An upfront fee of ${money(t.fee)}, plus ${isReferral(t) ? 'a referral commission: ' : ''}${commissionSentence(t)}`;
    case 'product': return `Product only, no cash payment: ${t.product}.`;
    default: return '';
  }
}

module.exports = {
  MODELS,
  ATTRIBUTION,
  DEFAULTS,
  BASES,
  REFERRAL_DEFAULTS,
  isReferral,
  platformName,
  referralTrackingPhrase,
  normalizeTerms,
  termsFromOffer,
  termsFromDetail,
  hasCommission,
  isFlat,
  describeTerms,
  CONTRACT_COPY_VERSION,
  commissionSentence,
  termsSummary,
};
