'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { encodeSubject } = require('./gmail');

test('encodeSubject strips smart punctuation that mojibakes in Subject headers', () => {
  // The reported bug: a Unicode em dash in the subject rendered as "Ã¢Â€Â“".
  assert.strictEqual(
    encodeSubject('Reve 2.0 Model Campaign — Let’s collab!'),
    "Reve 2.0 Model Campaign - Let's collab!",
  );
  assert.strictEqual(
    encodeSubject('Partnership Proposal for Reve – 2 Video Deal'),
    'Partnership Proposal for Reve - 2 Video Deal',
  );
  // Curly quotes and ellipsis normalize to ASCII too.
  assert.strictEqual(encodeSubject('“hi” …'), '"hi" ...');
  // Already-ASCII subjects are untouched.
  assert.strictEqual(encodeSubject('Plain - subject'), 'Plain - subject');
  assert.strictEqual(encodeSubject(null), '');
});

test('encodeSubject RFC 2047-encodes any residual non-ASCII (e.g. accents)', () => {
  const out = encodeSubject('Café résumé');
  assert.match(out, /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
  // Round-trips back to the original (no data loss, just safe transport).
  const b64 = out.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf8'), 'Café résumé');
  // The encoded header itself is pure ASCII — it can't mojibake.
  assert.ok(!/[^\x00-\x7F]/.test(out));
});
