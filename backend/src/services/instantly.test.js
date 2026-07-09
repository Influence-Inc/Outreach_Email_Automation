'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, stripMarkdown, replyToEmail } = require('./instantly');

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

// ── replyToEmail retry policy (regression guard) ───────────────────────────
// The reported production bug: the "Approve & send offer" click showed
// "aborted / failed" in the UI but the creator received 2-3 duplicate emails.
// Root cause: request() retried POST /emails/reply on AbortError / TypeError,
// which are AMBIGUOUS outcomes (the server may have accepted and sent the
// email — we just missed the response). replyToEmail now passes sendOnce:true
// so those ambiguous errors are fatal after the first attempt. Explicit
// server-side rejections (5xx / 429) are still retried because the server
// confirmed it did NOT process the request.

async function withStubbedFetch(fn, stub) {
  const original = globalThis.fetch;
  const originalKey = process.env.INSTANTLY_API_KEY;
  process.env.INSTANTLY_API_KEY = 'test-key';
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.INSTANTLY_API_KEY;
    else process.env.INSTANTLY_API_KEY = originalKey;
  }
}

test('replyToEmail does NOT retry on AbortError — one attempt only (prevents duplicate sends)', async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      await assert.rejects(
        replyToEmail({ replyToUuid: 'u', eaccount: 'a@b.co', subject: 's', body: 'b' }),
        /aborted|AbortError/i,
      );
    },
    async () => {
      calls += 1;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  );
  assert.strictEqual(calls, 1, 'timed-out send must NOT retry — the server may have already sent it');
});

test('replyToEmail does NOT retry on TypeError (network drop) — one attempt only', async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      await assert.rejects(
        replyToEmail({ replyToUuid: 'u', eaccount: 'a@b.co', subject: 's', body: 'b' }),
        /fetch failed/i,
      );
    },
    async () => {
      calls += 1;
      const err = new TypeError('fetch failed');
      throw err;
    },
  );
  assert.strictEqual(calls, 1, 'network-error send must NOT retry — ambiguous outcome');
});

test('replyToEmail DOES retry on explicit 5xx — server confirmed no-op, safe to resend', async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      const res = await replyToEmail({ replyToUuid: 'u', eaccount: 'a@b.co', subject: 's', body: 'b' });
      assert.deepStrictEqual(res, { ok: true });
    },
    async () => {
      calls += 1;
      if (calls < 2) {
        return { status: 503, ok: false, text: async () => 'busy', json: async () => ({}) };
      }
      return { status: 200, ok: true, text: async () => '', json: async () => ({ ok: true }) };
    },
  );
  assert.strictEqual(calls, 2, '5xx retry is safe — server said it did NOT process the request');
});
