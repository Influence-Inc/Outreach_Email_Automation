'use strict';

// Display helpers for the offer portal. Ported from the Influence-CDB-portal
// (src/lib/format.ts). Rates come out of pg as strings; both are accepted.

function formatMoney(rate, currency) {
  const amount = typeof rate === 'string' ? parseFloat(rate) : Number(rate);
  const code = currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch (_) {
    // Unknown/invalid currency code — fall back to "<CODE> <amount>".
    return `${code} ${amount.toLocaleString()}`;
  }
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date instanceof Date ? date : new Date(date));
}

// Substitute {placeholder} tokens. Mirrors services/templates.js's `fill` (kept
// as a small local copy rather than a cross-import — the offer-portal flow is
// deliberately decoupled from the new-creator email/IG-DM flow). Unknown
// {...} tokens are left intact rather than blanked out.
function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key] == null ? '' : vars[key])
      : match,
  );
}

module.exports = { formatMoney, formatDate, fillTemplate };
