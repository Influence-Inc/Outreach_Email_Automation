'use strict';

// Scheduler wiring for reopened replies (pollNegotiations step 6).
//
// A creator we'd closed out (dismissed offer → CLOSED, DECLINED, or idle
// auto-close → CLOSED) who replies again must be routed to surfaceReopenedReply
// so the message reaches the Delegate window. This exercises the real
// pollNegotiations query wiring: db.many is stubbed to return the closed creator
// ONLY for the CLOSED/DECLINED reply query, every other step gets an empty set,
// and we assert the reopened handler is invoked with that creator's id.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');
const scheduler = require('./scheduler');

const origMany = db.many;
const origSurface = negotiation.surfaceReopenedReply;

test('pollNegotiations routes a CLOSED creator with a fresh reply to surfaceReopenedReply', async () => {
  const reopenedQuery = /negotiation_status IN \('CLOSED', 'DECLINED'\)[\s\S]*latest_inbound_text IS NOT NULL/i;
  const calls = [];

  // Only the reopened-replies query returns a creator; every other step's query
  // returns an empty set so no other handler runs.
  db.many = async (sql) => (reopenedQuery.test(sql) ? [{ id: 77 }] : []);
  negotiation.surfaceReopenedReply = async (id) => {
    calls.push(id);
    return { action: 'reopened' };
  };

  try {
    await scheduler.pollNegotiations();
    assert.deepStrictEqual(calls, [77], 'the closed creator with a pending reply is reopened exactly once');
  } finally {
    db.many = origMany;
    negotiation.surfaceReopenedReply = origSurface;
  }
});
