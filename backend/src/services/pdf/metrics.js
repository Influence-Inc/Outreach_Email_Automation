'use strict';

// Font metrics + text encoding for the PDF writer.
//
// The generated contract PDF uses only the three Helvetica variants from the
// PDF standard-14 font set. Those fonts are guaranteed to be present in every
// PDF viewer, so nothing has to be embedded — which is what keeps this whole
// module dependency-free. The catch is that the writer must know each glyph's
// advance width itself in order to wrap lines, so the Adobe AFM width tables
// are transcribed below.
//
// Widths are in 1/1000 of an em (the PDF glyph space unit), indexed by
// WinAnsiEncoding code point starting at 32 (space). A string's width at font
// size S is therefore sum(widths) * S / 1000.

// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
  556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
  350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

// prettier-ignore
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
  556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
  350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

// Helvetica-Oblique shares Helvetica's advance widths exactly (the AFM tables
// are identical — only the glyph outlines are slanted), so it reuses the table.
const WIDTHS = {
  helvetica: HELVETICA,
  bold: HELVETICA_BOLD,
  italic: HELVETICA,
};

// PDF base font names, keyed by the short names used throughout the writer.
const BASE_FONTS = {
  helvetica: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
};

// WinAnsiEncoding differs from Latin-1 only in 0x80–0x9F, where Windows put
// typographic glyphs instead of the C1 control codes. Contract text routinely
// carries em dashes, curly quotes and bullets from the negotiation thread, so
// those have to survive into the PDF rather than degrading to "?".
const WIN_ANSI_HIGH = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// Characters with no WinAnsi glyph that nonetheless have an obvious ASCII
// stand-in. Mapping them beats printing "?" in the middle of a payment term.
const ASCII_FALLBACK = new Map([
  [0x00a0, 0x20], // non-breaking space
  [0x2007, 0x20], // figure space
  [0x202f, 0x20], // narrow no-break space
  [0x2212, 0x2d], // minus sign
  [0x2010, 0x2d], [0x2011, 0x2d], // hyphens
  [0x2032, 0x27], // prime
  [0x2033, 0x22], // double prime
]);

// Encode a JS string to a WinAnsi byte array. Astral-plane characters (emoji,
// which creators do put in their names) have no WinAnsi glyph at all and are
// dropped rather than rendered as a pair of mojibake bytes.
function encodeWinAnsi(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) {
      out.push(0x20);
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out.push(cp);
    } else if (WIN_ANSI_HIGH.has(cp)) {
      out.push(WIN_ANSI_HIGH.get(cp));
    } else if (ASCII_FALLBACK.has(cp)) {
      out.push(ASCII_FALLBACK.get(cp));
    } else if (cp >= 0xa0 && cp <= 0xff) {
      out.push(cp);
    } else if (cp > 0xffff) {
      // Astral (emoji, rare CJK extensions) — no representable glyph.
    } else {
      out.push(0x3f); // '?'
    }
  }
  return out;
}

function widthTable(font) {
  return WIDTHS[font] || WIDTHS.helvetica;
}

// Width of `text` in points at `size`, for the given short font name.
function stringWidth(text, font, size) {
  const table = widthTable(font);
  let mils = 0;
  for (const byte of encodeWinAnsi(text)) {
    // Codes below 32 never survive encodeWinAnsi, so the offset is always valid.
    mils += table[byte - 32] || 0;
  }
  return (mils * size) / 1000;
}

// Break `text` into lines that each fit within `maxWidth`. Words longer than
// the measure (an unspaced URL, a 40-character bank reference) are split
// mid-word rather than allowed to bleed into the margin.
function wrapText(text, font, size, maxWidth) {
  const source = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const lines = [];
  let line = '';

  const pushLine = () => {
    if (line) lines.push(line);
    line = '';
  };

  const hardSplit = (word) => {
    let chunk = '';
    for (const ch of word) {
      if (chunk && stringWidth(chunk + ch, font, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk;
  };

  for (const word of source.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (stringWidth(candidate, font, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    pushLine();
    line = stringWidth(word, font, size) <= maxWidth ? word : hardSplit(word);
  }
  pushLine();
  return lines;
}

module.exports = {
  BASE_FONTS,
  encodeWinAnsi,
  stringWidth,
  wrapText,
};
