'use strict';

// Creator Database sync client. Once a contract is signed we push the creator +
// contract into the Creator-Database service so future campaigns reuse the same
// master record (dedup by email → instagram → name happens on that side). Auth is
// a shared secret sent as `x-api-key`. Failures are surfaced to the caller — the
// submit route logs them and marks the contract for retry — but never block the
// creator's signing.

const contracts = require('./contracts');

const TIMEOUT_MS = Number(process.env.CREATOR_DB_TIMEOUT_MS || 15000);
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseUrl() {
  const u = process.env.CREATOR_DB_URL;
  if (!u) throw new Error('CREATOR_DB_URL is not set');
  return u.replace(/\/$/, '');
}

function isConfigured() {
  return !!process.env.CREATOR_DB_URL;
}

async function request(method, path, body) {
  const key = process.env.CREATOR_DB_API_KEY || '';
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
        throw Object.assign(new Error(`CreatorDB ${method} ${path} → ${res.status}: ${text}`), {
          retryable: true,
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`CreatorDB ${method} ${path} → ${res.status}: ${text}`);
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

// Drop undefined/null/'' so we never trip the Creator-DB's forbidNonWhitelisted
// / type validators with empty values.
const clean = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
};
const numOrUndef = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};
const intOrUndef = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const isoOrUndef = (v) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// Map a signed contract row + its creator into the Creator-DB CreateContractDto.
function buildPayload(contract, creator) {
  const d = (contract && contract.data) || {};
  const platforms = Array.isArray(d.platforms) ? d.platforms : d.platforms ? [d.platforms] : [];
  const igHandle =
    String(d.instagramUsername || creator.instagram_username || '').replace(/^@/, '') || undefined;
  const deliverables =
    typeof d.deliverables === 'string'
      ? d.deliverables
      : Array.isArray(d.deliverables)
        ? d.deliverables.join(', ')
        : undefined;
  return clean({
    // Identity (dedup keys on the Creator-DB side)
    creatorName: d.creatorName || creator.full_name || creator.first_name,
    email: d.email || creator.email,
    instagramUsername: igHandle,
    // Campaign + deliverables
    brandName: d.brandName,
    campaignName: d.campaignName,
    platform: platforms.length ? platforms.join(', ') : undefined,
    deliverables,
    numberOfDeliverables: intOrUndef(d.numberOfDeliverables),
    timeline: d.timeline,
    deadline: isoOrUndef(d.deadline),
    usageRights: d.usageRights,
    exclusivity: d.exclusivity,
    // Commercial
    compensation: numOrUndef(d.compensation),
    currency: /^[A-Z]{3}$/.test(String(d.currency || '')) ? d.currency : 'USD',
    paymentTerms: d.paymentTerms,
    guaranteedViews: intOrUndef(d.guaranteedViews),
    specialNotes: d.specialNotes,
    additionalTerms:
      Array.isArray(d.additionalTerms) && d.additionalTerms.length ? d.additionalTerms : undefined,
    // Contract
    contractRef: contract.token,
    contractUrl: contracts.contractUrl(contract.token),
    signerName: contract.signer_name,
    signedAt: isoOrUndef(contract.signed_at) || new Date().toISOString(),
    status: 'COMPLETED',
  });
}

async function syncSignedCreator(contract, creator) {
  return request('POST', '/contracts', buildPayload(contract, creator));
}

module.exports = { syncSignedCreator, buildPayload, isConfigured };
