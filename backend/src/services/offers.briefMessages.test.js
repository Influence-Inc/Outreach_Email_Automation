'use strict';

// The brand pitch and the interest question used to be ONE merged WhatsApp
// message ("Hi Sam, this is INFLUENCE. Acme is running a campaign...
// Interested in hearing more?"). It now goes out as two separate messages —
// the pitch, then the question with buttons — the way a person actually
// pitches a partnership over chat. These pin the two-send behaviour across all
// three brief entry points, that BOTH messages get logged to offer_messages,
// and that a failed follow-up question doesn't lose the intro that already
// landed. DB and the messaging providers are stubbed; no Postgres, no network.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const offers = require('./offers');

const orig = {
  one: db.one,
  query: db.query,
  sendWhatsAppText: whatsapp.sendWhatsAppText,
  sendWhatsAppChoice: whatsapp.sendWhatsAppChoice,
  sendIMessageText: imessage.sendIMessageText,
};

const CREATOR = {
  id: 1093,
  first_name: 'Himanshu',
  full_name: 'Himanshu Bhat',
  whatsapp: '+917899765920',
  imessage: null,
  campaign_name: 'Netflix Push',
  brand_name: 'Netflix',
  messaging_brief: null,
};

// introOutcome/questionOutcome: {sent} or {sent:false, error/skipped} for each
// leg of the two-message send.
function install({ introOutcome = { sent: true, id: 'wamid.intro' }, questionOutcome = { sent: true, id: 'wamid.q' } } = {}) {
  const inserted = [];
  const sent = { intro: 0, question: 0 };

  db.one = async () => ({ ...CREATOR });
  db.query = async (sql, params) => {
    if (/INSERT INTO offer_messages/i.test(sql)) inserted.push(params);
    return { rows: [], rowCount: 1 };
  };
  whatsapp.sendWhatsAppText = async ({ body }) => {
    sent.intro += 1;
    return { ...introOutcome, _body: body };
  };
  whatsapp.sendWhatsAppChoice = async ({ body }) => {
    sent.question += 1;
    return { ...questionOutcome, _body: body };
  };
  imessage.sendIMessageText = async ({ body }) => {
    sent.intro += 1;
    return { ...introOutcome, _body: body };
  };
  return { inserted, sent };
}

function restore() {
  Object.assign(db, { one: orig.one, query: orig.query });
  whatsapp.sendWhatsAppText = orig.sendWhatsAppText;
  whatsapp.sendWhatsAppChoice = orig.sendWhatsAppChoice;
  imessage.sendIMessageText = orig.sendIMessageText;
}

test('sendUsedCreatorBrief sends the pitch and the question as two separate WhatsApp sends', async () => {
  const { inserted, sent } = install();
  try {
    const result = await offers.sendUsedCreatorBrief(1093, 'whatsapp');
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sent.intro, 1);
    assert.strictEqual(sent.question, 1);

    assert.strictEqual(inserted.length, 2, 'both messages are logged to offer_messages');
    const [introRow, questionRow] = inserted;
    assert.match(introRow[2], /Netflix/, 'first message carries the brand pitch');
    assert.doesNotMatch(introRow[2], /Interested in hearing more/, 'the pitch does not carry the question');
    assert.strictEqual(questionRow[2], 'Interested in hearing more?');
  } finally {
    restore();
  }
});

test('a failed interest question still keeps the intro that already sent', async () => {
  const { inserted } = install({ questionOutcome: { sent: false, error: '131047 outside window' } });
  try {
    const result = await offers.sendUsedCreatorBrief(1093, 'whatsapp');
    assert.strictEqual(result.sent, false, 'overall failure — the CTA never reached the creator');
    assert.strictEqual(result.error, '131047 outside window');
    assert.strictEqual(inserted.length, 1, 'the intro is still recorded even though the question failed');
    assert.match(inserted[0][2], /Netflix/);
  } finally {
    restore();
  }
});

test('a failed intro sends no question at all, and logs nothing', async () => {
  const { inserted, sent } = install({ introOutcome: { sent: false, error: 'invalid recipient' } });
  try {
    const result = await offers.sendUsedCreatorBrief(1093, 'whatsapp');
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.error, 'invalid recipient');
    assert.strictEqual(sent.question, 0, 'no point asking a question that was never introduced');
    assert.strictEqual(inserted.length, 0);
  } finally {
    restore();
  }
});

test('established_channel is only set once BOTH messages went out', async () => {
  const writes = [];
  install({ questionOutcome: { sent: false, error: 'boom' } });
  const origQuery = db.query;
  db.query = async (sql, params) => {
    writes.push(sql);
    return origQuery(sql, params);
  };
  try {
    await offers.sendUsedCreatorBrief(1093, 'whatsapp');
    assert.ok(!writes.some((sql) => /UPDATE creators SET established_channel/i.test(sql)));
  } finally {
    restore();
  }
});

test('sendOfferBriefing also sends the pitch and question separately, offer_id included', async () => {
  db.one = async () => ({ ...CREATOR, id: 501, creator_id: 1093, brand_name: 'Netflix' });
  const inserted = [];
  db.query = async (sql, params) => {
    if (/INSERT INTO offer_messages/i.test(sql)) inserted.push(params);
    return { rows: [], rowCount: 1 };
  };
  whatsapp.sendWhatsAppText = async () => ({ sent: true, id: 'w1' });
  whatsapp.sendWhatsAppChoice = async () => ({ sent: true, id: 'w2' });
  try {
    const result = await offers.sendOfferBriefing(501, 'whatsapp');
    assert.strictEqual(result.sent, true);
    assert.strictEqual(inserted.length, 2);
    assert.strictEqual(inserted[0][1], 501, 'offer_id carried on the intro row');
    assert.strictEqual(inserted[1][1], 501, 'offer_id carried on the question row');
  } finally {
    restore();
  }
});

test('iMessage gets both messages as plain text, the question with the written-out hint', async () => {
  install();
  db.one = async () => ({ ...CREATOR, imessage: '+18005551234' });
  const bodies = [];
  imessage.sendIMessageText = async ({ body }) => {
    bodies.push(body);
    return { sent: true, id: `im${bodies.length}` };
  };
  try {
    const result = await offers.sendUsedCreatorBrief(1093, 'imessage');
    assert.strictEqual(result.sent, true);
    assert.strictEqual(bodies.length, 2);
    assert.doesNotMatch(bodies[0], /Interested in hearing more/);
    assert.match(bodies[1], /Interested in hearing more\?/);
    assert.match(bodies[1], /Reply Yes or No/i, 'iMessage has no buttons, so the hint is written out');
  } finally {
    restore();
  }
});
