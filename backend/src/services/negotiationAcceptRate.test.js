'use strict';

// negotiation.acceptQuotedRate — the admin accepting the creator's OWN quoted
// rate instead of shaping a counter offer. This is the mirror of the creator
// accepting our offer: WE agree to THEIR number, the deal moves to ACCEPTED at
// that fee, and it parks for the brand POC's contract approval — no contract
// is generated or emailed until the deal is approved in the Delegate window.
//
// The DB layer is a thin singleton (src/db), so we stub db.one/db.query to
// observe the writes. The contract pipeline is heavy (Claude + PDF + email), so
// we override contracts.createContractForCreator — negotiation.js calls it via
// property access on the module, so replacing it on the singleton works.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');
const contracts = require('./contracts');

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;
const origCreate = contracts.createContractForCreator;

const baseCreator = {
  id: 42,
  first_name: 'Joe',
  instagram_username: 'aibyjoe',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  negotiation_status: 'AWAITING_APPROVAL',
  usage_rights_policy: 'no_rights',
  quoted_rate: '3500', // NUMERIC comes back from pg as a string
  ig_scraped_data: { median: 29100 },
  max_cpm: 6,
};

// stageClaimable: when true the atomic UPDATE ... RETURNING returns a row (the
// stage matched); when false it returns null (stage already changed / closed).
// The atomic UPDATE goes through db.one (RETURNING *), so we capture its params
// too — tests need to inspect what custom_offer got written on the accept.
function install(creator, { stageClaimable = true } = {}) {
  const writes = [];
  db.one = async (sql, params) => {
    if (/UPDATE creators/i.test(sql) && /RETURNING \*/i.test(sql)) {
      writes.push({ sql, params });
      return stageClaimable
        ? { ...creator, negotiation_status: 'ACCEPTED', quoted_rate: Number(creator.quoted_rate) }
        : null;
    }
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // rate_offer_sent / rate_accepted lookups, app_settings, etc.
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  contracts.createContractForCreator = async () => ({ url: 'https://influence.test/sign/abc' });
  return writes;
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  contracts.createContractForCreator = origCreate;
}

// Find the email_events INSERT whose literal type appears in the SQL text.
const findEvent = (writes, type) =>
  writes.find((w) => /INSERT INTO email_events/i.test(w.sql) && new RegExp(`'${type}'`).test(w.sql));

test('accepting the creator rate locks the fee, moves to ACCEPTED, and logs an admin acceptance', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1'; // keep the contract email off the network
  const writes = install(baseCreator);
  try {
    const res = await negotiation.acceptQuotedRate(42);
    assert.strictEqual(res.action, 'accepted');
    assert.strictEqual(res.fee, 3500, 'agreed fee is the creator’s quoted rate');

    const ev = findEvent(writes, 'rate_accepted');
    assert.ok(ev, 'a rate_accepted event is logged');
    const detail = ev.params[1];
    assert.strictEqual(detail.fee, 3500, 'the logged fee is the creator rate');
    assert.strictEqual(detail.by, 'admin', 'flagged as an admin acceptance');
    assert.strictEqual(detail.source, 'creator_rate', 'source marks it as accepting the creator’s own rate');

    // No contract yet: the acceptance parks the deal for the brand POC's
    // go-ahead instead of firing the contract email.
    assert.ok(
      findEvent(writes, 'contract_approval_requested'),
      'acceptance requests the brand approval',
    );
    assert.ok(!findEvent(writes, 'contract_sent'), 'no contract is sent before the approval');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('accepting the creator rate pins a video-based custom_offer so the contract is not misrendered as view-based', async () => {
  // Without this pin the generated contract falls back to suggested_offers[0]
  // — the "Conservative View Deal" (view_based) that computeOffers always
  // emits first — and the contract silently renders as a view-based deal with
  // no video count. A creator quoting their own rate is a flat/video-based
  // deal, so acceptQuotedRate writes an explicit custom_offer of that shape.
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install(baseCreator);
  try {
    await negotiation.acceptQuotedRate(42);
    const claim = writes.find(
      (w) => /UPDATE creators/i.test(w.sql) && /custom_offer\s*=/i.test(w.sql) && /RETURNING \*/i.test(w.sql),
    );
    assert.ok(claim, 'the atomic ACCEPTED claim writes a custom_offer');
    const raw = claim.params[3];
    assert.ok(typeof raw === 'string', 'custom_offer is JSON-serialised for the jsonb cast');
    const offer = JSON.parse(raw);
    assert.strictEqual(offer.offer_type, 'video_based', 'the deal is pinned as video-based, not view-based');
    assert.strictEqual(offer.flat_fee, 3500, 'the pinned fee is the accepted creator rate');
    assert.ok(Number(offer.num_videos) >= 1, 'a positive video count is set so the contract lists deliverables');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('accepting a creator with no quoted rate is rejected (400)', async () => {
  install({ ...baseCreator, quoted_rate: null });
  try {
    await assert.rejects(
      () => negotiation.acceptQuotedRate(42),
      (err) => err.status === 400 && /has not shared a rate/i.test(err.message),
    );
  } finally {
    restore();
  }
});

test('accepting from a non-actionable stage is rejected (409)', async () => {
  // loadCreator returns a CLOSED creator; the atomic claim matches no row.
  install({ ...baseCreator, negotiation_status: 'CLOSED' }, { stageClaimable: false });
  try {
    await assert.rejects(
      () => negotiation.acceptQuotedRate(42),
      (err) => err.status === 409 && /not awaiting an offer/i.test(err.message),
    );
  } finally {
    restore();
  }
});
