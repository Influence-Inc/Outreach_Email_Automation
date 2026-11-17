'use strict';

// Two contracts for one creator: the manual "Send contract" route records the
// go-ahead (contract_approved) and calls ensureContractSent, while the
// scheduler's contract backfill sees "ACCEPTED + approved + no contract" and
// calls ensureContractSent too. createContractForCreator used to check for an
// existing contract, spend ~10s on the Claude thread extraction, then INSERT —
// so both callers passed the check, both INSERTed and both emailed the signing
// link (seen locally as contracts 13 and 14 for creator 8, 0.5s apart).
//
// These tests run the REAL createContractForCreator + sendContractOnAcceptance
// against an in-memory db stub. The stub models Postgres' row lock: a
// `SELECT … FROM creators … FOR UPDATE` inside db.withTransaction blocks until
// the other transaction holding it commits. The Claude call is stubbed with a
// delay so both callers are mid-extraction at the same time.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const claude = require('./claudeClient');
const thread = require('./thread');
const negotiation = require('./negotiation');

const orig = {
  one: db.one,
  query: db.query,
  many: db.many,
  withTransaction: db.withTransaction,
  callClaudeText: claude.callClaudeText,
  loadThread: thread.loadThread,
  dryRun: process.env.DRY_RUN,
};

const creator = {
  id: 8,
  campaign_id: 3,
  first_name: 'Joe',
  email: 'joe@example.test',
  instagram_username: 'aibyjoe',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  negotiation_status: 'ACCEPTED',
  contract_approved: true,
  usage_rights_policy: 'no_rights',
  quoted_rate: '3500',
  ig_scraped_data: { median: 29100 },
  max_cpm: 6,
};

const tick = () => new Promise((r) => setImmediate(r));

function install({ existing = null } = {}) {
  const state = { contracts: existing ? [existing] : [], inserts: 0, events: [] };
  let lockHeld = null; // promise resolved when the current holder commits

  const findContract = () => state.contracts[0] || null;

  const handle = async (sql, params) => {
    await tick(); // every statement yields, so concurrent callers interleave
    if (/INSERT INTO contracts/i.test(sql)) {
      state.inserts += 1;
      const row = { id: 12 + state.inserts, token: params[0], creator_id: params[1], status: 'pending', data: JSON.parse(params[3]) };
      state.contracts.push(row);
      return { rows: [row] };
    }
    if (/FROM contracts WHERE creator_id/i.test(sql)) {
      const row = findContract();
      return { rows: row ? [row] : [] };
    }
    const ev = /INSERT INTO email_events[^']*'([a-z_]+)'/i.exec(sql);
    if (ev) state.events.push(ev[1]);
    return { rows: [] };
  };

  db.one = async (sql, params) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    if (/FROM contracts WHERE creator_id/i.test(sql) || /INSERT INTO contracts/i.test(sql)) {
      return (await handle(sql, params)).rows[0] || null;
    }
    return null; // offers (no portal deal), app_settings, fee/terms events
  };
  db.query = handle;
  db.many = async () => [];
  db.withTransaction = async (fn) => {
    let release = null;
    const client = {
      query: async (sql, params) => {
        if (/FROM creators WHERE id = \$1 FOR UPDATE/i.test(sql)) {
          while (lockHeld) await lockHeld;
          lockHeld = new Promise((r) => { release = r; });
          return { rows: [{ id: params[0] }] };
        }
        return handle(sql, params);
      },
    };
    try {
      return await fn(client);
    } finally {
      if (release) { lockHeld = null; release(); }
    }
  };
  // The ~10s thread extraction, shortened: long enough that both callers are
  // past the unlocked existence check before either reaches the INSERT.
  claude.callClaudeText = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return '{}';
  };
  thread.loadThread = async () => [];
  process.env.DRY_RUN = '1';
  return state;
}

function restore() {
  db.one = orig.one;
  db.query = orig.query;
  db.many = orig.many;
  db.withTransaction = orig.withTransaction;
  claude.callClaudeText = orig.callClaudeText;
  thread.loadThread = orig.loadThread;
  if (orig.dryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = orig.dryRun;
}

const count = (arr, v) => arr.filter((x) => x === v).length;

test('concurrent ensureContractSent calls create one contract and send one email', async () => {
  const state = install();
  try {
    const results = await Promise.all([
      negotiation.ensureContractSent(creator.id), // the manual route's send
      negotiation.ensureContractSent(creator.id), // the scheduler backfill
    ]);
    assert.strictEqual(state.inserts, 1, 'exactly one contract row is INSERTed');
    assert.strictEqual(state.contracts.length, 1);
    assert.strictEqual(count(state.events, 'contract_created'), 1);
    assert.strictEqual(count(state.events, 'contract_sent'), 1, 'the signing link is emailed once');
    assert.deepStrictEqual(
      results.map((r) => !!r.reused).sort(),
      [false, true],
      'the loser reports that it reused the winner\'s contract',
    );
  } finally {
    restore();
  }
});

test('a manual re-send racing the backfill still sends one email', async () => {
  // resend: true is the manual route on an already-approved creator. It may
  // re-email a contract that existed before it ran, but never one a concurrent
  // caller created moments ago — that caller is already emailing it.
  const state = install();
  try {
    await Promise.all([
      negotiation.ensureContractSent(creator.id, { resend: true }),
      negotiation.ensureContractSent(creator.id),
    ]);
    assert.strictEqual(state.inserts, 1);
    assert.strictEqual(count(state.events, 'contract_sent'), 1);
  } finally {
    restore();
  }
});

test('an existing contract is not re-emailed unless a re-send is asked for', async () => {
  const existing = { id: 5, token: 'tok-existing', creator_id: creator.id, status: 'pending', data: {} };

  let state = install({ existing });
  try {
    const res = await negotiation.ensureContractSent(creator.id);
    assert.deepStrictEqual(res, { ok: true, reused: true });
    assert.strictEqual(state.inserts, 0);
    assert.strictEqual(count(state.events, 'contract_sent'), 0, 'the backfill never re-emails');
  } finally {
    restore();
  }

  state = install({ existing });
  try {
    const res = await negotiation.ensureContractSent(creator.id, { resend: true });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(state.inserts, 0, 'the re-send reuses the existing contract');
    assert.strictEqual(count(state.events, 'contract_sent'), 1, 'a deliberate re-send emails the link again');
  } finally {
    restore();
  }
});
