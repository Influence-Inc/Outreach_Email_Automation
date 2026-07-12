'use strict';

// Instagram display names are frequently decorated in ways that read as
// obvious bot output when dropped verbatim into a "Hi {firstName}," greeting:
//   - ALL CAPS:          "PEAR"
//   - all lowercase:     "taoagou"
//   - stylized fonts:    "ᴠᴇʀᴍᴏꜱᴀ" (small caps), "𝓙𝓪𝓷𝓮" (script), "Ｊａｎｅ" (fullwidth)
//   - wrapped in emoji / symbols: "🤍 Gayatri", "★ 🖇️  Najwa Q  ◟♡ ˒"
//
// formatFirstName rewrites a raw name the way a person would actually type it:
// plain letters with one capital per word ("Pear", "Vermosa", "Gayatri",
// "Najwa Q"), while PRESERVING legitimate accents ("José") and multi-word
// names / trailing initials ("Anvith K" stays "Anvith K"). Returns '' when
// nothing name-like survives, so callers can fall back (e.g. to the @handle).

// Latin small-capital letters live in Unicode blocks (Phonetic Extensions,
// etc.) that have NO compatibility decomposition, so NFKC leaves them
// untouched — map them to plain capitals by hand. This is the common
// small-caps "font" pasted into IG bios.
const SMALL_CAPS = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E',
  'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J',
  'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O',
  'ᴘ': 'P', 'ꞯ': 'Q', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T',
  'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};

function mapStylizedLetters(s) {
  let out = '';
  for (const ch of s) out += SMALL_CAPS[ch] || ch;
  return out;
}

// Case a single un-delimited part of a name. A part that is UNIFORM — all
// caps ("PEAR") or all lowercase ("taoagou") — carries no casing intent, so we
// title-case it (first letter up, rest down). A part that is already MIXED
// case ("McKenzie", "DeShawn", "iZzy") was deliberately styled by a human, so
// we keep its internal capitals and only guarantee the first letter is capital.
// Spread into code points so a leading accented/astral char counts as one.
function titleCasePart(part) {
  const chars = [...part];
  if (chars.length === 0) return part;
  const hasUpper = /\p{Lu}/u.test(part);
  const hasLower = /\p{Ll}/u.test(part);
  const rest =
    hasUpper && hasLower
      ? chars.slice(1).join('') // intentional mixed case — preserve as typed
      : chars.slice(1).join('').toLocaleLowerCase();
  return chars[0].toLocaleUpperCase() + rest;
}

// Case a whole word. Split on hyphen/apostrophe boundaries (keeping the
// delimiters) so each part is cased on its own: "mary-jane" → "Mary-Jane",
// "o'brien" → "O'Brien". A name with no such delimiter ("McKenzie") is a
// single part and keeps its internal capital via titleCasePart.
function titleCaseWord(w) {
  return w
    .split(/([-'])/)
    .map((seg) => (seg === '-' || seg === "'" ? seg : titleCasePart(seg)))
    .join('');
}

function formatFirstName(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // 1) Drop zero-width joiners / variation selectors so emoji sequences don't
  //    leave orphaned combining code points glued onto a real letter.
  s = s.replace(/[︀-️​-‍⁠﻿]/g, '');
  // 2) Fold stylized fonts to plain letters: small-caps map first, then NFKC
  //    (handles Mathematical Alphanumeric bold/italic/script, fullwidth,
  //    circled letters, …) while keeping accented letters composed ("é").
  s = mapStylizedLetters(s).normalize('NFKC');
  // 3) Replace anything that isn't a letter, a combining mark (accents), an
  //    intra-word apostrophe/hyphen, or whitespace with a space — this strips
  //    emoji, ★, ♡, and other decoration and lets word-splitting isolate the
  //    real name from the junk around it.
  s = s.replace(/[^\p{L}\p{M}\s'-]/gu, ' ');
  // 4) Split, trim stray leading/trailing apostrophes/hyphens off each token,
  //    drop tokens with no letters left, and title-case what remains.
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => /\p{L}/u.test(w))
    .map(titleCaseWord)
    .join(' ');
}

module.exports = { formatFirstName };
