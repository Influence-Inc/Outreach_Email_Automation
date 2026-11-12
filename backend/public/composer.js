// Influence — rich-text email composer (window.EmailComposer)
//
// The "Write your own email" editor in Deal Studio: the fourth option beside the
// three offer structures, and the hand-off reply box. A contenteditable with a
// formatting toolbar (bold, italic, underline, strikethrough, heading, bulleted
// and numbered lists, quote, links, clear formatting, undo/redo) and a paste
// cleaner, so text copied from Google Docs, Gmail, Notion or Word keeps its
// bold / italics / lists / links but never drags in fonts, colours, classes,
// images or scripts.
//
// Whatever leaves here is still treated as untrusted — the backend re-sanitises
// it (backend/src/services/emailHtml.js) to the same tag allowlist before it is
// emailed, and stores a markdown copy of it for Claude to read.
//
// SHARED FILE: an identical copy ships in the Chrome extension
// (extension/composer.js) for the "Decide offer" panel. Edit
// backend/public/composer.js, then copy it over — a test fails if they differ.
(function (global) {
  'use strict';

  // ---- Sanitiser (paste + read-out) --------------------------------------
  // Mirrors the server allowlist. Inline styles from the source (Docs/Word put
  // bold/italic in style="font-weight:700") are translated into tags first, then
  // every attribute is dropped except a safe href.
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const DROP = new Set([
    'script', 'style', 'meta', 'link', 'title', 'head', 'template', 'noscript', 'iframe', 'object',
    'embed', 'svg', 'math', 'img', 'picture', 'video', 'audio', 'canvas', 'button', 'input', 'select',
    'textarea', 'form', 'xml',
  ]);
  // Containers that are a paragraph when they hold only inline content, and are
  // unwrapped when they hold blocks (so pasted layout divs/tables don't nest).
  const CONTAINER = new Set([
    'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'center', 'address', 'pre', 'dl', 'dt', 'dd',
  ]);
  const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', ...CONTAINER]);

  function safeHref(raw) {
    const href = String(raw || '').trim();
    const compact = href.replace(/[\u0000- \u007f]+/g, '');
    return SAFE_URL.test(compact) ? href : null;
  }

  function styleFlags(el) {
    const st = el.style || {};
    const weight = String(st.fontWeight || '');
    const deco = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
    return {
      bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
      notBold: weight === 'normal' || weight === 'lighter' || (Number(weight) > 0 && Number(weight) < 600),
      italic: st.fontStyle === 'italic' || st.fontStyle === 'oblique',
      underline: /underline/.test(deco),
      strike: /line-through/.test(deco),
    };
  }

  function hasBlockDescendant(el) {
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      if (BLOCKS.has(t) || hasBlockDescendant(c)) return true;
    }
    return false;
  }

  // Convert one source node into clean nodes appended to `out` (in `doc`).
  function convert(node, out, doc, ctx) {
    if (node.nodeType === 3) {
      out.appendChild(doc.createTextNode(node.nodeValue.replace(/ /g, ' ')));
      return;
    }
    if (node.nodeType !== 1) return; // comments, processing instructions
    let tag = node.tagName.toLowerCase();
    if (tag.includes(':')) tag = 'span'; // Word's <o:p> & friends
    if (DROP.has(tag)) return;
    const kids = (target, nextCtx = ctx) => node.childNodes.forEach((c) => convert(c, target, doc, nextCtx));

    if (tag === 'br') { out.appendChild(doc.createElement('br')); return; }

    // Block-level structure.
    let block = null;
    if (tag === 'p') block = 'p';
    else if (tag === 'h1' || tag === 'h2') block = 'h2';
    else if (/^h[3-6]$/.test(tag)) block = 'h3';
    else if (tag === 'ul' || tag === 'ol' || tag === 'li' || tag === 'blockquote') block = tag;
    else if (CONTAINER.has(tag)) {
      if (hasBlockDescendant(node)) { kids(out); return; }
      block = 'p';
    }
    // A <p> inside a list item (Docs does this) is just the item's text.
    if (block === 'p' && ctx.inLi) block = null;

    // Inline formatting from tags and from inline styles.
    const f = styleFlags(node);
    const bold = !f.notBold && (tag === 'b' || tag === 'strong' || f.bold) && !ctx.bold && !/^h/.test(block || '');
    const italic = (tag === 'i' || tag === 'em' || tag === 'cite' || f.italic) && !ctx.italic;
    // Links are underlined by the mail client already; a Docs/Gmail link also
    // carries text-decoration:underline on its inner span — not a <u>.
    const underline = (tag === 'u' || tag === 'ins' || f.underline) && tag !== 'a' && !ctx.inA && !ctx.underline;
    const strike = (tag === 's' || tag === 'strike' || tag === 'del' || f.strike) && !ctx.strike;
    const href = tag === 'a' ? safeHref(node.getAttribute('href')) : null;

    let target = out;
    let top = null;
    const wrap = (name) => {
      const el = doc.createElement(name);
      target.appendChild(el);
      if (!top) top = el;
      target = el;
      return el;
    };
    if (block) wrap(block);
    if (href && !ctx.inA) wrap('a').setAttribute('href', href);
    if (bold) wrap('b');
    if (italic) wrap('i');
    if (underline) wrap('u');
    if (strike) wrap('s');
    kids(target, {
      bold: ctx.bold || bold,
      italic: ctx.italic || italic,
      underline: ctx.underline || underline,
      strike: ctx.strike || strike,
      inA: ctx.inA || !!href,
      inLi: block === 'li' ? true : block === 'ul' || block === 'ol' ? false : ctx.inLi,
    });
    // An empty inline wrapper is noise; an empty paragraph is a blank line.
    if (top && !BLOCKS.has(top.tagName.toLowerCase()) && !top.textContent && !top.querySelector('br')) {
      top.remove();
    }
  }

  // Merge adjacent identical inline tags (<b>a</b><b>b</b> → <b>ab</b>) and drop
  // a trailing empty paragraph. Purely cosmetic for the stored HTML.
  function tidy(root) {
    // Blocks with nothing in them (Chrome leaves a <p></p> where a list was
    // started) would only add stray spacing. A <p><br></p> blank line stays.
    root.querySelectorAll('p,h2,h3,blockquote,li,ul,ol').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('br,a,li')) el.remove();
    });
    root.querySelectorAll('b,i,u,s').forEach((el) => {
      const prev = el.previousSibling;
      if (prev && prev.nodeType === 1 && prev.tagName === el.tagName) {
        while (el.firstChild) prev.appendChild(el.firstChild);
        el.remove();
      }
    });
    while (root.lastChild) {
      const last = root.lastChild;
      const blank =
        (last.nodeType === 3 && !last.nodeValue.trim()) ||
        (last.nodeType === 1 && last.tagName === 'BR') ||
        (last.nodeType === 1 && /^(P|DIV|H2|H3)$/.test(last.tagName) && !last.textContent.trim() && !last.querySelector('a'));
      if (!blank) break;
      last.remove();
    }
  }

  function sanitize(html) {
    const src = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const doc = document.implementation.createHTMLDocument('');
    const out = doc.createElement('div');
    src.body.childNodes.forEach((c) => convert(c, out, doc, {}));
    tidy(out);
    return out.innerHTML;
  }

  // ---- Plain text / markdown → HTML --------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inlineMd(s) {
    let out = esc(s);
    const links = [];
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url.replace(/&amp;/g, '&'));
      if (!href) return m;
      links.push(`<a href="${esc(href)}">${label}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m, pre, url) => {
      links.push(`<a href="${url}">${url}</a>`);
      return `${pre}\u0000${links.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>');
    out = out.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
    out = out.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  }
  // Markdown-ish text (what "Draft with AI" returns) → editor HTML.
  function markdownToHtml(md) {
    const blocks = String(md || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    return blocks
      .map((b) => {
        const lines = b.split('\n').filter((l) => l.trim() !== '');
        if (!lines.length) return '';
        // Two or more "- " lines are a list; a lone one is the "- Jennifer"
        // sign-off every drafted email ends with.
        if (lines.length > 1 && lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
          return `<ul>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*[-•*]\s+/, ''))}</li>`).join('')}</ul>`;
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return `<ol>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
        }
        if (lines.every((l) => /^\s*>/.test(l))) {
          return `<blockquote>${lines.map((l) => inlineMd(l.replace(/^\s*>\s?/, ''))).join('<br>')}</blockquote>`;
        }
        if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) {
          return `<h3>${inlineMd(lines[0].replace(/^#{1,3}\s+/, ''))}</h3>`;
        }
        return `<p>${lines.map(inlineMd).join('<br>')}</p>`;
      })
      .join('');
  }
  // Plain-text paste: paragraphs on blank lines, <br> on single newlines,
  // bare URLs linked. No markdown interpretation (a pasted "*" stays a "*").
  function textToHtml(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => {
        const html = esc(p).replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2">$2</a>');
        return `<p>${html.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }

  // ---- Icons ---------------------------------------------------------------
  const I = (d, extra = '') =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const ICONS = {
    bold: I('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z"/>', ' stroke-width="2.4"'),
    italic: I('<path d="M14 5h-4M14 19h-4M14 5l-4 14"/>'),
    underline: I('<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>'),
    strike: I('<path d="M16 6.5C15.3 5 13.8 4 12 4c-2.5 0-4 1.4-4 3.2 0 1.3.8 2.2 2.2 2.8"/><path d="M4 12h16"/><path d="M8 17.5C8.7 19 10.2 20 12 20c2.5 0 4-1.4 4-3.3 0-.9-.3-1.6-.9-2.2"/>'),
    heading: I('<path d="M6 4v16M18 4v16M6 12h12"/>'),
    ul: I('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    ol: I('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9M4 9h3M4 14.5a1.5 1.5 0 0 1 3 0c0 1-3 2.2-3 3.5h3"/>', ' stroke-width="1.8"'),
    quote: I('<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z"/>', ' stroke-width="1.8"'),
    link: I('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    clear: I('<path d="M4 7V5h11v2M9.5 5 7 19M5 19h5M15 14l5 5M20 14l-5 5"/>'),
    undo: I('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: I('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  };

  const isMac = /Mac|iPhone|iPad/.test((global.navigator && global.navigator.platform) || '');
  const MOD = isMac ? '⌘' : 'Ctrl+';

  // ---- The editor ----------------------------------------------------------
  function create(opts = {}) {
    const root = document.createElement('div');
    root.className = 'ec';
    root.innerHTML = `
      <div class="ec-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" class="ec-btn" data-cmd="bold" title="Bold (${MOD}B)" aria-label="Bold">${ICONS.bold}</button>
        <button type="button" class="ec-btn" data-cmd="italic" title="Italic (${MOD}I)" aria-label="Italic">${ICONS.italic}</button>
        <button type="button" class="ec-btn" data-cmd="underline" title="Underline (${MOD}U)" aria-label="Underline">${ICONS.underline}</button>
        <button type="button" class="ec-btn" data-cmd="strikeThrough" title="Strikethrough" aria-label="Strikethrough">${ICONS.strike}</button>
        <span class="ec-sep" aria-hidden="true"></span>
        <button type="button" class="ec-btn" data-cmd="heading" title="Heading" aria-label="Heading">${ICONS.heading}</button>
        <button type="button" class="ec-btn" data-cmd="insertUnorderedList" title="Bulleted list (${MOD}⇧8)" aria-label="Bulleted list">${ICONS.ul}</button>
        <button type="button" class="ec-btn" data-cmd="insertOrderedList" title="Numbered list (${MOD}⇧7)" aria-label="Numbered list">${ICONS.ol}</button>
        <button type="button" class="ec-btn" data-cmd="quote" title="Quote" aria-label="Quote">${ICONS.quote}</button>
        <span class="ec-sep" aria-hidden="true"></span>
        <button type="button" class="ec-btn" data-cmd="link" title="Link (${MOD}K)" aria-label="Link">${ICONS.link}</button>
        <button type="button" class="ec-btn" data-cmd="clear" title="Clear formatting" aria-label="Clear formatting">${ICONS.clear}</button>
        <span class="ec-spacer"></span>
        <button type="button" class="ec-btn" data-cmd="undo" title="Undo (${MOD}Z)" aria-label="Undo">${ICONS.undo}</button>
        <button type="button" class="ec-btn" data-cmd="redo" title="Redo (${MOD}⇧Z)" aria-label="Redo">${ICONS.redo}</button>
      </div>
      <div class="ec-linkbar" hidden>
        <input type="text" class="ec-link-input" placeholder="Paste or type a link — https://… or name@email.com" spellcheck="false" autocomplete="off">
        <button type="button" class="ec-link-apply">Apply</button>
        <button type="button" class="ec-link-remove">Remove</button>
        <button type="button" class="ec-link-close" aria-label="Close">✕</button>
      </div>
      <div class="ec-editor" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true"></div>
      <div class="ec-foot">
        <span class="ec-hint">Paste from Google Docs, Gmail or Word keeps bold, lists and links · ${MOD}⇧V pastes plain text</span>
      </div>`;
    const toolbar = root.querySelector('.ec-toolbar');
    const editor = root.querySelector('.ec-editor');
    const linkbar = root.querySelector('.ec-linkbar');
    const linkInput = root.querySelector('.ec-link-input');
    const linkRemove = root.querySelector('.ec-link-remove');
    if (opts.placeholder) editor.dataset.placeholder = opts.placeholder;
    if (opts.minHeight) editor.style.minHeight = `${opts.minHeight}px`;
    if (opts.hint === false) root.querySelector('.ec-foot').remove();
    if (opts.ariaLabel) editor.setAttribute('aria-label', opts.ariaLabel);

    const listeners = [];
    const emit = () => {
      refreshEmpty();
      listeners.forEach((fn) => { try { fn(); } catch { /* listener errors stay local */ } });
    };

    function exec(cmd, val = null) {
      editor.focus();
      try { document.execCommand('styleWithCSS', false, false); } catch { /* old engines */ }
      document.execCommand(cmd, false, val);
      refreshState();
      emit();
    }

    function blockAncestor(tagRe) {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount) return null;
      let n = sel.getRangeAt(0).startContainer;
      while (n && n !== editor) {
        if (n.nodeType === 1 && tagRe.test(n.tagName)) return n;
        n = n.parentNode;
      }
      return null;
    }
    const selectionInside = () => {
      const sel = global.getSelection();
      return !!(sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer));
    };

    function refreshState() {
      if (!selectionInside()) return;
      const on = (cmd) => { try { return document.queryCommandState(cmd); } catch { return false; } };
      toolbar.querySelectorAll('[data-cmd]').forEach((b) => {
        const c = b.dataset.cmd;
        let active = false;
        if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(c)) active = on(c);
        else if (c === 'heading') active = !!blockAncestor(/^H[1-6]$/);
        else if (c === 'quote') active = !!blockAncestor(/^BLOCKQUOTE$/);
        else if (c === 'link') active = !!blockAncestor(/^A$/);
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function refreshEmpty() {
      const empty = !editor.textContent.trim() && !editor.querySelector('li,a');
      root.classList.toggle('is-empty', empty);
    }

    // ---- Links ----
    let savedRange = null;
    function openLinkbar() {
      const sel = global.getSelection();
      savedRange = sel && sel.rangeCount && selectionInside() ? sel.getRangeAt(0).cloneRange() : null;
      const a = blockAncestor(/^A$/);
      linkInput.value = a ? a.getAttribute('href') || '' : '';
      linkRemove.hidden = !a;
      linkbar.hidden = false;
      linkInput.focus();
      linkInput.select();
    }
    function closeLinkbar(refocus = true) {
      linkbar.hidden = true;
      if (refocus) restoreRange();
    }
    function restoreRange() {
      editor.focus();
      if (savedRange) {
        const sel = global.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
    }
    function normalizeUrl(v) {
      const s = String(v || '').trim();
      if (!s) return null;
      if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(s)) return `mailto:${s}`;
      if (SAFE_URL.test(s)) return s;
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
      return null;
    }
    function applyLink() {
      const url = normalizeUrl(linkInput.value);
      if (!url) { linkInput.classList.add('is-invalid'); linkInput.focus(); return; }
      linkInput.classList.remove('is-invalid');
      restoreRange();
      const a = blockAncestor(/^A$/);
      if (a) a.setAttribute('href', url);
      else if (savedRange && !savedRange.collapsed) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url.replace(/^mailto:/i, ''))}</a>&nbsp;`);
      closeLinkbar(false);
      refreshState();
      emit();
    }
    function removeLink() {
      restoreRange();
      const a = blockAncestor(/^A$/);
      if (a) {
        const range = document.createRange();
        range.selectNodeContents(a);
        const sel = global.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand('unlink');
      closeLinkbar(false);
      refreshState();
      emit();
    }
    root.querySelector('.ec-link-apply').addEventListener('click', applyLink);
    linkRemove.addEventListener('click', removeLink);
    root.querySelector('.ec-link-close').addEventListener('click', () => closeLinkbar());
    linkInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); applyLink(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeLinkbar(); }
    });
    linkInput.addEventListener('input', () => linkInput.classList.remove('is-invalid'));

    // ---- Toolbar ----
    // mousedown (not click) + preventDefault keeps the editor's selection alive.
    toolbar.addEventListener('mousedown', (ev) => { if (ev.target.closest('.ec-btn')) ev.preventDefault(); });
    toolbar.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.ec-btn');
      if (!btn || root.classList.contains('is-disabled')) return;
      const c = btn.dataset.cmd;
      if (c === 'link') return openLinkbar();
      if (c === 'heading') return exec('formatBlock', blockAncestor(/^H[1-6]$/) ? 'P' : 'H3');
      if (c === 'quote') return exec('formatBlock', blockAncestor(/^BLOCKQUOTE$/) ? 'P' : 'BLOCKQUOTE');
      if (c === 'clear') {
        exec('removeFormat');
        if (blockAncestor(/^(H[1-6]|BLOCKQUOTE)$/)) exec('formatBlock', 'P');
        return;
      }
      exec(c);
    });

    // ---- Keyboard ----
    let plainPaste = false;
    editor.addEventListener('keydown', (ev) => {
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (!mod) return;
      const k = ev.key.toLowerCase();
      if (k === 'k') { ev.preventDefault(); openLinkbar(); }
      else if (ev.shiftKey && (k === '8' || k === '*')) { ev.preventDefault(); exec('insertUnorderedList'); }
      else if (ev.shiftKey && (k === '7' || k === '&')) { ev.preventDefault(); exec('insertOrderedList'); }
      else if (ev.shiftKey && k === 'v') { plainPaste = true; setTimeout(() => { plainPaste = false; }, 400); }
    });

    // ---- Paste & drop ----
    function insertClean(dt) {
      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      const clean = html && !plainPaste ? sanitize(html) : textToHtml(text);
      plainPaste = false;
      if (!clean) return;
      document.execCommand('insertHTML', false, clean);
      // execCommand may re-add style spans to match the surroundings; strip them.
      editor.querySelectorAll('[style],[class],span,font').forEach((el) => {
        el.removeAttribute('style');
        el.removeAttribute('class');
        if (el.tagName === 'SPAN' || el.tagName === 'FONT') el.replaceWith(...el.childNodes);
      });
      emit();
    }
    editor.addEventListener('paste', (ev) => {
      if (!ev.clipboardData) return;
      ev.preventDefault();
      insertClean(ev.clipboardData);
    });
    editor.addEventListener('drop', (ev) => {
      ev.preventDefault(); // never drop files/images into an email body
      const dt = ev.dataTransfer;
      if (!dt || (!dt.getData('text/html') && !dt.getData('text/plain'))) return;
      const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
      if (pos) {
        const sel = global.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
      insertClean(dt);
    });

    editor.addEventListener('focus', () => {
      try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* unsupported */ }
      // Start an empty editor inside a paragraph, so the first line is a <p>
      // like every line after it (otherwise it's a bare text node).
      if (!editor.firstChild) {
        editor.innerHTML = '<p><br></p>';
        const sel = global.getSelection();
        const r = document.createRange();
        r.setStart(editor.firstChild, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      root.classList.add('is-focused');
    });
    editor.addEventListener('blur', () => root.classList.remove('is-focused'));
    editor.addEventListener('input', emit);
    editor.addEventListener('keyup', refreshState);
    editor.addEventListener('mouseup', refreshState);
    document.addEventListener('selectionchange', () => { if (selectionInside()) refreshState(); });
    // A click on a link inside the editor edits it rather than following it.
    editor.addEventListener('click', (ev) => {
      if (ev.target.closest('a') && (ev.metaKey || ev.ctrlKey)) {
        global.open(ev.target.closest('a').href, '_blank', 'noopener');
      }
    });

    refreshEmpty();

    const api = {
      el: root,
      editor,
      getHtml: () => sanitize(editor.innerHTML),
      getText: () => editor.innerText.replace(/ /g, ' ').trim(),
      isEmpty: () => !editor.textContent.trim(),
      setHtml(html) { editor.innerHTML = sanitize(html); emit(); },
      setMarkdown(md) { editor.innerHTML = sanitize(markdownToHtml(md)); emit(); },
      clear() { editor.innerHTML = ''; emit(); },
      focus() {
        editor.focus();
        const sel = global.getSelection();
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      },
      onChange(fn) { listeners.push(fn); return api; },
      setDisabled(on) {
        root.classList.toggle('is-disabled', !!on);
        editor.contentEditable = on ? 'false' : 'true';
        toolbar.querySelectorAll('button').forEach((b) => { b.disabled = !!on; });
      },
    };
    if (opts.html) api.setHtml(opts.html);
    else if (opts.markdown) api.setMarkdown(opts.markdown);
    return api;
  }

  // The largest dollar amount in a piece of text ($4,500 / $4.5k / $4500), for
  // the "Looks like this email offers $X" hint. Mirrors the backend's
  // extractOfferAmount so the hint and a hand-off reply agree.
  function detectAmount(text) {
    const s = String(text || '');
    const amounts = [];
    let m;
    const kRe = /\$\s*(\d+(?:\.\d+)?)\s*[kK]\b/g;
    while ((m = kRe.exec(s)) !== null) amounts.push(Math.round(Number(m[1]) * 1000));
    const rawRe = /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![kK\d])/g;
    while ((m = rawRe.exec(s)) !== null) amounts.push(Math.round(Number(m[1].replace(/,/g, ''))));
    const ok = amounts.filter((n) => Number.isFinite(n) && n > 0);
    return ok.length ? Math.max(...ok) : null;
  }

  // The largest plausible percentage in a piece of text ("15%", "12.5 percent"),
  // for the "set as commission?" nudge. 100%+ is ignored ("100% creative freedom").
  function detectPercent(text) {
    const s = String(text || '');
    const re = /(\d{1,2}(?:\.\d{1,2})?)\s*(?:%|percent\b)/gi;
    const found = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100) found.push(n);
    }
    return found.length ? Math.max(...found) : null;
  }

  // ---- Deal terms picker ----------------------------------------------------
  // "Terms in this email": how the deal pays the creator — none (a plain reply),
  // a flat fee, commission only (affiliate), an upfront fee + commission, or
  // product only. Produces the shape backend/src/services/dealTerms.js
  // validates; the server is authoritative, this only gives instant feedback.
  const TERMS_MODELS = [
    { id: 'none', label: 'Just a reply' },
    { id: 'flat', label: 'Flat fee' },
    { id: 'commission', label: 'Commission' },
    { id: 'hybrid', label: 'Fee + commission' },
    { id: 'product', label: 'Product only' },
  ];
  const TERMS_HINTS = {
    none: 'A plain reply — their rate stays open, and this flag snoozes until they answer.',
    flat: 'Sent as your offer — their “yes” books this fee for the contract.',
    commission: 'An affiliate offer: no fee, a share of the sales they drive. Their “yes” books these terms and the contract is written from them.',
    hybrid: 'An upfront fee plus a share of the sales they drive. Their “yes” books both.',
    product: 'Product / gifting only, no cash. Their “yes” books it and the contract says so.',
  };
  const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US');

  function describeTerms(t) {
    if (!t) return '';
    if (t.model === 'flat') return fmtMoney(t.fee);
    if (t.model === 'commission') return `${t.commission.rate_pct}% commission`;
    if (t.model === 'hybrid') return `${fmtMoney(t.fee)} + ${t.commission.rate_pct}% commission`;
    if (t.model === 'product') return 'Product only';
    return '';
  }
  // One-line plain-English summary (shown under the picker, and handed to
  // "Draft with AI" so the drafted email states exactly these terms).
  function summarizeTerms(t) {
    if (!t) return '';
    const c = t.commission;
    const commission = c
      ? `${c.rate_pct}% commission on net sales via ${
          c.attribution === 'code' ? `promo code ${c.promo_code || '(to be assigned)'}`
            : c.attribution === 'link_and_code' ? `their tracked link or promo code ${c.promo_code || '(to be assigned)'}`
            : 'their tracked link'
        } (${c.cookie_days}-day window), paid monthly within ${c.payout_net_days} days, ${
          c.term_months ? `for ${c.term_months} month${c.term_months === 1 ? '' : 's'}` : 'ongoing'
        }`
      : '';
    if (t.model === 'flat') return `A flat fee of ${fmtMoney(t.fee)}.`;
    if (t.model === 'commission') return `No upfront fee — ${commission}.`;
    if (t.model === 'hybrid') return `${fmtMoney(t.fee)} upfront, plus ${commission}.`;
    if (t.model === 'product') return `Product only, no cash: ${t.product}.`;
    return '';
  }

  function createTermsPicker(opts = {}) {
    const allowNone = opts.allowNone !== false;
    const models = TERMS_MODELS.filter((m) => allowNone || m.id !== 'none');
    const uid = Math.random().toString(36).slice(2, 8);
    const root = document.createElement('div');
    root.className = 'tp';
    root.innerHTML = `
      <div class="tp-label">${esc(opts.label || 'Terms in this email')}</div>
      <div class="tp-models" role="radiogroup" aria-label="${esc(opts.label || 'Terms in this email')}">
        ${models.map((m) => `<button type="button" class="tp-model" role="radio" data-model="${m.id}">${m.label}</button>`).join('')}
      </div>
      <div class="tp-fields">
        <div class="tp-row tp-fee-row">
          <label class="tp-field"><span class="tp-flabel tp-fee-label">Fee</span>
            <span class="tp-money"><span class="tp-affix">$</span><input type="number" min="0" step="50" class="tp-input tp-fee" inputmode="decimal"></span></label>
        </div>
        <div class="tp-commission">
          <div class="tp-row">
            <label class="tp-field tp-narrow"><span class="tp-flabel">Commission</span>
              <span class="tp-money"><input type="number" min="0" max="100" step="0.5" class="tp-input tp-rate" inputmode="decimal"><span class="tp-affix tp-affix-r">%</span></span></label>
            <label class="tp-field"><span class="tp-flabel">Sales tracked by</span>
              <select class="tp-input tp-attr">
                <option value="link">Tracked link</option>
                <option value="code">Promo code</option>
                <option value="link_and_code">Link + promo code</option>
              </select></label>
            <label class="tp-field tp-code-field" hidden><span class="tp-flabel">Promo code <span class="tp-opt">optional</span></span>
              <input type="text" class="tp-input tp-code" maxlength="40" placeholder="e.g. SAM15" spellcheck="false" autocomplete="off"></label>
          </div>
          <div class="tp-row">
            <label class="tp-field tp-narrow"><span class="tp-flabel">Attribution window</span>
              <span class="tp-money"><input type="number" min="1" max="365" class="tp-input tp-cookie" value="30"><span class="tp-affix tp-affix-r">days</span></span></label>
            <label class="tp-field tp-narrow"><span class="tp-flabel">Term</span>
              <select class="tp-input tp-term">
                <option value="1">1 month</option><option value="3">3 months</option><option value="6" selected>6 months</option>
                <option value="12">12 months</option><option value="24">24 months</option><option value="">Ongoing</option>
              </select></label>
            <label class="tp-field tp-narrow"><span class="tp-flabel">Paid monthly, within</span>
              <span class="tp-money"><input type="number" min="0" max="120" class="tp-input tp-net" value="30"><span class="tp-affix tp-affix-r">days</span></span></label>
          </div>
        </div>
        <div class="tp-row tp-product-row">
          <label class="tp-field tp-wide"><span class="tp-flabel">What they receive</span>
            <input type="text" class="tp-input tp-product" maxlength="300" placeholder="e.g. Full skincare set (~$250 retail), shipped before filming"></label>
        </div>
      </div>
      <button type="button" class="tp-suggest" hidden></button>
      <div class="tp-summary" aria-live="polite"></div>`;
    const q = (sel) => root.querySelector(sel);
    const els = {
      fee: q('.tp-fee'), feeLabel: q('.tp-fee-label'), rate: q('.tp-rate'), attr: q('.tp-attr'),
      code: q('.tp-code'), codeField: q('.tp-code-field'), cookie: q('.tp-cookie'), term: q('.tp-term'),
      net: q('.tp-net'), product: q('.tp-product'), suggest: q('.tp-suggest'), summary: q('.tp-summary'),
    };
    let model = allowNone ? 'none' : 'flat';
    const listeners = [];
    const emit = () => { render(); listeners.forEach((fn) => { try { fn(); } catch { /* local */ } }); };

    function read() {
      // → { terms } | { error, el } | { terms: null } for "none"
      if (model === 'none') return { terms: null };
      const t = { model, fee: null, commission: null, product: null };
      if (model === 'flat' || model === 'hybrid') {
        const fee = Number(els.fee.value);
        if (!els.fee.value || !Number.isFinite(fee) || fee <= 0) {
          return { error: model === 'hybrid' ? 'Enter the upfront fee.' : 'Enter the fee.', el: els.fee };
        }
        t.fee = Math.round(fee);
      }
      if (model === 'commission' || model === 'hybrid') {
        const rate = Number(els.rate.value);
        if (!els.rate.value || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
          return { error: 'Enter the commission rate (0–100%).', el: els.rate };
        }
        const code = els.code.value.trim();
        if (code && !/^[A-Za-z0-9_-]{2,40}$/.test(code)) {
          return { error: 'Promo codes use letters, numbers, "-" and "_" only.', el: els.code };
        }
        t.commission = {
          rate_pct: Math.round(rate * 100) / 100,
          attribution: els.attr.value,
          promo_code: els.attr.value === 'link' || !code ? null : code.toUpperCase(),
          cookie_days: Math.round(Number(els.cookie.value) || 30),
          term_months: els.term.value === '' ? null : Number(els.term.value),
          payout_net_days: Math.round(Number(els.net.value) >= 0 && els.net.value !== '' ? Number(els.net.value) : 30),
        };
      }
      if (model === 'product') {
        const p = els.product.value.trim();
        if (!p) return { error: 'Describe the product they receive.', el: els.product };
        t.product = p;
      }
      return { terms: t };
    }

    function render() {
      root.dataset.model = model;
      root.querySelectorAll('.tp-model').forEach((b) => {
        const on = b.dataset.model === model;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      q('.tp-fee-row').hidden = !(model === 'flat' || model === 'hybrid');
      els.feeLabel.textContent = model === 'hybrid' ? 'Upfront fee' : 'Fee';
      q('.tp-commission').hidden = !(model === 'commission' || model === 'hybrid');
      q('.tp-product-row').hidden = model !== 'product';
      els.codeField.hidden = els.attr.value === 'link';
      const r = read();
      const hint = TERMS_HINTS[model] || '';
      els.summary.innerHTML = r.terms ? `<b>${esc(summarizeTerms(r.terms))}</b> ${esc(hint)}` : esc(hint);
    }

    root.querySelectorAll('.tp-model').forEach((b) => {
      b.addEventListener('click', () => {
        model = b.dataset.model;
        emit();
        const first = { flat: els.fee, hybrid: els.fee, commission: els.rate, product: els.product }[model];
        if (first && !first.value && opts.focusOnSwitch !== false) first.focus();
      });
    });
    root.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', emit);
      el.addEventListener('change', emit);
    });

    // "Your email mentions $500 and 15% — set as fee + commission?" Never
    // applied silently: the terms are what an acceptance books.
    let dismissed = '';
    function suggestFrom(text) {
      const amt = detectAmount(text);
      const pctN = detectPercent(text);
      let s = null;
      if (model === 'none') {
        if (amt && pctN) s = { model: 'hybrid', fee: amt, rate: pctN, text: `Your email mentions $${amt.toLocaleString('en-US')} and ${pctN}% — set as fee + commission` };
        else if (pctN) s = { model: 'commission', rate: pctN, text: `Your email mentions ${pctN}% — set as a commission offer` };
        else if (amt) s = { model: 'flat', fee: amt, text: `Your email mentions $${amt.toLocaleString('en-US')} — set as the fee` };
      } else if ((model === 'flat' || model === 'hybrid') && !els.fee.value && amt) {
        s = { model, fee: amt, text: `Use $${amt.toLocaleString('en-US')} from your email as the ${model === 'hybrid' ? 'upfront fee' : 'fee'}` };
      } else if ((model === 'commission' || model === 'hybrid') && !els.rate.value && pctN) {
        s = { model, rate: pctN, text: `Use ${pctN}% from your email as the commission` };
      }
      const key = s ? JSON.stringify(s) : '';
      els.suggest.hidden = !s || key === dismissed;
      if (s) {
        els.suggest.textContent = s.text;
        els.suggest.onclick = () => {
          dismissed = key;
          model = s.model;
          if (s.fee) els.fee.value = s.fee;
          if (s.rate) els.rate.value = s.rate;
          els.suggest.hidden = true;
          emit();
        };
      }
    }

    function setTerms(t) {
      if (!t || !t.model || t.model === 'none') { model = allowNone ? 'none' : 'flat'; render(); return; }
      model = t.model;
      if (t.fee != null) els.fee.value = t.fee;
      const c = t.commission;
      if (c) {
        if (c.rate_pct != null) els.rate.value = c.rate_pct;
        if (c.attribution) els.attr.value = c.attribution;
        if (c.promo_code) els.code.value = c.promo_code;
        if (c.cookie_days) els.cookie.value = c.cookie_days;
        els.term.value = c.term_months == null ? '' : String(c.term_months);
        if (c.payout_net_days != null) els.net.value = c.payout_net_days;
      }
      if (t.product) els.product.value = t.product;
      render();
    }

    render();
    if (opts.initial) setTerms(opts.initial);
    const api = {
      el: root,
      getModel: () => model,
      read,
      setTerms,
      suggestFrom,
      describe: () => { const r = read(); return r.terms ? describeTerms(r.terms) : ''; },
      summary: () => { const r = read(); return r.terms ? summarizeTerms(r.terms) : ''; },
      onChange(fn) { listeners.push(fn); return api; },
      setDisabled(on) { root.querySelectorAll('button, input, select').forEach((el) => { el.disabled = !!on; }); },
    };
    return api;
  }

  global.EmailComposer = {
    create,
    sanitize,
    markdownToHtml,
    textToHtml,
    detectAmount,
    detectPercent,
    createTermsPicker,
    describeTerms,
    summarizeTerms,
  };
})(window);
