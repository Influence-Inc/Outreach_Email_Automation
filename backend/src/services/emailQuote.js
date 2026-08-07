'use strict';

// Split an inbound email into the NEW message the person just typed and the
// QUOTED earlier thread their mail client appended underneath it.
//
// Why this matters beyond cosmetics: every reply Gmail/Outlook/Apple Mail sends
// carries our own previous email below the new text, signature and all. Any
// code that reads "the tail of the message" — sender-name detection, gist
// summaries, learned examples — otherwise reads OUR words instead of theirs.
// That is exactly how a reply from the creator Kam got greeted "Hi Jennifer,":
// the last lines of the message were the "- Jennifer" sign-off inside the
// quoted copy of the email he was replying to.
//
// The split is deliberately conservative — a missed boundary only leaves extra
// context behind, but a false one would silently delete what the creator wrote.
// Callers that must never end up with an empty string use stripQuotedReply(),
// which falls back to the original text when the split leaves nothing.

// ── Boundary markers ───────────────────────────────────────────────────────

// "On Thu, 6 Aug 2026 at 22:21, Jennifer Max <jennifer@…> wrote:" and its
// localized equivalents. Gmail hard-wraps this line, so we also try joining it
// with the next couple of lines before deciding (see findAttribution).
const ATTRIB_OPENER = /^\s*(?:on|le|el|am|op|den|il)\b/i;
const ATTRIB_TAIL = /(?:wrote|a écrit|écrit|escribió|escribio|schrieb|schreef|napisał\(a\))\s*:\s*$/i;

// Forward / "original message" separators every client spells its own way.
const SEPARATORS = [
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^\s*begin forwarded message:\s*$/i,
  /^\s*-{2,}\s*(?:reply above this line|please reply above)\b/i,
];

// Outlook desktop separates the quote with a run of underscores followed by the
// original message's headers. The underscores alone are too weak a signal
// (people do use ASCII rules), so a header block has to follow — see isDivider.
const UNDERSCORE_DIVIDER = /^\s*_{5,}\s*$/;

// The quoted message's own header block ("From: … / Sent: … / To: …"), which
// both Outlook and forwarded mail emit as plain text.
const HEADER_FROM = /^\s*(?:from|de|von|van)\s*:\s*\S/i;
const HEADER_FOLLOW =
  /^\s*(?:sent|date|to|cc|bcc|subject|reply-to|envoyé|para|asunto|fecha|gesendet|an|betreff|verzonden|aan|onderwerp)\s*:/i;

// Mail-client footers. Not quoted history, but the same kind of noise: they sit
// below the sign-off and would otherwise be the last line a tail scan sees.
const CLIENT_TRAILERS = [
  /^\s*sent from my \S+/i,
  /^\s*sent from (?:mail|outlook|yahoo|windows|samsung|my mobile)\b/i,
  /^\s*get outlook for (?:ios|android)\b/i,
];

// HTML containers clients wrap the quote in, when the body arrives as HTML
// rather than text.
const HTML_QUOTE_MARKERS = [
  /<blockquote[\s>]/i,
  /<div[^>]*class="?[^">]*gmail_quote/i,
  /<div[^>]*id="?(?:appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)/i,
  /<hr[^>]*id="?stopSpelling/i,
];

// ── HTML → text ────────────────────────────────────────────────────────────
// Small, dependency-free flattening of an HTML body. Block tags become newlines
// so line-oriented boundary detection still works on a converted body.
function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function looksLikeHtml(s) {
  return /<(?:div|p|br|blockquote|table|span)\b/i.test(s);
}

// ── Boundary helpers ───────────────────────────────────────────────────────

// Is `lines[i]` the start of an "On … wrote:" attribution? Returns true for the
// single-line form and for the wrapped form, where the opener and the trailing
// "wrote:" land on different lines. Requires a digit or an email address in the
// joined text so an ordinary sentence starting with "On" ("On Monday I can
// shoot, wrote a script already:") can't trigger it.
function isAttribution(lines, i) {
  if (!ATTRIB_OPENER.test(lines[i])) return false;
  let joined = lines[i];
  for (let n = 0; n <= 2; n++) {
    if (n > 0) {
      if (i + n >= lines.length) break;
      joined = `${joined} ${lines[i + n].trim()}`;
    }
    if (joined.length > 400) break;
    if (ATTRIB_TAIL.test(joined) && /\d|@/.test(joined)) return true;
  }
  return false;
}

// Is `lines[i]` a quoted message's header block — a "From:" line backed up by at
// least one more header (Sent/Date/To/Subject) within the next few lines? The
// corroborating line is what keeps a creator writing "From: my end this all
// looks good" out of the boundary set.
function isHeaderBlock(lines, i) {
  if (!HEADER_FROM.test(lines[i])) return false;
  let seen = 0;
  for (let j = i + 1; j < lines.length && seen < 4; j++) {
    if (!lines[j].trim()) continue;
    seen++;
    if (HEADER_FOLLOW.test(lines[j])) return true;
  }
  return false;
}

// Outlook's underscore rule, only when the quoted headers really do follow it.
function isDivider(lines, i) {
  if (!UNDERSCORE_DIVIDER.test(lines[i])) return false;
  let seen = 0;
  for (let j = i + 1; j < lines.length && seen < 3; j++) {
    if (!lines[j].trim()) continue;
    seen++;
    if (HEADER_FROM.test(lines[j]) || isAttribution(lines, j)) return true;
  }
  return false;
}

function isSeparator(line) {
  return SEPARATORS.some((re) => re.test(line));
}

function isClientTrailer(line) {
  return CLIENT_TRAILERS.some((re) => re.test(line));
}

// ── Split ──────────────────────────────────────────────────────────────────

/**
 * Split a raw email body into `{ latest, quoted }`.
 *
 * `latest` keeps the sender's OWN signature — that sign-off is precisely what
 * sender-name detection needs — and drops everything from the first quote
 * boundary onward. `quoted` is that remainder, kept (rather than discarded) so
 * callers can still show or reason about the history when they want to.
 *
 * Lines that are `>`-quoted are removed in place rather than treated as a hard
 * boundary, so an inline "reply between the quotes" keeps the replier's text.
 */
function splitQuotedReply(raw) {
  const original = raw == null ? '' : String(raw);
  if (!original.trim()) return { latest: '', quoted: '' };

  let s = original.replace(/\r\n?/g, '\n');
  let htmlTail = '';

  // HTML bodies: cut at the quote container first, then flatten to text. Doing
  // it in this order matters — flattening first would lose the container tags
  // that mark where the quote begins.
  if (looksLikeHtml(s)) {
    let cut = -1;
    for (const re of HTML_QUOTE_MARKERS) {
      const m = s.match(re);
      if (m && m.index != null && (cut === -1 || m.index < cut)) cut = m.index;
    }
    if (cut > -1) {
      htmlTail = htmlToText(s.slice(cut));
      s = s.slice(0, cut);
    }
    s = htmlToText(s);
  }

  const lines = s.split('\n');
  const kept = [];
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      isSeparator(line) ||
      isAttribution(lines, i) ||
      isHeaderBlock(lines, i) ||
      isDivider(lines, i) ||
      isClientTrailer(line)
    ) {
      boundary = i;
      break;
    }
    if (/^\s*>/.test(line)) continue; // inline quote — drop the line, keep reading
    kept.push(line);
  }

  const quotedLines = boundary === -1 ? [] : lines.slice(boundary);
  const quoted = [quotedLines.join('\n'), htmlTail].filter((p) => p && p.trim()).join('\n').trim();
  return { latest: kept.join('\n').trim(), quoted };
}

/**
 * The new message only, guaranteed non-empty when the input was non-empty.
 *
 * Some clients top-post in a shape we can't parse, or quote the whole thing —
 * in those cases keeping the original text is strictly better than handing a
 * caller nothing, so the split result is only used when it has content.
 */
function stripQuotedReply(raw) {
  const original = raw == null ? '' : String(raw).replace(/\r\n?/g, '\n');
  const { latest } = splitQuotedReply(original);
  return latest || original.trim();
}

module.exports = { splitQuotedReply, stripQuotedReply, htmlToText };
