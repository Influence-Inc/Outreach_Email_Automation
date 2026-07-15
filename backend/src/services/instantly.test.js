'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const {
  renderMarkdown,
  stripMarkdown,
  replyToEmail,
  removeLeadFromCampaign,
  parseAddressList,
  replyAllCc,
  fetchReplyAllCc,
} = require('./instantly');

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

// ── removeLeadFromCampaign ─────────────────────────────────────────────────
// Stopping outreach is CAMPAIGN-SCOPED: we remove the creator's lead from one
// campaign (find the lead id via POST /leads/list, then DELETE /leads with the
// campaign_id + ids), never the workspace block list — so the same address is
// left free to be enrolled in a different campaign later.

test('removeLeadFromCampaign finds the exact-email lead in the campaign and deletes it by id', async () => {
  const calls = [];
  await withStubbedFetch(
    async () => {
      const n = await removeLeadFromCampaign({ email: 'Creator@Example.com', campaignId: 'camp-9' });
      assert.strictEqual(n, 1);
    },
    async (url, opts) => {
      calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      if (url.endsWith('/leads/list')) {
        return {
          status: 200, ok: true, text: async () => '',
          // A non-matching address is returned too — the broad `search` filter
          // must be narrowed to exact matches on our side.
          json: async () => ({ items: [
            { id: 'lead-1', email: 'creator@example.com' },
            { id: 'lead-2', email: 'someoneelse@example.com' },
          ] }),
        };
      }
      return { status: 200, ok: true, text: async () => '', json: async () => ({ deleted: 1 }) };
    },
  );
  const list = calls.find((c) => c.url.endsWith('/leads/list'));
  const del = calls.find((c) => c.url.endsWith('/leads') && c.method === 'DELETE');
  assert.ok(list, 'lists leads scoped to the campaign');
  assert.strictEqual(list.body.campaign_id, 'camp-9');
  assert.ok(del, 'deletes via DELETE /leads');
  assert.strictEqual(del.body.campaign_id, 'camp-9');
  assert.deepStrictEqual(del.body.ids, ['lead-1'], 'only the exact-email lead is deleted');
});

test('removeLeadFromCampaign returns 0 and does NOT delete when the creator is not enrolled', async () => {
  let deleteCalled = false;
  await withStubbedFetch(
    async () => {
      const n = await removeLeadFromCampaign({ email: 'nobody@example.com', campaignId: 'camp-9' });
      assert.strictEqual(n, 0);
    },
    async (url, opts) => {
      if (url.endsWith('/leads/list')) {
        return { status: 200, ok: true, text: async () => '', json: async () => ({ items: [] }) };
      }
      if (opts.method === 'DELETE') deleteCalled = true;
      return { status: 200, ok: true, text: async () => '', json: async () => ({ deleted: 0 }) };
    },
  );
  assert.strictEqual(deleteCalled, false, 'no delete is issued when nothing matches');
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

// ── Reply-all CC (regression guard) ─────────────────────────────────────────
// The reported bug: an agent replied with the creator (and others) in To/Cc,
// and our threaded reply went ONLY to the agent — everyone else on the inbound
// email was silently dropped from the deal thread. Replies must CC every other
// recipient of the inbound email (reply-all), excluding only our own sending
// mailbox and the sender (who is already the reply's To).

test('parseAddressList handles arrays, comma strings, and "Name <addr>" forms', () => {
  assert.deepStrictEqual(
    parseAddressList('Rocco Sacino <rocco@rakugomedia.com>, willschafer@gmail.com'),
    ['rocco@rakugomedia.com', 'willschafer@gmail.com'],
  );
  assert.deepStrictEqual(
    parseAddressList(['A@B.co', 'a@b.co', '  ', 'c@d.co']),
    ['a@b.co', 'c@d.co'],
  );
  assert.deepStrictEqual(parseAddressList(null), []);
  assert.deepStrictEqual(parseAddressList(''), []);
});

test('replyAllCc keeps every inbound recipient except our mailbox and the sender', () => {
  // The screenshot case: rocco (agent) sends To: willschafer + jennifer (us).
  // Our reply goes To rocco via reply_to_uuid — willschafer must be CC'd.
  assert.deepStrictEqual(
    replyAllCc({
      toList: 'willschafer@gmail.com, Jennifer <jennifer@frominfluence.com>',
      ccList: null,
      fromAddress: 'Rocco Sacino <rocco@rakugomedia.com>',
      eaccount: 'jennifer@frominfluence.com',
    }),
    ['willschafer@gmail.com'],
  );
});

test('replyAllCc merges To + Cc, dedupes, and compares case-insensitively', () => {
  assert.deepStrictEqual(
    replyAllCc({
      toList: 'Jennifer@FromInfluence.com, agent@mgmt.co',
      ccList: ['creator@gmail.com', 'agent@mgmt.co'],
      fromAddress: 'agent@mgmt.co',
      eaccount: 'jennifer@frominfluence.com',
    }),
    ['creator@gmail.com'],
  );
});

test('replyAllCc is empty when the creator replied directly with nobody else on the email', () => {
  assert.deepStrictEqual(
    replyAllCc({
      toList: 'jennifer@frominfluence.com',
      ccList: '',
      fromAddress: 'creator@gmail.com',
      eaccount: 'jennifer@frominfluence.com',
    }),
    [],
  );
});

test('replyToEmail sends cc_address_email_list when a cc list is given', async () => {
  let sent;
  await withStubbedFetch(
    async () => {
      await replyToEmail({
        replyToUuid: 'u',
        eaccount: 'a@b.co',
        subject: 's',
        body: 'b',
        cc: ['willschafer@gmail.com', 'agent@mgmt.co'],
      });
    },
    async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { status: 200, ok: true, text: async () => '', json: async () => ({ ok: true }) };
    },
  );
  assert.strictEqual(sent.cc_address_email_list, 'willschafer@gmail.com,agent@mgmt.co');
});

test('replyToEmail omits cc_address_email_list when there is nobody to CC', async () => {
  let sent;
  await withStubbedFetch(
    async () => {
      await replyToEmail({ replyToUuid: 'u', eaccount: 'a@b.co', subject: 's', body: 'b', cc: [] });
    },
    async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { status: 200, ok: true, text: async () => '', json: async () => ({ ok: true }) };
    },
  );
  assert.strictEqual('cc_address_email_list' in sent, false);
});

test('fetchReplyAllCc computes the CC list from the fetched email object', async () => {
  let fetchedUrl;
  await withStubbedFetch(
    async () => {
      const cc = await fetchReplyAllCc({ emailId: 'uuid-1', eaccount: 'jennifer@frominfluence.com' });
      assert.deepStrictEqual(cc, ['willschafer@gmail.com']);
    },
    async (url) => {
      fetchedUrl = url;
      return {
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({
          id: 'uuid-1',
          from_address_email: 'Rocco Sacino <rocco@rakugomedia.com>',
          to_address_email_list: 'willschafer@gmail.com, jennifer@frominfluence.com',
          cc_address_email_list: '',
        }),
      };
    },
  );
  assert.ok(fetchedUrl.endsWith('/emails/uuid-1'), 'fetches the inbound email by id');
});
