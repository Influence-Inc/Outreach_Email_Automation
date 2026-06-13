'use strict';

// Lightweight pre-send email verification to cut bounces from scraped
// addresses. No external/paid API: it validates the address syntax, then asks
// DNS whether the domain can receive mail (an MX record, or an A/AAAA record
// per the RFC 5321 fallback).
//
// Philosophy: only a DEFINITIVE "this domain can't receive mail" (NXDOMAIN /
// no records) marks an address invalid. Transient DNS hiccups (SERVFAIL,
// timeouts) fail OPEN — we never block a send because a lookup was flaky.
// Catches the common scraped-list bounce sources: typos (gmial.com), dead
// domains, and malformed addresses. A paid verification API could be slotted
// in later behind the same verifyEmail() interface.

const dns = require('dns').promises;

// Pragmatic address syntax — not full RFC 5322, but rejects scraped junk:
// requires a local part, a domain, and a dotted TLD of 2+ chars.
const EMAIL_RE = /^[^\s@"]+@[^\s@]+\.[^\s@.]{2,}$/;

function isValidSyntax(email) {
  return EMAIL_RE.test(String(email == null ? '' : email).trim());
}

// Per-process cache so a bulk run does one lookup per domain, not per address.
const domainCache = new Map();

// Hard failures mean the domain genuinely can't receive mail. Anything else
// (SERVFAIL, timeout, …) is transient and must not penalise the address.
const HARD_DNS_ERRORS = new Set(['ENOTFOUND', 'ENODATA']);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function domainDeliverable(domain, timeoutMs) {
  if (domainCache.has(domain)) return domainCache.get(domain);

  let deliverable;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), timeoutMs);
    deliverable = Array.isArray(mx) && mx.some((r) => r && r.exchange);
  } catch (err) {
    if (err.code && !HARD_DNS_ERRORS.has(err.code)) {
      deliverable = true; // transient lookup failure -> fail open
    } else {
      // No MX record: RFC 5321 allows delivery to the domain's A/AAAA record.
      try {
        const addrs = await withTimeout(
          dns.resolve4(domain).catch(() => dns.resolve6(domain)),
          timeoutMs,
        );
        deliverable = Array.isArray(addrs) && addrs.length > 0;
      } catch (err2) {
        deliverable = !!(err2.code && !HARD_DNS_ERRORS.has(err2.code)); // transient -> open
      }
    }
  }

  const result = { deliverable };
  domainCache.set(domain, result);
  return result;
}

// Returns { valid: boolean, reason: string }.
async function verifyEmail(email, { timeoutMs = 5000 } = {}) {
  const e = String(email == null ? '' : email).trim();
  if (!isValidSyntax(e)) return { valid: false, reason: 'malformed address' };
  const domain = e.split('@')[1].toLowerCase();
  const { deliverable } = await domainDeliverable(domain, timeoutMs);
  if (!deliverable) return { valid: false, reason: `no mail server for ${domain}` };
  return { valid: true, reason: 'ok' };
}

module.exports = { verifyEmail, isValidSyntax };
