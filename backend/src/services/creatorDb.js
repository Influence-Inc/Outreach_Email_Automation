'use strict';

// Creator Database sync client. Once a contract is signed we push the creator +
// contract into the Creator-Database service so future campaigns reuse the same
// master record (dedup by email → instagram → name happens on that side). Auth is
// a shared secret sent as `x-api-key`. Failures are surfaced to the caller — the
// submit route logs them and marks the contract for retry — but never block the
// creator's signing.

const contracts = require('./contracts');
const { resolveHandle } = require('./creatorIdentity');

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

// Keep only the non-empty string values of a nested object (address / bank
// details). Returns undefined when nothing is left so we don't send an object
// full of nulls (and so `clean` drops the key entirely).
const cleanNested = (o) => {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return Object.keys(out).length ? out : undefined;
};

// Map a signed contract row + its creator into the Creator-DB CreateContractDto.
function buildPayload(contract, creator) {
  const d = (contract && contract.data) || {};
  // The creator's signing submission (address, phone, signature, bank details).
  const sub = (contract && contract.submission && contract.submission.fields) || {};
  const addr = sub.address || {};
  const bank = sub.bankAccount || {};
  const platforms = Array.isArray(d.platforms) ? d.platforms : d.platforms ? [d.platforms] : [];
  const igHandle = resolveHandle(d, creator);
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
    // A view floor is a view-based term — never sync one for a flat video-based
    // deal, even if a stale value lingers on a contract generated before the
    // deal was correctly classified.
    guaranteedViews: d.offerType === 'video_based' ? undefined : intOrUndef(d.guaranteedViews),
    specialNotes: d.specialNotes,
    additionalTerms:
      Array.isArray(d.additionalTerms) && d.additionalTerms.length ? d.additionalTerms : undefined,
    // Contract
    contractRef: contract.token,
    contractUrl: contracts.contractUrl(contract.token),
    signerName: contract.signer_name,
    signedAt: isoOrUndef(contract.signed_at) || new Date().toISOString(),
    status: 'COMPLETED',
    // Signer submission captured on the signing page.
    signerEmail: contract.signer_email || d.email || creator.email || undefined,
    signerPhone: sub.phone || undefined,
    signerGender: sub.gender || undefined,
    signerSignedDate: isoOrUndef(sub.signedDate),
    signatureImage:
      typeof sub.signatureDataUrl === 'string' && sub.signatureDataUrl.startsWith('data:image/')
        ? sub.signatureDataUrl
        : undefined,
    address: cleanNested({
      line1: addr.line1,
      line2: addr.line2,
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      country: addr.country,
    }),
    paymentDetails: cleanNested({
      accountHolderName: bank.accountHolderName,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      iban: bank.iban,
      routingNumber: bank.routingNumber,
      ifscCode: bank.ifscCode,
      panNumber: bank.panNumber,
      swiftCode: bank.swiftCode,
      taxIdNumber: bank.taxIdNumber,
    }),
  });
}

async function syncSignedCreator(contract, creator) {
  return request('POST', '/contracts', buildPayload(contract, creator));
}

// New-vs-old segmentation lookup. Batch-asks the Creator Database which of the
// given Instagram handles have already participated in a campaign OTHER than
// `excludeCampaign` (the current campaign's name). Returns { results: [...] }
// in the same order as the handles passed in — see the Creator-DB
// CreatorsService.checkParticipation for the result shape.
//
// Kept in place for the segmentation job (services/segmentation.js) that
// writes creators.creator_segment, which the negotiation flow reads to decide
// whether to route a returning creator through the offer portal — an
// orthogonal concern from the Used/Unused/New badge on the dashboard.
async function lookupParticipation(instagramUsernames, excludeCampaign) {
  const handles = (instagramUsernames || []).map((h) => String(h || '').trim()).filter(Boolean);
  if (!handles.length) return { results: [] };
  const body = { instagramUsernames: handles };
  if (excludeCampaign) body.excludeCampaign = excludeCampaign;
  return request('POST', '/creators/participation', body);
}

// ── Bulk categorization + creator lookup (Used / Unused / New dashboard badge)
// One round-trip per creators-list load, batching every row's {email, ig}
// through the Creator-DB categorize endpoint. Distinct from the older
// participation lookup: the categorize response tells us whether a creator has
// signed at least one contract (Used) vs merely being in the DB (Unused), and
// it can match by EITHER email or Instagram — so a row we only have an email
// for still lights up correctly.
//
// Category rules (see Creator-DB CreatorsService.categorize):
//   • used   — creator is in Creator-DB and has ≥1 contract row (any status)
//   • unused — creator is in Creator-DB but has NO contracts
//   • new    — no creator matches (not in Creator-DB)
async function categorizeCreators(keys) {
  if (!Array.isArray(keys) || !keys.length) return [];
  // Any error (Creator-DB down, unset URL) is turned into a batch of 'new' so
  // the dashboard still renders without categorization instead of failing the
  // whole creators list.
  if (!isConfigured()) return keys.map(() => ({ category: 'new', creator: null }));
  try {
    return await request('POST', '/creators/categorize', { keys });
  } catch (err) {
    console.warn('[creatorDb] categorize failed:', err.message);
    return keys.map(() => ({ category: 'new', creator: null }));
  }
}

// Search Creator-DB for existing creators to import into a campaign. Passes
// through the free-text `q` and the Used/Unused `category` filter; returns the
// raw Creator-DB paginated response {data, meta}. Called by the Deal Studio's
// "Search Creator Database" panel — see routes/creatorDb.js.
async function searchCreators({ q = '', category = 'any', limit = 20 } = {}) {
  const params = new URLSearchParams();
  const query = String(q || '').trim();
  if (query) params.set('search', query);
  if (category === 'used' || category === 'unused') params.set('category', category);
  // Pagination: hard-cap at 50 (Creator-DB's own PaginationQueryDto max) so a
  // stray call can't ask for the entire creators table.
  params.set('limit', String(Math.max(1, Math.min(50, Number(limit) || 20))));
  return request('GET', `/creators?${params.toString()}`);
}

module.exports = {
  syncSignedCreator,
  buildPayload,
  isConfigured,
  lookupParticipation,
  categorizeCreators,
  searchCreators,
};
