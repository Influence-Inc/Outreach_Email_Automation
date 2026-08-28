'use strict';

// Guards offers.signMiniContract's push of a signed USED-creator deal into the
// campaign dashboard (influence-stats). Regression coverage for the bug where a
// used creator's signature was recorded (contract_signed_at, contract_approved)
// but the creator never appeared as a new row on the campaign page — because,
// unlike routes/contracts.js's full-contract flow for new/unused creators, this
// function never called campaignDashboard.syncSignedCreator. DB, briefs, and the
// campaign-dashboard client are all stubbed — no network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const campaignDashboard = require('./campaignDashboard');
const briefs = require('./briefs');
const signedContractEmail = require('./signedContractEmail');
const offers = require('./offers');

const origOne = db.one;
const origQuery = db.query;
const origIsConfigured = campaignDashboard.isConfigured;
const origSyncSignedCreator = campaignDashboard.syncSignedCreator;
const origFlagBriefPending = briefs.flagBriefPending;
const origSendMiniContractCopy = signedContractEmail.sendMiniContractCopy;

const SIGNATURE = 'data:image/png;base64,AAAA';

function baseOfferRow(overrides = {}) {
  return {
    id: 501,
    creator_id: 88,
    campaign_id: 1,
    token: 'offertok',
    status: 'accepted',
    contract_signed_at: null,
    contract_platforms: ['Instagram', 'TikTok'],
    deliverables: ['2 Reels'],
    brand_name: 'Netflix',
    first_name: 'Sam',
    full_name: 'Sam Rivera',
    campaign_name: 'Summer Launch',
    requested_start_date: null,
    ...overrides,
  };
}

function baseCreatorRow(overrides = {}) {
  return {
    id: 88,
    campaign_id: 1,
    email: 'sam@x.com',
    instagram_username: 'sam',
    contract_approved: false,
    ...overrides,
  };
}

function install({ offerRow = baseOfferRow(), creatorRow = baseCreatorRow(), configured = true, syncImpl } = {}) {
  const dashboardCalls = [];
  const copyCalls = [];
  db.one = async (sql, params) => {
    if (/FROM offers o\s+JOIN creators c ON c\.id = o\.creator_id/i.test(sql)) {
      return offerRow ? { ...offerRow } : null;
    }
    // The signing UPDATE returns the stored row (RETURNING *) — the emailed
    // copy is rendered from it, so the stub hands back what Postgres would.
    if (/^\s*UPDATE offers/i.test(sql)) {
      return {
        ...offerRow,
        contract_signed_at: new Date('2026-08-25T10:00:00Z'),
        contract_signer_name: params[1],
        contract_signer_ip: params[2],
        contract_terms: JSON.parse(params[3]),
        contract_signature: params[4],
      };
    }
    if (/FROM creators WHERE id = \$1/i.test(sql)) {
      return creatorRow ? { ...creatorRow } : null;
    }
    return null;
  };
  db.query = async () => ({ rows: [], rowCount: 1 });
  campaignDashboard.isConfigured = () => configured;
  campaignDashboard.syncSignedCreator =
    syncImpl ||
    (async (contract, creator) => {
      dashboardCalls.push({ contract, creator });
      return { success: true, created: true };
    });
  briefs.flagBriefPending = async () => {};
  signedContractEmail.sendMiniContractCopy = async (row) => {
    copyCalls.push(row);
    return { sent: true, to: 'sam@x.com' };
  };
  return { dashboardCalls, copyCalls };
}

function restoreAll() {
  db.one = origOne;
  db.query = origQuery;
  campaignDashboard.isConfigured = origIsConfigured;
  campaignDashboard.syncSignedCreator = origSyncSignedCreator;
  briefs.flagBriefPending = origFlagBriefPending;
  signedContractEmail.sendMiniContractCopy = origSendMiniContractCopy;
}

test('signMiniContract pushes the signed used creator into the campaign dashboard', async () => {
  const { dashboardCalls } = install();
  try {
    const r = await offers.signMiniContract({
      token: 'offertok',
      signature: SIGNATURE,
      signerName: 'Sam Rivera',
      ip: '1.2.3.4',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(dashboardCalls.length, 1, 'campaign dashboard sync is called exactly once');
    assert.strictEqual(dashboardCalls[0].contract.token, 'offertok');
    assert.deepStrictEqual(dashboardCalls[0].contract.data.platforms, ['Instagram', 'TikTok']);
    assert.strictEqual(dashboardCalls[0].creator.id, 88);
    assert.strictEqual(dashboardCalls[0].creator.campaign_id, 1, 'syncs against the CURRENT campaign row');
  } finally {
    restoreAll();
  }
});

test('signMiniContract still signs successfully when the dashboard sync fails (best-effort)', async () => {
  install({ syncImpl: async () => { throw new Error('dashboard down'); } });
  try {
    const r = await offers.signMiniContract({ token: 'offertok', signature: SIGNATURE });
    assert.strictEqual(r.ok, true, 'signing itself never fails because of a dashboard-sync error');
  } finally {
    restoreAll();
  }
});

test('signMiniContract skips the dashboard sync (without failing) when CAMPAIGN_DASHBOARD_URL is not configured', async () => {
  const { dashboardCalls } = install({ configured: false });
  try {
    const r = await offers.signMiniContract({ token: 'offertok', signature: SIGNATURE });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(dashboardCalls.length, 0);
  } finally {
    restoreAll();
  }
});

test('signMiniContract emails the creator their signed copy, from the stored row', async () => {
  const { copyCalls } = install();
  try {
    const r = await offers.signMiniContract({
      token: 'offertok',
      signature: SIGNATURE,
      signerName: 'Sam Rivera',
      ip: '1.2.3.4',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.copyEmailed, true);
    assert.strictEqual(copyCalls.length, 1, 'the signed copy goes out exactly once');
    const sent = copyCalls[0];
    // It must render from what was STORED (signature, server timestamp, the
    // immutable terms snapshot), not from the request payload.
    assert.strictEqual(sent.contract_signature, SIGNATURE);
    assert.strictEqual(sent.contract_signer_name, 'Sam Rivera');
    assert.ok(sent.contract_signed_at instanceof Date);
    assert.deepStrictEqual(sent.contract_terms.platforms, ['Instagram', 'TikTok']);
    // Plus the joined columns the RETURNING row doesn't carry.
    assert.strictEqual(sent.campaign_name, 'Summer Launch');
    assert.strictEqual(sent.first_name, 'Sam');
  } finally {
    restoreAll();
  }
});

test('signMiniContract still signs successfully when the copy email fails (best-effort)', async () => {
  install();
  signedContractEmail.sendMiniContractCopy = async () => { throw new Error('resend down'); };
  try {
    const r = await offers.signMiniContract({ token: 'offertok', signature: SIGNATURE });
    assert.strictEqual(r.ok, true, 'a mail failure never fails a signature already stored');
    assert.strictEqual(r.copyEmailed, false);
  } finally {
    restoreAll();
  }
});
