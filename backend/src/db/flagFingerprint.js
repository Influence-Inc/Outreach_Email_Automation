'use strict';

// Server-side fingerprint of a creator's CURRENT flag — the identity a
// "dismiss" is pinned to. Built only from the fields that RAISE a flag (a
// needs_human / delegated_at hand-off, an awaiting-approval offer's
// suggested_offers, an accepted deal's status), so it stays stable across
// cosmetic row updates (email opens, timeline writes) but shifts the moment
// there's genuinely new activity that needs a human. When it shifts, a stored
// dismissal no longer matches and the creator re-flags on its own — no
// "clear on every activity" bookkeeping required.
//
// It's expressed as a SQL fragment (an md5 over the relevant columns) rather
// than JS so the exact same definition is reused everywhere it's needed: the
// dismiss write, the per-row `flag_dismissed` the dashboard reads, and the
// campaigns action_count that feeds the sidebar pending-dot. One definition =
// server and every query always agree.
//
// `p` is the column prefix: '' inside an UPDATE on creators, or 'cr.' when the
// table is aliased (e.g. the campaigns action_count join).
function flagFingerprintSql(p = '') {
  return `md5(
    coalesce((${p}needs_human)::text, '')       || '|' ||
    coalesce((${p}delegated_at)::text, '')      || '|' ||
    coalesce(${p}negotiation_status, '')        || '|' ||
    coalesce((${p}contract_approved)::text, '') || '|' ||
    coalesce((${p}suggested_offers)::text, '')  || '|' ||
    coalesce((${p}replied_at)::text, '')
  )`;
}

// Boolean SQL: is this creator's stored dismissal still valid — i.e. a non-null
// stored fingerprint that still equals the freshly-computed one? A changed
// fingerprint (new activity) makes this false, so the flag comes back.
function flagDismissedSql(p = '') {
  return `(${p}flag_dismissed_fp IS NOT NULL AND ${p}flag_dismissed_fp = ${flagFingerprintSql(p)})`;
}

module.exports = { flagFingerprintSql, flagDismissedSql };
