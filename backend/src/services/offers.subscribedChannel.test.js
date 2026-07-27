'use strict';

// Guards offers.subscribedChannelFor — the decision of whether we can skip the
// email invite and message a used creator DIRECTLY. Scoped to the CURRENT
// campaign (only this row's established_channel counts) so a used creator pulled
// into a NEW campaign is re-invited by email even if they've chatted with us in
// another campaign — while opt-out stays cross-campaign for compliance.
// The opt-out lookup (a single db.one query, only when a phone is present) is
// stubbed; no real Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const origOne = db.one;

// optedOutAnywhere: what the cross-campaign bool_or(messaging_opted_out) query
// returns for this person's phone.
function install({ optedOutAnywhere = false } = {}) {
  const queries = [];
  db.one = async (sql, params) => {
    queries.push({ sql, params });
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: optedOutAnywhere };
    return null;
  };
  return queries;
}
function restore() {
  db.one = origOne;
}

test('messaging us in THIS campaign → returns that channel (skip the email, message directly)', async () => {
  install();
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: '+18005551234',
      imessage: null,
      established_channel: 'whatsapp',
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, 'whatsapp');
  } finally {
    restore();
  }
});

test('a NEW campaign row (established_channel unset) → null, even with a phone on file', async () => {
  // This is the Option B fix: a used creator pulled into a fresh campaign has no
  // established_channel on THIS row, so we return null → they get the email invite
  // again, rather than being silently messaged off a prior campaign's thread.
  install({ optedOutAnywhere: false });
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: '+18005551234',
      imessage: null,
      established_channel: null,
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, null);
  } finally {
    restore();
  }
});

test('opted out on ANY of the person\'s rows → null (compliance stays cross-campaign)', async () => {
  install({ optedOutAnywhere: true });
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: '+18005551234',
      imessage: null,
      established_channel: 'whatsapp', // established here, but opted out elsewhere
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, null);
  } finally {
    restore();
  }
});

test('no phone on file → falls back to this row (established, not opted out)', async () => {
  const queries = install();
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: null,
      imessage: null,
      established_channel: 'imessage',
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, 'imessage');
    assert.strictEqual(queries.length, 0, 'no cross-campaign query without a phone to match on');
  } finally {
    restore();
  }
});

test('no phone + opted out on this row → null', async () => {
  install();
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: null,
      imessage: null,
      established_channel: 'imessage',
      messaging_opted_out: true,
    });
    assert.strictEqual(ch, null);
  } finally {
    restore();
  }
});
