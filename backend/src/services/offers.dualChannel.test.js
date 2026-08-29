'use strict';

// sendOfferOutreach used to be strictly either/or: an established messaging
// channel returned early and the offer email was never sent, so a creator
// mid-conversation got the deal in WhatsApp and nothing in their inbox. These
// pin the fan-out — chat AND email when the conversation is open, email alone
// when it is not (we never cold-push WhatsApp/iMessage). DB, email and the
// messaging providers are stubbed; no Postgres and no network.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const email = require('./offerPortal/email');
const whatsapp = require('./offerPortal/whatsapp');
const offers = require('./offers');

const orig = {
  one: db.one,
  many: db.many,
  query: db.query,
  sendOfferEmail: email.sendOfferEmail,
  sendOfferWithContactEmail: email.sendOfferWithContactEmail,
  sendWhatsAppText: whatsapp.sendWhatsAppText,
  sendWhatsAppLink: whatsapp.sendWhatsAppLink,
  env: { ...process.env },
};

// inviteNumbersFor only offers a channel that is fully send-ready, so the
// "text Hi" invite branch needs the Cloud provider to look configured.
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = '123456789';
process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER = '+13322879678';

test.after(() => {
  process.env = orig.env;
});

const OFFER = {
  id: 501,
  creator_id: 1093,
  token: 'tok_abc',
  brand_name: 'Netflix',
  expires_at: new Date(Date.now() + 7 * 864e5),
  creator_email: 'creator@example.com',
  first_name: 'Himanshu',
  full_name: 'Himanshu Bhat',
  whatsapp: '+917899765920',
  imessage: null,
  messaging_opted_out: false,
  established_channel: null,
};

// establishedChannel: what this creator row carries. subscribedOn: a
// subscription found on another campaign row for the same person. recentInbound:
// whether the provider's 24h free-form window is currently open — a proactive
// send needs BOTH a subscription and an open window (see openChannelFor).
function install({ establishedChannel = null, subscribedOn = null, recentInbound = null } = {}) {
  const sent = { email: 0, whatsapp: 0, inviteEmail: 0 };
  const logged = [];

  db.one = async (sql) => {
    if (/FROM offers o JOIN creators c/i.test(sql)) {
      return { ...OFFER, established_channel: establishedChannel };
    }
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: false };
    if (/established_channel IS NOT NULL/i.test(sql)) {
      return subscribedOn ? { established_channel: subscribedOn } : null;
    }
    if (/FROM offer_messages/i.test(sql)) return recentInbound ? { open: 1 } : null;
    // deliverOfferOverChannel re-reads the offer joined to the creator.
    if (/FROM offers o JOIN creators c ON c\.id = o\.creator_id/i.test(sql)) return { ...OFFER };
    return null;
  };
  db.many = async () => [];
  db.query = async (sql, params) => {
    if (/INSERT INTO offer_messages/i.test(sql)) logged.push(params);
    return { rows: [], rowCount: 1 };
  };
  email.sendOfferEmail = async () => {
    sent.email += 1;
    return { sent: true };
  };
  email.sendOfferWithContactEmail = async () => {
    sent.inviteEmail += 1;
    return { sent: true };
  };
  whatsapp.sendWhatsAppText = async () => {
    sent.whatsapp += 1;
    return { sent: true, id: 'wamid.test' };
  };
  // deliverOfferOverChannel sends the priced offer as a "View Offer" link
  // button via sendWhatsAppLink, not sendWhatsAppText — see whatsapp.js.
  whatsapp.sendWhatsAppLink = async () => {
    sent.whatsapp += 1;
    return { sent: true, id: 'wamid.test' };
  };
  return { sent, logged };
}

function restore() {
  Object.assign(db, { one: orig.one, many: orig.many, query: orig.query });
  email.sendOfferEmail = orig.sendOfferEmail;
  email.sendOfferWithContactEmail = orig.sendOfferWithContactEmail;
  whatsapp.sendWhatsAppText = orig.sendWhatsAppText;
  whatsapp.sendWhatsAppLink = orig.sendWhatsAppLink;
}

test('an established channel with the window open gets the offer over BOTH WhatsApp and email', async () => {
  const { sent } = install({ establishedChannel: 'whatsapp', recentInbound: 'whatsapp' });
  try {
    await offers.sendOfferOutreach(501);
    assert.strictEqual(sent.whatsapp, 1, 'the deal goes to the chat they are in');
    assert.strictEqual(sent.email, 1, 'and to the inbox, carrying the same link');
    assert.strictEqual(sent.inviteEmail, 0, 'no "text Hi" invite — they are already talking to us');
  } finally {
    restore();
  }
});

test('a fresh campaign row inherits the subscription and still gets both', async () => {
  // A creator who subscribed on an earlier campaign is not asked to text "Hi"
  // again just because this campaign gave them a new row.
  const { sent } = install({ establishedChannel: null, subscribedOn: 'whatsapp', recentInbound: 'whatsapp' });
  try {
    await offers.sendOfferOutreach(501);
    assert.strictEqual(sent.whatsapp, 1);
    assert.strictEqual(sent.email, 1);
    assert.strictEqual(sent.inviteEmail, 0);
  } finally {
    restore();
  }
});

test('subscribed but the window has closed → email invite, never a rejected free-form push', async () => {
  // The provider would reject a free-form send here, so the creator would get
  // nothing at all — strictly worse than the invite email.
  const { sent } = install({ establishedChannel: 'whatsapp', recentInbound: null });
  try {
    await offers.sendOfferOutreach(501);
    assert.strictEqual(sent.whatsapp, 0);
    assert.strictEqual(sent.inviteEmail, 1);
  } finally {
    restore();
  }
});

test('never subscribed → email invite only, never a cold WhatsApp push', async () => {
  const { sent } = install({ establishedChannel: null, subscribedOn: null, recentInbound: null });
  try {
    await offers.sendOfferOutreach(501);
    assert.strictEqual(sent.whatsapp, 0, 'cold-pushing WhatsApp is never allowed');
    assert.strictEqual(sent.inviteEmail, 1, 'they get the "text Hi to continue" invite instead');
  } finally {
    restore();
  }
});
