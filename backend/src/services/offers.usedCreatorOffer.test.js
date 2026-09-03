'use strict';

// Guards the Part 2 used-creator outreach entry point (offers.sendUsedCreatorOffer)
// and its two helpers: resolvePriorCpm (the CPM chain) and computeAutoOffer (the
// deterministic 1-video flat auto-price). Also guards the new offer-only email
// template (renderNewCampaignOfferEmail): friendly copy, offer link, NO "text Hi"
// chat CTAs. DB, email sender, and Creator-DB lookups are all stubbed — no
// network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const email = require('./offerPortal/email');
const creatorDb = require('./creatorDb');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origSendNew = email.sendNewCampaignOfferEmail;
const origLookupCpm = creatorDb.lookupCpmFromCreatorDb;

// --- computeAutoOffer -------------------------------------------------------

test('computeAutoOffer prices a 1-video flat deal at the given CPM', () => {
  // p25 = 100_000 views, cpm = $20 → fee = 100_000 * 20 / 1000 = $2000.
  const off = offers.computeAutoOffer({ p25: 100000 }, 20);
  assert.strictEqual(off.num_videos, 1);
  assert.strictEqual(off.flat_fee, 2000);
  assert.strictEqual(off.flat_per_video, 2000);
  assert.strictEqual(off.cpm_applied, 20);
  assert.strictEqual(off.offer_type, 'video_based');
});

test('computeAutoOffer returns null without stats OR without CPM (nothing to price against)', () => {
  assert.strictEqual(offers.computeAutoOffer(null, 20), null);
  assert.strictEqual(offers.computeAutoOffer({ p25: 0 }, 20), null);
  assert.strictEqual(offers.computeAutoOffer({ p25: 100000 }, 0), null);
});

// --- resolvePriorCpm --------------------------------------------------------

function stubCreatorDbCpm(value) {
  creatorDb.lookupCpmFromCreatorDb = async () => value;
}

test('resolvePriorCpm prefers Creator-DB cpm when it returns one', async () => {
  stubCreatorDbCpm(18);
  try {
    const r = await offers.resolvePriorCpm(
      { email: 'sam@x.com', instagram_username: 'sam' },
      { max_cpm: 12, data: {} },
    );
    assert.deepStrictEqual(r, { cpm: 18, source: 'creator_db' });
  } finally {
    creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
  }
});

test('resolvePriorCpm falls back to the bot-API bookedCpm on this creator\'s row', async () => {
  stubCreatorDbCpm(null);
  try {
    const r = await offers.resolvePriorCpm(
      { email: 'sam@x.com', instagram_username: 'sam' },
      {
        max_cpm: 12,
        data: {
          creators: [
            { email: 'other@x.com', username: 'other', commercials: { bookedCpm: 99 } },
            { email: 'SAM@x.com', username: 'sam', commercials: { bookedCpm: 25 } },
          ],
        },
      },
    );
    assert.deepStrictEqual(r, { cpm: 25, source: 'bot_api_bookedCpm' });
  } finally {
    creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
  }
});

test('resolvePriorCpm falls back to campaign.max_cpm when the earlier sources have nothing', async () => {
  stubCreatorDbCpm(null);
  try {
    const r = await offers.resolvePriorCpm(
      { email: 'sam@x.com', instagram_username: 'sam' },
      { max_cpm: 12, data: { creators: [] } },
    );
    assert.deepStrictEqual(r, { cpm: 12, source: 'campaign_max_cpm' });
  } finally {
    creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
  }
});

// --- renderNewCampaignOfferEmail (offer-link only, NO chat buttons) --------

test('renderNewCampaignOfferEmail is friendly, has the offer link, and NO chat CTAs', () => {
  const r = email.renderNewCampaignOfferEmail({
    firstName: 'Sam',
    brandName: 'Netflix',
    offerUrl: 'https://portal.example/o/tok123',
    expiryDate: 'Aug 1',
  });
  assert.match(r.subject, /Netflix/);
  assert.match(r.subject, /Sam/);
  assert.match(r.text, /^Hi Sam/);
  assert.match(r.text, /new Netflix campaign/i);
  assert.match(r.text, /https:\/\/portal\.example\/o\/tok123/);
  assert.match(r.text, /Aug 1/);
  // No "text Hi" chat CTAs — the graduation email is the one-time connect
  // invite for Used creators. This email is offer-only.
  assert.doesNotMatch(r.html, /wa\.me/);
  assert.doesNotMatch(r.html, /Text us on/);
  assert.doesNotMatch(r.text, /text.*Hi/i);
});

// --- sendUsedCreatorOffer (integration) ------------------------------------

function install({
  creator,
  cpmFromCreatorDb = null,
  subscribed = null,
  windowOpen = false,
  offerCreate = { id: 42, token: 'tok42', expires_at: new Date('2026-08-01').toISOString(), creator_id: creator ? creator.id : null },
  emailSent = { sent: true },
} = {}) {
  const writes = [];
  const emails = [];
  const dmOffers = [];

  db.one = async (sql) => {
    if (/FROM creators c LEFT JOIN campaigns ca ON ca\.id = c\.campaign_id/i.test(sql) && /c\.\*/.test(sql)) {
      return creator ? { ...creator } : null;
    }
    // subscribedChannelFor's opt-out cross-campaign query
    if (/bool_or\(messaging_opted_out\)/i.test(sql)) return { opted_out: false };
    // Person-level subscription lookup across the creator's other campaign rows.
    if (/established_channel IS NOT NULL/i.test(sql)) {
      return subscribed ? { established_channel: subscribed } : null;
    }
    // conversationWindowOpen — a proactive DM needs the provider's 24h
    // free-form window open, not just a subscription.
    if (/FROM offer_messages/i.test(sql)) return windowOpen ? { open: 1 } : null;
    // deliverOfferOverChannel's fetch
    if (/FROM offers o JOIN creators c ON c\.id = o\.creator_id/i.test(sql)) {
      return {
        ...creator,
        creator_id: creator.id,
        id: offerCreate.id,
        token: offerCreate.token,
        expires_at: offerCreate.expires_at,
        brand_name: creator.campaign_brand_name,
      };
    }
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    // createOffer transactional insert doesn't go through db.query, so nothing
    // to special-case here.
    return { rows: [], rowCount: 0 };
  };
  // Stub createOffer via db.withTransaction (used inside createOffer). Simpler:
  // stub the outermost pieces so we don't reach withTransaction. We do that by
  // patching offers.createOffer via db.withTransaction:
  const origWithTx = db.withTransaction;
  db.withTransaction = async (fn) => {
    const client = { query: async () => ({ rows: [offerCreate], rowCount: 1 }) };
    return await fn(client);
  };
  install._restoreTx = () => {
    db.withTransaction = origWithTx;
  };
  creatorDb.lookupCpmFromCreatorDb = async () => cpmFromCreatorDb;
  email.sendNewCampaignOfferEmail = async (args) => {
    emails.push(args);
    return emailSent;
  };
  // Force subscribedChannelFor to a fixed answer by making the local row report
  // its own established_channel (that's the fast path when there's no phone or
  // the opt-out lookup is stubbed above to false). We set creator.established_
  // channel in the arg to control this.
  return { writes, emails, dmOffers };
}

function restoreAll() {
  db.one = origOne;
  db.query = origQuery;
  if (install._restoreTx) install._restoreTx();
  email.sendNewCampaignOfferEmail = origSendNew;
  creatorDb.lookupCpmFromCreatorDb = origLookupCpm;
}

const baseCreator = {
  id: 88,
  email: 'sam@x.com',
  first_name: 'Sam',
  full_name: 'Sam Rivera',
  instagram_username: 'sam',
  whatsapp: null,
  imessage: null,
  messaging_opted_out: false,
  established_channel: null,
  ig_scraped_data: { p25: 100000, p50: 120000 },
  campaign_id: 1,
  campaign_brand_name: 'Netflix',
  max_cpm: 12,
  campaign_data: {},
};

test('sendUsedCreatorOffer auto-prices, mints an offer, and sends the offer email when NOT yet messaging us', async () => {
  const { writes, emails } = install({ creator: { ...baseCreator }, cpmFromCreatorDb: 20 });
  try {
    const r = await offers.sendUsedCreatorOffer(88);
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.via, 'email');
    assert.strictEqual(r.token, 'tok42');
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0].brandName, 'Netflix');
    assert.match(emails[0].offerUrl, /\/o\/tok42/);
    assert.ok(writes.some((w) => /'offer_auto_priced'/i.test(w.sql)));
    assert.ok(writes.some((w) => /'sent'/i.test(w.sql) && /offer_events/i.test(w.sql)));
  } finally {
    restoreAll();
  }
});

test('sendUsedCreatorOffer sends the DM (no email) when subscribed and the window is open', async () => {
  const { emails } = install({
    creator: { ...baseCreator, established_channel: 'imessage', imessage: '+15551234567' },
    cpmFromCreatorDb: 20,
    windowOpen: true,
  });
  try {
    const r = await offers.sendUsedCreatorOffer(88);
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.via, 'messaging');
    assert.deepStrictEqual(r.channels, ['iMessage']);
    assert.strictEqual(emails.length, 0, 'no email when we DM the offer directly');
  } finally {
    restoreAll();
  }
});

test('sendUsedCreatorOffer returns no_stats (caller falls back) when the creator has no view stats', async () => {
  const { emails } = install({ creator: { ...baseCreator, ig_scraped_data: null }, cpmFromCreatorDb: 20 });
  try {
    const r = await offers.sendUsedCreatorOffer(88);
    assert.deepStrictEqual(r, { sent: false, reason: 'no_stats' });
    assert.strictEqual(emails.length, 0);
  } finally {
    restoreAll();
  }
});

test('sendUsedCreatorOffer refuses to send to an opted-out creator', async () => {
  const { emails } = install({ creator: { ...baseCreator, messaging_opted_out: true }, cpmFromCreatorDb: 20 });
  try {
    const r = await offers.sendUsedCreatorOffer(88);
    assert.deepStrictEqual(r, { sent: false, reason: 'opted_out' });
    assert.strictEqual(emails.length, 0);
  } finally {
    restoreAll();
  }
});
