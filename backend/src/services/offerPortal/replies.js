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

module.exports = {
  DECLINE_REASONS,
  classifyReply,
  thankYouMessage,
  politeCloseMessage,
  DEFLECTION_MESSAGE,
};
