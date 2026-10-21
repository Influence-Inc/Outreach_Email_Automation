'use strict';

// View economics and the creator fee, ported from creator-list's services/enrichment/enrichment:
//   economics/stats.py, maturity.py, baseline.py (P6), multiplier.py (P7),
//   current_baseline.py (P8), expected_views.py (P9), estimated_cpm.py (typical_views,
//   expected_ad_views), fee.py (P10: rate evidence, then Estimated CPM x expected ad views) and
//   tools/make_review_workbook.py (realised CPM per brand-deal Reel, P11).
// Values are "Derived" objects: { metric, value, low, high, unit, confidence, method, formula,
// inputs, notes }; value null means unknown, with the reason in `reason`.

const { pyRound } = require('./pyre');

const CONFIG = {
  maturity: { early_days: 7, mature_days: 30 },
  baseline: { min_samples: 5, high_min_samples: 5, high_max_dispersion: 0.2, high_max_dispersion_large: 0.35, large_sample: 10, medium_max_dispersion: 0.6 },
  multiplier: { window_days: 45, window_min_samples: 5, min_samples: 3, recency_half_life_months: 12, high_min_samples: 8, medium_min_samples: 5, high_max_dispersion: 0.25, medium_max_dispersion: 0.5 },
  current_baseline: { last_n: 10, min_samples: 5, exclude_early: true },
  fee: { rate_evidence_max_age_months: 18 },
};
const DAY_MS = 86400000;
const DAYS_PER_MONTH = 30.4375;

// --- Confidence ---------------------------------------------------------------------------

const ORDER = ['unknown', 'low', 'medium', 'high'];
const weakest = (...cs) => ORDER[Math.min(...cs.map((c) => ORDER.indexOf(c)))];

const unknown = (metric, { unit, method, formula, reason, inputs = {} }) => ({
  metric, value: null, low: null, high: null, unit, confidence: 'unknown', method, formula, inputs, notes: [], reason,
});
const known = (d) => d != null && d.value != null;

// --- Statistics (stats.py) ----------------------------------------------------------------

function median(values) {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  if (!n) throw new Error('median of no values');
  return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
}
const mad = (values) => {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
};
function dispersion(values) {
  const m = median(values);
  return m === 0 ? Infinity : mad(values) / m;
}
function weightedQuantile(values, weights, q) {
  if (!values.length || values.length !== weights.length) throw new Error('values and weights must be non-empty and the same length');
  const pairs = values.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    cum += pairs[i][1];
    if (Math.abs(cum - target) < 1e-12 && i + 1 < pairs.length) return (pairs[i][0] + pairs[i + 1][0]) / 2;
    if (cum > target) return pairs[i][0];
  }
  return pairs[pairs.length - 1][0];
}
const weightedMedian = (v, w) => weightedQuantile(v, w, 0.5);
const quartiles = (values) => {
  const ones = values.map(() => 1);
  return [weightedQuantile(values, ones, 0.25), weightedQuantile(values, ones, 0.75)];
};
const r4 = (x) => Number(x.toFixed(4));

// --- Posts --------------------------------------------------------------------------------

// A Reel's commercial status from P3: COLLABORATED -> PAID, NOT_COLLABORATED -> ORGANIC.
const STATUS = { COLLABORATED: 'PAID', NOT_COLLABORATED: 'ORGANIC', UNKNOWN: 'UNKNOWN' };
const daysBetween = (later, earlier) => Math.floor((later - earlier) / DAY_MS);

function maturity(p, cfg = CONFIG.maturity) {
  if (!p.views_observed_at) return 'UNKNOWN';
  const age = (p.views_observed_at - p.published_at) / DAY_MS;
  if (age < 0) return 'UNKNOWN';
  if (age < cfg.early_days) return 'EARLY';
  if (age < cfg.mature_days) return 'MATURING';
  return 'MATURE';
}

function organicPosts(posts, { asOf, window = null, allowed = ['MATURE'], excludeIds = [] }) {
  const kept = [];
  const dropped = {};
  const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
  for (const p of posts) {
    if (excludeIds.includes(p.post_id)) continue;
    if (p.published_at > asOf) drop('published_after_as_of');
    else if (p.status !== 'ORGANIC') drop(`commercial_${p.status.toLowerCase()}`);
    else if (p.views == null) drop('views_unavailable');
    else if (window && !(window[0] <= p.published_at && p.published_at <= window[1])) drop('outside_window');
    else if (!allowed.includes(maturity(p))) drop('not_mature');
    else kept.push(p);
  }
  return [kept, dropped];
}

function baselineConfidence(values, cfg = CONFIG.baseline) {
  const n = values.length;
  const spread = dispersion(values);
  if (n >= cfg.large_sample && spread <= cfg.high_max_dispersion_large) return 'high';
  if (n >= cfg.high_min_samples && spread <= cfg.high_max_dispersion) return 'high';
  if (spread <= cfg.medium_max_dispersion) return 'medium';
  return 'low';
}

// P6: median views of mature organic posts.
function organicBaseline(posts, { asOf, window = null, excludeIds = [], minSamples = CONFIG.baseline.min_samples, metric = 'organic_baseline_views' }) {
  const [kept, dropped] = organicPosts(posts, { asOf, window, excludeIds });
  const formula = 'median(views of organic posts)';
  if (kept.length < minSamples) {
    return unknown(metric, { unit: 'views', method: 'median', formula, reason: `insufficient organic posts: ${kept.length} usable, ${minSamples} needed`, inputs: { dropped, sample_size: kept.length, min_samples: minSamples } });
  }
  const views = kept.map((p) => p.views);
  const [q1, q3] = quartiles(views);
  return {
    metric, value: median(views), low: q1, high: q3, unit: 'views', confidence: baselineConfidence(views),
    method: 'median', formula, inputs: { dropped, sample_size: views.length, min_samples: minSamples, dispersion: r4(dispersion(views)) }, notes: [],
  };
}

// P8: median views of the most recent organic posts, early (< 7 days) ones skipped.
function currentOrganicBaseline(posts, { asOf, cfg = CONFIG.current_baseline }) {
  const n = cfg.last_n;
  const formula = `median(views of the ${n} most recent organic posts)`;
  const allowed = cfg.exclude_early ? ['MATURING', 'MATURE'] : ['EARLY', 'MATURING', 'MATURE'];
  const [eligible, dropped] = organicPosts(posts, { asOf, allowed });
  eligible.sort((a, b) => b.published_at - a.published_at);
  const recent = eligible.slice(0, n);
  const previous = eligible.slice(n, 2 * n);
  if (recent.length < cfg.min_samples) {
    return unknown('current_organic_baseline_views', {
      unit: 'views', method: `median_last_${n}`, formula,
      reason: `insufficient recent organic posts: ${recent.length} usable, ${cfg.min_samples} needed`,
      inputs: { dropped, sample_size: recent.length, min_samples: cfg.min_samples },
    });
  }
  const views = recent.map((p) => p.views);
  const value = median(views);
  let trend = null;
  if (previous.length >= cfg.min_samples) {
    const prev = median(previous.map((p) => p.views));
    trend = prev ? r4(value / prev) : null;
  }
  const [q1, q3] = quartiles(views);
  const notes = [];
  if (trend != null && (trend >= 1.5 || trend <= 0.67)) notes.push(`performance trend vs previous ${n} organic posts: ${trend}x`);
  return {
    metric: 'current_organic_baseline_views', value, low: q1, high: q3, unit: 'views', confidence: baselineConfidence(views),
    method: `median_last_${n}`, formula, inputs: { dropped, sample_size: views.length, dispersion: r4(dispersion(views)), trend_vs_previous: trend }, notes,
  };
}

// P7: weighted median of (sponsored views / organic baseline around that post).
function sponsoredMultiplier(posts, { asOf, cfg = CONFIG.multiplier }) {
  const formula = 'weighted_median(sponsored_views / organic_baseline) with weight = classification_confidence * 0.5 ^ (age_months / half_life)';
  const windowMs = cfg.window_days * DAY_MS;
  const samples = [];
  const baselines = [];
  const skipped = {};
  for (const sp of posts) {
    if (sp.status !== 'PAID' || sp.published_at > asOf) continue;
    if (sp.views == null) { skipped[sp.post_id] = 'views unavailable'; continue; }
    if (maturity(sp) !== 'MATURE') { skipped[sp.post_id] = 'views not mature yet'; continue; }
    const base = organicBaseline(posts, {
      asOf,
      window: [new Date(sp.published_at.getTime() - windowMs), new Date(sp.published_at.getTime() + windowMs)],
      excludeIds: [sp.post_id],
      minSamples: cfg.window_min_samples,
      metric: `organic_baseline_views[${sp.post_id}]`,
    });
    if (!known(base) || !base.value) { skipped[sp.post_id] = 'no usable organic baseline around this post'; continue; }
    const ageMonths = Math.max(daysBetween(asOf, sp.published_at), 0) / DAYS_PER_MONTH;
    samples.push({
      post_id: sp.post_id, views: sp.views, baseline: base.value, ratio: sp.views / base.value,
      weight: (sp.classification_confidence ?? 1) * 0.5 ** (ageMonths / cfg.recency_half_life_months),
    });
    baselines.push(base);
  }
  const usable = samples.filter((s) => s.weight > 0);
  const common = { samples, skipped, min_samples: cfg.min_samples };
  if (usable.length < cfg.min_samples) {
    return unknown('sponsored_view_multiplier', {
      unit: 'ratio', method: 'weighted_median', formula,
      reason: `insufficient sponsored samples: ${usable.length} usable, ${cfg.min_samples} needed`,
      inputs: { ...common, sample_size: usable.length },
    });
  }
  const ratios = usable.map((s) => s.ratio);
  const weights = usable.map((s) => s.weight);
  const spread = dispersion(ratios);
  let own;
  if (ratios.length >= cfg.high_min_samples && spread <= cfg.high_max_dispersion) own = 'high';
  else if (ratios.length >= cfg.medium_min_samples && spread <= cfg.medium_max_dispersion) own = 'medium';
  else own = 'low';
  const ranks = baselines.map((b) => ORDER.indexOf(b.confidence)).sort((a, b) => a - b);
  const typical = ORDER[ranks[Math.floor((ranks.length - 1) / 2)]];
  return {
    metric: 'sponsored_view_multiplier',
    value: r4(weightedMedian(ratios, weights)),
    low: r4(weightedQuantile(ratios, weights, 0.25)),
    high: r4(weightedQuantile(ratios, weights, 0.75)),
    unit: 'ratio', confidence: weakest(own, typical), method: 'weighted_median', formula,
    inputs: { ...common, sample_size: usable.length, dispersion: r4(spread) }, notes: [],
  };
}

// P9: current organic baseline x sponsored multiplier.
function expectedSponsoredViews(base, mult) {
  const formula = 'current_organic_baseline * sponsored_view_multiplier';
  const missing = [base, mult].filter((d) => !known(d)).map((d) => d.metric);
  if (missing.length) {
    return unknown('expected_sponsored_views', { unit: 'views', method: 'baseline_x_multiplier', formula, reason: `missing input: ${missing.join(', ')}` });
  }
  return {
    metric: 'expected_sponsored_views',
    value: pyRound(base.value * mult.value),
    low: mult.low != null ? pyRound(base.value * mult.low) : null,
    high: mult.high != null ? pyRound(base.value * mult.high) : null,
    unit: 'views', confidence: weakest(base.confidence, mult.confidence), method: 'baseline_x_multiplier', formula,
    inputs: { current_organic_baseline: base.value, sponsored_view_multiplier: mult.value }, notes: [],
  };
}

// Typical views: P8's current organic baseline; if unknown, the median of recent Reels (LOW).
function typicalViews(posts, { asOf }) {
  const base = currentOrganicBaseline(posts, { asOf });
  if (known(base)) return base;
  const views = posts.filter((p) => p.views != null && p.published_at <= asOf).map((p) => p.views);
  if (!views.length) return base;
  return {
    metric: 'typical_views', value: median(views), low: null, high: null, unit: 'views', confidence: 'low',
    method: 'median_recent', formula: 'median(views of recent Reels, brand deals included)',
    inputs: { sample_size: views.length },
    notes: ['not enough recent organic Reels for typical views; used all recent Reels'],
  };
}

// What the rate is priced on: P9, else the median of brand-deal Reels >= 7 days old (capped at
// typical views), else typical views.
function expectedAdViews(expected, posts, typical, { asOf, minAgeDays = 7 }) {
  if (known(expected)) return expected;
  const deals = posts.filter((p) => p.status === 'PAID' && p.views != null && daysBetween(asOf, p.published_at) >= minAgeDays);
  if (deals.length) {
    const v = deals.map((p) => p.views);
    let mid = median(v);
    const notes = [`ads ratio unknown; used the median of ${v.length} brand-deal Reels' views`];
    if (known(typical) && mid > typical.value) {
      notes.push(`capped at typical views (${pyRound(typical.value).toLocaleString('en-US')}): their brand-deal Reels got ${pyRound(mid).toLocaleString('en-US')}, more than normal reach`);
      mid = typical.value;
    }
    return {
      metric: 'expected_ad_views', value: mid, low: Math.min(...v), high: Math.max(...v), unit: 'views', confidence: 'low',
      method: 'median_brand_deal_reels', formula: `median(views of brand-deal Reels at least ${minAgeDays} days old)`,
      inputs: { sample_size: v.length }, notes,
    };
  }
  if (known(typical)) {
    return {
      ...typical,
      metric: 'expected_ad_views',
      confidence: 'low',
      notes: [...typical.notes, 'no brand deals seen: assumes an ad gets as many views as a normal Reel'],
    };
  }
  return unknown('expected_ad_views', {
    unit: 'views', method: 'none',
    formula: 'P9 expected sponsored views, else brand-deal median, else typical views',
    reason: 'no expected sponsored views, no brand-deal Reels and no typical views',
  });
}

// --- P10: the fee -------------------------------------------------------------------------

// rate evidence: [{amount, currency, rate_type: 'CAMPAIGN_ACTUAL'|'CREATOR_REPORTED',
// content_type: 'reel', observed_at: Date, source}]. Only real observations; estimates never.
const EVIDENCE_PRIORITY = ['CAMPAIGN_ACTUAL', 'CREATOR_REPORTED'];
const EVIDENCE_CONFIDENCE = { CAMPAIGN_ACTUAL: 'high', CREATOR_REPORTED: 'medium' };

function feeFromRateEvidence(evidence, { asOf, contentType = 'reel', reasons }) {
  const maxDays = CONFIG.fee.rate_evidence_max_age_months * DAYS_PER_MONTH;
  for (const type of EVIDENCE_PRIORITY) {
    const rows = evidence.filter((r) => r.rate_type === type && (r.content_type || 'reel') === contentType
      && daysBetween(asOf, r.observed_at) >= 0 && daysBetween(asOf, r.observed_at) <= maxDays);
    if (!rows.length) continue;
    const currency = rows.reduce((a, b) => (b.observed_at > a.observed_at ? b : a)).currency;
    const same = rows.filter((r) => r.currency === currency);
    const amounts = same.map((r) => r.amount);
    const notes = same.length < rows.length ? [`ignored ${rows.length - same.length} ${type} rows in other currencies`] : [];
    return {
      metric: 'estimated_fee',
      value: Number(median(amounts).toFixed(2)),
      low: Number(Math.min(...amounts).toFixed(2)),
      high: Number(Math.max(...amounts).toFixed(2)),
      unit: 'fee_per_deliverable', currency, confidence: EVIDENCE_CONFIDENCE[type],
      method: `rate_evidence:${type}`,
      formula: `median(${type} fees for ${contentType}, last ${CONFIG.fee.rate_evidence_max_age_months} months)`,
      inputs: { amounts, rate_type: type, sources: same.map((r) => r.source) }, notes,
    };
  }
  reasons.push('rate_evidence: no campaign-actual or creator-reported fee in range');
  return null;
}

function feeFromEstimatedCpm(cpm, views, { reasons }) {
  if (!known(cpm)) { reasons.push('estimated_cpm: no Estimated CPM'); return null; }
  if (!known(views)) { reasons.push('estimated_cpm: expected ad views unknown'); return null; }
  const v = views.value;
  const lo = cpm.low != null ? cpm.low : cpm.value;
  const hi = cpm.high != null ? cpm.high : cpm.value;
  return {
    metric: 'estimated_fee',
    value: Number(((v / 1000) * cpm.value).toFixed(2)),
    low: Number(((v / 1000) * lo).toFixed(2)),
    high: Number(((v / 1000) * hi).toFixed(2)),
    unit: 'fee_per_deliverable', currency: cpm.currency, confidence: weakest(cpm.confidence, views.confidence),
    method: 'estimated_cpm', formula: 'expected_ad_views / 1000 * estimated_cpm (low / mid / high)',
    inputs: { expected_ad_views: v, ad_views_method: views.method, estimated_cpm: [lo, cpm.value, hi] }, notes: [],
  };
}

// First applicable method wins: the creator's own fees, else Estimated CPM x expected ad views.
function estimateFee({ asOf, rateEvidence = [], estimatedCpm, adViews }) {
  const reasons = [];
  const result = feeFromRateEvidence(rateEvidence, { asOf, reasons })
    || feeFromEstimatedCpm(estimatedCpm, adViews, { reasons });
  if (result) {
    result.notes.push(...reasons.map((r) => `skipped ${r}`));
    return result;
  }
  return unknown('estimated_fee', { unit: 'fee_per_deliverable', method: 'none', formula: 'no applicable method', reason: reasons.join('; ') });
}

// --- P11: realised CPM --------------------------------------------------------------------

const REALISED_BASIS = {
  brand_deals: 'brand-deal Reel',
  young_brand_deals: 'brand-deal Reel under 7 days old (still gaining views)',
  normal_reels: 'normal Reel (no brand deals seen: as if an ad did as well)',
};

// Rate / each Reel's views x 1000, on the best Reels there are: brand deals at least 7 days
// old; else younger brand deals; else, with no brand deals seen, their normal Reels.
function realisedCpm(fee, posts, { asOf }) {
  const formula = 'median(rate / views of each brand-deal Reel x 1000)';
  const newest = [...posts].sort((a, b) => b.published_at - a.published_at);
  const deals = newest.filter((p) => p.status === 'PAID' && p.views);
  const normal = newest.filter((p) => p.status !== 'PAID' && p.views);
  const old = deals.filter((p) => daysBetween(asOf, p.published_at) >= 7);
  const [basis, picked] = old.length ? ['brand_deals', old] : deals.length ? ['young_brand_deals', deals] : ['normal_reels', normal];
  const perVideo = known(fee) ? picked.map((p) => ({ post_id: p.post_id, views: p.views, cpm: Number(((fee.value / p.views) * 1000).toFixed(2)) })) : [];
  if (!perVideo.length) {
    return { ...unknown('realised_cpm', { unit: 'cpm', method: 'median_over_brand_deal_reels', formula, reason: fee.value == null ? 'no rate' : 'no Reels with views to measure' }), per_video: [] };
  }
  const values = perVideo.map((v) => v.cpm);
  return {
    metric: 'realised_cpm', value: Number(median(values).toFixed(2)), low: Math.min(...values), high: Math.max(...values),
    unit: 'cpm', currency: fee.currency, confidence: fee.confidence, method: 'median_over_brand_deal_reels', formula,
    inputs: { videos: values.length, basis }, per_video: perVideo,
    notes: [`${values.length} x ${REALISED_BASIS[basis]}; range = lowest to highest`],
  };
}

module.exports = {
  CONFIG, STATUS, weakest, unknown, known,
  median, dispersion, weightedQuantile, quartiles, maturity,
  organicBaseline, currentOrganicBaseline, sponsoredMultiplier, expectedSponsoredViews,
  typicalViews, expectedAdViews, estimateFee, realisedCpm,
};
