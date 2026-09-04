'use strict';

// A used creator who is subscribed on WhatsApp/iMessage gets the outreach in
// BOTH places — the chat AND their inbox. Being reachable on chat used to
// suppress the email entirely; it doesn't any more. The chat is where they are
// right now, but the inbox is what survives a scrolled-past conversation, and a
// creator should never have to work out which of the two is authoritative.
//
// Also guards the sender: every Resend send goes out under the INFLUENCE name,
// whatever shape the OFFER_EMAIL_FROM / EMAIL_FROM env happens to be in.
//
// DB, chat providers and the email sender are all stubbed — no network, no
// Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const email = require('./offerPortal/email');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const offers = require('./offers');

// ── the sender name ────────────────────────────────────────────────────────

// Awaits fn before restoring, so an async body still runs with the env in place
// (a plain try/finally around `return fn()` would restore mid-flight).
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a bare address in the env still sends under the INFLUENCE name', async () => {
  // The failure this prevents: OFFER_EMAIL_FROM set to just the address on the
  // deployment, so every creator saw "offers@useinfluence.xyz" as the sender.
  await withEnv({ OFFER_EMAIL_FROM: 'offers@useinfluence.xyz', EMAIL_FROM: undefined }, () => {
    assert.strictEqual(email.fromAddress(), 'INFLUENCE <offers@useinfluence.xyz>');
  });
  await withEnv({ OFFER_EMAIL_FROM: undefined, EMAIL_FROM: '  hello@useinfluence.xyz  ' }, () => {
    assert.strictEqual(email.fromAddress(), 'INFLUENCE <hello@useinfluence.xyz>');
  });
});

test('an env value that already names a sender is left exactly as configured', async () => {
  await withEnv({ OFFER_EMAIL_FROM: 'Jennifer at INFLUENCE <jen@useinfluence.xyz>', EMAIL_FROM: undefined }, () => {
    assert.strictEqual(email.fromAddress(), 'Jennifer at INFLUENCE <jen@useinfluence.xyz>');
  });
});

test('with nothing configured the default sender is still named', async () => {
  await withEnv({ OFFER_EMAIL_FROM: undefined, EMAIL_FROM: undefined }, () => {
    assert.strictEqual(email.fromAddress(), 'INFLUENCE <offers@useinfluence.xyz>');
  });
  await withEnv({ CONTRACT_EMAIL_FROM: undefined }, () => {
    assert.strictEqual(email.contractFromAddress(), 'INFLUENCE Contracts <contracts@useinfluence.xyz>');
  });
});

// ── the invite that goes out on both channels ──────────────────────────────

const orig = {
  one: db.one,
  query: db.query,
  sendWhatsAppText: whatsapp.sendWhatsAppText,
  sendWhatsAppChoice: whatsapp.sendWhatsAppChoice,
  sendIMessageText: imessage.sendIMessageText,
  sendPortalInviteEmail: email.sendPortalInviteEmail,
};

function install({ creator, windowOpen = true, chatSent = true, emailSent = { sent: true } } = {}) {
  const writes = [];
  const emails = [];
  const chats = [];

  db.one = async (sql) => {
    if (/FROM creators c LEFT JOIN campaigns ca/i.test(sql)) return creator ? { ...creator } : null;
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: false };
    if (/established_channel IS NOT NULL/i.test(sql)) return null; // this row already knows
    if (/FROM offer_messages/i.test(sql)) return windowOpen ? { open: 1 } : null;
    if (/SELECT whatsapp, imessage FROM creators/i.test(sql)) {
      return { whatsapp: creator.whatsapp, imessage: creator.imessage };
    }
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };

  const chat = async ({ to, body }) => {
    chats.push({ to, body });
    return chatSent ? { sent: true, id: `m${chats.length}` } : { sent: false, error: 'provider down' };
  };
  whatsapp.sendWhatsAppText = chat;
  whatsapp.sendWhatsAppChoice = chat;
  imessage.sendIMessageText = chat;
  email.sendPortalInviteEmail = async (args) => {
    emails.push(args);
    return emailSent;
  };
  return { writes, emails, chats };
}

function restore() {
  db.one = orig.one;
  db.query = orig.query;
  whatsapp.sendWhatsAppText = orig.sendWhatsAppText;
  whatsapp.sendWhatsAppChoice = orig.sendWhatsAppChoice;
  imessage.sendIMessageText = orig.sendIMessageText;
  email.sendPortalInviteEmail = orig.sendPortalInviteEmail;
}

const subscribedCreator = {
  id: 88,
  email: 'sam@x.com',
  first_name: 'Sam',
  full_name: 'Sam Rivera',
  whatsapp: '+18005551234',
  imessage: null,
  messaging_opted_out: false,
  established_channel: 'whatsapp',
  brand_name: 'Netflix',
};

test('a WhatsApp-subscribed used creator is invited on WhatsApp AND by email', async () => {
  const { emails, chats } = install({ creator: { ...subscribedCreator } });
  try {
    const r = await offers.sendUsedCreatorInvite(88);
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(r.channels, ['WhatsApp', 'Email']);
    assert.ok(chats.length >= 1, 'the chat message still goes out');
    assert.strictEqual(emails.length, 1, 'and so does the email');
    assert.strictEqual(emails[0].to, 'sam@x.com');
    assert.strictEqual(emails[0].brandName, 'Netflix');
  } finally {
    restore();
  }
});

test('the mirrored email points at the open chat instead of asking for another "Hi"', async () => {
  const { emails } = install({ creator: { ...subscribedCreator } });
  try {
    await offers.sendUsedCreatorInvite(88);
    assert.strictEqual(emails[0].established, 'whatsapp');
    // Render it for real: the copy must not send someone already mid-conversation
    // back to square one.
    const r = email.renderPortalInviteEmail({
      firstName: 'Sam',
      brandName: 'Netflix',
      established: 'whatsapp',
    });
    assert.match(r.text, /WhatsApp/);
    assert.doesNotMatch(r.text, /send us a quick "Hi"/i);
    assert.doesNotMatch(r.html, /wa\.me/, 'no "text us" button — they already did');
    assert.doesNotMatch(r.html, /Text us on/);
  } finally {
    restore();
  }
});

test('a failing mirror email never costs the creator the chat message', async () => {
  const { emails, chats } = install({
    creator: { ...subscribedCreator },
    emailSent: { sent: false, error: 'resend exploded' },
  });
  try {
    const r = await offers.sendUsedCreatorInvite(88);
    assert.strictEqual(r.sent, true, 'the chat send still counts');
    assert.deepStrictEqual(r.channels, ['WhatsApp'], 'Email is only claimed when it actually sent');
    assert.ok(chats.length >= 1);
    assert.strictEqual(emails.length, 1, 'but it was attempted');
  } finally {
    restore();
  }
});

test('a subscribed creator with no email on file still gets the chat message', async () => {
  const { emails } = install({ creator: { ...subscribedCreator, email: null } });
  try {
    const r = await offers.sendUsedCreatorInvite(88);
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(r.channels, ['WhatsApp']);
    assert.strictEqual(emails.length, 0, 'nothing to mirror to');
  } finally {
    restore();
  }
});

test('a closed conversation window still falls back to the "text Hi" invite email', async () => {
  // Unchanged behaviour: outside the provider's 24h free-form window a chat send
  // would just be rejected, so the invite email is the whole outreach — and it
  // DOES need the "Hi" CTA, because that is what reopens the window. Needs the
  // WhatsApp provider to look configured, or inviteNumbersFor withholds the
  // number and there is nothing to invite them to.
  const { emails, chats } = install({ creator: { ...subscribedCreator }, windowOpen: false });
  try {
    await withEnv(
      {
        WHATSAPP_CLOUD_ACCESS_TOKEN: 'tok',
        WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'pid',
        WHATSAPP_CLOUD_DISPLAY_NUMBER: '+18005550000',
      },
      async () => {
        const r = await offers.sendUsedCreatorInvite(88);
        assert.strictEqual(r.sent, true);
        assert.strictEqual(chats.length, 0, 'no chat send outside the window');
        assert.strictEqual(emails.length, 1);
        assert.ok(!emails[0].established, 'the standard invite, with its "Hi" buttons');
        assert.ok(emails[0].whatsappNumber, 'and our business number to text');
      },
    );
  } finally {
    restore();
  }
});
