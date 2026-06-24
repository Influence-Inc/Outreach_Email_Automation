'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { renderOutreach, renderFollowup, getHardcodedDefaults } = require('./templates');

test('renderOutreach personalizes the subject with firstName', () => {
  const { subject } = renderOutreach(null, { firstName: 'Alex', brandName: 'Nike' });
  // Per-recipient {firstName} in the subject breaks the same-subject bulk-mail
  // fingerprint.
  assert.match(subject, /Alex/);
  assert.doesNotMatch(subject, /\{firstName\}/);
  // No "paid" promotional trigger in the subject.
  assert.doesNotMatch(subject, /paid/i);
});

test('renderFollowup personalizes subject and prefixes with Re:', () => {
  const { subject } = renderFollowup(null, { firstName: 'Sam', brandName: 'Nike' }, 0);
  assert.match(subject, /^Re:/);
  assert.match(subject, /Sam/);
});

test('renderOutreach respects a custom template subject/body', () => {
  const tpl = { outreach: { subject: 'custom {firstName}', body: 'hello {firstName}' } };
  const { subject, body } = renderOutreach(tpl, { firstName: 'Jo' });
  assert.strictEqual(subject, 'custom Jo');
  assert.strictEqual(body, 'hello Jo');
});

test('getHardcodedDefaults returns a usable seed shape', () => {
  const d = getHardcodedDefaults();
  assert.ok(d.outreach.subject);
  assert.ok(d.outreach.body);
  assert.ok(d.followup.subject);
  assert.ok(d.followup.body);
});
