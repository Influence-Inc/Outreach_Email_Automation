'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, stripMarkdown } = require('./instantly');

// ── renderMarkdown ─────────────────────────────────────────────────────────

test('renderMarkdown converts **bold** to <strong>', () => {
  assert.strictEqual(
    renderMarkdown('So great to hear from you!\n\n**Content Style**\nWe\'d love…'),
    "So great to hear from you!<br>\n<br>\n<strong>Content Style</strong><br>\nWe'd love…",
  );
});

test('renderMarkdown converts [label](url) to a hyperlink', () => {
  assert.strictEqual(
    renderMarkdown('See our [portfolio](https://influence.co/portfolio) here.'),
    'See our <a href="https://influence.co/portfolio">portfolio</a> here.',
  );
});

test('renderMarkdown auto-links a bare URL', () => {
  assert.strictEqual(
    renderMarkdown('Details at https://influence.co/collab today.'),
    'Details at <a href="https://influence.co/collab">https://influence.co/collab</a> today.',
  );
});

test('renderMarkdown does not double-linkify a URL already inside a markdown link', () => {
  // The URL inside [label](URL) must NOT be additionally wrapped by the bare-URL pass.
  const out = renderMarkdown('Book: [calendar](https://cal.com/j)');
  assert.strictEqual(
    out,
    'Book: <a href="https://cal.com/j">calendar</a>',
    'the bare-URL rule must skip URLs it already emitted as href="…"',
  );
  assert.ok(!/href="https:\/\/cal\.com\/j"[^>]*>.*<a /.test(out), 'no nested <a>');
});

test('renderMarkdown escapes HTML in the raw body so bodies cannot inject tags', () => {
  const out = renderMarkdown('Reply: <script>alert(1)</script> & </div>');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(out.includes('&amp;'));
  assert.ok(!/<script/i.test(out), 'raw <script> tag must not survive');
});

test('renderMarkdown handles multiple **bold** spans and mixed content in one body', () => {
  const body =
    'Hi Alex,\n\n' +
    '**Deliverables & Rates**\n' +
    '- 2 videos for the intro package\n' +
    '- Long-term retainer if the fit is right\n\n' +
    'More info: [website](https://influence.co) — talk soon!';
  const out = renderMarkdown(body);
  assert.ok(out.includes('<strong>Deliverables &amp; Rates</strong>'));
  assert.ok(out.includes('<a href="https://influence.co">website</a>'));
  // Line breaks preserved.
  assert.ok(out.split('<br>').length >= 5);
});

test('renderMarkdown does not treat a lone asterisk pair across paragraphs as bold', () => {
  // Non-greedy, single-line rule: `**` that spans a newline must not match, so
  // an unclosed `**` in one paragraph never eats the next paragraph.
  const out = renderMarkdown('unclosed ** here\n\nnext paragraph ** end.');
  assert.ok(!/<strong>/.test(out), 'no bold when the ** pair straddles a newline');
});

// ── stripMarkdown ──────────────────────────────────────────────────────────

test('stripMarkdown drops bold markers and inlines link URLs for text clients', () => {
  assert.strictEqual(
    stripMarkdown('**Content Style**\nWe love your work.'),
    'Content Style\nWe love your work.',
  );
  assert.strictEqual(
    stripMarkdown('See our [portfolio](https://influence.co/portfolio) here.'),
    'See our portfolio (https://influence.co/portfolio) here.',
  );
});

test('stripMarkdown leaves bare URLs untouched (they render fine in text)', () => {
  assert.strictEqual(
    stripMarkdown('Details at https://influence.co/collab today.'),
    'Details at https://influence.co/collab today.',
  );
});
