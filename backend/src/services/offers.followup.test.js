'use strict';

// Guards offers.sendUsedCreatorInviteFollowup — the ONE-TIME reminder to a USED
// creator who got the messaging invite but never engaged. Two invariants matter:
//   1. It is idempotent: every non-transient outcome stamps invite_followup_at
//      (so the scheduler never re-selects the creator), and a genuinely transient
//      send failure does NOT stamp (so it retries next tick).
//   2. It sends the right thing: the offer email (with the portal link) when a
//      live offer exists, else the "text Hi" invite; with neither a link nor a
//      reachable number, it sends nothing but still stamps.
// DB + the email senders are stubbed — no network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const email = require('./offerPortal/email');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origOffer = email.sendOfferWithContactEmail;
const origInvite = email.sendPortalInviteEmail;

function install({ creator, pending = null, sendResult = { sent: true } }) {
  const writes = [];
  const offerSends = [];
  const inviteSends = [];
  db.one = async (sql) => {
    if (/FROM creators c LEFT JOIN campaigns/i.test(sql)) return creator ? { ...creator } : null;
    if (/FROM offers WHERE creator_id/i.test(sql)) return pending;
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  email.sendOfferWithContactEmail = async (args) => {
    offerSends.push(args);
    return sendResult;
  };
  email.sendPortalInviteEmail = async (args) => {
    inviteSends.push(args);
    return sendResult;
  };
  return { writes, offerSends, inviteSends };
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
  email.sendOfferWithContactEmail = origOffer;
  email.sendPortalInviteEmail = origInvite;
}

const stamped = (writes) => writes.some((w) => /invite_followup_at\s*=\s*NOW\(\)/i.test(w.sql));
const loggedEvent = (writes) => writes.some((w) => /'invite_followup_sent'/i.test(w.sql));

// Phone fields null → inviteNumbersFor is deterministically (null, null) with no
// env dependence, so a send only happens via the offer link.
const baseCreator = {
  id: 55,
  email: 'creator@example.com',
  first_name: 'Priya',
  full_name: 'Priya R',
  whatsapp: null,
  imessage: null,
  messaging_opted_out: false,
  established_channel: null,
  brand_name: 'Acme',
};

test('sends the offer email (with the portal link) when a live offer exists, then stamps + logs', async () => {
  const { writes, offerSends } = install({
    creator: { ...baseCreator },
    pending: { token: 'tok123', expires_at: new Date('2026-08-01').toISOString() },
  });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: true });
    assert.strictEqual(offerSends.length, 1, 'one offer email is sent');
    assert.match(offerSends[0].offerUrl, /\/o\/tok123/, 'it carries the offer link');
    assert.strictEqual(offerSends[0].reminder, true, 'it is framed as a reminder');
    assert.ok(stamped(writes), 'invite_followup_at is stamped');
    assert.ok(loggedEvent(writes), 'an invite_followup_sent event is logged');
  } finally {
    restore();
  }
});

test('does nothing (but still stamps) once the creator has engaged', async () => {
  const { writes, offerSends, inviteSends } = install({
    creator: { ...baseCreator, established_channel: 'imessage' },
  });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: false, reason: 'already_engaged' });
    assert.strictEqual(offerSends.length + inviteSends.length, 0, 'no reminder to someone already talking to us');
    assert.ok(stamped(writes), 'still stamped so we never reconsider them');
    assert.ok(!loggedEvent(writes));
  } finally {
    restore();
  }
});

test('does nothing (but stamps) for an opted-out creator', async () => {
  const { writes, offerSends, inviteSends } = install({ creator: { ...baseCreator, messaging_opted_out: true } });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: false, reason: 'opted_out' });
    assert.strictEqual(offerSends.length + inviteSends.length, 0);
    assert.ok(stamped(writes));
  } finally {
    restore();
  }
});

test('stamps and skips when there is neither a live offer link nor a reachable number', async () => {
  const { writes, offerSends, inviteSends } = install({ creator: { ...baseCreator }, pending: null });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: false, reason: 'nothing_to_send' });
    assert.strictEqual(offerSends.length + inviteSends.length, 0);
    assert.ok(stamped(writes), 'stamped so the scheduler stops reconsidering');
    assert.ok(!loggedEvent(writes));
  } finally {
    restore();
  }
});

test('a transient send failure is NOT stamped (so the next tick retries)', async () => {
  const { writes } = install({
    creator: { ...baseCreator },
    pending: { token: 'tok123', expires_at: new Date('2026-08-01').toISOString() },
    sendResult: { sent: false, error: 'network blip' },
  });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: false, reason: 'network blip' });
    assert.ok(!stamped(writes), 'left unstamped so it retries');
    assert.ok(!loggedEvent(writes));
  } finally {
    restore();
  }
});

test('an unconfigured email provider IS stamped (nothing will ever send)', async () => {
  const { writes } = install({
    creator: { ...baseCreator },
    pending: { token: 'tok123', expires_at: new Date('2026-08-01').toISOString() },
    sendResult: { sent: false, skipped: true },
  });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(55);
    assert.deepStrictEqual(res, { sent: false, reason: 'email_not_configured' });
    assert.ok(stamped(writes), 'stamped so we stop retrying a hard-off provider');
    assert.ok(!loggedEvent(writes));
  } finally {
    restore();
  }
});

test('skips a creator id that no longer exists', async () => {
  const { writes, offerSends, inviteSends } = install({ creator: null });
  try {
    const res = await offers.sendUsedCreatorInviteFollowup(999);
    assert.deepStrictEqual(res, { sent: false, reason: 'not_found' });
    assert.strictEqual(offerSends.length + inviteSends.length, 0);
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});
