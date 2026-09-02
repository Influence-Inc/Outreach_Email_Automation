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

// The brief stage asks a soft INTEREST question ("interested in hearing more?
// Reply Yes or No"), not a binding accept — so it reads a wider set of casual
// affirmatives ("sure", "ok", "tell me more", "how much?") as interested, and
// their negatives as not. A real creator rarely types the exact word "yes"; the
// strict classifyReply (used at the binding accept/decline stage) would send too
// many of them to the clarification nudge. Returns 'accept' (interested) |
// 'decline' (not) | 'other' (ambiguous → a Yes/No nudge, never a wrong reveal).
const INTEREST_YES = [
  'yes', 'yea', 'yeah', 'yep', 'yup', 'ya', 'sure', 'ok', 'okay', 'okk',
  'interested', 'definitely', 'absolutely', 'sounds good', 'sounds great',
  'tell me more', 'more details', 'more info', 'how much', 'whats the rate',
  "what's the rate", 'go ahead', 'lets go', "let's go", 'im in', "i'm in", 'in',
];
// Unambiguous multi-word declines — these can't be affirmations, so they win
// even though some ("not interested") contain a yes-word substring ("interested").
const INTEREST_NO_STRONG = [
  'not interested', 'no thanks', 'no thank you', 'not right now', 'not now',
  'maybe later', 'not a fit', "i'll pass", 'ill pass',
];
const INTEREST_NO_WORDS = ['no', 'nope', 'nah', 'pass'];
function classifyInterest(body) {
  const text = String(body || '').trim().toLowerCase();
  if (!text) return 'other';

  // A clear multi-word decline settles it up front.
  if (INTEREST_NO_STRONG.some((w) => containsPhrase(text, w))) return 'decline';

  const hasYes = INTEREST_YES.some((w) => containsPhrase(text, w));
  const hasNo = INTEREST_NO_WORDS.some((w) => containsPhrase(text, w));

  // Bare yes/no signals: only act when exactly one is present. A false "decline"
  // would close a live deal, so anything genuinely mixed falls to 'other' (a
  // harmless Yes/No nudge) rather than guessing.
  if (hasNo && !hasYes) return 'decline';
  if (hasYes && !hasNo) return 'accept';
  return 'other';
}

// Canonical bodies — used by both the offer response follow-up and the inbound
// WhatsApp/iMessage handler. The acceptance message follows the approved
// reference copy ("We'll be sharing the creative brief shortly.").
// House style for every creator-facing message below: short sentences, one idea
// per line, a blank line between what happened and what happens next, and at
// most one emoji — reserved for genuine milestones (a confirmed deal), never as
// decoration. Reads like a brand's messaging channel, not a mail merge.
function thankYouMessage(firstName) {
  return `That's confirmed, ${firstName} — great to have you on board. 🎉\n\nWe'll send your content brief shortly with everything you need to get started.`;
}

function politeCloseMessage(firstName) {
  return `No problem at all, ${firstName} — thanks for letting us know.\n\nWe'll keep you in mind for future collaborations.`;
}

// Sent when a creator declines specifically because this collaboration isn't a
// fit (decline reason "Not a fit") — a warmer, forward-looking close than the
// generic politeCloseMessage: we'll come back when there's a better match.
function notAFitCloseMessage(firstName) {
  return `Completely understand, ${firstName} — thanks for taking a look.\n\nThis one may not be the right match, but we'll be in touch when we have a campaign that suits you better.`;
}

// Brand/product brief sent the moment a creator first replies — BEFORE the
// actual rate/deliverables (see offers.messaging_stage). brandBlurb is already
// resolved by the caller (the campaign's custom messaging_brief, placeholder-
// filled, or a generic brand-name-only fallback); this just wraps it with a
// greeting and the interest yes/no CTA.
// Does the copy already open with its own greeting? A campaign's custom
// messaging_brief is usually written as a complete message and starts with
// "Hi {firstName}," — prepending ours on top of it went out as
// "Hi Sam, this is INFLUENCE. Hi Sam, …", which reads like a broken mail merge.
function startsWithGreeting(text, firstName) {
  const head = String(text || '').trimStart().slice(0, 80).toLowerCase();
  if (/^(hi|hey|hello|dear|good (morning|afternoon|evening))\b/.test(head)) return true;
  const name = String(firstName || '').trim().toLowerCase();
  return !!name && head.startsWith(name);
}

// The brief the creator sees first — greeting + brand context, sent as its OWN
// message. Kept apart from the interest question (INTEREST_QUESTION, below)
// rather than one long paragraph: a person pitching a partnership sends the
// pitch, waits, then asks if you're interested — not both in one breath. It
// also means the buttons on the second message sit right next to the question
// they answer, not scrolled away under a wall of brand copy.
function renderBriefIntro(firstName, brandBlurb) {
  const blurb = String(brandBlurb || '').trim();
  return startsWithGreeting(blurb, firstName) ? blurb : `Hi ${firstName}, this is INFLUENCE.\n\n${blurb}`;
}

// The second message: a standalone interest question. On WhatsApp Cloud it
// carries tappable buttons (INTEREST_BUTTONS); sendWhatsAppChoice appends
// INTEREST_FALLBACK_HINT only where buttons aren't available.
const INTEREST_QUESTION = 'Interested in hearing more?';

// Tappable reply options. The TITLE is what the creator taps and also what Meta
// echoes back as the inbound message body, so every title must classify to the
// intent it promises — classifyInterest for the brief stage, classifyReply for
// the binding accept/decline. replies.buttons.test.js pins exactly that, so a
// reworded button can never silently start meaning the opposite.
const INTEREST_BUTTONS = [
  { id: 'interest_yes', title: 'Yes, tell me more' },
  { id: 'interest_no', title: 'Not right now' },
];
const INTEREST_FALLBACK_HINT = 'Reply Yes or No.';

const OFFER_BUTTONS = [
  { id: 'offer_accept', title: 'Accept offer' },
  { id: 'offer_decline', title: 'Decline' },
];
const OFFER_FALLBACK_HINT = 'Reply Accept or Decline, or open the link above for the full details.';

// Sent when a reply to the brief (awaiting a yes/no on INTEREST, not yet a rate
// decision) doesn't classify as either. A stage-appropriate nudge — the
// creator just needs to pick Yes or No, so this is what they get instead of
// no reply at all.
function interestClarificationMessage(firstName) {
  return `No problem, ${firstName} — just let us know.\n\nYes if you'd like to hear the details, or No if now isn't the right time.`;
}

// Sent when a creator replies to the invite email before an offer has been
// priced (no offer exists yet). A warm holding reply — the admin is flagged to
// price the offer, whose brief then follows on this same channel — instead of
// the generic support deflection, which would read as a brush-off to someone
// who just reached out as asked.
function firstContactHoldingMessage(firstName) {
  return `Great to hear from you, ${firstName}.\n\nWe're putting your collaboration details together and will share them here shortly.`;
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
  classifyInterest,
  parseRequestedRate,
  isOptOut,
  isOptIn,
  thankYouMessage,
  politeCloseMessage,
  notAFitCloseMessage,
  tooHighReply,
  renderBriefIntro,
  INTEREST_QUESTION,
  startsWithGreeting,
  interestClarificationMessage,
  firstContactHoldingMessage,
  INTEREST_BUTTONS,
  INTEREST_FALLBACK_HINT,
  OFFER_BUTTONS,
  OFFER_FALLBACK_HINT,
  OPT_OUT_CONFIRMATION,
  OPT_IN_CONFIRMATION,
};
