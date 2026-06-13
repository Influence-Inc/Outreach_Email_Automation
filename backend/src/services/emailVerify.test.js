'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { isValidSyntax } = require('./emailVerify');

// Only the syntax gate is covered here (deterministic, no network). The DNS/MX
// path is exercised via the live smoke test, not committed tests, to avoid
// flakiness from network conditions.
test('isValidSyntax accepts real-looking addresses', () => {
  assert.ok(isValidSyntax('jj@33andwest.com'));
  assert.ok(isValidSyntax('a.b+tag@sub.example.co.uk'));
  assert.ok(isValidSyntax('HOWDY@travisyeehaw.com'));
});

test('isValidSyntax rejects scraped junk', () => {
  assert.ok(!isValidSyntax(''));
  assert.ok(!isValidSyntax(null));
  assert.ok(!isValidSyntax('not-an-email'));
  assert.ok(!isValidSyntax('a@b'));          // no dotted TLD
  assert.ok(!isValidSyntax('a@@b.com'));     // double @
  assert.ok(!isValidSyntax('a b@c.com'));    // space in local part
  assert.ok(!isValidSyntax('@no-local.com')); // missing local part
  assert.ok(!isValidSyntax('trailing@dot.')); // empty TLD
});
