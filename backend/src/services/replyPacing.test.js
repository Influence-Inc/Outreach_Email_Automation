'use strict';

// Reply pacing: automated replies wait 5–60 minutes after the creator's message
// (services/replyPacing.js), are persisted rather than held in a timer, and a
// newer inbound / our own send / a stage change supersedes or cancels a pending
// reply instead of sending it stale.
//
// The DB layer is a thin singleton (src/db), so db.one/query/many are stubbed to
// observe writes, and a fake Claude client fixes the classified action.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');
const replyPacing = require('./replyPacing');
const scheduler = require('./scheduler');

const MIN = 60 * 1000;
const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  negotiation._setClient(null);
}

function fakeClientReturning(obj) {
  const text = JSON.stringify(obj);
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } };
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));
const sent = (writes) => has(writes, /'sent_negotiation'/i);
const delegated = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);

const baseCreator = {
  id: 9,
  first_name: 'Mia',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  usage_rights_policy: 'no_rights',
  status: 'replied',
  negotiation_status: 'AWAITING_RATE',
  instantly_reply_uuid: 'uuid-9',
  instantly_email_account: 'jennifer@useinfluence.xyz',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 40000 },
  max_cpm: 3,
  email: 'mia@example.com',
};

const answer = {
  understanding: 'asks which platforms',
  action: 'answer_question',
  email: { subject: 'Re: Paid Partnership with Reve', body: 'Hi Mia, Instagram only for this one. - Jennifer' },
  send_now: true,
};

// Stubs for processReply / handleAcceptedReply. `pendingSendAt` is the send
// time of a reply already waiting (returned by the supersede UPDATE).
function install(creator, { pendingSendAt = null } = {}) {
  const writes = [];
  const inserted = [];
  db.one = async (sql, params) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    if (/INSERT INTO scheduled_replies/i.test(sql)) {
      const [creator_id, source, kind, result, stage, inbound_text, inbound_at, send_at] = params;
      const row = { id: 100 + inserted.length, creator_id, source, kind, result, stage, inbound_text, inbound_at, send_at, status: 'pending' };
      inserted.push(row);
      return row;
    }
    return null;
  };
  let supersedes = 0;
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    if (/UPDATE scheduled_replies[\s\S]*'superseded'[\s\S]*RETURNING send_at/i.test(sql)) {
      supersedes++;
      // Only the first supersede finds the old row; it's gone after that.
      return { rows: supersedes === 1 && pendingSendAt ? [{ send_at: pendingSendAt }] : [] };
    }
    return { rows: [] };
  };
  db.many = async () => [];
  return { writes, inserted };
}

// ── Delay bounds ────────────────────────────────────────────────────────────

test('pickDelayMs stays within 5 min .. 60 min (minus dispatch slack) at the extremes and at random', () => {
  assert.strictEqual(replyPacing.pickDelayMs(() => 0), 5 * MIN);
  const top = replyPacing.pickDelayMs(() => 0.999999);
  assert.ok(top <= 60 * MIN - replyPacing.DISPATCH_SLACK_MS, 'top draw leaves headroom for the dispatcher');
  assert.ok(top > 57 * MIN);
  for (let i = 0; i < 2000; i++) {
    const d = replyPacing.pickDelayMs();
    assert.ok(d >= 5 * MIN && d + replyPacing.DISPATCH_SLACK_MS <= 60 * MIN, `delay ${d}ms out of bounds`);
  }
  // Out-of-range randomness is clamped, never widens the window.
  assert.strictEqual(replyPacing.pickDelayMs(() => -3), 5 * MIN);
  assert.ok(replyPacing.pickDelayMs(() => 7) <= 60 * MIN);
});

test('delays are actually spread across the window (not a fixed gap)', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(Math.floor(replyPacing.pickDelayMs() / (5 * MIN)));
  assert.ok(seen.size >= 8, `expected draws across many 5-minute buckets, got ${seen.size}`);
});

test('computeSendAt measures from the inbound arrival, not from when the reply was decided', () => {
  const inboundAt = new Date('2026-11-24T10:00:00Z');
  const now = new Date('2026-11-24T10:04:00Z'); // scheduler picked it up 4 min later
  const at = replyPacing.computeSendAt({ inboundAt, now, rand: () => 0 });
  assert.strictEqual(at.toISOString(), '2026-11-24T10:05:00.000Z');
  const late = replyPacing.computeSendAt({ inboundAt, now, rand: () => 0.999999 });
  assert.ok(late - inboundAt <= 60 * MIN);
});

test('computeSendAt falls back to now when the arrival time is unknown', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const at = replyPacing.computeSendAt({ inboundAt: null, now, rand: () => 0.5 });
  assert.ok(at - now >= 5 * MIN && at - now <= 60 * MIN);
});

test('a superseding message keeps the earlier send time when it is still >= 5 min after the new message', () => {
  const inboundAt = new Date('2026-11-24T10:10:00Z');
  const previousSendAt = new Date('2026-11-24T10:40:00Z');
  const at = replyPacing.computeSendAt({ inboundAt, previousSendAt, rand: () => 0 });
  assert.strictEqual(at.toISOString(), previousSendAt.toISOString());
});

test('a superseding message redraws when the earlier send time would land < 5 min after it', () => {
  const inboundAt = new Date('2026-11-24T10:10:00Z');
  const previousSendAt = new Date('2026-11-24T10:12:00Z'); // only 2 min after the new message
  const at = replyPacing.computeSendAt({ inboundAt, previousSendAt, rand: () => 0 });
  assert.strictEqual(at.toISOString(), '2026-11-24T10:15:00.000Z');
});

// ── Stale guard ────────────────────────────────────────────────────────────

test('staleReason: send only when nothing moved since the reply was decided', () => {
  const row = { stage: 'AWAITING_RATE', created_at: '2026-11-24T10:05:00Z' };
  const fresh = { ...baseCreator, latest_inbound_text: null, last_negotiation_email_at: '2026-11-24T09:00:00Z' };
  assert.strictEqual(replyPacing.staleReason(row, fresh), null);
  assert.strictEqual(replyPacing.staleReason(row, null), 'creator_missing');
  assert.strictEqual(replyPacing.staleReason(row, { ...fresh, status: 'stopped' }), 'stopped');
  assert.strictEqual(replyPacing.staleReason(row, { ...fresh, latest_inbound_text: 'one more thing' }), 'new_inbound');
  assert.strictEqual(replyPacing.staleReason(row, { ...fresh, negotiation_status: 'AWAITING_DECISION' }), 'stage_changed');
  assert.strictEqual(
    replyPacing.staleReason(row, { ...fresh, last_negotiation_email_at: '2026-11-24T10:20:00Z' }),
    'already_replied',
  );
  assert.strictEqual(
    replyPacing.staleReason(row, { ...fresh, delegated_at: '2026-11-24T10:20:00Z' }),
    'handed_to_human',
  );
  // An older hand-off (before the reply was decided) doesn't block it.
  assert.strictEqual(replyPacing.staleReason(row, { ...fresh, delegated_at: '2026-11-24T08:00:00Z' }), null);
});

// ── processReply / handleAcceptedReply scheduling ───────────────────────────

test('paced processReply parks the reply 5–60 min after the inbound instead of sending it', async () => {
  const inboundAt = new Date(Date.now() - 2 * MIN);
  const { writes, inserted } = install({
    ...baseCreator,
    latest_inbound_text: 'Is this Instagram only?',
    latest_inbound_at: inboundAt,
  });
  negotiation._setClient(fakeClientReturning(answer));
  try {
    const res = await negotiation.processReply(baseCreator.id, { pace: true });
    assert.strictEqual(res.action, 'answer_question');
    assert.ok(res.scheduled_for, 'returns the scheduled send time');
    assert.ok(!sent(writes), 'nothing is sent inline');
    assert.strictEqual(inserted.length, 1, 'one reply is scheduled');
    const row = inserted[0];
    assert.strictEqual(row.source, 'negotiation');
    assert.strictEqual(row.kind, 'reply_qa');
    assert.strictEqual(row.stage, 'AWAITING_RATE');
    assert.deepStrictEqual(row.result.email, answer.email, 'the drafted email is stored verbatim');
    assert.strictEqual(row.inbound_text, 'Is this Instagram only?');
    const gap = new Date(row.send_at) - inboundAt;
    assert.ok(gap >= 5 * MIN && gap <= 60 * MIN, `gap ${gap / MIN} min`);
    assert.ok(has(writes, /latest_inbound_text = NULL/i), 'the inbound is consumed so it is not re-processed');
    assert.ok(
      has(writes, /UPDATE scheduled_replies[\s\S]*'superseded'/i),
      'any older pending reply is superseded first',
    );
  } finally {
    restore();
  }
});

test('without pace, processReply still sends inline (direct callers unchanged)', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const { writes, inserted } = install({ ...baseCreator, latest_inbound_text: 'Is this Instagram only?' });
  negotiation._setClient(fakeClientReturning(answer));
  try {
    const res = await negotiation.processReply(baseCreator.id);
    assert.strictEqual(res.scheduled_for, undefined);
    assert.ok(sent(writes), 'sent immediately');
    assert.strictEqual(inserted.length, 0);
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('a new inbound while a reply is pending supersedes it and reschedules with the earlier slot when still valid', async () => {
  const inboundAt = new Date(Date.now() - 1 * MIN);
  const pendingSendAt = new Date(inboundAt.getTime() + 20 * MIN);
  const { inserted, writes } = install(
    { ...baseCreator, latest_inbound_text: 'Also — do you need TikTok too?', latest_inbound_at: inboundAt },
    { pendingSendAt },
  );
  negotiation._setClient(fakeClientReturning(answer));
  try {
    await negotiation.processReply(baseCreator.id, { pace: true });
    assert.ok(!sent(writes));
    assert.strictEqual(inserted.length, 1, 'exactly one replacement reply');
    assert.strictEqual(
      new Date(inserted[0].send_at).toISOString(),
      pendingSendAt.toISOString(),
      'keeps the earlier send time — still 5+ min after the new message',
    );
    assert.strictEqual(inserted[0].inbound_text, 'Also — do you need TikTok too?', 'answers the newer message');
  } finally {
    restore();
  }
});

test('a new inbound that needs a human supersedes the pending reply and schedules nothing', async () => {
  const { writes, inserted } = install(
    { ...baseCreator, latest_inbound_text: 'Who covers the bank fees?', latest_inbound_at: new Date() },
    { pendingSendAt: new Date(Date.now() + 10 * MIN) },
  );
  negotiation._setClient(fakeClientReturning({ understanding: 'payment terms', action: 'escalate' }));
  try {
    const res = await negotiation.processReply(baseCreator.id, { pace: true });
    assert.strictEqual(res.action, 'delegated');
    assert.ok(delegated(writes), 'handed off immediately — no pacing on hand-offs');
    assert.ok(has(writes, /UPDATE scheduled_replies[\s\S]*'superseded'/i), 'old pending reply superseded');
    assert.strictEqual(inserted.length, 0);
    assert.ok(!sent(writes));
  } finally {
    restore();
  }
});

test('a rate quote (no email) is applied immediately even when paced', async () => {
  const { writes, inserted } = install({
    ...baseCreator,
    latest_inbound_text: 'My rate is $800 per video',
    latest_inbound_at: new Date(),
  });
  negotiation._setClient(
    fakeClientReturning({ understanding: 'rate', action: 'shared_rate', quoted_rate: 800, email: null, send_now: false }),
  );
  try {
    await negotiation.processReply(baseCreator.id, { pace: true });
    assert.strictEqual(inserted.length, 0);
    assert.ok(has(writes, /negotiation_status = 'AWAITING_APPROVAL'/i), 'stage moves right away');
  } finally {
    restore();
  }
});

test('paced handleAcceptedReply parks a post-acceptance answer', async () => {
  const { writes, inserted } = install({
    ...baseCreator,
    negotiation_status: 'ACCEPTED',
    latest_inbound_text: 'Quick one — Instagram only?',
    latest_inbound_at: new Date(),
  });
  negotiation._setClient(fakeClientReturning(answer));
  try {
    const res = await negotiation.handleAcceptedReply(baseCreator.id, { pace: true });
    assert.strictEqual(res.action, 'answer_question');
    assert.ok(res.scheduled_for);
    assert.ok(!sent(writes));
    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(inserted[0].source, 'accepted');
    assert.strictEqual(inserted[0].stage, 'ACCEPTED');
  } finally {
    restore();
  }
});

// ── Dispatch ───────────────────────────────────────────────────────────────

function dispatchStubs(creator) {
  const writes = [];
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? (creator ? { ...creator } : null) : null);
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  return writes;
}

const dueRow = {
  id: 501,
  creator_id: baseCreator.id,
  source: 'negotiation',
  kind: 'reply_qa',
  result: { ...answer },
  stage: 'AWAITING_RATE',
  inbound_text: 'Is this Instagram only?',
  created_at: '2026-11-24T10:05:00Z',
  attempts: 1,
};
const freshCreator = { ...baseCreator, latest_inbound_text: null, last_negotiation_email_at: '2026-11-24T09:00:00Z' };

test('a due reply is sent with the stored email and marked sent', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = dispatchStubs(freshCreator);
  try {
    const r = await negotiation.sendScheduledReply(dueRow);
    assert.deepStrictEqual(r, { sent: true });
    const ev = writes.find((w) => /'sent_negotiation'/i.test(w.sql));
    assert.ok(ev, 'the email goes out');
    assert.strictEqual(ev.params[1].kind, 'reply_qa');
    assert.ok(has(writes, /SET status = 'sent'/i));
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

for (const [label, creator, reason] of [
  ['a newer inbound arrived', { ...freshCreator, latest_inbound_text: 'wait, one more question' }, 'new_inbound'],
  ['the team replied first', { ...freshCreator, last_negotiation_email_at: '2026-11-24T10:30:00Z' }, 'already_replied'],
  ['the stage moved on', { ...freshCreator, negotiation_status: 'AWAITING_DECISION' }, 'stage_changed'],
  ['outreach was stopped', { ...freshCreator, status: 'stopped' }, 'stopped'],
]) {
  test(`a due reply is dropped, not sent, when ${label}`, async () => {
    const writes = dispatchStubs(creator);
    try {
      const r = await negotiation.sendScheduledReply(dueRow);
      assert.deepStrictEqual(r, { cancelled: reason });
      assert.ok(!sent(writes), 'nothing is sent');
      const mark = writes.find((w) => /UPDATE scheduled_replies SET status = \$2/i.test(w.sql));
      assert.ok(mark);
      assert.strictEqual(mark.params[1], reason === 'new_inbound' ? 'superseded' : 'cancelled');
      assert.strictEqual(mark.params[2], reason);
    } finally {
      restore();
    }
  });
}

test('a send failure is retried, and handed to a human after the last attempt', async () => {
  const prevDryRun = process.env.DRY_RUN;
  delete process.env.DRY_RUN; // real send path; no reply uuid → throws
  const creator = { ...freshCreator, instantly_reply_uuid: null };
  try {
    let writes = dispatchStubs(creator);
    let r = await negotiation.sendScheduledReply({ ...dueRow, attempts: 1 });
    assert.deepStrictEqual(r, { failed: true, retry: true });
    const retry = writes.find((w) => /last_error/i.test(w.sql));
    assert.strictEqual(retry.params[1], 'pending');
    assert.ok(!delegated(writes));

    writes = dispatchStubs(creator);
    r = await negotiation.sendScheduledReply({ ...dueRow, attempts: replyPacing.MAX_ATTEMPTS });
    assert.deepStrictEqual(r, { failed: true, retry: false });
    assert.strictEqual(writes.find((w) => /last_error/i.test(w.sql)).params[1], 'failed');
    assert.ok(delegated(writes), 'the creator message reaches a human');
  } finally {
    if (prevDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

test('dispatchDueReplies claims due rows atomically (skipping creators with an unprocessed inbound) and sends them', async () => {
  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = dispatchStubs(freshCreator);
  let claimSql = null;
  db.many = async (sql) => {
    if (/UPDATE scheduled_replies sr[\s\S]*status = 'sending'/i.test(sql)) {
      claimSql = sql;
      return [dueRow];
    }
    return [];
  };
  try {
    const r = await negotiation.dispatchDueReplies();
    assert.deepStrictEqual(r, { sent: 1, cancelled: 0, failed: 0 });
    assert.match(claimSql, /send_at <= NOW\(\)/);
    assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claimSql, /latest_inbound_text IS NOT NULL/);
    assert.ok(sent(writes));
  } finally {
    process.env.DRY_RUN = prevDryRun;
    restore();
  }
});

// ── Scheduler wiring ───────────────────────────────────────────────────────

test('the scheduler runs automated replies paced', async () => {
  const origProcess = negotiation.processReply;
  const origAccepted = negotiation.handleAcceptedReply;
  const calls = [];
  db.many = async (sql) => {
    if (/status = 'replied' AND negotiation_status IS NULL/i.test(sql)) return [{ id: 1 }];
    if (/negotiation_status = 'ACCEPTED' AND latest_inbound_text IS NOT NULL/i.test(sql)) return [{ id: 2 }];
    return [];
  };
  negotiation.processReply = async (id, opts) => calls.push(['process', id, opts]);
  negotiation.handleAcceptedReply = async (id, opts) => calls.push(['accepted', id, opts]);
  try {
    await scheduler.pollNegotiations();
    assert.deepStrictEqual(calls, [
      ['process', 1, { pace: true }],
      ['accepted', 2, { pace: true }],
    ]);
  } finally {
    negotiation.processReply = origProcess;
    negotiation.handleAcceptedReply = origAccepted;
    restore();
  }
});

// ── Dashboard ──────────────────────────────────────────────────────────────

test('attachScheduledReplies tags rows with their pending reply, and never breaks the list on error', async () => {
  db.many = async () => [{ creator_id: 1, send_at: '2026-11-24T10:30:00Z', kind: 'reply1', action: 'asking_details' }];
  try {
    const rows = [{ id: 1 }, { id: 2 }];
    await replyPacing.attachScheduledReplies(rows);
    assert.deepStrictEqual(rows[0].scheduled_reply, {
      send_at: '2026-11-24T10:30:00Z',
      kind: 'reply1',
      action: 'asking_details',
    });
    assert.strictEqual(rows[1].scheduled_reply, null);

    db.many = async () => {
      throw new Error('relation "scheduled_replies" does not exist');
    };
    const rows2 = [{ id: 1 }];
    await replyPacing.attachScheduledReplies(rows2);
    assert.strictEqual(rows2[0].scheduled_reply, null);
  } finally {
    restore();
  }
});
