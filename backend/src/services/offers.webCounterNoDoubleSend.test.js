'use strict';

// Regression guard for the "portal counter double-messaged the creator on
// WhatsApp" bug. When a Used creator with an established WhatsApp channel
// counters (or reschedules) from the offer PORTAL, negotiateBudget /
// negotiateSchedule must NOT mirror the resulting child offer over WhatsApp —
// they're already staring at it on the page. The same call from the WhatsApp
// webhook (channel: 'whatsapp') still delivers on the message thread.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const creatorDb = require('./creatorDb');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origWithTx = db.withTransaction;
const origLookupCpm = creatorDb.lookupCpmFromCreatorDb;
const origSendWa = whatsapp.sendWhatsAppText;
const origSendWaLink = whatsapp.sendWhatsAppLink;
const origSendIm = imessage.sendIMessageText;

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

const BASE_OFFER = {
  id: 1,
  token: 'tok',
  status: 'pending',
  expires_at: FUTURE,
  rate: 1500,
  currency: 'USD',
  expected_impressions: 100000,
  deliverables: ['1 Reel'],
  brand_name: 'Netflix',
  creator_id: 88,
  campaign_id: 1,
};

// Set up the same DB fixtures the counterOptions test uses but hand back
// establishedChannel: 'whatsapp' so the delivery path is armed. The single
// deliverOfferOverChannel path is exercised (no ig_scraped_data → the two-option
// mint doesn't fire, so we get exactly one child offer). Also intercepts the
// WhatsApp + iMessage sends so tests can assert whether they fired.
function install({ establishedChannel = 'whatsapp' } = {}) {
  const sends = { wa: 0, im: 0 };

  db.one = async (sql) => {
    if (/FROM offers WHERE token/i.test(sql)) return { ...BASE_OFFER };
    // negotiateSchedule's join with campaigns for the deadline gate.
    if (/FROM offers o LEFT JOIN campaigns/i.test(sql)) return { ...BASE_OFFER, campaign_deadline_date: null };
    if (/ca\.id = \$2/.test(sql) && /instagram_username/i.test(sql)) {
      return {
        email: 'sam@x.com',
        instagram_username: 'sam',
        // stats null → skip the two-option flow so we can exercise the
        // single-counter delivery path this bug lives on.
        ig_scraped_data: null,
        max_cpm: 12,
        campaign_data: {},
      };
    }
    if (/established_channel FROM creators/i.test(sql)) {
      return { established_channel: establishedChannel };
    }
    // deliverOfferOverChannel re-reads the offer joined to the creator to pull
    // the destination number; return a WhatsApp number for the sticky channel.
    if (/FROM offers o[\s\S]*JOIN creators c ON c\.id = o\.creator_id/i.test(sql)) {
      return {
        ...BASE_OFFER,
        first_name: 'Sam',
        full_name: 'Sam Rivera',
        whatsapp: '+15551230000',
        imessage: null,
      };
    }
    // Final fetch after mint returns whatever child was just inserted.
    if (/SELECT \* FROM offers WHERE id = \$1/i.test(sql)) {
      return {
        id: 999,
        token: 'child-tok',
        brand_name: BASE_OFFER.brand_name,
        deliverables: ['2 Reels'],
        rate: 1500,
        currency: 'USD',
        expected_impressions: 200000,
        expires_at: FUTURE,
        parent_offer_id: BASE_OFFER.id,
      };
    }
    return null;
  };
  db.query = async () => ({ rows: [], rowCount: 1 });
  db.withTransaction = async (fn) => {
    const client = {
      query: async (sql) => {
        if (/INSERT INTO offers/i.test(sql)) return { rows: [{ id: 999 }], rowCount: 1 };
        if (/UPDATE offers/i.test(sql)) return { rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  };
  creatorDb.lookupCpmFromCreatorDb = async () => 15;
  // deliverOfferOverChannel routes WhatsApp through sendWhatsAppLink (button
  // + fallback text); iMessage through sendIMessageText. Older builds sent
  // plain text — stub both surfaces so this test survives either code path.
  whatsapp.sendWhatsAppText = async () => { sends.wa += 1; return { sent: true, id: 'wamid.X' }; };
  whatsapp.sendWhatsAppLink = async () => { sends.wa += 1; return { sent: true, id: 'wamid.X' }; };
  imessage.sendIMessageText = async () => { sends.im += 1; return { sent: true, id: 'im.X' }; };
  return sends;
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.withTransaction = origWithTx;
  creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
  whatsapp.sendWhatsAppText = origSendWa;
  whatsapp.sendWhatsAppLink = origSendWaLink;
  imessage.sendIMessageText = origSendIm;
}

test('portal counter does NOT re-send the offer on WhatsApp even when a WhatsApp thread is established', async () => {
  const sends = install({ establishedChannel: 'whatsapp' });
  try {
    const r = await offers.negotiateBudget({
      token: 'tok', requestedRate: 1800, channel: 'web',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(sends.wa, 0, 'web counter must not push a WhatsApp message');
    assert.strictEqual(sends.im, 0);
  } finally {
    restore();
  }
});

test('WhatsApp-originated counter still delivers the child offer over WhatsApp', async () => {
  const sends = install({ establishedChannel: 'whatsapp' });
  try {
    const r = await offers.negotiateBudget({
      token: 'tok', requestedRate: 1800, channel: 'whatsapp',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'countered');
    assert.strictEqual(sends.wa, 1, 'messaged-in counter must reply on the same thread');
  } finally {
    restore();
  }
});

test('portal reschedule does NOT re-send the re-offer on WhatsApp', async () => {
  const sends = install({ establishedChannel: 'whatsapp' });
  try {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await offers.negotiateSchedule({
      token: 'tok', availableDate: tomorrow, channel: 'web',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'rescheduled');
    assert.strictEqual(sends.wa, 0, 'web reschedule must not push a WhatsApp message');
  } finally {
    restore();
  }
});
