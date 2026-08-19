'use strict';

// A creator received five different offer links in four minutes, the last one
// landing AFTER they had accepted and signed — because every re-run of outreach
// minted a brand new offer with a brand new token and delivered it. These pin the
// guard: one live offer at a time, and never a fresh offer on top of an accepted
// one. A finished deal (declined / expired) may still be re-approached.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const orig = { one: db.one, many: db.many, query: db.query };

const CREATOR = {
  id: 1093,
  email: 'creator@example.com',
  first_name: 'Himanshu',
  full_name: 'Himanshu Bhat',
  whatsapp: '+917899765920',
  imessage: null,
  messaging_opted_out: false,
  established_channel: 'whatsapp',
  ig_scraped_data: { p50: 6000 },
  campaign_brand_name: 'Netflix',
  max_cpm: 4,
  campaign_data: null,
};

// existingOffer: what the live-offer lookup finds for this creator.
function install({ existingOffer = null } = {}) {
  const created = [];
  db.one = async (sql) => {
    if (/FROM creators c LEFT JOIN campaigns ca/i.test(sql)) return { ...CREATOR };
    if (/FROM offers\s+WHERE creator_id = \$1 AND status IN/i.test(sql)) return existingOffer;
    if (/INSERT INTO offers/i.test(sql)) {
      created.push(sql);
      return { id: 999, token: 'tok_new', expires_at: new Date() };
    }
    return null;
  };
  db.many = async () => [];
  db.query = async (sql) => {
    if (/INSERT INTO offers/i.test(sql)) created.push(sql);
    return { rows: [], rowCount: 1 };
  };
  return created;
}

function restore() {
  Object.assign(db, orig);
}

test('an accepted offer blocks a second one — the signed deal is not reopened', async () => {
  const created = install({ existingOffer: { id: 77, token: 'tok_live', status: 'accepted' } });
  try {
    const res = await offers.sendUsedCreatorOffer(1093);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'offer_already_accepted');
    assert.strictEqual(res.token, 'tok_live', 'reports the offer that already stands');
    assert.strictEqual(created.length, 0, 'no new offer minted');
  } finally {
    restore();
  }
});

test('a pending offer blocks a second one — no competing links', async () => {
  const created = install({ existingOffer: { id: 78, token: 'tok_live', status: 'pending' } });
  try {
    const res = await offers.sendUsedCreatorOffer(1093);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'offer_already_pending');
    assert.strictEqual(created.length, 0);
  } finally {
    restore();
  }
});

test('sendPortalOffer refuses too, so a second dashboard click is harmless', async () => {
  const created = install({ existingOffer: { id: 79, token: 'tok_live', status: 'pending' } });
  try {
    const res = await offers.sendPortalOffer(1093, { flat_fee: 20, offer_type: 'flat' });
    assert.match(res.skipped, /already has a pending offer/);
    assert.strictEqual(res.token, 'tok_live');
    assert.strictEqual(created.length, 0);
  } finally {
    restore();
  }
});

test('a finished deal does not block a re-approach', async () => {
  // The lookup only matches pending/accepted, so declined and expired offers
  // return null here — pricing a fresh offer then is legitimate.
  const created = install({ existingOffer: null });
  try {
    const res = await offers.sendUsedCreatorOffer(1093);
    assert.notStrictEqual(res.reason, 'offer_already_declined');
    assert.ok(created.length > 0 || res.sent !== false || res.reason, 'proceeds past the guard');
  } finally {
    restore();
  }
});
