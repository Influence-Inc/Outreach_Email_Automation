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

async function request(method, path, body, opts = {}) {
  const key = process.env.CREATOR_DB_API_KEY || '';
  // Callers on an interactive path (the dashboard's creators list) pass a tighter
  // budget; background sync keeps the patient defaults.
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const maxAttempts = opts.attempts || MAX_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      // The document endpoint returns HTML, not JSON — callers opt in via
      // { parse: 'text' } so we hand back the raw body untouched.
      if (opts.parse === 'text') return res.text();
      return res.json().catch(() => ({}));
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable || err.name === 'AbortError' || err.name === 'TypeError';
      if (!retryable || attempt === maxAttempts) throw err;
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

// Plain-text pay terms for a non-flat deal (Creator-DB has no fields for them).
function payTermsLines(d) {
  const lines = [];
  if (d.compensationModel === 'commission' && d.commission) lines.push(`Commission only: ${d.commission.summary}`);
  if (d.compensationModel === 'hybrid' && d.commission) {
    lines.push(`Upfront fee of $${Number(d.compensation || 0).toLocaleString('en-US')} plus ${d.commission.summary}`);
  }
  if (d.compensationModel === 'product') lines.push(`Product only, no cash payment: ${d.productDescription || 'product as agreed'}`);
  return lines;
}

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
    // Commercial — sync the total possible payout (base + any performance
    // bonus). `totalPayment` is that total; it equals `compensation` (the
    // guaranteed base) on every non-bonus deal, and falls back to it on older
    // rows that stored only the one figure.
    // A commission / product deal syncs its cash part only (0 when there is
    // none); the terms themselves go across as the first additional term until
    // Creator-DB has native fields for them.
    compensation: d.compensationModel && d.compensationModel !== 'flat'
      ? (d.compensation != null ? numOrUndef(d.compensation) : 0)
      : numOrUndef(d.totalPayment != null ? d.totalPayment : d.compensation),
    currency: /^[A-Z]{3}$/.test(String(d.currency || '')) ? d.currency : 'USD',
    paymentTerms: d.paymentTerms,
    // A view floor is a view-based term — never sync one for a flat video-based
    // deal, even if a stale value lingers on a contract generated before the
    // deal was correctly classified.
    guaranteedViews: d.offerType === 'video_based' ? undefined : intOrUndef(d.guaranteedViews),
    specialNotes: d.specialNotes,
    // The extracted thread terms combined with the team's hand-added manual
    // points (see contracts.combinedAdditionalTerms) so manual extras sync too.
    additionalTerms: (() => {
      const merged = [...payTermsLines(d), ...contracts.combinedAdditionalTerms(d)];
      return merged.length ? merged : undefined;
    })(),
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
  const res = await request('POST', '/contracts', buildPayload(contract, creator));
  // A newly signed creator flips Unused/New → Used; drop cached badges so the
  // dashboard reflects it on the next load instead of after the cache TTL.
  clearCategorizeCache();
  return res;
}

// Fetch the compliant legal contract document (the "Creator Services
// Agreement") for a signed creator straight from the Creator Database — the
// same document its dashboard renders and downloads — so Deal Studio's
// "Contract" download yields that legal PDF (drawn signature included) rather
// than the outreach signing page.
//
// Resolution mirrors how the two systems already talk: categorize the creator
// (by email OR IG handle) to get the Creator-DB creator id, then pick the
// contract whose `contractRef` equals the outreach signing token (that mapping
// is set in buildPayload above), falling back to the most recent contract.
// Returns { html, creatorId, contractId } or null when Creator-DB isn't
// configured or nothing matches, so the caller can surface a clean
// "not available" instead of failing.
async function fetchContractDocumentHtml({ email, instagramUsername, contractRef } = {}, opts = {}) {
  if (!isConfigured()) return null;

  const results = await categorizeCreators([
    { email: email || null, instagramUsername: instagramUsername || null },
  ]);
  const hit = Array.isArray(results) && results[0];
  const creatorId = hit && hit.creator && hit.creator.id;
  if (!creatorId) return null;

  const list = await request('GET', `/roster/${encodeURIComponent(creatorId)}/contracts`);
  const rows = (list && list.contracts) || [];
  if (!rows.length) return null;
  const ref = contractRef ? String(contractRef) : '';
  const match =
    (ref && rows.find((c) => c.contractRef && String(c.contractRef) === ref)) || rows[0];
  if (!match || !match.id) return null;

  const qs = opts.print ? '?print=1' : '';
  const html = await request(
    'GET',
    `/roster/${encodeURIComponent(creatorId)}/contracts/${encodeURIComponent(match.id)}/document${qs}`,
    null,
    { parse: 'text' },
  );
  return { html, creatorId, contractId: match.id };
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

// ── Dashboard categorize: cached + time-boxed ───────────────────────────────
// The creators list used to await categorizeCreators() on every load, and the
// request helper's retry policy (15s timeout × 3 attempts + 2s/4s backoff) meant
// a slow or unreachable Creator-DB held the whole Deal Studio table for up to
// ~50s on every campaign switch. The badge is decoration, so the list path now:
//   • serves results from a short-lived in-memory cache (switching back to a
//     campaign costs no Creator-DB round-trip at all), and
//   • only waits CATEGORIZE_BUDGET_MS for the keys it hasn't seen. Past that the
//     list renders without those badges (`null`, not a false 'new') while the
//     request finishes in the background and fills the cache for the next load.
const CATEGORIZE_CACHE_TTL_MS = Number(process.env.CREATOR_DB_CATEGORIZE_TTL_MS || 10 * 60 * 1000);
const CATEGORIZE_BUDGET_MS = Number(process.env.CREATOR_DB_CATEGORIZE_BUDGET_MS || 2500);
const CATEGORIZE_CACHE_MAX = 20000;
const _categorizeCache = new Map(); // keyId -> { value, at }
// keyId -> Promise<value|null> for lookups already on the wire, so a reload (or
// a quick switch back) while Creator-DB is still answering joins that request
// instead of firing another one at a struggling upstream.
const _categorizeInflight = new Map();

function categorizeKeyId(k) {
  const email = String((k && k.email) || '').trim().toLowerCase();
  const ig = String((k && k.instagramUsername) || '').trim().replace(/^@/, '').toLowerCase();
  return `${email}|${ig}`;
}

function _cacheGet(id) {
  const hit = _categorizeCache.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CATEGORIZE_CACHE_TTL_MS) {
    _categorizeCache.delete(id);
    return undefined;
  }
  return hit.value;
}

function _cacheSet(id, value) {
  if (_categorizeCache.size >= CATEGORIZE_CACHE_MAX) {
    // Map iterates in insertion order — drop the oldest tenth.
    let n = Math.ceil(CATEGORIZE_CACHE_MAX / 10);
    for (const k of _categorizeCache.keys()) {
      _categorizeCache.delete(k);
      if (--n <= 0) break;
    }
  }
  _categorizeCache.set(id, { value, at: Date.now() });
}

function clearCategorizeCache() {
  _categorizeCache.clear();
  _categorizeInflight.clear();
}

// Same contract as categorizeCreators() (results in input order), except a key
// whose answer isn't available inside the budget comes back as null. When the
// background request later lands, `onLate(keys, results)` is called with the
// keys that missed the budget so the caller can do follow-up work (name sync).
async function categorizeCreatorsCached(keys, { budgetMs = CATEGORIZE_BUDGET_MS, onLate } = {}) {
  if (!Array.isArray(keys) || !keys.length) return [];
  if (!isConfigured()) return keys.map(() => ({ category: 'new', creator: null }));

  const ids = keys.map(categorizeKeyId);
  const out = ids.map((id) => _cacheGet(id) || null);
  const missIdx = [];
  const waits = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 1) {
    if (out[i] || seen.has(ids[i])) continue;
    seen.add(ids[i]);
    if (_categorizeInflight.has(ids[i])) waits.push(_categorizeInflight.get(ids[i]));
    else missIdx.push(i);
  }
  if (!missIdx.length && !waits.length) return out;

  const missKeys = missIdx.map((i) => keys[i]);
  let fetchP = Promise.resolve(null);
  if (missKeys.length) {
    // The background half keeps the normal per-attempt timeout (only the wait
    // is bounded) so a slow-but-alive Creator-DB still warms the cache.
    fetchP = request('POST', '/creators/categorize', { keys: missKeys }, { attempts: 2 })
      .then((results) => {
        const list = Array.isArray(results) ? results : [];
        missIdx.forEach((i, j) => {
          if (list[j]) _cacheSet(ids[i], list[j]);
        });
        return list;
      })
      .catch((err) => {
        console.warn('[creatorDb] categorize failed:', err.message);
        return null;
      })
      .finally(() => {
        for (const i of missIdx) _categorizeInflight.delete(ids[i]);
      });
    missIdx.forEach((i, j) => {
      _categorizeInflight.set(ids[i], fetchP.then((list) => (list && list[j]) || null));
    });
  }

  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
  const first = await Promise.race([Promise.all([fetchP, ...waits]), budget]);
  clearTimeout(timer);

  if (first === 'timeout') {
    console.warn(`[creatorDb] categorize exceeded ${budgetMs}ms — rendering without badges for some creators`);
    if (onLate && missKeys.length) {
      fetchP.then((list) => { if (list) onLate(missKeys, list); }).catch(() => {});
    }
  }
  // Fill every row (including duplicates of a missed key) from the cache, which
  // the fetch has populated if it finished in time.
  for (let i = 0; i < ids.length; i += 1) {
    if (!out[i]) out[i] = _cacheGet(ids[i]) || null;
  }
  return out;
}

// Fetch the master creator record by ID (GET /creator/:id). Returns the full
// creator row including cpm / acceptedRate / quotedRate — used to price a Used-
// creator's new-campaign offer at their prior CPM. Returns null on any miss so
// the caller can fall back gracefully.
async function getCreatorById(id) {
  if (!id || !isConfigured()) return null;
  try {
    return await request('GET', `/creator/${encodeURIComponent(id)}`);
  } catch (err) {
    console.warn(`[creatorDb] getCreatorById(${id}) failed:`, err.message);
    return null;
  }
}

// Prior negotiated CPM for a creator (from Creator-DB), or null. Chains
// categorize → GET /creator/:id since categorize's response is truncated: the
// batch call finds a matching creator (email OR IG handle, the same identity
// keys Creator-DB uses), then we fetch the full record for its cpm. Silent on
// any miss — Creator-DB is optional, and the caller falls back to other CPM
// sources when this returns null.
async function lookupCpmFromCreatorDb({ email, instagramUsername } = {}) {
  if (!isConfigured()) return null;
  const em = String(email || '').trim();
  const un = String(instagramUsername || '').replace(/^@/, '').trim();
  if (!em && !un) return null;
  const results = await categorizeCreators([{ email: em || null, instagramUsername: un || null }]);
  const hit = Array.isArray(results) && results[0];
  const id = hit && hit.creator && hit.creator.id;
  if (!id) return null;
  const record = await getCreatorById(id);
  const cpm = record && record.cpm != null ? Number(record.cpm) : null;
  return Number.isFinite(cpm) && cpm > 0 ? cpm : null;
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
  fetchContractDocumentHtml,
  buildPayload,
  isConfigured,
  lookupParticipation,
  categorizeCreators,
  categorizeCreatorsCached,
  categorizeKeyId,
  clearCategorizeCache,
  getCreatorById,
  lookupCpmFromCreatorDb,
  searchCreators,
};
