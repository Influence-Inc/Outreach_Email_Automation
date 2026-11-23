'use strict';

// The contract's terms, resolved into the exact label/value rows a reader sees.
//
// IMPORTANT: this is a hand-kept mirror of renderSections() in
// public/contract.js — the signing page the creator actually reads and signs.
// The browser script can't require a backend module, so the same derivations
// (which rows appear, how each value is phrased) live in both places, the same
// way isAutoSuppressedTerm is mirrored there today. Any change to one must be
// made in the other, or the PDF copy of a contract will stop matching the page
// that was signed. contractTerms.test.js pins the phrasing on this side.

const { combinedAdditionalTerms, stripCadenceFromDeliverables } = require('./contracts');

function fmtMoney(n, cur) {
  if (n == null || Number.isNaN(Number(n))) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur || 'USD',
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return (cur ? `${cur} ` : '$') + Number(n).toLocaleString('en-US');
  }
}

// Does the deliverables text already say how many ("3 short-form videos",
// "2 Instagram Reels + 1 TikTok")? A digit alone isn't enough: the text the
// thread extraction writes for a commission deal often names the promo code
// ("…promoting promo code KAI12"), and treating that "12" as a count hid the
// Number of deliverables row. Mirrored in public/contract.js.
function statesCount(text) {
  return /(^|[^A-Za-z0-9])\d+\s*(x\s*)?([A-Za-z-]+\s+){0,2}(videos?|reels?|posts?|tiktoks?|shorts|stories|story|deliverables?|uploads?|clips?)\b/i.test(String(text || ''));
}

function fmtNum(n) {
  return n == null || Number.isNaN(Number(n)) ? null : Number(n).toLocaleString('en-US');
}

// Drop rows whose value is absent, matching the signing page's row() helper.
function rows(list) {
  return list.filter((r) => r && r.value != null && r.value !== '');
}

// Every contract sentence ends with a full stop — including text stored on
// older contracts and terms pulled from the email thread, which often don't.
// A trailing comma or semicolon becomes the full stop; text already ending in
// . ! ? (or one inside a closing quote/bracket) is left alone. Mirrored as
// sentence() in public/contract.js.
function sentence(text) {
  if (text == null) return text;
  const t = String(text).trim().replace(/[,;]+$/, '');
  if (!t || /[.!?…:]["'”’)\]]*$/.test(t)) return t;
  return `${t}.`;
}

// Build the read-only term sections for a contract's `data` blob. Returns
// [{ title, rows: [{ label, value, big }] }] plus an Additional Terms section
// carrying `bullets` instead of rows.
// Pay rows for a deal that isn't a flat fee. Mirrored in public/contract.js
// (the signing page) — keep the two in step. Returns null for a flat deal.
//
// The Reporting / Returns rows are standard affiliate terms; their wording is
// pending the team's legal review.
// Contract wording. Version 2 (dealTerms.CONTRACT_COPY_VERSION) leads with
// what the creator gets, then states every condition in full; a contract
// created before it (no copyVersion) keeps the original wording, so a signed
// contract never reads differently from what was signed. Mirrored as COPY in
// public/contract.js.
const COPY = {
  1: {
    tracking: {
      code: (code) => `Sales are attributed to the creator's ${code}.`,
      link_and_code: (code) => `Sales are attributed to the creator's tracked link or ${code}.`,
      link: () => "Sales are attributed to the creator's tracked link (provided by us).",
    },
    reporting: "Commission is calculated from the brand's monthly sales report, shared with the creator with each payout.",
    returns: 'Commission on orders later refunded, returned or charged back is deducted from the next payout.',
    commissionOnly: () => 'Commission only — no upfront fee',
    productOnly: 'Product only — no cash payment',
    productPayment: 'No cash payment',
    commissionPay: (days) => `Direct bank transfer, monthly, within ${days} days of each month's end.`,
    feePay: (days, anchor) => `Direct bank transfer, initiated within ${days} working days of ${anchor}.`,
    exclusivity: (v) => v,
    usageRights: (included) => (included ? 'Included' : 'Not included'),
    paidAds: (included) => (included ? 'Included' : 'Not included'),
  },
  2: {
    tracking: {
      code: (code) => `Every sale made with the creator's ${code} is credited to them.`,
      link_and_code: (code) => `Every sale through the creator's tracked link or ${code} is credited to them.`,
      link: () => "Every sale through the creator's tracked link (provided by us) is credited to them.",
    },
    reporting: "Each payout comes with the brand's monthly sales report, so the creator can see exactly how their commission was calculated.",
    returns: 'The creator earns on every completed order. Commission on orders later refunded, returned or charged back is deducted from the next payout.',
    commissionOnly: (referral) => (referral ? 'Referral commission — no limit on the brands the creator refers' : 'Uncapped commission'),
    productOnly: 'Gifted product — the creator keeps it',
    productPayment: 'The product ships to the creator before content production begins.',
    commissionPay: (days) => `Paid to the creator's bank account every month, within ${days} days of each month's end.`,
    feePay: (days, anchor) => `Payment is sent by direct bank transfer within ${days} working days of ${anchor}.`,
    exclusivity: (v) => (/^\s*(none|no|n\/a|no exclusivity)\.?\s*$/i.test(String(v || '')) ? 'None — the creator is free to work with any brand' : v),
    // Same grant as v1's Included / Not included, said from the creator's side.
    usageRights: (included) => (included ? "Included — the brand can feature the creator's content in its marketing" : 'Retained by the creator'),
    paidAds: (included) => (included ? "Included — the brand can boost the creator's content with paid ads" : "The creator's content stays organic — it won't run as paid ads"),
  },
};
function copyFor(d) {
  return Number(d && d.copyVersion) >= 2 ? COPY[2] : COPY[1];
}

function trackingText(c, copy) {
  const code = c.promoCode ? `promo code ${c.promoCode}` : 'personal promo code (provided by us)';
  const t = copy.tracking;
  if (c.attribution === 'code') return t.code(code);
  if (c.attribution === 'link_and_code') return t.link_and_code(code);
  return t.link();
}

function nonFlatPayRows(d, { fmtMoney, termsText, hasSchedule, upPct, remPct, copy }) {
  const model = d.compensationModel;
  if (!model || model === 'flat') return null;
  const c = d.commission || null;
  const out = [];
  if (model === 'product') {
    out.push({ label: 'Compensation', value: copy.productOnly, big: true });
    out.push({ label: 'Product', value: d.productDescription || 'As agreed in writing' });
    out.push({ label: 'Payment terms', value: sentence(d.paymentTerms || copy.productPayment) });
    return out;
  }
  if (model === 'hybrid') {
    out.push({ label: 'Upfront fee', value: fmtMoney(d.compensation, d.currency), big: true });
  } else {
    out.push({ label: 'Compensation', value: copy.commissionOnly(!!(c && c.basis === 'referral')), big: true });
  }
  if (c) {
    // Mirrors public/contract.js: a referral deal's rows come from the server.
    const referral = c.basis === 'referral';
    out.push({ label: referral ? 'Referral commission' : 'Commission', value: sentence(c.summary) });
    out.push({ label: 'Tracking', value: sentence(c.tracking || trackingText(c, copy)) });
    out.push({ label: 'Reporting', value: sentence(c.reporting || copy.reporting) });
    out.push({ label: referral ? 'Refunds' : 'Returns', value: sentence(c.returns || copy.returns) });
    if (c.rules) out.push({ label: 'Referral rules', value: sentence(c.rules) });
  }
  out.push({ label: 'Currency', value: d.currency });
  if (model === 'hybrid') {
    out.push({ label: 'Upfront fee payment', value: sentence(termsText) });
    if (hasSchedule) out.push({ label: 'Payment schedule', value: `${upPct}% upfront, ${remPct}% ${d.remainderTrigger || 'on completion'}` });
    if (c) out.push({ label: 'Commission payment', value: copy.commissionPay(c.payoutNetDays) });
  } else {
    out.push({ label: 'Payment terms', value: sentence(d.paymentTerms || (c ? copy.commissionPay(c.payoutNetDays) : '')) });
  }
  return out;
}

function contractSections(data) {
  const d = data && typeof data === 'object' ? data : {};
  const copy = copyFor(d);
  const sections = [];

  sections.push({
    title: 'Parties',
    rows: rows([
      { label: 'Creator', value: d.creatorName, big: true },
      {
        label: 'Instagram',
        value: d.instagramUsername ? `@${String(d.instagramUsername).replace(/^@/, '')}` : null,
      },
      { label: 'Email', value: d.email },
      { label: 'Brand', value: d.brandLegalName || d.brandName, big: true },
    ]),
  });

  const platforms = Array.isArray(d.platforms) ? d.platforms : d.platforms ? [d.platforms] : [];
  const minViews = d.minTotalViews != null ? d.minTotalViews : d.guaranteedViews;
  const isViewBased = d.offerType === 'view_based';
  const isVideoBased = d.offerType === 'video_based';
  const minVideos = d.minVideos != null ? Number(d.minVideos) : null;
  const hasMinVideos = isViewBased && Number.isFinite(minVideos) && minVideos > 0;
  const deliverablesText = stripCadenceFromDeliverables(String(d.deliverables || ''));
  const deliverablesHasCount = statesCount(deliverablesText);
  // A commission-only deal may have open-ended or no deliverables
  // (contracts.deliverablesModePatch): no count, no deadline, and with none, no
  // content rights either. Its sentences are stored on the contract.
  const mode = d.deliverablesMode === 'open' || d.deliverablesMode === 'none' ? d.deliverablesMode : 'fixed';
  const guaranteedViewsLabel = isViewBased ? 'Guaranteed total views' : 'Min. guaranteed views';
  const guaranteedViewsValue =
    isViewBased && minViews
      ? `${fmtNum(minViews)} — combined across all posts on Instagram`
      : minViews
        ? fmtNum(minViews)
        : null;
  const viewDays =
    d.viewCountingDays != null
      ? Number(d.viewCountingDays)
      : d.bonusWindowDays != null
        ? Number(d.bonusWindowDays)
        : 30;
  const countingWindowText = `Views for each post are counted for ${viewDays} days from the day it is posted.`;

  sections.push({
    title: 'Campaign & Deliverables',
    rows: rows([
      { label: 'Campaign', value: d.campaignName },
      { label: 'Platforms', value: platforms.length ? platforms.join(', ') : null },
      { label: 'Deliverables', value: deliverablesText },
      isViewBased || deliverablesHasCount || mode !== 'fixed'
        ? null
        : {
            label: 'Number of deliverables',
            value: fmtNum(d.numberOfDeliverables || d.numberOfVideos),
          },
      hasMinVideos
        ? {
            label: 'Minimum videos',
            value: `At least ${fmtNum(minVideos)} video${minVideos === 1 ? '' : 's'}`,
          }
        : null,
      !isVideoBased && minViews
        ? { label: guaranteedViewsLabel, value: guaranteedViewsValue }
        : null,
      isViewBased && minViews
        ? {
            label: 'Posting commitment',
            value:
              'The creator keeps posting short-form videos on Instagram until the combined views ' +
              `across all their posts reach at least ${fmtNum(minViews)}. The deliverable is ` +
              'complete only once that combined total is reached.',
          }
        : null,
      isViewBased && minViews
        ? { label: 'View counting window', value: countingWindowText }
        : null,
      mode === 'open' && d.postingCommitment
        ? { label: 'Posting commitment', value: d.postingCommitment }
        : null,
    ]),
  });

  const deliverableCount = Number(
    d.numberOfDeliverables != null ? d.numberOfDeliverables : d.numberOfVideos,
  );
  const showCadence = !(Number.isFinite(deliverableCount) && deliverableCount <= 1);
  // Open-ended / no deliverables: nothing is due, so there's no timeline.
  if (mode === 'fixed') {
    sections.push({
      title: 'Timeline',
      rows: rows([
        showCadence ? { label: 'Cadence', value: d.timeline } : null,
        { label: 'Deadline', value: d.postingDeadline || d.deadline },
      ]),
    });
  }

  // On a video+bonus deal `compensation` is the guaranteed base and the bonus
  // is paid on top, so the total is base + bonus. Read the base directly rather
  // than deriving it by subtraction (which went negative when an out-of-date
  // total was smaller than the bonus).
  const baseComp =
    d.compensation != null
      ? Number(d.compensation)
      : d.totalPayment != null
        ? Number(d.totalPayment)
        : null;
  const upPct = d.upfrontPercent;
  const remPct = d.remainderPercent;
  const hasSchedule = Number(upPct) > 0 && Number(remPct) > 0;
  const days = Number(d.paymentTermsDays);
  const daysN = Number.isFinite(days) && days > 0 ? days : 7;
  const termsAnchor = hasSchedule
    ? 'each payment milestone'
    : 'completing and posting all agreed deliverables';
  const termsText = copy.feePay(daysN, termsAnchor);
  const hasBonus = !!(d.bonusAmount && d.bonusThresholdViews);
  const totalIncl = hasBonus && baseComp != null ? baseComp + Number(d.bonusAmount) : baseComp;

  // Commission / fee + commission / product deals (see dealTerms.js) have their
  // own pay rows; a flat-fee deal keeps the rows below unchanged.
  const nonFlat = nonFlatPayRows(d, { fmtMoney, termsText, hasSchedule, upPct, remPct, copy });
  if (nonFlat) {
    sections.push({ title: 'Compensation & Payment', rows: rows(nonFlat) });
  } else sections.push({
    title: 'Compensation & Payment',
    rows: rows([
      { label: 'Compensation', value: fmtMoney(baseComp, d.currency), big: true },
      hasBonus
        ? {
            label: 'Performance bonus',
            value:
              `${fmtMoney(d.bonusAmount, d.currency)} if total views reach ` +
              `${fmtNum(d.bonusThresholdViews)}. ${countingWindowText}`,
          }
        : null,
      hasBonus ? { label: 'Total (incl. bonus)', value: fmtMoney(totalIncl, d.currency) } : null,
      { label: 'Currency', value: d.currency },
      { label: 'Payment terms', value: termsText },
      hasSchedule
        ? {
            label: 'Payment schedule',
            value: `${upPct}% upfront, ${remPct}% ${d.remainderTrigger || 'on completion'}`,
          }
        : null,
    ]),
  });

  // No deliverables: no content to grant rights over or keep live.
  sections.push(
    mode === 'none'
      ? { title: 'Exclusivity', rows: rows([{ label: 'Exclusivity', value: copy.exclusivity(d.exclusivity) }]) }
      : {
          title: 'Usage Rights & Exclusivity',
          rows: rows([
            { label: 'Usage rights', value: copy.usageRights(!!d.paidAdsIncluded) },
            { label: 'Paid ads', value: copy.paidAds(!!d.paidAdsIncluded) },
            { label: 'Exclusivity', value: copy.exclusivity(d.exclusivity) },
            { label: 'Posts remain live for', value: `${d.postLiveMonths || 6} months` },
          ]),
        },
  );

  const bullets = combinedAdditionalTerms(d).map(sentence);
  if (bullets.length) sections.push({ title: 'Additional Terms', bullets });

  return sections;
}

module.exports = { contractSections, sentence, statesCount };
