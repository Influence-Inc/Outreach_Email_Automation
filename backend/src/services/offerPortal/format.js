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

module.exports = { formatMoney, formatDate };
