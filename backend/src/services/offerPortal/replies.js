'use strict';

// Offer-portal inbound reply classifier ("bot") + canonical follow-up message
// bodies. Ported from Influence-CDB-portal (src/lib/replies.ts). Keyword matching
// is intentionally simple; anything ambiguous defaults to `other` and is
// surfaced to a human (needs_review). Used by the WhatsApp + iMessage inbound
// webhooks so an old creator can accept/decline the offer by replying.

const DECLINE_REASONS = ['Budget', 'Timing', 'Not a fit'];

const ACCEPT_WORDS = ['yes', 'accept', 'accepted', 'confirm', 'in'];
const DECLINE_WORDS = ['no', 'decline', 'pass', 'not interested'];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word/phrase match so "in" doesn't trip on "instagram" and "no" doesn't
// trip on "not interested" (which has its own decline phrase).
function containsPhrase(text, phrase) {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`).test(text);
}

// Returns 'accept' | 'decline' | 'other'.
function classifyReply(body) {
  const text = String(body || '').trim().toLowerCase();
  if (!text) return 'other';

  const hasAccept = ACCEPT_WORDS.some((w) => containsPhrase(text, w));
  const hasDecline = DECLINE_WORDS.some((w) => containsPhrase(text, w));

  // Either none or both → human review. Drift-avoiding default.
  if (hasAccept && !hasDecline) return 'accept';
  if (hasDecline && !hasAccept) return 'decline';
  return 'other';
}

// Canonical bodies — used by both the offer response follow-up and the inbound
// WhatsApp/iMessage handler. The acceptance message follows the approved
// reference copy ("We'll be sharing the creative brief shortly.").
function thankYouMessage(firstName) {
  return `Thanks for accepting, ${firstName}. We are looking forward to working with you on this one. We'll be sharing the creative brief shortly.`;
}

function politeCloseMessage(firstName) {
  return `No problem at all, ${firstName}. Thanks for letting us know. We will keep you in mind for future opportunities. Have a great day.`;
}

const DEFLECTION_MESSAGE =
  'Thanks for the message. For any questions or doubts, please contact our support team at jennifer@useinfluence.xyz and they will get back to you.';

// Brand/product brief sent the moment a creator first replies — BEFORE the
// actual rate/deliverables (see offers.messaging_stage). brandBlurb is already
// resolved by the caller (the campaign's custom messaging_brief, placeholder-
// filled, or a generic brand-name-only fallback); this just wraps it with a
// greeting and the interest yes/no CTA.
function renderMessagingBrief(firstName, brandBlurb) {
  return `Hi ${firstName}, this is INFLUENCE. ${brandBlurb} Interested in hearing more? Reply Yes or No.`;
}

// Sent when a reply to the brief (awaiting a yes/no on INTEREST, not yet a rate
// decision) doesn't classify as either. A stage-appropriate nudge instead of
// the generic DEFLECTION_MESSAGE, which points to human support and would be a
// non-sequitur here — the creator just needs to pick Yes or No.
function interestClarificationMessage(firstName) {
  return `Thanks, ${firstName}! Just let us know — reply Yes if you'd like to hear the details, or No if you're not interested right now.`;
}

// Extract a counter-rate ask from a free-text reply ("can you do $500?",
// "how about 750", "$1,200"). Returns the number, or null when there's no clear
// monetary ask (so the caller falls back to human review). Deliberately
// conservative: a bare small number like "2" ("2 reels") is NOT treated as a rate.
function parseRequestedRate(body) {
  const text = String(body || '');

  // Currency-marked amount: $500, 500 usd, ₹5,000, rs 5000, 750 dollars.
  const marked = text.match(
    /(?:\$|₹|usd|inr|rs\.?)\s*([\d][\d,]*(?:\.\d+)?)|([\d][\d,]*(?:\.\d+)?)\s*(?:dollars?|usd|inr|rupees?|rs\.?)/i,
  );
  if (marked) {
    const n = Number((marked[1] || marked[2]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }

  // The whole message is just a number ("500", "1,200").
  const only = text.trim().replace(/[,$₹]/g, '');
  if (/^\d+(?:\.\d+)?$/.test(only)) {
    const n = Number(only);
    if (Number.isFinite(n) && n >= 50) return n;
  }

  // A number alongside price-intent words ("how about 750", "do 600 for it").
  if (/\b(do|about|for|rate|price|pay|paid|budget|counter|quote|offer|charge)\b/i.test(text)) {
    const m = text.match(/\b(\d[\d,]{1,})(?:\.\d+)?\b/);
    if (m) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n >= 50) return n;
    }
  }
  return null;
}

// Sent when a counter-rate ask is above the CPM ceiling (negotiateBudget returns
// 'too_high'): the original offer stays live at its rate.
function tooHighReply(firstName, currentRateFormatted) {
  return `Thanks ${firstName}. That's a bit beyond our budget for this campaign${
    currentRateFormatted ? ` — the current offer stands at ${currentRateFormatted}` : ''
  }. It's still live if you'd like to go ahead, and we'd love to work with you.`;
}

// STOP/UNSUBSCRIBE opt-out + START opt-in (SMS/WhatsApp compliance). Match the
// canonical single keyword exactly (so "stop by anytime" is NOT an opt-out), plus
// the unmistakable "unsubscribe" / "opt out" phrasing anywhere in the message.
function normalizeKeyword(body) {
  return String(body || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/, '');
}
const OPT_OUT_EXACT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out']);
const OPT_IN_EXACT = new Set(['start', 'unstop', 'resume', 'subscribe', 'optin', 'opt in', 'opt-in']);

function isOptOut(body) {
  const t = normalizeKeyword(body);
  if (!t) return false;
  if (OPT_OUT_EXACT.has(t)) return true;
  return /\bunsubscribe\b/.test(t) || /\bopt[\s-]?out\b/.test(t);
}
function isOptIn(body) {
  const t = normalizeKeyword(body);
  if (!t) return false;
  if (OPT_IN_EXACT.has(t)) return true;
  return /\bopt[\s-]?in\b/.test(t);
}

const OPT_OUT_CONFIRMATION =
  "You've been unsubscribed and won't receive further messages from INFLUENCE. Reply START at any time to resume.";
const OPT_IN_CONFIRMATION =
  "You're re-subscribed to INFLUENCE messages. Reply STOP at any time to unsubscribe.";

module.exports = {
  DECLINE_REASONS,
  classifyReply,
  parseRequestedRate,
  isOptOut,
  isOptIn,
  thankYouMessage,
  politeCloseMessage,
  tooHighReply,
  renderMessagingBrief,
  interestClarificationMessage,
  DEFLECTION_MESSAGE,
  OPT_OUT_CONFIRMATION,
  OPT_IN_CONFIRMATION,
};
