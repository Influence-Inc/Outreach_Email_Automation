'use strict';

// Merge a campaign's saved scouting defaults with per-run overrides into the
// frozen config the scouting rules (services/sourcingFilters.js) consume. Coerces
// numbers, splits comma/newline keyword strings, defaults risk to 'medium' and
// the reels window to 12.

const RISKS = ['low', 'medium', 'high'];

function toKeywordList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(v) {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildConfig(defaults = {}, override = {}) {
  const merged = { ...(defaults || {}), ...(override || {}) };
  return {
    niche: merged.niche ? String(merged.niche).trim() : '',
    keywords: toKeywordList(merged.keywords),
    floor: num(merged.floor),
    ceiling: num(merged.ceiling),
    risk: RISKS.includes(merged.risk) ? merged.risk : 'medium',
    targetCount: num(merged.targetCount) || 0,
    reelsWindow: num(merged.reelsWindow) || 12,
    nicheThreshold: num(merged.nicheThreshold),
  };
}

module.exports = { buildConfig, toKeywordList, RISKS };
