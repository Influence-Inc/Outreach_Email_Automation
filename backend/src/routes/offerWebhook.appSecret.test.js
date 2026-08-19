'use strict';

// A correct App Secret pasted into a hosting dashboard with a trailing newline or
// wrapping quotes produces exactly the same symptom as a wrong one: every inbound
// webhook 401s while the value looks right on screen. These guard the tolerance
// for that, and the refusal to tolerate an actually-different secret.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const router = require('./offerWebhook');

const SECRET = '7f3a9c1e5b8d2046af71c93e0d6b4a25';
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

function reqWith(rawSecretInEnv, { body = BODY, signWith = SECRET, header = true } = {}) {
  process.env.WHATSAPP_CLOUD_APP_SECRET = rawSecretInEnv;
  const raw = Buffer.from(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', signWith).update(raw).digest('hex');
  return {
    rawBody: raw,
    body: JSON.parse(body),
    headers: header ? { 'x-hub-signature-256': sig, 'content-type': 'application/json' } : {},
  };
}

const orig = process.env.WHATSAPP_CLOUD_APP_SECRET;
test.after(() => {
  if (orig === undefined) delete process.env.WHATSAPP_CLOUD_APP_SECRET;
  else process.env.WHATSAPP_CLOUD_APP_SECRET = orig;
});

test('accepts a clean secret', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith(SECRET)), true);
});

test('accepts a secret stored with a trailing newline', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith(`${SECRET}\n`)), true);
});

test('accepts a secret stored with surrounding whitespace', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith(`  ${SECRET}  `)), true);
});

test('accepts a secret stored with wrapping quotes', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith(`"${SECRET}"`)), true);
  assert.strictEqual(router.verifyMetaSignature(reqWith(`'${SECRET}'`)), true);
});

test('still rejects a genuinely different secret', () => {
  const req = reqWith('00000000000000000000000000000000', { signWith: SECRET });
  assert.strictEqual(router.verifyMetaSignature(req), false);
});

test('still rejects a tampered body', () => {
  const req = reqWith(SECRET);
  req.rawBody = Buffer.from(JSON.stringify({ object: 'tampered' }));
  assert.strictEqual(router.verifyMetaSignature(req), false);
});

test('rejects when the signature header is missing', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith(SECRET, { header: false })), false);
});

test('a whitespace-only secret counts as unset (verification disabled)', () => {
  assert.strictEqual(router.verifyMetaSignature(reqWith('   ', { header: false })), true);
});

test('appSecretCandidates yields the raw, trimmed and unquoted forms without duplicates', () => {
  assert.deepStrictEqual(router.appSecretCandidates(SECRET), [SECRET]);
  assert.deepStrictEqual(router.appSecretCandidates(`${SECRET}\n`), [`${SECRET}\n`, SECRET]);
  assert.deepStrictEqual(router.appSecretCandidates(`"${SECRET}"`), [`"${SECRET}"`, SECRET]);
});
