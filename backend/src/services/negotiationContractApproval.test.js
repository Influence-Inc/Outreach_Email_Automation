'use strict';

// negotiation.approveContract — the brand-POC go-ahead on an accepted deal.
// Our team must get a "go" from the brand's point of contact before finalizing
// a creator, so acceptance parks the deal in the Delegate window and ONLY this
// approval may generate + email the contract. Covered:
//   1. Approving an accepted, unapproved deal records the approval and
//      generates + sends the contract.
//   2. Approving a deal that isn't ACCEPTED is rejected (409).
//   3. A duplicate approval (already approved, contract already exists) does
//      not re-send the signing email.
//   4. ensureContractSent (the scheduler-backfill / manual-route entry point)
//      refuses an unapproved creator — the hard gate behind the approval.
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
  negotiation_status: 'ACCEPTED',
  contract_approved: false,
  usage_rights_policy: 'no_rights',
  quoted_rate: '3500', // NUMERIC comes back from pg as a string
  ig_scraped_data: { median: 29100 },
  max_cpm: 6,
};

// claimable: whether the atomic contract_approved claim matches a row (i.e. the
// deal was still unapproved). hasContract: whether a contract row already
// exists for the creator (the duplicate-click lookup). portalDeal: whether the
// creator has an accepted/signed offer-portal offer — those creators sign the
// mini contract on the page, so no full contract may be generated for them.
function install(creator, { claimable = true, hasContract = false, portalDeal = false } = {}) {
  const writes = [];
  db.one = async (sql) => {
    if (/UPDATE creators/i.test(sql) && /contract_approved\s*=\s*TRUE/i.test(sql)) {
      return claimable ? { id: creator.id } : null;
    }
    if (/SELECT id FROM contracts/i.test(sql)) return hasContract ? { id: 7 } : null;
    if (/FROM offers/i.test(sql)) return portalDeal ? { '?column?': 1 } : null;
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null; // app_settings, latest message lookups, etc.
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

test('approving an accepted deal records the go-ahead and sends the contract', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1'; // keep the contract email off the network
  const writes = install(baseCreator);
  try {
    const res = await negotiation.approveContract(42);
    assert.strictEqual(res.action, 'approved');

    const approvedEv = findEvent(writes, 'contract_approved');
    assert.ok(approvedEv, 'a contract_approved event is logged');
    assert.strictEqual(approvedEv.params[1].by, 'admin', 'the approval is attributed to the admin');

    assert.ok(findEvent(writes, 'contract_sent'), 'the contract goes out on approval');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('approving a deal that is not accepted is rejected (409)', async () => {
  const writes = install({ ...baseCreator, negotiation_status: 'AWAITING_DECISION' });
  try {
    await assert.rejects(
      () => negotiation.approveContract(42),
      (err) => err.status === 409 && /not accepted yet/i.test(err.message),
    );
    assert.ok(!findEvent(writes, 'contract_approved'), 'no approval is logged');
    assert.ok(!findEvent(writes, 'contract_sent'), 'no contract goes out');
  } finally {
    restore();
  }
});

test('a duplicate approval does not re-send the signing email', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install(
    { ...baseCreator, contract_approved: true },
    { claimable: false, hasContract: true },
  );
  try {
    const res = await negotiation.approveContract(42);
    assert.strictEqual(res.action, 'approved');
    assert.strictEqual(res.already, true, 'reported as already approved');
    assert.ok(!findEvent(writes, 'contract_approved'), 'the approval is not logged twice');
    assert.ok(!findEvent(writes, 'contract_sent'), 'the signing email is not re-sent');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// A used creator runs their whole deal on the offer portal: they accept on the
// page, then draw a signature on the mini contract there. No full contract is
// ever generated for them — one would be a second, redundant agreement, and the
// contracts row it leaves behind makes Deal Studio's status pill read "contract
// sent" / "contract signed" for a deal the creator has not signed.
test('approving a deal the creator accepted on the offer portal is rejected (409)', async () => {
  const writes = install(baseCreator, { portalDeal: true });
  try {
    await assert.rejects(
      () => negotiation.approveContract(42),
      (err) => err.status === 409 && /offer portal/i.test(err.message),
    );
    assert.ok(!findEvent(writes, 'contract_approved'), 'no approval is logged');
    assert.ok(!findEvent(writes, 'contract_sent'), 'no second contract goes out');
  } finally {
    restore();
  }
});

// signMiniContract sets contract_approved = TRUE purely to skip the "Approve
// deal" delegate, which would otherwise match the scheduler's "approved with no
// contract" backfill on every portal signer.
test('ensureContractSent skips a portal deal even once it is approved', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({ ...baseCreator, contract_approved: true }, { portalDeal: true });
  try {
    const res = await negotiation.ensureContractSent(42);
    assert.deepStrictEqual(res, { skipped: 'portal_deal' });
    assert.ok(!findEvent(writes, 'contract_sent'), 'the backfill mints no contract for a portal signer');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('ensureContractSent refuses a creator without the recorded approval', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install(baseCreator); // contract_approved: false
  try {
    const res = await negotiation.ensureContractSent(42);
    assert.deepStrictEqual(res, { skipped: 'not approved' });
    assert.ok(!findEvent(writes, 'contract_sent'), 'no contract goes out without the approval');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// The manual escape hatch (POST /:id/contract, wired to the dashboard's "Send
// contract" fallback button) records an approval and calls ensureContractSent
// regardless of negotiation stage — the flow used when a mixed-intent reply
// lands the deal at AWAITING_DECISION + hand-off, the human answers, and the
// AI never advances it to ACCEPTED. approveContract itself would 409 here;
// this path must not.
test('ensureContractSent sends the contract at AWAITING_DECISION once the manual approval is recorded', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    contract_approved: true, // the route records this before calling ensureContractSent
  });
  try {
    const res = await negotiation.ensureContractSent(42);
    assert.deepStrictEqual(res, { ok: true });
    assert.ok(findEvent(writes, 'contract_sent'), 'the contract goes out on the manual send');
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});
