'use strict';

// Campaign dashboard (influence-stats) sync client. Once a contract is signed
// we push a new row (or update the existing one) so the dashboard's
// deliverables + deadline columns are filled in automatically, without manual
// data entry. Auth is a shared secret sent as `x-api-key`. Failures are
// surfaced to the caller — the submit route logs them and marks the contract
// for retry — but never block the creator's signing.
//
// Campaign matching: the dashboard's own campaign id is already stored
// verbatim as this backend's campaigns.id (see campaignsApi.js — campaigns
// are synced FROM the dashboard's bot API), so creator.campaign_id is passed
// straight through as `campaignId`. No separate mapping is needed.

const { resolveHandle } = require('./creatorIdentity');

const TIMEOUT_MS = Number(process.env.CAMPAIGN_DASHBOARD_TIMEOUT_MS || 15000);
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseUrl() {
  const u = process.env.CAMPAIGN_DASHBOARD_URL;
  if (!u) throw new Error('CAMPAIGN_DASHBOARD_URL is not set');
  return u.replace(/\/$/, '');
}

function isConfigured() {
  return !!process.env.CAMPAIGN_DASHBOARD_URL;
}

async function request(method, path, body) {
  const key = process.env.CAMPAIGN_DASHBOARD_API_KEY || '';
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status >= 500 || res.status === 429) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`CampaignDashboard ${method} ${path} → ${res.status}: ${text}`), {
          retryable: true,
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`CampaignDashboard ${method} ${path} → ${res.status}: ${text}`);
      }
      return res.json().catch(() => ({}));
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable || err.name === 'AbortError' || err.name === 'TypeError';
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await sleep(2 ** attempt * 1000); // 2s, 4s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// x == null catches both null and undefined — a view-based deal's
// numberOfVideos is explicitly null (see baseContractData), and Number(null)
// is 0 (finite), so without this check a view-based deal would wrongly sync
// delMinVideos: 0 instead of omitting the field.
const intOrUndef = (x) => {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

// The dashboard stores a plain YYYY-MM-DD date, not a timestamp.
const ymdOrUndef = (v) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

const clean = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
};

// Map a signed contract row + its creator into the campaign dashboard's
// "new creator row" DTO (POST /api/external/deal-studio/creators).
function buildPayload(contract, creator) {
  const d = (contract && contract.data) || {};
  const igHandle = resolveHandle(d, creator);
  // Video-based deals name a fixed video count; view-based deals have no
  // video count and instead carry a total-views target (see baseContractData
  // in contracts.js) — never send both.
  return clean({
    campaignId: creator.campaign_id,
    username: igHandle,
    email: d.email || creator.email,
    deadline: ymdOrUndef(d.postingDeadline || d.deadline),
    delMinVideos: intOrUndef(d.numberOfVideos),
    delMinViews: intOrUndef(d.minTotalViews ?? d.guaranteedViews),
    contractRef: contract.token,
  });
}

async function syncSignedCreator(contract, creator) {
  return request('POST', '/api/external/deal-studio/creators', buildPayload(contract, creator));
}

module.exports = { syncSignedCreator, buildPayload, isConfigured };
