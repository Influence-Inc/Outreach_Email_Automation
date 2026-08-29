'use strict';

// Subscribing is per PERSON, not per campaign row. When a creator texts our
// business number we mark EVERY row sharing their phone, so a campaign that
// adds them months later inherits the subscription instead of emailing them to
// re-introduce themselves — the whole point of "text Hi once". DB is stubbed.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const orig = { one: db.one, query: db.query };

function install({ creatorRow = { whatsapp: '+18005551234', imessage: null } } = {}) {
  const writes = [];
  db.one = async () => (creatorRow ? { ...creatorRow } : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 3 };
  };
  return writes;
}
function restore() {
  Object.assign(db, orig);
}

test('subscribing marks every row that shares the creator\'s phone', async () => {
  const writes = install();
  try {
    const n = await offers.subscribeCreatorChannel(88, 'whatsapp');
    assert.strictEqual(n, 3, 'reports how many of the person\'s rows were updated');
    assert.strictEqual(writes.length, 1);
    // Matched on the phone tail, NOT the creator id — that is what carries the
    // subscription across campaigns.
    assert.match(writes[0].sql, /right\(regexp_replace/i);
    assert.doesNotMatch(writes[0].sql, /WHERE id = \$1/i);
    assert.deepStrictEqual(writes[0].params, ['8005551234', 'whatsapp']);
  } finally {
    restore();
  }
});

test('an existing channel is never overwritten by a message on the other one', async () => {
  const writes = install();
  try {
    await offers.subscribeCreatorChannel(88, 'whatsapp');
    // COALESCE keeps whatever is already there, so a creator established on
    // iMessage isn't flipped to WhatsApp by one stray inbound.
    assert.match(writes[0].sql, /established_channel = COALESCE\(established_channel, \$2\)/i);
  } finally {
    restore();
  }
});

test('a creator with no phone on file falls back to updating just their row', async () => {
  const writes = install({ creatorRow: { whatsapp: null, imessage: null } });
  try {
    const n = await offers.subscribeCreatorChannel(88, 'whatsapp');
    assert.strictEqual(n, 1);
    assert.match(writes[0].sql, /WHERE id = \$1/i);
    assert.deepStrictEqual(writes[0].params, [88, 'whatsapp']);
  } finally {
    restore();
  }
});

test('an unknown creator id still does not throw', async () => {
  const writes = install({ creatorRow: null });
  try {
    await offers.subscribeCreatorChannel(999, 'whatsapp');
    assert.strictEqual(writes.length, 1, 'falls back to the id-scoped update');
  } finally {
    restore();
  }
});
