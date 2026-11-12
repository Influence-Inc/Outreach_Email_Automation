'use strict';

// Rich-text emails written by a human in Deal Studio's composer (the "Write
// your own email" option next to the three offer structures, and the hand-off
// reply box). The browser sends HTML; nothing about that HTML is trusted.
//
// Three jobs, all dependency-free:
//   sanitizeEmailHtml(html) → the HTML we actually email. A strict allowlist of
//       formatting tags (bold, italic, underline, strike, lists, quotes, small
//       headings, links) with every attribute dropped except a safe href. Text
//       pasted from Google Docs / Gmail / Word arrives already normalised by the
//       composer; this is the server-side backstop, so a hand-crafted request
//       can never smuggle a script, style or tracking attribute into an email.
//   htmlToMarkdown(html)    → the same email as markdown-flavoured plain text.
//       This is what goes into the stored conversation (email_messages.body), so
//       Claude — the reply classifier, the "Draft with AI" writers, the contract
//       extractor, the timeline summariser — reads a composed email exactly like
//       every other message in the thread (same **bold** / [label](url) subset
//       the AI-written emails use).
//   htmlToText(html)        → the text/plain alternative part of the email.

const ALLOWED = new Set([
  'p', 'div', 'br',
  'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'blockquote',
  'h1', 'h2', 'h3',
  'a',
]);
// Synonyms collapsed to one canonical tag so the output is predictable.
const ALIAS = { strike: 's', del: 's', ins: 'u' };
const VOID = new Set(['br']);
const BLOCK = new Set(['p', 'div', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3']);
// Dropped together with everything inside them.
const DROP_WITH_CONTENT = ['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'textarea', 'select', 'xml'];

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function escapeText(s) {
  return String(s).replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      // A non-breaking space reads as a normal space everywhere we use the text.
      if (code === 160) return ' ';
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED[ent.toLowerCase()];
    return v != null ? v : m;
  });
}

function hrefFrom(attrs) {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs || '');
  if (!m) return null;
  const raw = decodeEntities((m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) || '').trim();
  // Strip control chars / whitespace that browsers ignore inside a scheme
  // ("java\nscript:") before testing it.
  const compact = raw.replace(/[\u0000- \u007f]+/g, '');
  if (!SAFE_URL.test(compact)) return null;
  return raw;
}

// Tag tokenizer. Attribute values may legally contain '>' inside quotes, so the
// attribute run is matched quote-aware rather than with a bare [^>]*.
const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;

function stripDropped(html) {
  let out = String(html || '');
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi');
    out = out.replace(re, '');
  }
  return out;
}

// Parse (already de-scripted) HTML into a small tree of allowed nodes:
//   { tag, href?, children: [...] } or a string (decoded text).
// Unknown tags are unwrapped (their text is kept); stray closers are ignored;
// anything left open at the end is closed.
function parse(html) {
  const root = { tag: '#root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const src = stripDropped(html);
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    const tok = m[0];
    if (m[2] == null) {
      if (tok.startsWith('<!') || tok.startsWith('<?')) continue; // comment / doctype / cdata
      top().children.push(decodeEntities(tok)); // text (or a lone '<')
      continue;
    }
    const closing = m[1] === '/';
    let tag = m[2].toLowerCase();
    tag = ALIAS[tag] || tag;
    if (!ALLOWED.has(tag)) continue; // unwrap: drop the tag, keep its content
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node = { tag, children: [] };
    if (tag === 'a') {
      const href = hrefFrom(m[3]);
      if (!href) continue; // a link we won't emit becomes plain text
      node.href = href;
    }
    // An <li> opened directly inside another <li> (sloppy paste) closes the first.
    if (tag === 'li' && top().tag === 'li') stack.pop();
    top().children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3] || '')) stack.push(node);
  }
  return root;
}

// ── HTML out ──────────────────────────────────────────────────────────────
// Inline styles only (mail clients ignore <style>), applied to the few tags
// whose client defaults look wrong in an email.
const EMAIL_STYLE = {
  p: 'margin:0 0 12px 0;',
  div: '',
  ul: 'margin:0 0 12px 0;padding-left:24px;',
  ol: 'margin:0 0 12px 0;padding-left:24px;',
  li: 'margin:0 0 4px 0;',
  blockquote: 'margin:0 0 12px 0;padding-left:12px;border-left:3px solid #d0d0d0;color:#555555;',
  h1: 'font-size:20px;margin:0 0 12px 0;',
  h2: 'font-size:18px;margin:0 0 10px 0;',
  h3: 'font-size:16px;margin:0 0 8px 0;',
};

function renderHtml(node, { forEmail }) {
  if (typeof node === 'string') return escapeText(node);
  const inner = node.children.map((c) => renderHtml(c, { forEmail })).join('');
  if (node.tag === '#root') return inner;
  if (node.tag === 'br') return '<br>';
  if (node.tag === 'a') return `<a href="${escapeAttr(node.href)}">${inner}</a>`;
  // Formatting wrappers around nothing visible are noise, and so is a block
  // with nothing at all in it (a <p><br></p> blank line is kept).
  if (!BLOCK.has(node.tag) && !inner.replace(/<br>/g, '').trim()) return inner;
  if (BLOCK.has(node.tag) && !inner.trim()) return '';
  const style = forEmail && EMAIL_STYLE[node.tag] ? ` style="${EMAIL_STYLE[node.tag]}"` : '';
  return `<${node.tag}${style}>${inner}</${node.tag}>`;
}

// Visible text of a subtree (for emptiness checks).
function textOf(node) {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

// Drop trailing empty blocks / line breaks (an editor always leaves one).
function trimTrailing(root) {
  const kids = root.children;
  while (kids.length) {
    const last = kids[kids.length - 1];
    const empty =
      typeof last === 'string'
        ? !last.trim()
        : last.tag === 'br' || (BLOCK.has(last.tag) && !textOf(last).trim() && !hasLink(last));
    if (!empty) break;
    kids.pop();
  }
  return root;
}
function hasLink(node) {
  if (typeof node === 'string') return false;
  return node.tag === 'a' || node.children.some(hasLink);
}

// The sanitised HTML, unstyled (for storage / display back in the dashboard).
function sanitizeEmailHtml(html) {
  return renderHtml(trimTrailing(parse(html)), { forEmail: false }).trim();
}

// The sanitised HTML with the inline email styles applied — what is sent.
function emailHtml(html) {
  return renderHtml(trimTrailing(parse(html)), { forEmail: true }).trim();
}

// ── Markdown / plain text out ─────────────────────────────────────────────
// Walk the tree into lines. Blocks start on a new line and paragraphs are
// separated by a blank line; list items get "- " / "1. " prefixes; quotes get
// "> ". `md` toggles markdown markers (bold, italic, links) vs plain text.
function renderText(root, { md }) {
  const out = [];
  let line = '';
  const flush = () => { out.push(line); line = ''; };
  const blankLine = () => {
    if (line.trim()) flush();
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
  };
  const prefixStack = [];
  const prefix = () => prefixStack.join('');
  const startLine = () => { if (line.trim()) flush(); line = prefix(); };

  const walk = (node, listCtx) => {
    if (typeof node === 'string') {
      const t = node.replace(/[\r\n\t ]+/g, ' ');
      if (!line.trim() || line === prefix()) {
        if (!line) line = prefix();
        line += t.replace(/^ +/, '');
      } else {
        line += t;
      }
      return;
    }
    const kids = (ctx) => node.children.forEach((c) => walk(c, ctx));
    switch (node.tag) {
      case '#root': kids(listCtx); break;
      case 'br': flush(); line = prefix(); break;
      case 'strong': case 'b': {
        const inner = inlineText(node, md);
        appendInline(md && inner.trim() ? `**${inner.trim()}**${/\s$/.test(inner) ? ' ' : ''}` : inner);
        break;
      }
      case 'em': case 'i': {
        const inner = inlineText(node, md);
        appendInline(md && inner.trim() ? `*${inner.trim()}*${/\s$/.test(inner) ? ' ' : ''}` : inner);
        break;
      }
      case 's': {
        const inner = inlineText(node, md);
        appendInline(md && inner.trim() ? `~~${inner.trim()}~~` : inner);
        break;
      }
      case 'u': kids(listCtx); break;
      case 'a': {
        const label = inlineText(node, md).trim();
        const href = node.href;
        const bare = href.replace(/^mailto:/i, '');
        let s;
        if (!label || label === href || label === bare) s = bare;
        else s = md ? `[${label}](${href})` : `${label} (${bare})`;
        appendInline(s);
        break;
      }
      case 'ul': case 'ol': {
        blankLineSoft();
        const ctx = { ordered: node.tag === 'ol', n: 0 };
        node.children.forEach((c) => walk(c, ctx));
        blankLine();
        break;
      }
      case 'li': {
        startLine();
        const ctx = listCtx || { ordered: false, n: 0 };
        ctx.n += 1;
        const marker = ctx.ordered ? `${ctx.n}. ` : '- ';
        line += marker;
        prefixStack.push(' '.repeat(marker.length));
        node.children.forEach((c) => walk(c, null));
        prefixStack.pop();
        if (line.trim()) flush();
        line = '';
        break;
      }
      case 'blockquote': {
        blankLine();
        prefixStack.push('> ');
        line = prefix();
        kids(null);
        if (line.trim() && line !== prefix()) flush();
        prefixStack.pop();
        line = '';
        blankLine();
        break;
      }
      case 'h1': case 'h2': case 'h3': {
        blankLine();
        line = prefix();
        const inner = inlineText(node, md).trim();
        line += md && inner ? `**${inner}**` : inner;
        blankLine();
        break;
      }
      case 'p': case 'div': default: {
        // A <div> is a line (Chrome's contenteditable wraps each line in one); a
        // <p> is a paragraph.
        if (node.tag === 'p') blankLine(); else startLine();
        if (!line) line = prefix();
        kids(listCtx);
        if (node.tag === 'p') blankLine();
        else if (line.trim() && line !== prefix()) { flush(); line = ''; }
        break;
      }
    }
  };
  function blankLineSoft() { if (line.trim() && line !== prefix()) flush(); line = ''; }
  function appendInline(s) {
    if (!line) line = prefix();
    line += s;
  }
  walk(root, null);
  if (line.trim() && line !== prefix()) flush();

  // Tidy: trim right edges, collapse runs of blank lines, trim ends.
  const lines = out.map((l) => l.replace(/[ \t]+$/g, ''));
  const tidy = [];
  for (const l of lines) {
    const blank = !l.trim() || /^(> ?)+$/.test(l.trim() + ' ');
    if (blank && (!tidy.length || tidy[tidy.length - 1] === '')) continue;
    tidy.push(blank ? '' : l);
  }
  while (tidy.length && tidy[tidy.length - 1] === '') tidy.pop();
  return tidy.join('\n');
}

// Flattened inline text of a node (bold/italic/link inside it rendered too).
function inlineText(node, md) {
  return node.children
    .map((c) => {
      if (typeof c === 'string') return c.replace(/[\r\n\t ]+/g, ' ');
      if (c.tag === 'br') return ' ';
      if (c.tag === 'a') {
        const label = inlineText(c, md).trim();
        const bare = c.href.replace(/^mailto:/i, '');
        if (!label || label === c.href || label === bare) return bare;
        return md ? `[${label}](${c.href})` : `${label} (${bare})`;
      }
      return inlineText(c, md);
    })
    .join('');
}

function htmlToMarkdown(html) {
  return renderText(trimTrailing(parse(html)), { md: true });
}

function htmlToText(html) {
  return renderText(trimTrailing(parse(html)), { md: false });
}

// Everything a send needs from one composer payload. Throws (status 400) when
// the email has no visible text, so an empty editor can never send.
function prepareComposedEmail(rawHtml) {
  const html = sanitizeEmailHtml(rawHtml);
  const markdown = htmlToMarkdown(html);
  if (!markdown.trim()) {
    const err = new Error('The email is empty — write something first.');
    err.status = 400;
    throw err;
  }
  return { html, emailHtml: emailHtml(html), markdown, text: htmlToText(html) };
}

module.exports = {
  sanitizeEmailHtml,
  emailHtml,
  htmlToMarkdown,
  htmlToText,
  prepareComposedEmail,
  decodeEntities,
};
