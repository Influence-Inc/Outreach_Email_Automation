'use strict';

// Regression guard for the "window we never noticed" bug.
//
// updates_last_inbound_at used to be written in exactly one place — inside
// onInboundMessage, behind a subscription check, and only reached when the
// creator had no pending offer. So every message a creator sent during offer
// negotiation was invisible to the update lane: requestHi() asked someone
// mid-conversation to "send us a Hi", and deliverPending() spent a PAID
// template where a free-form message would have gone through.
//
// Two things fix it and both are covered here: stampInbound writes the stamp for
// any creator (subscribed or not, across every row sharing the phone number),
// and loadCreator falls back to the newest inbound in offer_messages so rows
// that predate the stamp are still recognised without a backfill.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const creatorUpdates = require('./creatorUpdates');

const origOne = db.one;
const origQuery = db.query;

function restore() {
  db.one = origOne;
  db.query = origQuery;
}

// --- stampInbound -----------------------------------------------------------

test('stampInbound writes the window stamp for a creator who is NOT subscribed', async () => {
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1 };
  };
  try {
    await creatorUpdates.stampInbound(42, 'whatsapp');
    assert.strictEqual(calls.length, 1, 'exactly one UPDATE');
    assert.match(calls[0].sql, /updates_last_inbound_at = NOW\(\)/);
    // No subscription predicate anywhere — the stamp is unconditional.
    assert.doesNotMatch(calls[0].sql, /updates_subscribed_at/);
    assert.deepStrictEqual(calls[0].params, [42, 'whatsapp']);
  } finally {
    restore();
  }
});

test('stampInbound propagates across every row sharing the phone number', async () => {
  let sql = '';
  db.query = async (s) => {
    sql = s;
    return { rowCount: 3 };
  };
  try {
    const rows = await creatorUpdates.stampInbound(42, 'whatsapp');
    // Same last-10-digits identity rule the opt-out check and
    // subscribeCreatorChannel already use, so one person's several
    // per-campaign rows all carry the window.
    assert.match(sql, /right\(regexp_replace/);
    assert.strictEqual(rows, 3);
  } finally {
    restore();
  }
});

test('stampInbound never downgrades an established channel', async () => {
  let sql = '';
  db.query = async (s) => {
    sql = s;
    return { rowCount: 1 };
  };
  try {
    await creatorUpdates.stampInbound(42, 'whatsapp');
    // COALESCE, not assignment: a creator established on iMessage isn't
    // flipped by one stray WhatsApp message.
    assert.match(sql, /established_channel = COALESCE\(established_channel, \$2\)/);
  } finally {
    restore();
  }
});

// --- loadCreator fallback ---------------------------------------------------

test('loadCreator resolves the window from offer_messages when the column is unstamped', async () => {
  let sql = '';
  db.one = async (s) => {
    sql = s;
    return { id: 7 };
  };
  try {
    // statusFor is the thinnest public caller of loadCreator.
    db.query = async () => ({ rowCount: 0 });
    const origMany = db.many;
    db.many = async () => [];
    try {
      await creatorUpdates.statusFor(7);
    } finally {
      db.many = origMany;
    }
    // GREATEST ignores NULLs, so a row with no stamp still reports the newest
    // inbound from the message log — no backfill needed.
    assert.match(sql, /GREATEST\(/);
    assert.match(sql, /MAX\(m\.sent_at\)/);
    assert.match(sql, /direction = 'inbound'/);
    assert.match(sql, /AS updates_last_inbound_at/);
  } finally {
    restore();
  }
});

// --- the decision this protects --------------------------------------------

test('a creator whose only inbound was mid-negotiation counts as in-window', () => {
  // What loadCreator now returns for someone who messaged us an hour ago while
  // negotiating, and was never subscribed: the fallback fills the field, so
  // windowOpen is true and the free-form path is taken instead of a template.
  const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
  assert.strictEqual(creatorUpdates.windowOpen({ updates_last_inbound_at: anHourAgo }), true);
});

test('the 24h boundary still shuts the window', () => {
  const longAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
  assert.strictEqual(creatorUpdates.windowOpen({ updates_last_inbound_at: longAgo }), false);
  // And a creator who has genuinely never written in is still out of window —
  // the fallback must not invent one.
  assert.strictEqual(creatorUpdates.windowOpen({ updates_last_inbound_at: null }), false);
});
