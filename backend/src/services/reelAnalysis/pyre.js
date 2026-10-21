'use strict';

// Python `re` / `str` behaviour the creator-list ports rely on. Python's \w, \d and \b are
// Unicode-aware in str patterns; JavaScript's are ASCII-only even with the `u` flag, so a
// caption in Hindi or with accents would split into different words. `py()` rewrites a
// pattern written in Python syntax to the JavaScript equivalent.

const W = '\\p{L}\\p{N}_';
const WB = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;

function py(src, flags = '') {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      i++;
      if (n === 'w') out += inClass ? W : `[${W}]`;
      else if (n === 'W') out += inClass ? '\\P{L}' : `[^${W}]`; // never used inside a class here
      else if (n === 'd') out += '\\p{Nd}';
      else if (n === 'b' && !inClass) out += WB;
      else out += `\\${n}`;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, `${flags.replace(/[gu]/g, '')}gu`);
}

// re.finditer: every match, with .index and groups.
const finditer = (re, text) => [...String(text).matchAll(re)];

// s[:n] counted in code points, as Python slices a str.
const cut = (s, n) => {
  const chars = Array.from(String(s));
  return chars.length <= n ? String(s) : chars.slice(0, n).join('');
};

// str.strip(chars) / rstrip(chars); without `chars`, Python's whitespace.
const WS = ' \t\n\r\x0b\x0c                 　\x1c\x1d\x1e\x1f\x85';
function rstrip(s, chars = WS) {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
}
function lstrip(s, chars = WS) {
  let b = 0;
  while (b < s.length && chars.includes(s[b])) b++;
  return s.slice(b);
}
const strip = (s, chars) => lstrip(rstrip(String(s), chars), chars);

// str.split() with no separator: runs of whitespace, no empty strings.
const split = (s) => String(s).split(/[\s\x1c-\x1f\x85]+/u).filter(Boolean);

// str.isupper() for one character.
const isUpper = (c) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();

// Python 3 round(): half to even. Plain numbers only (the ports round counts and seconds).
function pyRound(x, nd = 0) {
  const m = 10 ** nd;
  const v = x * m;
  const r = Math.round(v);
  const diff = Math.abs(v % 1);
  if (Math.abs(diff - 0.5) < 1e-9) {
    const f = Math.floor(v);
    return (f % 2 === 0 ? f : f + 1) / m;
  }
  return r / m;
}

module.exports = { py, finditer, cut, strip, rstrip, lstrip, split, isUpper, pyRound, W, WB };
