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

function fmtNum(n) {
  return n == null || Number.isNaN(Number(n)) ? null : Number(n).toLocaleString('en-US');
}

// Drop rows whose value is absent, matching the signing page's row() helper.
function rows(list) {
  return list.filter((r) => r && r.value != null && r.value !== '');
}

// Build the read-only term sections for a contract's `data` blob. Returns
// [{ title, rows: [{ label, value, big }] }] plus an Additional Terms section
// carrying `bullets` instead of rows.
function contractSections(data) {
  const d = data && typeof data === 'object' ? data : {};
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
  const deliverablesHasCount = /\d/.test(deliverablesText);
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
      isViewBased || deliverablesHasCount
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
    ]),
  });

  const deliverableCount = Number(
    d.numberOfDeliverables != null ? d.numberOfDeliverables : d.numberOfVideos,
  );
  const showCadence = !(Number.isFinite(deliverableCount) && deliverableCount <= 1);
  sections.push({
    title: 'Timeline',
    rows: rows([
      showCadence ? { label: 'Cadence', value: d.timeline } : null,
      { label: 'Deadline', value: d.postingDeadline || d.deadline },
    ]),
  });

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
  const termsText = `Direct bank transfer, initiated within ${daysN} working days of ${termsAnchor}`;
  const hasBonus = !!(d.bonusAmount && d.bonusThresholdViews);
  const totalIncl = hasBonus && baseComp != null ? baseComp + Number(d.bonusAmount) : baseComp;

  sections.push({
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

  sections.push({
    title: 'Usage Rights & Exclusivity',
    rows: rows([
      { label: 'Usage rights', value: d.paidAdsIncluded ? 'Included' : 'Not included' },
      { label: 'Paid ads', value: d.paidAdsIncluded ? 'Included' : 'Not included' },
      { label: 'Exclusivity', value: d.exclusivity },
      { label: 'Posts remain live for', value: `${d.postLiveMonths || 6} months` },
    ]),
  });

  const bullets = combinedAdditionalTerms(d);
  if (bullets.length) sections.push({ title: 'Additional Terms', bullets });

  return sections;
}

module.exports = { contractSections };
