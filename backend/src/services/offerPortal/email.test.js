'use strict';

// Run with: npm test  (node --test)
//
// Guards the portal invite email template: it must withhold the offer's
// details (no offerUrl/rate — the point is the creator has to text us first)
// and only reference channels we actually pass a number for.
const test = require('node:test');
const assert = require('node:assert');
const email = require('./email');
const { renderOfferEmail, renderPortalInviteEmail } = email;

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

test('reminder mode softens the subject/opening of both invite and offer emails', () => {
  const invite = email.renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: null,
    reminder: true,
  });
  assert.match(invite.subject, /Reminder/i);
  assert.match(invite.text, /following up/i);
  assert.match(invite.html, /following up/i);

  const offer = email.renderOfferWithContactEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    offerUrl: 'https://portal.example/o/tok123',
    expiryDate: 'Aug 1',
    whatsappNumber: null,
    imessageNumber: null,
    reminder: true,
  });
  assert.match(offer.subject, /Reminder/i);
  assert.match(offer.text, /still open/i);
  assert.match(offer.text, /\/o\/tok123/); // the link is still there
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

// --- Part 3: friendly-but-professional copy pass -------------------------

test('renderOfferEmail is warm, names the creator + brand, and keeps the offer link/expiry', () => {
  const r = renderOfferEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    offerUrl: 'https://portal.example/o/tok123',
    expiryDate: 'Aug 1',
  });
  assert.match(r.subject, /Acme/);
  assert.match(r.text, /^Hi Sam,/);
  assert.match(r.text, /Acme/);
  assert.match(r.text, /https:\/\/portal\.example\/o\/tok123/);
  assert.match(r.text, /Aug 1/);
  assert.match(r.html, /\/o\/tok123/);
  // Warmer than the old transactional "Please accept or decline through the
  // above link." closer.
  assert.doesNotMatch(r.text, /Please accept or decline/);
});

test('renderBriefReadyEmail is warm, names the creator + brand, and keeps the brief link', () => {
  const r = email.renderBriefReadyEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    briefUrl: 'https://portal.example/brief/tok123',
  });
  assert.match(r.subject, /Acme/);
  assert.match(r.text, /^Hi Sam,/);
  assert.match(r.text, /Acme/);
  assert.match(r.text, /https:\/\/portal\.example\/brief\/tok123/);
  assert.match(r.html, /\/brief\/tok123/);
});

test('renderPortalInviteEmail body never names a specific channel not offered (WhatsApp-only stays silent on iMessage)', () => {
  const r = renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: null,
  });
  assert.doesNotMatch(r.text, /iMessage/);
  assert.doesNotMatch(r.html, /iMessage/);
});

test('renderPortalInviteEmail reminder subject still says "Reminder" (friendlier body, same signal)', () => {
  const r = renderPortalInviteEmail({
    firstName: 'Sam',
    brandName: 'Acme',
    whatsappNumber: '+18005551234',
    imessageNumber: null,
    reminder: true,
  });
  assert.match(r.subject, /Reminder/i);
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

// The attachment field is opt-in: adding it for the signed-contract copy must
// not put an empty `attachments` key on every other send (Resend rejects some
// malformed shapes, and an unexpected key is a silent behaviour change).
test('a plain send carries no attachments key; an attached send carries exactly one', async () => {
  const savedKey = process.env.RESEND_API_KEY;
  const savedFetch = global.fetch;
  const payloads = [];
  try {
    process.env.RESEND_API_KEY = 'test_key';
    global.fetch = async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: 'm1' }), text: async () => '{}' };
    };

    await email.sendBriefReadyEmail({
      to: 'creator@example.com',
      firstName: 'Sam',
      brandName: 'Acme',
      briefUrl: 'https://example.com/b/1',
    });
    assert.ok(!('attachments' in payloads[0]), 'plain sends must not declare attachments');

    await email.sendSignedContractEmail({
      to: 'creator@example.com',
      firstName: 'Sam',
      brandName: 'Acme',
      campaignName: 'Spring',
      pdf: Buffer.from('%PDF-1.4 test'),
      filename: 'Sam-Contract-Signed.pdf',
    });
    assert.strictEqual(payloads[1].attachments.length, 1);
    assert.strictEqual(payloads[1].attachments[0].filename, 'Sam-Contract-Signed.pdf');
    assert.strictEqual(
      Buffer.from(payloads[1].attachments[0].content, 'base64').toString(),
      '%PDF-1.4 test',
    );
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
  }
});
