'use strict';

// Guards offers.subscribedChannelFor — the decision of whether we can skip the
// email invite and message a used creator DIRECTLY. Scoped to the CURRENT
// campaign (only this row's established_channel counts) so a used creator pulled
// into a NEW campaign is re-invited by email even if they've chatted with us in
// another campaign — while opt-out stays cross-campaign for compliance.
//
// One exception to the same-campaign rule: if the PERSON has messaged us within
// the last 24h on any of their rows, the conversation window is open and they are
// waiting on the deal in that chat, so the fresh row inherits the channel rather
// than emailing "text Hi to continue" to someone mid-conversation.
//
// The lookups (opt-out, then recent inbound) are stubbed; no real Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const origOne = db.one;

// optedOutAnywhere: what the cross-campaign bool_or(messaging_opted_out) query
// returns for this person's phone.
// recentInboundChannel: what the open-conversation lookup finds for this
// person's phone (null = no inbound inside the window).
function install({ optedOutAnywhere = false, recentInboundChannel = null } = {}) {
  const queries = [];
  db.one = async (sql, params) => {
    queries.push({ sql, params });
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: optedOutAnywhere };
    if (/FROM offer_messages/i.test(sql)) {
      return recentInboundChannel ? { channel: recentInboundChannel } : null;
    }
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

test('a NEW campaign row with no recent inbound → null (email invite, not a cold push)', async () => {
  // A used creator pulled into a fresh campaign has no established_channel on
  // THIS row and no open conversation, so we return null → they get the email
  // invite again, rather than being silently messaged off a prior campaign's
  // thread (which would also be outside the provider's 24h window).
  install({ optedOutAnywhere: false, recentInboundChannel: null });
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

// The reported bug: the creator had been texting us minutes earlier, the admin
// priced the offer, and it went out as an email invite because the offer hung off
// a fresh campaign row whose established_channel was still unset.
test('a NEW campaign row inherits the channel when the person messaged us inside the window', async () => {
  const queries = install({ recentInboundChannel: 'whatsapp' });
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: '+18005551234',
      imessage: null,
      established_channel: null,
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, 'whatsapp');

    // The stub returns a row for any offer_messages query, so a wrong column name
    // passes here even though Postgres would throw "column m.created_at does not
    // exist" and abort the whole offer send. offer_messages timestamps its rows
    // as sent_at (NOT created_at), so pin the real column the query must use.
    const inboundQuery = queries.find((q) => /FROM offer_messages/i.test(q.sql));
    assert.ok(inboundQuery, 'the open-conversation lookup ran');
    assert.match(inboundQuery.sql, /\bm\.sent_at\b/, 'must filter/order on offer_messages.sent_at');
    assert.doesNotMatch(inboundQuery.sql, /\bm\.created_at\b/, 'offer_messages has no created_at column');
  } finally {
    restore();
  }
});

test('an open conversation never overrides a cross-campaign opt-out', async () => {
  install({ optedOutAnywhere: true, recentInboundChannel: 'whatsapp' });
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

test('an open conversation on a channel this row has no number for → null', async () => {
  // The reply would have no destination, so the email invite is the honest path.
  install({ recentInboundChannel: 'imessage' });
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

test('this row\'s own established_channel wins without needing the inbound lookup', async () => {
  const queries = install({ recentInboundChannel: 'imessage' });
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: '+18005551234',
      imessage: '+18005551234',
      established_channel: 'whatsapp',
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, 'whatsapp');
    assert.ok(
      !queries.some((q) => /FROM offer_messages/i.test(q.sql)),
      'no open-conversation lookup when the row is already established',
    );
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
