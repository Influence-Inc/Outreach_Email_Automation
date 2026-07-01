'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const replyLearning = require('./replyLearning');
const replyExamples = require('./replyExamples');
const instantly = require('./instantly');

function fakeClientReturning(jsonStr) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: jsonStr }] }),
    },
  };
}

function memoryStore() {
  const inserted = [];
  const events = [];
  return {
    inserted,
    events,
    insert: async (ex) => {
      inserted.push(ex);
      return true;
    },
    existingIds: async () => new Set(),
    logEvent: async (creatorId, detail) => {
      events.push({ creatorId, detail });
    },
  };
}

function resetHooks() {
  replyLearning._setClient(undefined);
  replyLearning._setStore(null);
  delete process.env.LEARN_FROM_DELEGATE;
}

// ── normalizeInstantlyEmail ─────────────────────────────────────────────────

test('normalizeInstantlyEmail extracts defensively from varying field names', () => {
  const e = replyLearning.normalizeInstantlyEmail({
    id: 'm1',
    thread_id: 't1',
    from_address_email: 'Creator Name <creator@example.com>',
    subject: 'Re: collab',
    timestamp_email: '2026-06-01T10:00:00Z',
    body: { html: '<p>Hey there!<br>Sounds great.</p>' },
    eaccount: 'jennifer@useinfluence.xyz',
  });
  assert.strictEqual(e.id, 'm1');
  assert.strictEqual(e.threadId, 't1');
  assert.strictEqual(e.from, 'creator@example.com', 'bare address extracted from display form');
  assert.ok(e.text.includes('Sounds great'), 'html body converted to text');
  assert.strictEqual(e.eaccount, 'jennifer@useinfluence.xyz');
  assert.ok(e.ts > 0, 'timestamp parsed');
});

test('normalizeInstantlyEmail strips quoted reply history', () => {
  const e = replyLearning.normalizeInstantlyEmail({
    id: 'm2',
    thread_id: 't1',
    from_email: 'creator@example.com',
    timestamp_created: '2026-06-01T10:00:00Z',
    body: { text: 'My rate is $900.\n\nOn Mon, Jun 1, 2026 Jennifer wrote:\n> earlier message' },
  });
  assert.strictEqual(e.text, 'My rate is $900.');
});

// ── pairEmailsInThread ──────────────────────────────────────────────────────

function mail(id, from, ts, text, extra = {}) {
  return {
    id,
    threadId: 't1',
    from,
    subject: 'Re: collab',
    ts,
    text,
    eaccount: 'jennifer@useinfluence.xyz',
    ...extra,
  };
}

test('pairEmailsInThread pairs each creator message with the NEXT manager reply', () => {
  const senders = new Set(['jennifer@useinfluence.xyz']);
  const pairs = replyLearning.pairEmailsInThread(
    [
      mail('o1', 'jennifer@useinfluence.xyz', 1, 'Hi! Interested in a collab?'),
      mail('i1', 'creator@example.com', 2, 'Yes! Tell me more'),
      mail('o2', 'jennifer@useinfluence.xyz', 3, 'Here are the details…'),
      mail('i2', 'creator@example.com', 4, 'My rate is $800'),
      // no manager reply to i2 yet → i2 stays unpaired
    ],
    senders,
  );
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].inboundId, 'i1');
  assert.strictEqual(pairs[0].outboundId, 'o2');
  assert.strictEqual(pairs[0].inbound, 'Yes! Tell me more');
  assert.strictEqual(pairs[0].outbound, 'Here are the details…');
});

test('pairEmailsInThread detects direction via the per-email eaccount field too', () => {
  // No SENDER_EMAIL configured — from === eaccount marks the manager's mail.
  const pairs = replyLearning.pairEmailsInThread(
    [
      mail('i1', 'creator@example.com', 1, 'what platform is this for?'),
      mail('o1', 'jennifer@useinfluence.xyz', 2, 'Instagram Reels only.'),
    ],
    new Set(),
  );
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].outboundId, 'o1');
});

test('pairEmailsInThread skips pairs with empty bodies', () => {
  const senders = new Set(['jennifer@useinfluence.xyz']);
  const pairs = replyLearning.pairEmailsInThread(
    [
      mail('i1', 'creator@example.com', 1, ''),
      mail('o1', 'jennifer@useinfluence.xyz', 2, 'Hello?'),
    ],
    senders,
  );
  assert.strictEqual(pairs.length, 0);
});

// ── learnFromHumanReply (the Delegate-window feed) ──────────────────────────

test('learnFromHumanReply labels and stores a delegate example', async (t) => {
  t.after(resetHooks);
  const store = memoryStore();
  replyLearning._setStore(store);
  replyLearning._setClient(
    fakeClientReturning(
      JSON.stringify({
        action: 'answer_question',
        quoted_rate: null,
        stage: 'AWAITING_RATE',
        skip: false,
        notes: 'Creator asked about payment timing.',
      }),
    ),
  );

  const res = await replyLearning.learnFromHumanReply({
    creator: { id: 42, email: 'creator@example.com' },
    inbound: 'How and when do I get paid?',
    outbound: { subject: 'Re: collab', body: 'We pay via wire within 7 days of the post going live. - Jennifer' },
    stage: 'AWAITING_RATE',
  });

  assert.strictEqual(res.learned, true);
  assert.strictEqual(store.inserted.length, 1);
  const ex = store.inserted[0];
  assert.strictEqual(ex.source, 'delegate');
  assert.ok(ex.id.startsWith('delegate_42_'), `id has the delegate prefix: ${ex.id}`);
  assert.strictEqual(ex.expected_action, 'answer_question');
  assert.strictEqual(ex.stage, 'AWAITING_RATE');
  assert.strictEqual(ex.creator_id, 42);
  assert.ok(ex.outbound_body.includes('wire within 7 days'));
  // Timeline breadcrumb logged for the dashboard.
  assert.strictEqual(store.events.length, 1);
  assert.strictEqual(store.events[0].detail.action, 'answer_question');
});

test('learnFromHumanReply skips replies the labeler flags (priced offers)', async (t) => {
  t.after(resetHooks);
  const store = memoryStore();
  replyLearning._setStore(store);
  replyLearning._setClient(
    fakeClientReturning(JSON.stringify({ action: 'answer_question', skip: true, notes: 'contains an offer' })),
  );

  const res = await replyLearning.learnFromHumanReply({
    creator: { id: 7 },
    inbound: 'what can you offer?',
    outbound: { subject: 'Re: collab', body: 'We can do $1,500 for 2 videos.' },
  });
  assert.strictEqual(res.skipped, 'offer or non-exchange');
  assert.strictEqual(store.inserted.length, 0);
});

test('learnFromHumanReply never stores when the labeler fails or returns junk', async (t) => {
  t.after(resetHooks);
  const store = memoryStore();
  replyLearning._setStore(store);

  replyLearning._setClient(fakeClientReturning('not json at all'));
  let res = await replyLearning.learnFromHumanReply({
    creator: { id: 7 },
    inbound: 'hello',
    outbound: { body: 'hi there' },
  });
  assert.strictEqual(res.skipped, 'label failed');

  replyLearning._setClient(fakeClientReturning(JSON.stringify({ action: 'made_up_action' })));
  res = await replyLearning.learnFromHumanReply({
    creator: { id: 7 },
    inbound: 'hello',
    outbound: { body: 'hi there' },
  });
  assert.ok(String(res.skipped).includes('unknown action'));
  assert.strictEqual(store.inserted.length, 0);
});

test('learnFromHumanReply honors the LEARN_FROM_DELEGATE=0 kill-switch', async (t) => {
  t.after(resetHooks);
  process.env.LEARN_FROM_DELEGATE = '0';
  const store = memoryStore();
  replyLearning._setStore(store);
  replyLearning._setClient(fakeClientReturning(JSON.stringify({ action: 'answer_question', skip: false })));

  const res = await replyLearning.learnFromHumanReply({
    creator: { id: 7 },
    inbound: 'hello',
    outbound: { body: 'hi there' },
  });
  assert.strictEqual(res.skipped, 'disabled');
  assert.strictEqual(store.inserted.length, 0);
});

test('learnFromHumanReply skips silently when there is no delegate question', async (t) => {
  t.after(resetHooks);
  const store = memoryStore();
  replyLearning._setStore(store);
  const res = await replyLearning.learnFromHumanReply({
    creator: { id: 7 },
    inbound: null, // e.g. admin replied without a stored delegate_question
    outbound: { body: 'hi there' },
  });
  assert.strictEqual(res.skipped, 'missing text');
  assert.strictEqual(store.inserted.length, 0);
});

// ── harvestInbox (the Instantly mailbox feed) ───────────────────────────────

test('harvestInbox pages the mailbox, pairs threads, labels, and stores keepers', async (t) => {
  const origListEmails = instantly.listEmails;
  const origKey = process.env.INSTANTLY_API_KEY;
  const origSender = process.env.SENDER_EMAIL;
  t.after(() => {
    instantly.listEmails = origListEmails;
    if (origKey == null) delete process.env.INSTANTLY_API_KEY;
    else process.env.INSTANTLY_API_KEY = origKey;
    if (origSender == null) delete process.env.SENDER_EMAIL;
    else process.env.SENDER_EMAIL = origSender;
    resetHooks();
  });

  process.env.INSTANTLY_API_KEY = 'test-key';
  process.env.SENDER_EMAIL = 'jennifer@useinfluence.xyz';

  // Two pages: thread t1 is a clean Q→A exchange, thread t2's reply is a
  // priced offer the labeler must drop.
  const page1 = {
    items: [
      {
        id: 'o1',
        thread_id: 't1',
        from_address_email: 'jennifer@useinfluence.xyz',
        timestamp_email: '2026-06-01T10:00:00Z',
        subject: 'Collab',
        body: { text: 'Hi! Interested in a paid collab?' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
      {
        id: 'i1',
        thread_id: 't1',
        from_address_email: 'creator@example.com',
        timestamp_email: '2026-06-01T11:00:00Z',
        subject: 'Re: Collab',
        body: { text: 'Is this Instagram only or also TikTok?' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
    ],
    next_starting_after: 'cursor-1',
  };
  const page2 = {
    items: [
      {
        id: 'o2',
        thread_id: 't1',
        from_address_email: 'jennifer@useinfluence.xyz',
        timestamp_email: '2026-06-01T12:00:00Z',
        subject: 'Re: Collab',
        body: { text: 'Instagram Reels only for this campaign. - Jennifer' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
      {
        id: 'i2',
        thread_id: 't2',
        from_address_email: 'other@example.com',
        timestamp_email: '2026-06-01T13:00:00Z',
        subject: 'Re: Collab',
        body: { text: 'what is your budget?' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
      {
        id: 'o3',
        thread_id: 't2',
        from_address_email: 'jennifer@useinfluence.xyz',
        timestamp_email: '2026-06-01T14:00:00Z',
        subject: 'Re: Collab',
        body: { text: 'We can do $1,500 for 2 videos.' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
    ],
    next_starting_after: null,
  };
  const pages = [page1, page2];
  instantly.listEmails = async () => pages.shift() || { items: [] };

  // The fake labeler keeps clean exchanges and skips priced offers.
  replyLearning._setClient({
    messages: {
      create: async ({ messages }) => {
        const text = messages[0].content;
        const isOffer = /\$\s?[\d,]+/.test(text.split('MANAGER REPLY')[1] || '');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'answer_question',
                quoted_rate: null,
                stage: null,
                skip: isOffer,
                notes: isOffer ? 'offer email' : 'platform question',
              }),
            },
          ],
        };
      },
    },
  });

  const store = memoryStore();
  replyLearning._setStore(store);

  const summary = await replyLearning.harvestInbox({ maxEmails: 10, log: () => {} });

  assert.strictEqual(summary.scanned, 5);
  assert.strictEqual(summary.threads, 2);
  assert.strictEqual(summary.candidates, 2);
  assert.strictEqual(summary.kept, 1, 'only the clean Q→A pair is stored');
  assert.strictEqual(summary.skippedOffer, 1, 'the priced-offer reply is dropped');
  assert.strictEqual(store.inserted.length, 1);
  const ex = store.inserted[0];
  assert.strictEqual(ex.id, 'harvest_t1_i1');
  assert.strictEqual(ex.source, 'harvest');
  assert.ok(ex.outbound_body.includes('Instagram Reels only'));
});

test('harvestInbox skips already-learned pairs without labeling them again', async (t) => {
  const origListEmails = instantly.listEmails;
  const origKey = process.env.INSTANTLY_API_KEY;
  t.after(() => {
    instantly.listEmails = origListEmails;
    if (origKey == null) delete process.env.INSTANTLY_API_KEY;
    else process.env.INSTANTLY_API_KEY = origKey;
    resetHooks();
  });
  process.env.INSTANTLY_API_KEY = 'test-key';

  instantly.listEmails = async () => ({
    items: [
      {
        id: 'i1',
        thread_id: 't1',
        from_address_email: 'creator@example.com',
        timestamp_email: '2026-06-01T10:00:00Z',
        body: { text: 'question?' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
      {
        id: 'o1',
        thread_id: 't1',
        from_address_email: 'jennifer@useinfluence.xyz',
        timestamp_email: '2026-06-01T11:00:00Z',
        body: { text: 'answer.' },
        eaccount: 'jennifer@useinfluence.xyz',
      },
    ],
    next_starting_after: null,
  });

  let labelCalls = 0;
  replyLearning._setClient({
    messages: {
      create: async () => {
        labelCalls += 1;
        return { content: [{ type: 'text', text: '{"action":"answer_question","skip":false}' }] };
      },
    },
  });
  const store = memoryStore();
  store.existingIds = async () => new Set(['harvest_t1_i1']); // learned on a prior sweep
  replyLearning._setStore(store);

  const summary = await replyLearning.harvestInbox({ maxEmails: 10, log: () => {} });
  // The stub re-serves the same page with no cursor — the collector must
  // dedupe and stop instead of re-scanning it until the cap.
  assert.strictEqual(summary.scanned, 2);
  assert.strictEqual(summary.alreadyKnown, 1);
  assert.strictEqual(summary.kept, 0);
  assert.strictEqual(labelCalls, 0, 'no Claude spend on already-learned pairs');
});
