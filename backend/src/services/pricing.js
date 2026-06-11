'use strict';

// Pure-formula pricing for creator negotiation. NO Claude here — every number
// is deterministic. See the build brief, Step 2.
//
// An offer object has the shape:
//   {
//     offer_id, offer_type ('view_based'|'video_based'), label, num_videos,
//     flat_fee, flat_per_video, view_guarantee, cpm_applied,
//     satisfies_creator_rate (bool|null), notes
//   }

const TARGET_CPM = Number(process.env.TARGET_CPM || 15);
const RISK_BUFFER = Number(process.env.RISK_BUFFER || 0.2);
const BONUS_PERCENTAGE = Number(process.env.BONUS_PERCENTAGE || 0.2);
const NUM_VIDEOS = Number(process.env.NUM_VIDEOS || 2);

// "1.2K" -> 1200, "3M" -> 3_000_000, "950" -> 950
function parseViewCount(s) {
  s = String(s).trim().toUpperCase();
  if (s.endsWith('K')) return parseFloat(s) * 1e3;
  if (s.endsWith('M')) return parseFloat(s) * 1e6;
  return parseFloat(s);
}

// Interpolated percentile. arr sorted ascending; p in [0,1].
function calculatePercentile(arr, p) {
  const n = arr.length;
  if (!n) return 0;
  if (n === 1) return arr[0];
  const i = p * (n - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, n - 1);
  const w = i - lo;
  return arr[lo] * (1 - w) + arr[hi] * w;
}

function computeStats(views) {
  const s = [...views].sort((a, b) => a - b);
  const sum = s.reduce((acc, n) => acc + n, 0);
  return {
    p10: calculatePercentile(s, 0.1),
    p25: calculatePercentile(s, 0.25),
    p50: calculatePercentile(s, 0.5),
    p75: calculatePercentile(s, 0.75),
    reel_count: s.length,
    min_views: s.length ? s[0] : 0,
    avg: s.length ? Math.round(sum / s.length) : 0,
    views_raw: views,
  };
}

const roundTo = (x, step) => Math.round(x / step) * step;

// Returns the offers: 1 conservative view-based deal + 3 video-based deals.
function computeOffers(stats, maxCpm, quotedRate) {
  const eff = maxCpm * (1 - RISK_BUFFER);
  const mk = (id, type, label, num, fee, views) => ({
    offer_id: id,
    offer_type: type,
    label,
    num_videos: num,
    flat_fee: Math.round(fee),
    flat_per_video: Math.round(type === 'view_based' ? fee : fee / num),
    view_guarantee: views,
    cpm_applied: +(views ? (fee / views) * 1000 : eff).toFixed(2),
    satisfies_creator_rate: quotedRate == null ? null : Math.round(fee) >= quotedRate,
    notes: '',
  });
  const v = (x) => Math.max(roundTo(x, 25000), 25000);
  const v1 = v(stats.min_views);
  const perVid = (stats.p25 / 1000) * eff;
  return [
    mk('view_1', 'view_based', 'Conservative View Deal', 1, (v1 / 1000) * eff, v1),
    mk('video_1', 'video_based', '1 Video Flat Deal', 1, perVid * 1, 0),
    mk('video_2', 'video_based', '2 Videos Flat Deal', 2, perVid * 2, 0),
    mk('video_3', 'video_based', '3 Videos Flat Deal', 3, perVid * 3, 0),
  ];
}

// Live CPM for the dashboard sliders.
const cpmFor = (fee, views) => (views ? +((fee / views) * 1000).toFixed(2) : null);

module.exports = {
  TARGET_CPM,
  RISK_BUFFER,
  BONUS_PERCENTAGE,
  NUM_VIDEOS,
  parseViewCount,
  calculatePercentile,
  computeStats,
  computeOffers,
  cpmFor,
};
