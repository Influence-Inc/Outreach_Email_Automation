'use strict';

// Run with: npm test  (node --test)
//
// Guards markManualReplySent — the timeline entry logged when a human sends
// a reply outside the automated flow (Instantly unibox, or connected mailbox).
// Three behaviours matter:
//   1. A fresh manual reply is logged with the message_id + snippet AND clears
//      any pending Delegate flags on the row so the next inbound is processed
//      by the automation instead of parked again.
//   2. A duplicate webhook (same message_id) is a no-op — the timeline never
//      doubles up.
//   3. When one of the app's own outbound sends (delegate reply, priced offer,
//      negotiation reply, contract) was just logged, the email_sent webhook is
//      the echo of that send and must NOT also be logged as a manual reply.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const outreach = require('./outreach');

const origOne = db.one;
const origQuery = db.query;

function restore() {
  db.one = origOne;
  db.query = origQuery;
}

test('markManualReplySent logs a fresh manual reply and clears delegate flags', async () => {
  const writes = [];
  db.one = async () => null; // no dupe, no recent app send
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  try {
    const inserted = await outreach.markManualReplySent(7, {
      messageId: 'msg-1',
      subject: 'Re: Paid Partnership with Reve',
      body: 'That works for us — 500k views at $3.5k. Sending contract next.',
      source: 'instantly_unibox',
    });
    assert.strictEqual(inserted, true);
    const insertRow = writes.find((w) => /'sent_manual_reply'/i.test(w.sql));
    assert.ok(insertRow, 'the sent_manual_reply event is inserted');
    assert.strictEqual(insertRow.params[0], 7);
    assert.strictEqual(insertRow.params[1], 'msg-1');
    assert.ok(insertRow.params[2].snippet.startsWith('That works'));
    assert.strictEqual(insertRow.params[2].source, 'instantly_unibox');
    const clear = writes.find((w) => /needs_human\s*=\s*FALSE/i.test(w.sql));
    assert.ok(clear, 'the delegate flags are cleared so automation re-engages');
  } finally {
    restore();
  }
});

test('markManualReplySent is idempotent on message_id — duplicate webhook is a no-op', async () => {
  const writes = [];
  db.one = async (sql) => {
    // The dedupe now matches ANY prior event carrying this message_id.
    if (/message_id = \$2/i.test(sql)) return { id: 42 }; // already logged
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  try {
    const inserted = await outreach.markManualReplySent(7, {
      messageId: 'msg-1',
      body: 'redelivered webhook',
    });
    assert.strictEqual(inserted, false);
    assert.strictEqual(writes.length, 0, 'nothing is written on the duplicate');
  } finally {
    restore();
  }
});

test('markManualReplySent skips the echo of a sequence send that shares its message_id', async () => {
  // The bug class: an email_sent webhook re-fires with the SAME message_id as a
  // send we already logged (the outreach or a follow-up). It must not become a
  // second "Manual reply sent" — the message_id dedupe catches it even though no
  // prior sent_manual_reply exists for it.
  const writes = [];
  db.one = async (sql) => {
    // A prior event exists for this message_id (e.g. the logged sent_followup).
    if (/message_id = \$2/i.test(sql)) return { id: 7 };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  try {
    const inserted = await outreach.markManualReplySent(7, {
      messageId: 'followup-msg-id',
      body: 'echoed follow-up body',
    });
    assert.strictEqual(inserted, false, 'the sequence echo is not logged as a manual reply');
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});

test('markManualReplySent skips when an app-initiated send was just logged (echo of our own send)', async () => {
  const writes = [];
  db.one = async (sql) => {
    // No same-message-id dupe. But a recent APP outbound (delegate reply /
    // offer / negotiation reply / contract) exists in the last 5 minutes.
    if (/type = ANY\(\$2::text\[\]\)/i.test(sql) && /5 minutes/i.test(sql)) return { hit: 1 };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  try {
    const inserted = await outreach.markManualReplySent(7, {
      messageId: 'msg-echo',
      body: 'echoed body of the delegate reply we just sent',
    });
    assert.strictEqual(inserted, false, 'the echo is not double-logged');
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});
