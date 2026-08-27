'use strict';

// Run with: npm test  (node --test)
//
// Guards the executed-contract copy the creator gets by email the moment they
// sign: who it addresses, what it attaches, and that it goes out exactly once.
// db + global.fetch are stubbed — no database, no network.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const email = require('./offerPortal/email');
const signedContractEmail = require('./signedContractEmail');

const { recipientFor, firstNameFor, buildContractCopyEmail, sendSignedContractCopy } = signedContractEmail;

const SIGNED_ROW = {
  token: 'tok_abc',
  creator_id: 7,
  status: 'signed',
  signer_name: 'Rachel Ly',
  signer_email: 'rachel@signed.example',
  signed_at: '2026-08-10T21:52:52.000Z',
  data: {
    creatorName: 'rachel ly',
    email: 'rachel@contract.example',
    brandName: 'Reve',
    campaignName: 'Feature Group + Mobile',
    compensation: '$6,000',
  },
  submission: {
    agreedAt: '2026-08-10T21:52:52.000Z',
    fields: {
      legalName: 'Rachel Ly',
      bankAccount: { accountHolder: 'Rachel Ly', accountNumber: '1234567890' },
    },
  },
};

// Swap db.query / db.one / db.many and global.fetch for the duration of `fn`.
// The service reaches them through the module object at call time, so plain
// property assignment is enough — no loader hooks needed.
async function withStubs({ env = {}, one, query, many, fetchFn }, fn) {
  const saved = { one: db.one, query: db.query, many: db.many, fetch: global.fetch };
  const savedEnv = {};
  for (const k of Object.keys(env)) {
    savedEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  if (one) db.one = one;
  if (query) db.query = query;
  if (many) db.many = many;
  if (fetchFn) global.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    Object.assign(db, { one: saved.one, query: saved.query, many: saved.many });
    global.fetch = saved.fetch;
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

function okResponse(body = { id: 'msg_1' }) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

// ── Recipient / greeting resolution ────────────────────────────────────────

test('recipientFor prefers the address the creator signed with', () => {
  assert.strictEqual(recipientFor(SIGNED_ROW, { email: 'stale@creator.example' }), 'rachel@signed.example');
});

test('recipientFor falls back to the contract data, then the creator row', () => {
  const noSigner = { ...SIGNED_ROW, signer_email: null };
  assert.strictEqual(recipientFor(noSigner, { email: 'stale@creator.example' }), 'rachel@contract.example');

  const bare = { ...noSigner, data: {} };
  assert.strictEqual(recipientFor(bare, { email: 'stale@creator.example' }), 'stale@creator.example');
  assert.strictEqual(recipientFor(bare, null), '');
});

test('firstNameFor greets by the creator row, then the signed name', () => {
  assert.strictEqual(firstNameFor(SIGNED_ROW, { first_name: 'Rach' }), 'Rach');
  assert.strictEqual(firstNameFor(SIGNED_ROW, { full_name: 'Rachel Ly' }), 'Rachel');
  // No creator row at all — the legal name they signed carries the greeting.
  assert.strictEqual(firstNameFor(SIGNED_ROW, null), 'Rachel');
  assert.strictEqual(firstNameFor({ token: 't', data: {} }, null), 'there');
});

test('buildContractCopyEmail names the file after the signer, like the download', () => {
  const built = buildContractCopyEmail(SIGNED_ROW, { first_name: 'Rachel' });
  assert.strictEqual(built.filename, 'Rachel-Ly-Contract-Signed.pdf');
  assert.strictEqual(built.brandName, 'Reve');
  assert.strictEqual(built.campaignName, 'Feature Group + Mobile');
});

// ── The email itself ───────────────────────────────────────────────────────

test('renderSignedContractEmail names the brand and points at the attachment', () => {
  const r = email.renderSignedContractEmail({
    firstName: 'Rachel',
    brandName: 'Reve',
    campaignName: 'Feature Group + Mobile',
  });
  assert.match(r.subject, /signed Reve agreement/i);
  assert.match(r.text, /^Hi Rachel,/);
  assert.match(r.text, /attached/i);
  // It must never imply the creator has to go somewhere to fetch the document.
  assert.doesNotMatch(r.text, /https?:\/\//);
  assert.match(r.html, /Reve/);
});

// ── The send ───────────────────────────────────────────────────────────────

test('sendSignedContractCopy attaches the rendered PDF and audits the send', async () => {
  const events = [];
  let payload = null;
  const result = await withStubs(
    {
      env: { RESEND_API_KEY: 'test_key' },
      // Only call: the already-emailed guard (the creator row is passed in).
      one: async () => null,
      query: async (_sql, params) => {
        events.push(params);
        return { rowCount: 1 };
      },
      fetchFn: async (_url, init) => {
        payload = JSON.parse(init.body);
        return okResponse({ id: 'msg_42' });
      },
    },
    () => sendSignedContractCopy(SIGNED_ROW, { id: 7, first_name: 'Rachel', email: 'rachel@creator.example' }),
  );

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.to, 'rachel@signed.example');
  assert.strictEqual(payload.to, 'rachel@signed.example');
  assert.strictEqual(payload.attachments.length, 1);
  assert.strictEqual(payload.attachments[0].filename, 'Rachel-Ly-Contract-Signed.pdf');

  // The attachment is the real document, inline as base64 — not a link.
  const pdf = Buffer.from(payload.attachments[0].content, 'base64');
  assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.length > 1000, 'expected a full contract PDF, not a stub');

  // The audit row the retry sweep and the dashboard timeline both read.
  const [creatorId, detail] = events[0];
  assert.strictEqual(creatorId, 7);
  assert.strictEqual(detail.ok, true);
  assert.strictEqual(detail.token, 'tok_abc');
  assert.strictEqual(detail.messageId, 'msg_42');
});

test('sendSignedContractCopy sends the MASKED copy — full account numbers never travel', async () => {
  let payload = null;
  await withStubs(
    {
      env: { RESEND_API_KEY: 'test_key' },
      one: async () => null,
      query: async () => ({ rowCount: 1 }),
      fetchFn: async (_url, init) => {
        payload = JSON.parse(init.body);
        return okResponse();
      },
    },
    () => sendSignedContractCopy(SIGNED_ROW, { id: 7, first_name: 'Rachel' }),
  );
  const pdf = Buffer.from(payload.attachments[0].content, 'base64').toString('latin1');
  assert.ok(!pdf.includes('1234567890'), 'the full account number must not appear in the emailed copy');
});

test('sendSignedContractCopy does not send twice for the same contract', async () => {
  let fetched = 0;
  const result = await withStubs(
    {
      env: { RESEND_API_KEY: 'test_key' },
      one: async () => ({ '?column?': 1 }), // a prior successful copy exists
      query: async () => ({ rowCount: 1 }),
      fetchFn: async () => {
        fetched += 1;
        return okResponse();
      },
    },
    () => sendSignedContractCopy(SIGNED_ROW, { id: 7 }),
  );
  assert.deepStrictEqual(result, { sent: false, skipped: true, reason: 'already_emailed' });
  assert.strictEqual(fetched, 0);
});

test('sendSignedContractCopy skips an unsigned contract and a contract with no address', async () => {
  await withStubs({ env: { RESEND_API_KEY: 'test_key' } }, async () => {
    const pending = await sendSignedContractCopy({ token: 't', status: 'pending', data: {} });
    assert.strictEqual(pending.reason, 'not_signed');
  });

  const events = [];
  const noAddress = await withStubs(
    {
      env: { RESEND_API_KEY: 'test_key' },
      one: async () => null,
      query: async (_sql, params) => {
        events.push(params);
        return { rowCount: 1 };
      },
      fetchFn: async () => {
        throw new Error('must not send without an address');
      },
    },
    () =>
      sendSignedContractCopy({ ...SIGNED_ROW, signer_email: null, data: { brandName: 'Reve' } }, { id: 7 }),
  );
  assert.strictEqual(noAddress.reason, 'no_email');
  assert.strictEqual(events[0][1].ok, false);
});

test('sendSignedContractCopy skips quietly when Resend is not configured', async () => {
  const result = await withStubs({ env: { RESEND_API_KEY: undefined } }, () =>
    sendSignedContractCopy(SIGNED_ROW, { id: 7 }),
  );
  assert.deepStrictEqual(result, { sent: false, skipped: true, reason: 'not_configured' });
});

// ── The retry sweep ────────────────────────────────────────────────────────

test('retryUnsentContractCopies only looks at signed contracts with no delivered copy', async () => {
  let sql = '';
  await withStubs(
    {
      env: { RESEND_API_KEY: 'test_key' },
      many: async (text) => {
        sql = text;
        return [];
      },
    },
    () => signedContractEmail.retryUnsentContractCopies(),
  );
  assert.match(sql, /status IN \('signed', 'completed'\)/);
  assert.match(sql, /contract_copy_emailed/);
  assert.match(sql, /NOT EXISTS/);
});

test('retryUnsentContractCopies is a no-op when Resend is not configured', async () => {
  const out = await withStubs(
    {
      env: { RESEND_API_KEY: undefined },
      many: async () => {
        throw new Error('must not query without a key');
      },
    },
    () => signedContractEmail.retryUnsentContractCopies(),
  );
  assert.deepStrictEqual(out, { checked: 0, sent: 0, failed: 0 });
});
