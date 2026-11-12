'use strict';

// Run with: npm test  (node --test)
//
// "Write your own email" — the fourth option beside the three offer
// structures. Guards:
//   1. A composed email WITH a fee is an offer: atomic claim to
//      AWAITING_DECISION, a 'composed' custom_offer, a 'rate_offer_sent' with
//      that fee, the pending inbound consumed.
//   2. WITHOUT a fee it's a reply: stage untouched, 'sent_composed_email'
//      logged, the "Decide offer" flag snoozed until the creator answers.
//   3. A lost claim (already sent / wrong stage) sends nothing.
//   4. The HTML the creator receives and the markdown Claude reads both come
//      from the sanitised email; the stored thread keeps both.
//   5. Claude takes it in: the stored thread — with the account manager's own
//      emails labelled — reaches the reply classifier's prompt.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const instantly = require('./instantly');
const negotiation = require('./negotiation');

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;
const origReply = instantly.replyToEmail;

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  instantly.replyToEmail = origReply;
  negotiation._setClient(null);
}

const baseCreator = {
  id: 9,
  first_name: 'Sam',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-9',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Re: Paid Partnership with Reve',
  instantly_reply_cc: '',
  email: 'sam@example.com',
  negotiation_status: 'AWAITING_APPROVAL',
  quoted_rate: 6000,
  latest_inbound_text: 'My rate is $6,000 for two reels.',
};

const HTML =
  '<p>Hi Sam,</p><p>Thanks for the rate! <b>We can do $4,500</b> for two Reels, posted by <i>Dec 1</i>.</p>' +
  '<ul><li>Full creative freedom</li><li>No exclusivity</li></ul><p>- Jennifer</p><script>x()</script>';

function harness(creator, { claim = true } = {}) {
  const writes = [];
  const sent = [];
  db.one = async (sql, params) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    if (/INSERT INTO email_messages/i.test(sql)) {
      writes.push({ sql, params });
      return { id: 1 };
    }
    if (/negotiation_status = 'AWAITING_DECISION'/i.test(sql) && /RETURNING id/i.test(sql)) {
      writes.push({ sql, params });
      return claim ? { id: creator.id } : null;
    }
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  instantly.replyToEmail = async (args) => {
    sent.push(args);
    return { id: 'sent-1' };
  };
  return { writes, sent };
}

test('a composed email with a fee is sent as an offer', async () => {
  const prev = process.env.DRY_RUN;
  delete process.env.DRY_RUN; // exercise the real Instantly payload (stubbed)
  const { writes, sent } = harness(baseCreator);
  try {
    const res = await negotiation.sendComposedEmail(baseCreator.id, { html: HTML, fee: '4500' });
    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.offer, true);
    assert.strictEqual(res.fee, 4500);
    assert.strictEqual(res.terms.model, 'flat', 'the legacy `fee` field reads as flat-fee terms');

    const claim = writes.find((w) => /AWAITING_DECISION/.test(w.sql) && /RETURNING id/.test(w.sql));
    assert.ok(claim, 'atomic claim to AWAITING_DECISION');
    const offer = JSON.parse(claim.params[2]);
    assert.strictEqual(offer.offer_type, 'composed');
    assert.strictEqual(offer.flat_fee, 4500);

    assert.strictEqual(sent.length, 1, 'exactly one email goes out');
    assert.strictEqual(sent[0].replyToUuid, 'uuid-9', 'threaded on the creator reply');
    assert.strictEqual(sent[0].subject, 'Re: Paid Partnership with Reve', 'keeps the thread subject');
    assert.match(sent[0].html, /<b>We can do \$4,500<\/b>/);
    assert.match(sent[0].html, /<ul style=/, 'email html carries inline styles');
    assert.doesNotMatch(sent[0].html, /script/);
    assert.doesNotMatch(sent[0].text, /\*\*|<b>/, 'plain-text part has no markup');

    const stored = writes.find((w) => /INSERT INTO email_messages/.test(w.sql));
    assert.ok(stored, 'stored in the conversation thread');
    assert.strictEqual(stored.params[2], 'composed_offer');
    assert.match(stored.params[4], /\*\*We can do \$4,500\*\*/, 'markdown copy for Claude');
    assert.match(stored.params[4], /- Full creative freedom/);
    assert.match(stored.params[5], /<b>We can do/, 'sanitised html kept for display');

    const logged = writes.find((w) => /'rate_offer_sent'/.test(w.sql));
    assert.ok(logged, 'the fee is booked on the rate timeline');
    assert.strictEqual(logged.params[1].fee, 4500);
    assert.strictEqual(logged.params[1].source, 'composed');

    const consumed = writes.find((w) => /IS NOT DISTINCT FROM/.test(w.sql) && /needs_human\s*=\s*FALSE/.test(w.sql));
    assert.ok(consumed, 'the pending inbound is consumed so no auto-reply follows');
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('a composed email without a fee is a reply: stage untouched, flag snoozed', async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const { writes } = harness(baseCreator);
  try {
    const res = await negotiation.sendComposedEmail(baseCreator.id, {
      html: '<p>Quick one — is the $6,000 for one Reel or two?</p>',
      fee: '',
    });
    assert.deepStrictEqual(res, { sent: true, offer: false });
    assert.ok(!writes.some((w) => /AWAITING_DECISION/.test(w.sql)), 'no stage change');
    assert.ok(!writes.some((w) => /'rate_offer_sent'/.test(w.sql)), 'no offer logged');
    assert.ok(writes.some((w) => /'sent_composed_email'/.test(w.sql)), 'reply logged for the timeline');
    assert.ok(writes.some((w) => /flag_dismissed_fp\s*=\s*md5/.test(w.sql)), 'Decide-offer flag snoozed');
    const stored = writes.find((w) => /INSERT INTO email_messages/.test(w.sql));
    assert.strictEqual(stored.params[2], 'composed_reply');
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('a lost claim sends nothing and says why', async () => {
  const prev = process.env.DRY_RUN;
  delete process.env.DRY_RUN;
  const { writes, sent } = harness({ ...baseCreator, negotiation_status: 'AWAITING_DECISION' }, { claim: false });
  try {
    await assert.rejects(
      negotiation.sendComposedEmail(baseCreator.id, { html: HTML, fee: 4500 }),
      (err) => err.status === 409 && /not awaiting an offer/.test(err.message),
    );
    assert.strictEqual(sent.length, 0);
    assert.ok(!writes.some((w) => /INSERT INTO email_messages/.test(w.sql)));
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('empty email, bad fee and missing thread are refused before anything is written', async () => {
  const prev = process.env.DRY_RUN;
  delete process.env.DRY_RUN;
  const { writes, sent } = harness({ ...baseCreator, instantly_reply_uuid: null });
  try {
    await assert.rejects(negotiation.sendComposedEmail(9, { html: '<p><br></p>' }), (e) => e.status === 400);
    await assert.rejects(negotiation.sendComposedEmail(9, { html: '<p>hi</p>', fee: '-5' }), (e) => e.status === 400);
    await assert.rejects(negotiation.sendComposedEmail(9, { html: '<p>hi</p>' }), (e) => e.status === 409);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(writes.length, 0);
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('the hand-off reply box can send formatted html too', async () => {
  const prev = process.env.DRY_RUN;
  delete process.env.DRY_RUN;
  const { writes, sent } = harness({ ...baseCreator, needs_human: true, delegate_question: 'Can I post on TikTok too?' });
  try {
    await negotiation.sendDelegateReply(9, { html: '<p>Instagram <b>only</b> for this one.</p>' });
    assert.match(sent[0].html, /<b>only<\/b>/);
    const stored = writes.find((w) => /INSERT INTO email_messages/.test(w.sql));
    assert.strictEqual(stored.params[2], 'delegate_reply');
    assert.strictEqual(stored.params[4], 'Instagram **only** for this one.');
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('conversationContext labels the account manager’s own emails and drops the new inbound', async () => {
  db.many = async () => [
    { direction: 'outbound', kind: 'reply1', body: 'Here are the details. What is your rate?' },
    { direction: 'inbound', kind: null, body: 'My rate is $6,000.' },
    { direction: 'outbound', kind: 'composed_offer', body: 'We can do **$4,500** for two Reels.' },
    { direction: 'inbound', kind: null, body: 'Sounds good!' },
  ];
  try {
    const t = await negotiation.conversationContext({ id: 9 });
    assert.match(t, /\[MANAGER\]\nHere are the details/);
    assert.match(t, /\[MANAGER — written personally by our account manager\]\nWe can do \*\*\$4,500\*\*/);
    assert.doesNotMatch(t, /Sounds good/, 'the message being answered is not repeated as history');
  } finally {
    restore();
  }
});

test('the reply classifier sees the conversation, including the composed offer', async () => {
  let system = '';
  negotiation._setClient({
    messages: {
      create: async (req) => {
        system = req.system;
        return { content: [{ type: 'text', text: '{"understanding":"accepts","action":"accepted","quoted_rate":null,"email":{"subject":"s","body":"b"},"send_now":true}' }] };
      },
    },
  });
  try {
    const ctx = negotiation.ctxFor(
      { ...baseCreator, negotiation_status: 'AWAITING_DECISION' },
      {
        approvedOffer: { offer_type: 'composed', flat_fee: 4500, label: 'Offer in your own email' },
        conversation: '[MANAGER — written personally by our account manager]\nWe can do **$4,500** for two Reels.',
      },
    );
    const res = await negotiation.handleCreatorReply({ id: 9 }, 'Sounds good, let’s do it!', ctx);
    assert.strictEqual(res.action, 'accepted');
    const sys = typeof system === 'string' ? system : JSON.stringify(system);
    assert.match(sys, /CONVERSATION SO FAR/);
    assert.match(sys, /written personally by our account manager/);
    assert.match(sys, /We can do \*\*\$4,500\*\*/);
    assert.match(sys, /"offer_type":"composed"/);
  } finally {
    restore();
  }
});
