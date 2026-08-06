'use strict';

// Who are we writing to, and are they the creator or someone acting for them?
//
// Every outbound reply opens "Hi {name}," and some prompts additionally talk
// ABOUT the creator in the third person ("Kam's kind words") when a manager or
// agent is the one corresponding. Both of those are wrong in an obvious,
// embarrassing way when the name is wrong, so this module resolves the name
// once, deterministically, and hands the callers a single answer plus the
// confidence-bearing flag that decides second- vs third-person phrasing.
//
// Three failures motivated the current shape:
//
//   1. "Hi Jennifer," on a reply from the creator Kam — Jennifer is OUR OWN
//      manager name. The detector scanned the tail of the message, and the tail
//      of any real reply is the quoted copy of the email being replied to,
//      ending in our "- Jennifer" sign-off. Fixed by resolving names from the
//      NEW message only (emailQuote.stripQuotedReply) and, as an independent
//      backstop, by never greeting anyone with a name that is ours.
//
//   2. Third-person phrasing about the person actually reading the email. The
//      "writing on X's behalf" wording used to trigger on any name that didn't
//      string-equal the stored first name — so "Kam" vs "Kamran", or a
//      misdetection, produced an email that talked about its own recipient in
//      the third person. Now it needs positive evidence of a delegate, and
//      short forms of the creator's own name resolve to the creator.
//
//   3. A wrong name persisting. creators.reply_salutation caches the greeting so
//      an offer email sent days later still addresses the right person; once
//      poisoned it kept being preferred over re-detection. sanitizeStored()
//      rejects a cached value that is ours / not a person, so the row heals
//      itself on the next send instead of repeating the mistake forever.

const { formatFirstName } = require('./nameFormat');
const { stripQuotedReply } = require('./emailQuote');

const ROLE_WORD =
  'manager|agent|assistant|team|talent|mgmt|management|rep|representative|partnerships?|agency|mcn';
const NAME = "([A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)"; // "Alex" or "Alex Chen"

function firstToken(name) {
  return String(name || '').trim().split(/\s+/)[0] || null;
}

// A real name, case-sensitively: each token starts with a capital. This is the
// guard against the case-insensitive trigger match capturing a common word
// (the `i` flag lets "thanks, sounds good" match "Thanks, <Name>", but the
// captured "sounds" keeps its lowercase and is rejected here).
function looksLikeName(s) {
  return /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/.test(String(s || '').trim());
}
// Return the captured name's first token only if it's genuinely capitalized.
function nameOf(m) {
  return m && looksLikeName(m[1]) ? firstToken(m[1]) : null;
}

// Words that can match the name patterns but never name a person.
const NOT_A_PERSON = new Set([
  'the', 'team', 'hi', 'hello', 'hey', 'manager', 'agent', 'influence', 'thanks',
]);

// Find the writer's first name in the text they actually typed.
//
// Quoted history is stripped FIRST and unconditionally: the signature at the
// bottom of a reply belongs to whoever wrote the email being quoted — usually
// us — and reading it is never the right answer to "who sent this?".
function detectSenderName(text) {
  if (!text) return null;
  const s = stripQuotedReply(String(text));
  if (!s) return null;

  // 1. Signature block at the tail of the message. Scan the last few non-empty
  //    lines and try each shape people actually use:
  //   • "- Alex" / "– Alex Chen" / "- Alex, Manager"
  //   • "Best, Alex" / "Thanks, Alex" — signoff + name on the SAME line
  //   • "Best,\nTang" — signoff on its own line, name on the FOLLOWING line
  //     (a two-line block is one of the most common sign-off shapes in the
  //     wild; missing it here defaults the greeting to the creator's name and
  //     produces "Hi Linn," on a reply from a manager named Tang).
  const SIGNOFFS = 'best|thanks|thank you|regards|cheers|warmly|sincerely';
  const signoffAloneRe = new RegExp(`^(?:${SIGNOFFS})[,!.]?$`, 'i');
  const dashNameRe = new RegExp(`^[-–—]\\s*${NAME}(?:\\s*,\\s*(?:the\\s+)?(?:${ROLE_WORD})\\b)?`, 'i');
  const signoffAndNameRe = new RegExp(`^(?:${SIGNOFFS})[,!]?\\s+${NAME}$`, 'i');
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-6);
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i];
    let m = line.match(dashNameRe);
    if (nameOf(m)) return nameOf(m);
    m = line.match(signoffAndNameRe);
    if (nameOf(m)) return nameOf(m);
    // Two-line signature: this line is a bare "Best," / "Thanks," / "Regards"
    // etc., and the next non-empty line is JUST a name ("Tang", "Alex Chen").
    // Require the following line to match looksLikeName exactly so we can't
    // pick up a body sentence, and skip stacked signoff words so
    // "Best,\nRegards\nAlex" still lands on "Alex".
    if (signoffAloneRe.test(line)) {
      for (let j = i + 1; j < tail.length; j++) {
        const nxt = tail[j];
        if (signoffAloneRe.test(nxt)) continue;
        if (looksLikeName(nxt)) return firstToken(nxt);
        break;
      }
    }
  }

  // 2. Self-introduction: "this is Alex", "I'm Alex", "I am Alex",
  //    "Alex here", "Alex from XYZ", "on behalf of ... , Alex".
  let m = s.match(new RegExp(`\\b(?:this is|i['’]?m|i am|it['’]?s)\\s+${NAME}`, 'i'));
  if (nameOf(m)) return nameOf(m);
  m = s.match(new RegExp(`\\b${NAME}\\s+here\\b`, 'i'));
  if (nameOf(m)) return nameOf(m);
  m = s.match(new RegExp(`\\b${NAME}[,]?\\s+(?:the\\s+)?(?:${ROLE_WORD})\\b`, 'i'));
  if (nameOf(m)) return nameOf(m);

  return null;
}

// Common role-mailbox local parts that read as an inbox, not a person
// ("info@…", "team@…", "partnerships@…"). If the sender is one of these we do
// NOT invent a name from it — we fall through to the creator's stored first
// name instead, since "Hi Info," is worse than mis-greeting by the creator.
const ROLE_MAILBOX_LOCALS = new Set([
  'info', 'hello', 'hi', 'team', 'support', 'contact', 'admin', 'sales',
  'billing', 'noreply', 'no-reply', 'notifications', 'help', 'office',
  'inquiries', 'inquiry', 'partnerships', 'partnership', 'management',
  'mgmt', 'talent', 'agency', 'brand', 'brands', 'collabs', 'collab',
  'press', 'pr', 'marketing', 'business', 'biz', 'hi5', 'me',
]);

// Turn an email address into a plausible first name derived from its local
// part. "claudia@x", "claudia.villondo@x", "claudia+work@x" → "Claudia".
// Strips digits and separators, formats through formatFirstName (which folds
// stylized fonts / decoration and title-cases), and returns only the first
// token so a first-last local part yields just the first name. Returns null
// when the local part is missing, is a role mailbox, or leaves nothing
// name-like behind.
function nameFromEmail(email) {
  if (!email) return null;
  // A From header often arrives as `Jennifer Max <jennifer@…>`; the address
  // inside the angle brackets is the part that carries the local name.
  const raw = bareAddress(email) || String(email).trim();
  const at = raw.indexOf('@');
  if (at <= 0) return null;
  let local = raw.slice(0, at);
  // "+tag" suffixes (Gmail plus-addressing) never carry the name.
  local = local.split('+')[0];
  if (ROLE_MAILBOX_LOCALS.has(local.toLowerCase())) return null;
  // Turn separators / digits into spaces so formatFirstName can split on them.
  local = local.replace(/[._\-]+/g, ' ').replace(/\d+/g, ' ').trim();
  if (!local) return null;
  const formatted = formatFirstName(local);
  const first = firstToken(formatted);
  if (!first) return null;
  if (ROLE_MAILBOX_LOCALS.has(first.toLowerCase())) return null;
  return first;
}

// ── Identity checks ────────────────────────────────────────────────────────

const norm = (v) => formatFirstName(v).toLowerCase();
const tokensOf = (v) => norm(v).split(/\s+/).filter(Boolean);

// Are these two names plausibly the SAME human?
//
// Exact match, a shared token ("Anvith" vs "Anvith K"), or a short form of the
// first token ("Kam" vs "Kamran", "Jen" vs "Jennifer"). The prefix rule can
// merge two genuinely different people who share a stem ("Ana" / "Anastasia"),
// and that trade is deliberate: merging costs us a greeting by the creator's
// own name, while splitting costs an email that discusses its own reader in the
// third person — the failure this whole module exists to prevent.
function isSamePerson(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const at = tokensOf(A);
  const bt = tokensOf(B);
  if (at.some((t) => bt.includes(t))) return true;
  const [a0, b0] = [at[0], bt[0]];
  if (!a0 || !b0) return false;
  const [short, long] = a0.length <= b0.length ? [a0, b0] : [b0, a0];
  return short.length >= 3 && short !== long && long.startsWith(short);
}

const bareAddress = (v) => {
  const m = String(v || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
  return m ? m[0].toLowerCase() : '';
};

// Every name that means US — the manager we sign as, the brand, and the owners
// of our sending mailboxes. A greeting can never be one of these: an email that
// opens by addressing its own sender is the single most obvious way for this
// system to look broken. `ourNames` / `ourEmails` let a caller add the
// per-creator sending mailbox (creators.instantly_email_account), which the
// environment doesn't know about.
function ourIdentityNames({ ourNames = [], ourEmails = [] } = {}) {
  const set = new Set(['influence']);
  const add = (v) => {
    const f = firstToken(formatFirstName(v));
    if (f) set.add(f.toLowerCase());
  };
  // Mirrors the manager-name resolution in negotiation.js / templates.js,
  // including their shared default — an unset env still signs "Jennifer".
  add(process.env.MANAGER_NAME || process.env.SENDER_NAME || 'Jennifer');
  add(process.env.SENDER_NAME);
  add(process.env.BRAND_NAME);
  for (const n of ourNames) add(n);
  for (const e of [...ourEmails, process.env.SENDER_EMAIL, process.env.INSTANTLY_EACCOUNT]) {
    const n = nameFromEmail(e);
    if (n) set.add(n.toLowerCase());
  }
  return set;
}

function ourAddresses({ ourEmails = [] } = {}) {
  const set = new Set();
  for (const e of [...ourEmails, process.env.SENDER_EMAIL, process.env.INSTANTLY_EACCOUNT]) {
    const a = bareAddress(e);
    if (a) set.add(a);
  }
  return set;
}

// Is this name unusable as a greeting — a filler word, or our own identity?
// Checked only AFTER isSamePerson has ruled out the creator, so a creator who
// really is named Jennifer is still greeted by her name.
function isUnusableName(name, opts) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  if (NOT_A_PERSON.has(n)) return true;
  return ourIdentityNames(opts).has(n);
}

// Positive evidence that someone OTHER than the creator is corresponding, which
// is what licenses third-person phrasing about the creator. A different name on
// its own is not evidence — people sign with nicknames, and our own detection
// can be wrong. We require either an explicit statement of the relationship or
// a different sending address.
const ON_BEHALF_RE = new RegExp(
  `(?:\\bon behalf of\\b)|(?:\\b(?:i|we)\\s+(?:manage|represent|handle|look after|work with|work for)\\b)|(?:\\b(?:${ROLE_WORD})\\b)`,
  'i',
);
function hasDelegateEvidence(message, { senderEmail, creatorEmail }) {
  const senderNorm = bareAddress(senderEmail);
  const creatorNorm = bareAddress(creatorEmail);
  if (senderNorm && creatorNorm && senderNorm !== creatorNorm) return true;
  return ON_BEHALF_RE.test(String(message || ''));
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve who to greet on a reply.
 *
 * Returns `{ name, isDelegate, source }`:
 *   • name       — the greeting name, never empty ("there" when nothing is known)
 *   • isDelegate — true only with positive evidence that the writer is someone
 *                  other than the creator. Drives third-person phrasing about
 *                  the creator; when false, the email addresses its reader
 *                  directly as "you".
 *   • source     — which signal won, for logs and tests.
 *
 * Options: `senderEmail` / `creatorEmail` (the inbound's actual From vs the
 * creator's stored address) and `ourNames` / `ourEmails` (extra identities of
 * ours, e.g. the per-creator sending mailbox).
 */
function resolveSalutation(creatorFirstName, inboundText, opts = {}) {
  const fullCreatorName = formatFirstName(creatorFirstName) || null;
  const creatorToken = firstToken(fullCreatorName);
  const { senderEmail = null, creatorEmail = null } = opts;
  const message = stripQuotedReply(inboundText);
  const creatorResult = (source) => ({
    name: fullCreatorName || 'there',
    isDelegate: false,
    source,
  });

  // 1. A signature or self-introduction in the text they actually typed.
  const sender = detectSenderName(message);
  if (sender) {
    if (isSamePerson(sender, fullCreatorName)) {
      // The creator themselves. Greet by the stored name so a multi-word
      // first_name ("Anvith K") stays intact — unless they signed a SHORTER
      // form of it ("Kam" for "Kamran"), which is how they want to be called.
      const signedShortForm = creatorToken && sender.length < creatorToken.length;
      return {
        name: signedShortForm ? sender : fullCreatorName || sender,
        isDelegate: false,
        source: signedShortForm ? 'signature_short_form' : 'signature_creator',
      };
    }
    if (!isUnusableName(sender, opts)) {
      return {
        name: sender,
        isDelegate: hasDelegateEvidence(message, { senderEmail, creatorEmail }),
        source: 'signature',
      };
    }
    // The only name in the message is ours (the classic case: quoted history we
    // failed to strip) or a filler word — ignore it and keep resolving.
  }

  // 2. No usable signature name. If the reply came from a different address
  //    than the creator's own — a manager/agent inbox — greet by that inbox's
  //    owner rather than the creator. Same-address (or unknown-address) replies
  //    keep the creator-name fallback so a creator writing without a signature
  //    still gets their stored first_name.
  const senderNorm = bareAddress(senderEmail) || String(senderEmail || '').trim().toLowerCase();
  const creatorNorm = bareAddress(creatorEmail) || String(creatorEmail || '').trim().toLowerCase();
  if (senderNorm && senderNorm !== creatorNorm && !ourAddresses(opts).has(senderNorm)) {
    const emailName = nameFromEmail(senderEmail);
    if (emailName) {
      if (isSamePerson(emailName, fullCreatorName)) return creatorResult('sender_email_creator');
      if (!isUnusableName(emailName, opts)) {
        return { name: emailName, isDelegate: true, source: 'sender_email' };
      }
    }
  }

  // 3. The creator's own stored name, and "there" only when nothing is known.
  return creatorResult(fullCreatorName ? 'creator' : 'unknown');
}

// Back-compat: the greeting name alone.
function salutationFor(creatorFirstName, inboundText, opts = {}) {
  return resolveSalutation(creatorFirstName, inboundText, opts).name;
}

/**
 * Vet a greeting name cached on creators.reply_salutation before reusing it.
 *
 * The cache exists so an offer email sent after the inbound text has been
 * consumed still greets the right person — but a cached WRONG name repeats
 * forever, which is how one bad detection turned into a recurring bug. A value
 * that is our own name, a filler word, or the "there" placeholder is dropped so
 * the caller re-resolves from scratch. Anything else is returned verbatim,
 * including admin-typed names we shouldn't second-guess.
 */
function sanitizeStored(stored, creatorFirstName, opts = {}) {
  const raw = String(stored == null ? '' : stored).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'there') return null; // placeholder, not a name
  if (!/\p{L}/u.test(raw)) return null;
  // A creator genuinely named like us keeps their name; anyone else matching our
  // identity is the misdetection this guard exists for.
  if (isSamePerson(raw, creatorFirstName)) return raw;
  if (isUnusableName(firstToken(raw), opts)) return null;
  return raw;
}

module.exports = {
  resolveSalutation,
  salutationFor,
  sanitizeStored,
  detectSenderName,
  nameFromEmail,
  isSamePerson,
  ourIdentityNames,
  NOT_A_PERSON,
  ROLE_WORD,
};
