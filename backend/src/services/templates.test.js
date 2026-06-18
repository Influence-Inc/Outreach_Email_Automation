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

test('renderOutreach appends unsubscribe footer only when unsubscribeUrl is set', () => {
  const url = 'https://track.useinfluence.xyz/unsubscribe/1/abc';
  const withUrl = renderOutreach(null, { firstName: 'Alex', brandName: 'Nike', unsubscribeUrl: url });
  assert.ok(withUrl.body.includes(url), 'body must include the unsubscribe URL');
  assert.match(withUrl.body, /\{\{grey\}\}/, 'footer should be wrapped in grey marker');

  const noUrl = renderOutreach(null, { firstName: 'Alex', brandName: 'Nike' });
  assert.ok(!noUrl.body.includes('Unsubscribe'), 'no footer when URL absent');
  assert.ok(!noUrl.body.includes('{{grey}}'));
});

test('renderFollowup also gets the personalized subject and the unsub footer', () => {
  const url = 'https://track.useinfluence.xyz/unsubscribe/2/def';
  const { subject, body } = renderFollowup(
    null,
    { firstName: 'Sam', brandName: 'Nike', unsubscribeUrl: url },
    0,
  );
  assert.match(subject, /^Re:/);
  assert.match(subject, /Sam/);
  assert.ok(body.includes(url));
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
