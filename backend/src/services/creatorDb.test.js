'use strict';

// Run with: npm test  (node --test)
//
// Covers fetchContractDocumentHtml — the resolver behind Deal Studio's
// "Contract" download, which pulls the compliant legal document (the "Creator
// Services Agreement") from the Creator Database for a signed creator. It
// stubs fetch to assert the resolution chain: categorize (creator id) →
// contracts list (match by contractRef == outreach token) → document HTML.

const test = require('node:test');
const assert = require('node:assert');
const creatorDb = require('./creatorDb');

// Minimal Response-like stub. `body` is returned from .json(); the document
// endpoint reads .text() instead.
function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

async function withStubbedFetch(routes, fn) {
  const original = globalThis.fetch;
  const prevUrl = process.env.CREATOR_DB_URL;
  const prevKey = process.env.CREATOR_DB_API_KEY;
  process.env.CREATOR_DB_URL = 'https://cdb.test';
  process.env.CREATOR_DB_API_KEY = 'k';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET' });
    const handler = routes(url, opts);
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    if (prevUrl === undefined) delete process.env.CREATOR_DB_URL;
    else process.env.CREATOR_DB_URL = prevUrl;
    if (prevKey === undefined) delete process.env.CREATOR_DB_API_KEY;
    else process.env.CREATOR_DB_API_KEY = prevKey;
  }
}

test('fetchContractDocumentHtml resolves creator + contract and returns the print-ready document', async () => {
  const routes = (url) => {
    if (url.endsWith('/creators/categorize')) {
      return resp(200, [{ category: 'used', creator: { id: 'cdb-1' } }]);
    }
    if (url.endsWith('/roster/cdb-1/contracts')) {
      return resp(200, {
        contracts: [
          { id: 'other-7', contractRef: 'tok-zzz' },
          { id: 'ctr-9', contractRef: 'tok-abc' },
        ],
      });
    }
    if (url.endsWith('/roster/cdb-1/contracts/ctr-9/document?print=1')) {
      return resp(200, '<!doctype html><title>Creator Services Agreement</title>');
    }
    return null;
  };

  await withStubbedFetch(routes, async (calls) => {
    const out = await creatorDb.fetchContractDocumentHtml(
      { email: 'vy@example.com', instagramUsername: 'riu.drafts', contractRef: 'tok-abc' },
      { print: true },
    );
    assert.ok(out, 'expected a document result');
    assert.strictEqual(out.creatorId, 'cdb-1');
    assert.strictEqual(out.contractId, 'ctr-9'); // matched by contractRef, not order
    assert.match(out.html, /Creator Services Agreement/);
    // The document was requested in print mode.
    assert.ok(calls.some((c) => c.url.endsWith('/roster/cdb-1/contracts/ctr-9/document?print=1')));
  });
});

test('fetchContractDocumentHtml returns null when the creator is not in the Creator Database', async () => {
  const routes = (url) => {
    if (url.endsWith('/creators/categorize')) {
      return resp(200, [{ category: 'new', creator: null }]);
    }
    return null;
  };
  await withStubbedFetch(routes, async () => {
    const out = await creatorDb.fetchContractDocumentHtml({ email: 'nobody@example.com' }, { print: true });
    assert.strictEqual(out, null);
  });
});

test('fetchContractDocumentHtml returns null when Creator-DB is not configured', async () => {
  const prev = process.env.CREATOR_DB_URL;
  delete process.env.CREATOR_DB_URL;
  try {
    const out = await creatorDb.fetchContractDocumentHtml({ email: 'a@b.co', contractRef: 'x' });
    assert.strictEqual(out, null);
  } finally {
    if (prev !== undefined) process.env.CREATOR_DB_URL = prev;
  }
});
