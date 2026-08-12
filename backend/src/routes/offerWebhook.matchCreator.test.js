'use strict';

// Guards matchCreator's campaign-row resolution — the bug that made a Used
// creator's "Hi" get the generic support deflection instead of the brand brief.
//
// A Used creator has ONE ROW PER CAMPAIGN (schema: UNIQUE (campaign_id,
// instagram_url)): same person, same phone, several rows. The inbound scan is
// unordered, so it used to return an arbitrary (usually older, finished) row —
// and the NEW campaign's pending offer hangs off a different creator_id, so the
// webhook saw "no pending offer" and deflected. DB is stubbed; no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const webhook = require('./offerWebhook');

const origMany = db.many;
const origOne = db.one;
const origQuery = db.query;

const PHONE = '+13322879678';
const DIGITS = '13322879678';
const IG = 'https://instagram.com/tigerjackieshroff';

// rowsWithPhone: what the "creators WHERE whatsapp IS NOT NULL" scan returns.
// liveRow: the row the pending-offer lookup finds (null = nothing pending).
function install({ rowsWithPhone, liveRow }) {
  const writes = [];
  db.many = async () => rowsWithPhone;
  db.one = async (sql, params) => {
    if (/JOIN offers o ON o\.creator_id = c\.id AND o\.status = 'pending'/i.test(sql)) {
      return liveRow ? { ...liveRow } : null;
    }
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return { writes };
}
function restoreAll() {
  db.many = origMany;
  db.one = origOne;
  db.query = origQuery;
}

test('picks the campaign row holding the LIVE offer, not an arbitrary older row', async () => {
  // Row 7 = last campaign (finished). Row 42 = the new campaign we just offered.
  // The unordered scan lists the old row first — the exact production shape.
  install({
    rowsWithPhone: [
      { id: 7, contact: PHONE, whatsapp: PHONE, instagram_url: IG },
      { id: 42, contact: PHONE, whatsapp: PHONE, instagram_url: IG },
    ],
    liveRow: { id: 42, whatsapp: PHONE, instagram_url: IG },
  });
  try {
    const m = await webhook.matchCreator('whatsapp', DIGITS);
    assert.strictEqual(m.id, 42, 'must resolve to the campaign with the pending offer');
  } finally {
    restoreAll();
  }
});

test('backfills the phone onto the live row when its own column is still blank', async () => {
  // The new campaign's row exists but the TTL-gated Creator-DB sweep hasn't
  // filled its phone yet — without carrying the number over, the reply would
  // have no destination and sendOfferBriefing bails (no_contact_for_channel).
  const { writes } = install({
    rowsWithPhone: [{ id: 7, contact: PHONE, whatsapp: PHONE, instagram_url: IG }],
    liveRow: { id: 42, whatsapp: null, instagram_url: IG },
  });
  try {
    const m = await webhook.matchCreator('whatsapp', DIGITS);
    assert.strictEqual(m.id, 42);
    assert.strictEqual(m.whatsapp, PHONE, 'reply needs a destination number');
    assert.ok(
      writes.some((w) => /UPDATE creators SET whatsapp/i.test(w.sql) && w.params[0] === 42),
      'persists the number so later inbounds match this row directly',
    );
  } finally {
    restoreAll();
  }
});

test('keeps the matched row when nothing is pending anywhere', async () => {
  install({
    rowsWithPhone: [{ id: 7, contact: PHONE, whatsapp: PHONE, instagram_url: IG }],
    liveRow: null,
  });
  try {
    const m = await webhook.matchCreator('whatsapp', DIGITS);
    assert.strictEqual(m.id, 7);
  } finally {
    restoreAll();
  }
});

test('an unknown number still matches nothing', async () => {
  install({
    rowsWithPhone: [{ id: 7, contact: PHONE, whatsapp: PHONE, instagram_url: IG }],
    liveRow: { id: 42, whatsapp: PHONE, instagram_url: IG },
  });
  try {
    assert.strictEqual(await webhook.matchCreator('whatsapp', '19998887777'), null);
  } finally {
    restoreAll();
  }
});

test('a row with no instagram_url is returned as-is (nothing to re-point by)', async () => {
  install({
    rowsWithPhone: [{ id: 7, contact: PHONE, whatsapp: PHONE, instagram_url: null }],
    liveRow: { id: 42, whatsapp: PHONE, instagram_url: IG },
  });
  try {
    const m = await webhook.matchCreator('whatsapp', DIGITS);
    assert.strictEqual(m.id, 7);
  } finally {
    restoreAll();
  }
});
