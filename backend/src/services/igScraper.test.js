'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { cleanEmail, findEmail, trimAppendedTld } = require('./igScraper');

test('trimAppendedTld removes the glued-on word (the reported bug)', () => {
  // Instagram bio rendered as "cc jj@33andwest.com<br>ticket" collapses to a
  // textContent of "cc jj@33andwest.comticket" — the regex greedily extends
  // the TLD to "comticket". This case must trim back to "com".
  assert.strictEqual(trimAppendedTld('jj@33andwest.comticket'), 'jj@33andwest.com');
  assert.strictEqual(trimAppendedTld('user@example.netextra'), 'user@example.net');
  assert.strictEqual(trimAppendedTld('hi@brand.orginquiries'), 'hi@brand.org');
});

test('trimAppendedTld leaves well-formed and known longer TLDs alone', () => {
  assert.strictEqual(trimAppendedTld('jj@33andwest.com'), 'jj@33andwest.com');
  assert.strictEqual(trimAppendedTld('user@example.io'), 'user@example.io');
  assert.strictEqual(trimAppendedTld('a@example.consulting'), 'a@example.consulting');
  assert.strictEqual(trimAppendedTld('a@example.online'), 'a@example.online');
  assert.strictEqual(trimAppendedTld('a@sub.example.co.uk'), 'a@sub.example.co.uk');
});

test('trimAppendedTld leaves short unknown TLDs alone (≤6 chars)', () => {
  // We don't try to trim a 6-char-or-shorter unknown TLD — could be legit.
  assert.strictEqual(trimAppendedTld('a@example.coffee'), 'a@example.coffee');
});

test('cleanEmail handles whitespace, [at]/(at), and the TLD bug together', () => {
  assert.strictEqual(cleanEmail('JJ@33Andwest.COMTicket'), 'jj@33andwest.com');
  assert.strictEqual(cleanEmail(' jj @ 33andwest . com '), 'jj@33andwest.com');
  assert.strictEqual(cleanEmail('jj [at] 33andwest [dot] com'), 'jj@33andwest.com');
  assert.strictEqual(cleanEmail('jj (at) 33andwest (dot) com'), 'jj@33andwest.com');
});

test('findEmail extracts from messy bio text', () => {
  // Space-separated (no DOM weirdness): regex bounds correctly.
  assert.strictEqual(
    findEmail('cc jj@33andwest.com ticket inquiries'),
    'jj@33andwest.com',
  );
  // No separator (the bug case): regex grabs "comticket"; cleanEmail trims it.
  assert.strictEqual(
    findEmail('cc jj@33andwest.comticket inquiries'),
    'jj@33andwest.com',
  );
  assert.strictEqual(findEmail(''), null);
  assert.strictEqual(findEmail('no email here'), null);
});

test('findEmail ignores @-mentions that have a space before the @', () => {
  // Instagram handle mentions are not emails — a space before @ disqualifies it.
  assert.strictEqual(findEmail('1/2 of @afterthought.ca'), null);
  assert.strictEqual(findEmail('run by @brand.co with love'), null);
  assert.strictEqual(findEmail('collab? dm @some.studio'), null);
  // A real (glued) email elsewhere in the bio is still found.
  assert.strictEqual(findEmail('follow @brand or email hi@brand.com'), 'hi@brand.com');
  // A genuinely glued address (no space before @) is still an email.
  assert.strictEqual(findEmail('of@afterthought.ca'), 'of@afterthought.ca');
});
