'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');

process.env.UNSUBSCRIBE_SECRET = 'test-secret-do-not-use-in-prod';
const { signToken, verifyToken, unsubscribeUrl, unsubscribeMailto } = require('./unsubscribe');

test('signToken is deterministic for a given creatorId', () => {
  assert.strictEqual(signToken(42), signToken(42));
  assert.notStrictEqual(signToken(42), signToken(43));
});

test('verifyToken accepts the signed token and rejects everything else', () => {
  const t = signToken(7);
  assert.strictEqual(verifyToken(7, t), true);
  // Same token, different creator id — must reject (per-recipient binding).
  assert.strictEqual(verifyToken(8, t), false);
  // Empty / wrong-length / tampered.
  assert.strictEqual(verifyToken(7, ''), false);
  assert.strictEqual(verifyToken(7, null), false);
  assert.strictEqual(verifyToken(7, t + 'x'), false);
  assert.strictEqual(verifyToken(7, t.slice(0, -1) + (t.slice(-1) === '0' ? '1' : '0')), false);
});

test('unsubscribeUrl strips trailing slash and embeds creator + token', () => {
  const url = unsubscribeUrl('https://track.useinfluence.xyz/', 99);
  assert.match(url, /^https:\/\/track\.useinfluence\.xyz\/unsubscribe\/99\/[a-f0-9]{32}$/);
});

test('unsubscribeMailto encodes the token in the subject', () => {
  const m = unsubscribeMailto('jennifer@useinfluence.xyz', 99);
  assert.match(m, /^mailto:jennifer@useinfluence\.xyz\?subject=unsubscribe-99-[a-f0-9]{32}$/);
});
