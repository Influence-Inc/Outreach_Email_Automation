'use strict';

// Run with: npm test  (node --test)
//
// Guards the Linq (Partner API v3) iMessage send path: E.164 normalisation, the
// exact chats/parts request body, and the graceful-skip behaviour when the
// sandbox creds aren't configured. No network is touched — the skip/guard paths
// all return before fetch, and buildLinqPayload is pure.
const test = require('node:test');
const assert = require('node:assert');
const imessage = require('./imessage');

test('toE164 keeps E.164 with a leading +', () => {
  assert.strictEqual(imessage.toE164('+12223334444'), '+12223334444');
});

test('toE164 strips spaces, dashes, and parens but re-adds the +', () => {
  assert.strictEqual(imessage.toE164('(222) 333-4444'), '+2223334444');
  assert.strictEqual(imessage.toE164('+1 222-333-4444'), '+12223334444');
});

test('toE164 treats a leading 00 international prefix as +', () => {
  assert.strictEqual(imessage.toE164('00919812345670'), '+919812345670');
});

test('toE164 returns empty string for junk / empty input', () => {
  assert.strictEqual(imessage.toE164(''), '');
  assert.strictEqual(imessage.toE164(null), '');
  assert.strictEqual(imessage.toE164('abc'), '');
});

test('buildLinqPayload produces Linq chats/parts shape with E.164 numbers', () => {
  const payload = imessage.buildLinqPayload({
    from: '+1 (800) 555-0000',
    to: '18005551234',
    body: 'Hi there',
  });
  assert.deepStrictEqual(payload, {
    from: '+18005550000',
    to: ['+18005551234'],
    message: { parts: [{ type: 'text', value: 'Hi there' }] },
  });
});

test('businessNumber reflects IMESSAGE_FROM_NUMBER (empty when unset)', () => {
  const saved = process.env.IMESSAGE_FROM_NUMBER;
  try {
    delete process.env.IMESSAGE_FROM_NUMBER;
    assert.strictEqual(imessage.businessNumber(), '');
    process.env.IMESSAGE_FROM_NUMBER = '+18005550000';
    assert.strictEqual(imessage.businessNumber(), '+18005550000');
  } finally {
    if (saved === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = saved;
  }
});

test('renderOfferOutreachBody includes name, brand, link, and expiry', () => {
  const body = imessage.renderOfferOutreachBody({
    firstName: 'Sam',
    brandName: 'Acme',
    offerUrl: 'https://x.test/o/tok',
    expiryDate: 'Aug 1',
  });
  assert.match(body, /Sam/);
  assert.match(body, /Acme/);
  assert.match(body, /https:\/\/x\.test\/o\/tok/);
  assert.match(body, /Aug 1/);
});

test('renderRedirectPage opens Messages to the business number (normalised)', () => {
  const saved = process.env.IMESSAGE_FROM_NUMBER;
  try {
    process.env.IMESSAGE_FROM_NUMBER = '+1 (205) 370-6046';
    const html = imessage.renderRedirectPage();
    // The sms: target is the normalised E.164 of our business number…
    assert.match(html, /sms:\+12053706046/);
    // …offered as a tappable button and an auto-redirect, with the number shown.
    assert.match(html, /Open iMessage/);
    assert.match(html, /http-equiv="refresh"/);
    assert.match(html, /205/);
  } finally {
    if (saved === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = saved;
  }
});

test('renderRedirectPage shows a notice (no sms: link) when no number is configured', () => {
  const saved = process.env.IMESSAGE_FROM_NUMBER;
  try {
    delete process.env.IMESSAGE_FROM_NUMBER;
    const html = imessage.renderRedirectPage();
    assert.doesNotMatch(html, /sms:/);
    assert.match(html, /isn't set up/);
  } finally {
    if (saved === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = saved;
  }
});

test('sendIMessageText skips gracefully when creds are absent', async () => {
  const saved = {
    key: process.env.IMESSAGE_API_KEY,
    from: process.env.IMESSAGE_FROM_NUMBER,
  };
  try {
    // No API key → skip.
    delete process.env.IMESSAGE_API_KEY;
    process.env.IMESSAGE_FROM_NUMBER = '+18005550000';
    assert.deepStrictEqual(await imessage.sendIMessageText({ to: '+1222', body: 'x' }), {
      sent: false,
      skipped: true,
    });

    // Key present but no from-number → skip.
    process.env.IMESSAGE_API_KEY = 'test-key';
    delete process.env.IMESSAGE_FROM_NUMBER;
    assert.deepStrictEqual(await imessage.sendIMessageText({ to: '+1222', body: 'x' }), {
      sent: false,
      skipped: true,
    });

    // Creds present but recipient is unusable → error before any network call.
    process.env.IMESSAGE_API_KEY = 'test-key';
    process.env.IMESSAGE_FROM_NUMBER = '+18005550000';
    const res = await imessage.sendIMessageText({ to: 'not-a-number', body: 'x' });
    assert.strictEqual(res.sent, false);
    assert.match(res.error, /invalid recipient/);
  } finally {
    if (saved.key === undefined) delete process.env.IMESSAGE_API_KEY;
    else process.env.IMESSAGE_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = saved.from;
  }
});
