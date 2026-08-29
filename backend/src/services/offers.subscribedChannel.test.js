'use strict';

// Two separate questions, deliberately split:
//
//   subscribedChannelFor  — has this PERSON ever texted our business number?
//     Per person, not per campaign: texting us once subscribes them for good,
//     so a creator pulled into a new campaign months later is NOT emailed
//     "text Hi to continue" as if we'd never spoken. Identity is the phone
//     tail, the same rule the opt-out check and inbound sender matching use.
//
//   openChannelFor        — may we actually send right now?
//     Subscribed AND inside the provider's 24h free-form window. WhatsApp and
//     iMessage both reject a free-form message to someone who hasn't written to
//     us in 24h (Meta 131047/131026, Twilio 63016) — a platform rule, so a
//     subscription alone is not permission to send. Proactive senders must use
//     this one, or the send is rejected and the creator silently gets nothing.
//
// Opt-out beats both, cross-campaign, for compliance.
// The lookups are stubbed; no real Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const offers = require('./offers');

const origOne = db.one;

// optedOut:        what the cross-campaign bool_or(messaging_opted_out) returns.
// subscribedOn:    established_channel found on ANY row for this person's phone.
// windowOpen:      whether an inbound landed inside the 24h window.
function install({ optedOut = false, subscribedOn = null, windowOpen = false } = {}) {
  const queries = [];
  db.one = async (sql, params) => {
    queries.push({ sql, params });
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: optedOut };
    if (/established_channel IS NOT NULL/i.test(sql)) {
      return subscribedOn ? { established_channel: subscribedOn } : null;
    }
    if (/FROM offer_messages/i.test(sql)) return windowOpen ? { open: 1 } : null;
    return null;
  };
  return queries;
}
function restore() {
  db.one = origOne;
}

const CONTACT = {
  whatsapp: '+18005551234',
  imessage: null,
  established_channel: null,
  messaging_opted_out: false,
};

// --- subscribedChannelFor: person-level subscription ------------------------

test('this row\'s own established_channel is the answer, with no extra lookup', async () => {
  const queries = install({ subscribedOn: 'imessage' });
  try {
    const ch = await offers.subscribedChannelFor({ ...CONTACT, established_channel: 'whatsapp' });
    assert.strictEqual(ch, 'whatsapp');
    assert.ok(
      !queries.some((q) => /established_channel IS NOT NULL/i.test(q.sql)),
      'no cross-row lookup when this row already knows',
    );
  } finally {
    restore();
  }
});

// The change: a fresh campaign row inherits the subscription instead of asking
// the creator to introduce themselves again.
test('a NEW campaign row inherits a subscription made on another campaign', async () => {
  install({ subscribedOn: 'whatsapp' });
  try {
    assert.strictEqual(await offers.subscribedChannelFor(CONTACT), 'whatsapp');
  } finally {
    restore();
  }
});

test('never subscribed anywhere → null', async () => {
  install({ subscribedOn: null });
  try {
    assert.strictEqual(await offers.subscribedChannelFor(CONTACT), null);
  } finally {
    restore();
  }
});

test('a subscription on a channel this row has no number for → null', async () => {
  // The message would have no destination, so the email invite is the honest path.
  install({ subscribedOn: 'imessage' });
  try {
    assert.strictEqual(await offers.subscribedChannelFor(CONTACT), null);
  } finally {
    restore();
  }
});

test('opted out on ANY of the person\'s rows → null, subscribed or not', async () => {
  install({ optedOut: true, subscribedOn: 'whatsapp' });
  try {
    assert.strictEqual(await offers.subscribedChannelFor({ ...CONTACT, established_channel: 'whatsapp' }), null);
  } finally {
    restore();
  }
});

test('no phone on file → this row only, no cross-row lookup', async () => {
  const queries = install();
  try {
    const ch = await offers.subscribedChannelFor({
      whatsapp: null,
      imessage: null,
      established_channel: 'imessage',
      messaging_opted_out: false,
    });
    assert.strictEqual(ch, 'imessage');
    assert.strictEqual(queries.length, 0, 'nothing to match a person on without a phone');
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

// --- openChannelFor: subscription AND an open window ------------------------

test('subscribed with the window open → the channel', async () => {
  install({ subscribedOn: 'whatsapp', windowOpen: true });
  try {
    assert.strictEqual(await offers.openChannelFor(CONTACT), 'whatsapp');
  } finally {
    restore();
  }
});

// The reason subscription and sendability are separate: a long-subscribed
// creator who hasn't written in a week cannot be sent a free-form message, so
// the caller must fall back to email rather than have the provider reject it.
test('subscribed but the window has closed → null, so the caller falls back to email', async () => {
  install({ subscribedOn: 'whatsapp', windowOpen: false });
  try {
    assert.strictEqual(await offers.openChannelFor(CONTACT), null);
  } finally {
    restore();
  }
});

test('an open window on its own is not a subscription', async () => {
  install({ subscribedOn: null, windowOpen: true });
  try {
    assert.strictEqual(await offers.openChannelFor(CONTACT), null);
  } finally {
    restore();
  }
});

test('opt-out beats both a subscription and an open window', async () => {
  install({ optedOut: true, subscribedOn: 'whatsapp', windowOpen: true });
  try {
    assert.strictEqual(await offers.openChannelFor(CONTACT), null);
  } finally {
    restore();
  }
});

test('the window lookup reads offer_messages.sent_at, the column that exists', async () => {
  // offer_messages has no created_at; getting this wrong threw in Postgres and
  // aborted the whole offer send while passing against a stub. Pin the column.
  const queries = install({ subscribedOn: 'whatsapp', windowOpen: true });
  try {
    await offers.openChannelFor(CONTACT);
    const q = queries.find((x) => /FROM offer_messages/i.test(x.sql));
    assert.ok(q, 'the window lookup ran');
    assert.match(q.sql, /\bm\.sent_at\b/);
    assert.doesNotMatch(q.sql, /\bm\.created_at\b/);
  } finally {
    restore();
  }
});
