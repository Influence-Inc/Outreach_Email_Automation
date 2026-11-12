'use strict';

// Run with: npm test  (node --test)
//
// The composer's HTML is untrusted: whatever the browser sends must come out
// as a small, safe formatting subset, and the markdown copy Claude reads must
// say the same thing the creator sees.
const test = require('node:test');
const assert = require('node:assert');
const {
  sanitizeEmailHtml,
  emailHtml,
  htmlToMarkdown,
  htmlToText,
  prepareComposedEmail,
} = require('./emailHtml');

test('keeps the formatting subset and drops every attribute but a safe href', () => {
  const out = sanitizeEmailHtml(
    '<p class="x" style="color:red" onclick="steal()"><b>Bold</b>, <i>it</i>, <u>u</u>, <s>gone</s> ' +
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" onmouseover="x()">link</a></p>',
  );
  assert.strictEqual(
    out,
    '<p><b>Bold</b>, <i>it</i>, <u>u</u>, <s>gone</s> <a href="https://example.com/a?b=1&amp;c=2">link</a></p>',
  );
});

test('removes scripts, styles, comments and unsafe links entirely', () => {
  const out = sanitizeEmailHtml(
    '<style>p{color:red}</style><script>alert(1)</script><!-- note --><p>Hi <a href="javascript:alert(1)">there</a>' +
      '<a href=" java\nscript:alert(1)">x</a><img src=x onerror=alert(1)><iframe src="https://evil"></iframe></p>',
  );
  assert.strictEqual(out, '<p>Hi therex</p>');
  assert.doesNotMatch(out, /script|style|img|iframe|onerror/i);
});

test('unknown tags are unwrapped, their text kept and escaped', () => {
  const out = sanitizeEmailHtml('<section><span style="font-weight:700">A &lt;b&gt; 5 < 6</span></section>');
  assert.strictEqual(out, 'A &lt;b&gt; 5 &lt; 6');
});

test('attribute values containing ">" do not break out of the tag', () => {
  const out = sanitizeEmailHtml('<a title="a>b" href="https://x.com">ok</a><p data-x=\'"><script>bad()</script>\'>t</p>');
  assert.strictEqual(out, '<a href="https://x.com">ok</a><p>t</p>');
});

test('unbalanced markup is closed and stray closers ignored', () => {
  assert.strictEqual(sanitizeEmailHtml('<p><b>open</p></i>after'), '<p><b>open</b></p>after');
});

test('trailing empty paragraphs from the editor are trimmed', () => {
  assert.strictEqual(sanitizeEmailHtml('<p>Hi</p><p><br></p><div><br></div>'), '<p>Hi</p>');
});

test('emailHtml adds inline styles mail clients respect', () => {
  const out = emailHtml('<blockquote>q</blockquote><ul><li>a</li></ul>');
  assert.match(out, /<blockquote style="[^"]*border-left/);
  assert.match(out, /<ul style="[^"]*padding-left/);
});

test('htmlToMarkdown renders the same subset the AI emails use', () => {
  const md = htmlToMarkdown(
    '<p>Hi Sam,</p>' +
      '<p>Thanks for sharing your rate. <b>Here is what we can do:</b></p>' +
      '<ul><li><b>2 Reels</b> for $4,000</li><li>Posted by <i>Dec 1</i></li></ul>' +
      '<ol><li>First</li><li>Second</li></ol>' +
      '<p>See <a href="https://brand.com">our brand</a> or https://x.com</p>' +
      '<blockquote>Quoted line</blockquote>' +
      '<p>- Jennifer</p>',
  );
  assert.strictEqual(
    md,
    [
      'Hi Sam,',
      '',
      'Thanks for sharing your rate. **Here is what we can do:**',
      '',
      '- **2 Reels** for $4,000',
      '- Posted by *Dec 1*',
      '',
      '1. First',
      '2. Second',
      '',
      'See [our brand](https://brand.com) or https://x.com',
      '',
      '> Quoted line',
      '',
      '- Jennifer',
    ].join('\n'),
  );
});

test('htmlToText has no markdown markers and spells out link targets', () => {
  const text = htmlToText('<p><b>Deal</b>: see <a href="https://brand.com">brand</a>, mail <a href="mailto:a@b.co">a@b.co</a></p>');
  assert.strictEqual(text, 'Deal: see brand (https://brand.com), mail a@b.co');
});

test('Chrome contenteditable <div> lines become single lines, <br> breaks kept', () => {
  const md = htmlToMarkdown('<div>Line one</div><div>Line two<br>still two</div><div><br></div><div>after gap</div>');
  assert.strictEqual(md, 'Line one\nLine two\nstill two\n\nafter gap');
});

test('a Google Docs paste wrapper (<b style=font-weight:normal>) does not bold everything', () => {
  // The composer normalises this client-side; on the server the wrapper is just
  // a <b>, so the guarantee here is only that nothing unsafe survives and the
  // text is intact.
  const out = sanitizeEmailHtml('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span>Hello</span></p></b>');
  assert.match(out, /Hello/);
  assert.doesNotMatch(out, /meta|style|id=/);
});

test('entities decode in the text copies', () => {
  assert.strictEqual(htmlToText('<p>Tom &amp; Jerry&nbsp;&#8212; 5 &lt; 6</p>'), 'Tom & Jerry — 5 < 6');
});

test('prepareComposedEmail refuses an empty editor', () => {
  assert.throws(() => prepareComposedEmail('<p><br></p><div> </div>'), /empty/);
  const ok = prepareComposedEmail('<p>Hi <b>there</b></p>');
  assert.strictEqual(ok.markdown, 'Hi **there**');
  assert.strictEqual(ok.text, 'Hi there');
  assert.strictEqual(ok.html, '<p>Hi <b>there</b></p>');
});

test('empty blocks (Chrome leaves <p></p> where a list starts) are dropped', () => {
  assert.strictEqual(sanitizeEmailHtml('<p>Hi</p><p></p><ul><li>a</li></ul><p> </p><p>x</p>'), '<p>Hi</p><ul><li>a</li></ul><p>x</p>');
});

test('round-trips the composer’s real browser output', () => {
  // Captured from the dashboard composer after typing + a Google Docs paste.
  const html =
    '<p>Hi Sam, thanks for sharing your rate! <b>We can do $4,500 for two Reels.</b></p><ul><li>Full creative freedom</li><li>Posted by Dec 1</li></ul>' +
    '<p>Here is the brief: <a href="https://brand.com/brief">https://brand.com/brief</a> </p><p><b>Deliverables</b></p><ul><li><i>Two Reels</i> on Instagram</li></ul>' +
    '<p>See <a href="https://brand.com/brief">the brief</a> and this</p>';
  const { markdown, text } = prepareComposedEmail(html);
  assert.strictEqual(
    markdown,
    [
      'Hi Sam, thanks for sharing your rate! **We can do $4,500 for two Reels.**',
      '',
      '- Full creative freedom',
      '- Posted by Dec 1',
      '',
      'Here is the brief: https://brand.com/brief',
      '',
      '**Deliverables**',
      '',
      '- *Two Reels* on Instagram',
      '',
      'See [the brief](https://brand.com/brief) and this',
    ].join('\n'),
  );
  assert.match(text, /See the brief \(https:\/\/brand\.com\/brief\) and this/);
});
