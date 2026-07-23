'use strict';

// Run with: npm test  (node --test)
//
// Guards the portal invite email template: it must withhold the offer's
// details (no offerUrl/rate — the point is the creator has to text us first)
// and only reference channels we actually pass a number for.
const test = require('node:test');
const assert = require('node:assert');
const email = require('./email');

// Set PUBLIC_BASE_URL for the block so the iMessage button resolves to the https
// redirect page (the production path), and restore it after.
function withBaseUrl(url, fn) {
  const saved = process.env.PUBLIC_BASE_URL;
  const savedAlt = process.env.OFFER_PORTAL_BASE_URL;
  try {
    if (url === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = url;
    delete process.env.OFFER_PORTAL_BASE_URL;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
    if (savedAlt === undefined) delete process.env.OFFER_PORTAL_BASE_URL;
    else process.env.OFFER_PORTAL_BASE_URL = savedAlt;
  }
}

test('renderPortalInviteEmail lists both channels when both numbers are given', () => {
  withBaseUrl('https://out.example', () => {
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
    // iMessage button → our https redirect page (a raw sms: link is stripped by Gmail).
    assert.match(r.html, /href="https:\/\/out\.example\/go\/imessage"/);
    assert.doesNotMatch(r.html, /sms:[^"]*&/);
  });
});

test('iMessage button falls back to a direct sms: link when no base URL is set', () => {
  withBaseUrl(undefined, () => {
    const r = email.renderPortalInviteEmail({
      firstName: 'Sam',
      brandName: 'Acme',
      whatsappNumber: null,
      imessageNumber: '+18005555678',
    });
    assert.match(r.html, /href="sms:\+18005555678"/);
  });
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

test('renderOfferWithContactEmail includes the offer link AND both channel buttons', () => {
  withBaseUrl('https://out.example', () => {
    const r = email.renderOfferWithContactEmail({
      firstName: 'Sam',
      brandName: 'Acme',
      offerUrl: 'https://portal.example/o/tok123',
      expiryDate: 'Aug 1',
      whatsappNumber: '+18005551234',
      imessageNumber: '+18005555678',
    });
    // The negotiation link is revealed (unlike the plain invite)…
    assert.match(r.text, /\/o\/tok123/);
    assert.match(r.html, /\/o\/tok123/);
    // …alongside both contact options (iMessage via the https redirect page).
    assert.match(r.html, /wa\.me\/18005551234\?text=Hi/);
    assert.match(r.html, /href="https:\/\/out\.example\/go\/imessage"/);
    assert.doesNotMatch(r.html, /sms:[^"]*&/);
    assert.match(r.text, /Aug 1/);
  });
});

test('renderOfferWithContactEmail with no numbers reads as a plain offer email', () => {
  const r = email.renderOfferWithContactEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    offerUrl: 'https://portal.example/o/tok123',
    expiryDate: 'Aug 1',
    whatsappNumber: null,
    imessageNumber: null,
  });
  assert.match(r.html, /\/o\/tok123/);
  assert.doesNotMatch(r.html, /wa\.me/);
  assert.doesNotMatch(r.html, /sms:/);
  assert.doesNotMatch(r.text, /Prefer to chat/);
});

test('sendOfferWithContactEmail skips gracefully when RESEND_API_KEY is absent', async () => {
  const saved = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    const res = await email.sendOfferWithContactEmail({
      to: 'creator@example.com',
      firstName: 'Sam',
      brandName: 'Acme',
      offerUrl: 'https://portal.example/o/tok123',
      expiryDate: 'Aug 1',
      whatsappNumber: '+18005551234',
      imessageNumber: null,
    });
    assert.deepStrictEqual(res, { sent: false, skipped: true });
  } finally {
    if (saved === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved;
  }
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
