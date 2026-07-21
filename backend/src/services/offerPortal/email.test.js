'use strict';

// Run with: npm test  (node --test)
//
// Guards the portal invite email template: it must withhold the offer's
// details (no offerUrl/rate — the point is the creator has to text us first)
// and only reference channels we actually pass a number for.
const test = require('node:test');
const assert = require('node:assert');
const email = require('./email');

test('renderPortalInviteEmail lists both channels when both numbers are given', () => {
  const r = email.renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: '+18005555678',
  });
  assert.match(r.subject, /Acme/);
  assert.match(r.text, /Sam/);
  assert.match(r.text, /\+18005551234/);
  assert.match(r.text, /\+18005555678/);
  assert.match(r.html, /wa\.me\/18005551234\?text=Hi/);
  assert.match(r.html, /sms:\+18005555678&body=Hi/);
});

test('renderPortalInviteEmail omits a channel whose number is null', () => {
  const r = email.renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: null,
  });
  assert.match(r.text, /\+18005551234/);
  assert.doesNotMatch(r.text, /iMessage/);
  assert.match(r.html, /wa\.me/);
  assert.doesNotMatch(r.html, /sms:/);
});

test('renderPortalInviteEmail never reveals the offer link or rate', () => {
  const r = email.renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: '+18005555678',
  });
  assert.doesNotMatch(r.text, /\/o\//);
  assert.doesNotMatch(r.html, /\/o\//);
});

test('sendPortalInviteEmail skips gracefully when RESEND_API_KEY is absent', async () => {
  const saved = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    const res = await email.sendPortalInviteEmail({
      to: 'creator@example.com',
      firstName: 'Sam',
      brandName: 'Acme',
      whatsappNumber: '+18005551234',
      imessageNumber: null,
    });
    assert.deepStrictEqual(res, { sent: false, skipped: true });
  } finally {
    if (saved === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved;
  }
});
