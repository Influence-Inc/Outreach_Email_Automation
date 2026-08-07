'use strict';

// Run with: npm test  (node --test)
//
// End-to-end guard on the greeting, at the layer that actually reaches Claude:
// the system prompt and the user message. salutation.test.js proves the name
// resolves correctly in isolation; these tests prove every send path carries
// that name into the prompt, and that the prompt cannot re-derive a different
// one from the quoted thread.
//
// The bug being pinned: a reply from the creator Kam went out addressed
// "Hi Jennifer," (our own manager) and referred to Kam in the third person
// ("Thanks for Kam's kind words") — both because the sender name was read out of
// the quoted copy of our own email at the bottom of his reply.
const test = require('node:test');
const assert = require('node:assert');
const negotiation = require('./negotiation');
const templates = require('./negotiationTemplates');

function fakeClaude(capture) {
  return {
    messages: {
      create: async (args) => {
        capture.system = args.system;
        capture.messages = args.messages;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                understanding: 'ok',
                action: 'answer_question',
                quoted_rate: null,
                email: { subject: 'Re: test', body: 'BODY' },
                send_now: true,
              }),
            },
          ],
        };
      },
    },
  };
}

const KAM_REPLY = [
  'Hi Jennifer,',
  '',
  'Thanks for the detailed response! I am happy with the $5,000 figure.',
  '',
  'Is the agreement still for both Instagram and TikTok, or Instagram only?',
  '',
  'Best,',
  '',
  'Kam',
  '',
  'On Thu, 06 Aug 2026 22:21:16 +0000, Jennifer Max <jennifer@frominfluence.com> wrote:',
  '',
  'Hi Kam,',
  '',
  'Thank you for sharing your platform preferences — that makes total sense.',
  '',
  'Would love to make this happen, Kam — let me know your thoughts! :)',
  '',
  '- Jennifer',
].join('\n');

const kam = {
  id: 1,
  first_name: 'Kam',
  email: 'kam@gmail.com',
  brand_name: 'Reve',
  campaign_name: null,
  max_cpm: 15,
  negotiation_status: 'AWAITING_DECISION',
  ig_scraped_data: null,
  usage_rights_policy: 'no_rights',
  latest_inbound_text: KAM_REPLY,
  latest_inbound_from_email: 'kam@gmail.com',
};

async function classify(creator, replyText) {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator, negotiation.greetingCtx(creator, replyText));
    await negotiation.handleCreatorReply(creator, replyText, ctx);
  } finally {
    negotiation._setClient(null);
  }
  return capture;
}

// The greeting instruction specifically — the creator's own words are quoted
// into some prompts and legitimately open "Hi Jennifer,", so a bare search for
// that string across the whole prompt would match their text, not an order.
const greetingOrder = (system) => (system.match(/Open with EXACTLY "Hi [^"]*"/) || [])[0];

test('the reply prompt greets the creator, never our own manager name', async () => {
  const capture = await classify(kam, KAM_REPLY);
  assert.strictEqual(greetingOrder(capture.system), 'Open with EXACTLY "Hi Kam,"');
  assert.ok(
    capture.system.includes('"Hi Kam,"') && !capture.system.includes('"Hi Jennifer,"'),
    'prompt must never instruct a greeting with our own manager name',
  );
});

test('the reply prompt keeps the creator in the second person', async () => {
  const capture = await classify(kam, KAM_REPLY);
  assert.ok(
    /never in the third person/i.test(capture.system),
    'prompt should forbid third-person phrasing when writing to the creator',
  );
  assert.ok(
    !/on .*Kam.*'s behalf/i.test(capture.system),
    'prompt must not claim someone is writing on the creator\'s behalf',
  );
});

test('the quoted thread reaches Claude labelled as our own earlier email', async () => {
  const capture = await classify(kam, KAM_REPLY);
  const content = capture.messages[capture.messages.length - 1].content;
  assert.ok(/THE NEW MESSAGE THEY JUST SENT/.test(content), 'the new message should be marked off');
  assert.ok(/QUOTED EARLIER THREAD/.test(content), 'the quoted history should be marked off');
  // The terms discussed earlier are still available to the classifier…
  assert.ok(content.includes('platform preferences'), 'quoted context should be preserved');
  // …but the new message half must not contain our sign-off.
  const newHalf = content.split('QUOTED EARLIER THREAD')[0];
  assert.ok(!/- Jennifer/.test(newHalf), 'our sign-off must not sit in the new-message half');
});

test('a message with no quoted history is passed through unchanged', async () => {
  const plain = 'Sounds great, tell me more!';
  const capture = await classify({ ...kam, latest_inbound_text: plain }, plain);
  assert.strictEqual(capture.messages[capture.messages.length - 1].content, plain);
});

test('a poisoned cached salutation no longer reaches the offer prompt', async () => {
  // Once "Jennifer" had been written to creators.reply_salutation it was
  // preferred over re-detection on every later send — including the extension's
  // "Draft with AI" — so one bad reply kept mis-addressing the whole thread.
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const poisoned = { ...kam, reply_salutation: 'Jennifer', reply_is_delegate: true };
    const ctx = negotiation.ctxFor(poisoned);
    assert.strictEqual(ctx.salutation, 'Kam');
    await negotiation.draftOfferEmail(
      poisoned,
      { offer_id: 'x', offer_type: 'flat', flat_fee: 5000, num_videos: 1 },
      ctx,
      {},
    );
  } finally {
    negotiation._setClient(null);
  }
  assert.strictEqual(greetingOrder(capture.system), 'Open with EXACTLY "Hi Kam,"');
});

test('the Claude-unavailable heuristic reads the new message, not our quoted email', async () => {
  // Our REPLY 1 body contains "great", "keen" and "sounds good" — every one of
  // them trips the heuristic's "interested" test. Quoted under a creator's
  // decline, our own enthusiasm used to cancel it out (`declined && !interested`)
  // and the reply was classified as interested instead.
  const reply = [
    "We'll pass on this one.",
    '',
    '- Kam',
    '',
    'On Thu, 06 Aug 2026 22:21:16 +0000, Jennifer Max <jennifer@frominfluence.com> wrote:',
    '',
    templates.REPLY1_BODY,
  ].join('\n');
  negotiation._setClient(null); // no client → callClaude returns null → heuristic
  const ctx = negotiation.ctxFor(kam, negotiation.greetingCtx(kam, reply));
  const result = await negotiation.handleCreatorReply(kam, reply, ctx);
  assert.strictEqual(result.action, 'declined');
});

// ── Who wrote it is read from the message, not the address ─────────────────
//
// The sending address settles this far less often than it looks: a manager
// commonly replies from the creator's own inbox, and a creator sometimes writes
// from a second address. resolveGreeting therefore asks Claude to read the
// message, and treats the answer as a suggestion that still has to pass the
// same vetting as every other source.

function fakeJudge(json) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] }),
    },
  };
}

async function greetWith(judgeJson, creator, reply) {
  negotiation._setClient(judgeJson ? fakeJudge(judgeJson) : null);
  try {
    return await negotiation.resolveGreeting(creator, reply);
  } finally {
    negotiation._setClient(null);
  }
}

// Nothing here is legible to a pattern: it comes from Kam's own address, names
// nobody but Alex, and never says "manager" or uses a third-person pronoun.
const OPAQUE_MANAGER_REPLY = 'Thanks so much! We will take a look and come back to you on the split by Friday.\n\nBest,\nAlex';

test('Claude promotes a same-address reply to a delegate when it is sure', async () => {
  const before = negotiation.resolveSalutationFor(kam, OPAQUE_MANAGER_REPLY);
  assert.strictEqual(before.isDelegate, false, 'patterns alone cannot tell — that is the point');

  const g = await greetWith(
    { sender_name: 'Alex', wrote_by: 'someone_else', confidence: 'high', why: 'agency "we" voice' },
    kam,
    OPAQUE_MANAGER_REPLY,
  );
  assert.strictEqual(g.name, 'Alex');
  assert.strictEqual(g.isDelegate, true);
});

test('an unsure "someone else" does not flip the email into the third person', async () => {
  const g = await greetWith(
    { sender_name: 'Alex', wrote_by: 'someone_else', confidence: 'low', why: 'not clear' },
    kam,
    OPAQUE_MANAGER_REPLY,
  );
  assert.strictEqual(g.name, 'Alex');
  assert.strictEqual(g.isDelegate, false, 'a guess must not license third-person phrasing');
});

test('Claude can demote a false delegate back to the creator, unsure or not', async () => {
  // "Kam is my brand name, my page is under it" trips the pattern that looks for
  // the creator being named with a speaking verb.
  const reply = 'Kam is the name my page runs under. Happy with the structure — I would want 50% upfront.';
  assert.strictEqual(negotiation.resolveSalutationFor(kam, reply).isDelegate, true);

  const g = await greetWith(
    { sender_name: 'Kam', wrote_by: 'creator', confidence: 'low', why: 'first-person about their own page' },
    kam,
    reply,
  );
  assert.strictEqual(g.name, 'Kam');
  assert.strictEqual(g.isDelegate, false);
});

test('an unnamed third party is greeted "there", never by the creator name', async () => {
  const reply = 'Passing this on to the team — we will confirm the split shortly.';
  const g = await greetWith(
    { sender_name: null, wrote_by: 'someone_else', confidence: 'high', why: 'writes as the team' },
    kam,
    reply,
  );
  assert.strictEqual(g.name, 'there');
  assert.strictEqual(g.isDelegate, true);
});

test('a name Claude returns gets the same vetting as any other source', async () => {
  for (const bad of ['Jennifer', 'the manager', 'Influence', 'It looks like a manager wrote this', '']) {
    const g = await greetWith(
      { sender_name: bad, wrote_by: 'creator', confidence: 'high', why: 'x' },
      kam,
      'Sounds good.',
    );
    assert.strictEqual(g.name, 'Kam', `"${bad}" must not become the greeting`);
  }
});

test('a short form from Claude resolves to the creator, not a third party', async () => {
  const kamran = { ...kam, first_name: 'Kamran' };
  const g = await greetWith(
    { sender_name: 'Kam', wrote_by: 'creator', confidence: 'high', why: 'signs Kam' },
    kamran,
    'Sounds good.\n\n- Kam',
  );
  assert.strictEqual(g.name, 'Kam');
  assert.strictEqual(g.isDelegate, false);
});

test('with Claude unavailable the deterministic answer stands', async () => {
  const g = await greetWith(null, kam, KAM_REPLY);
  assert.deepStrictEqual(
    { name: g.name, isDelegate: g.isDelegate },
    { name: 'Kam', isDelegate: false },
  );
});

test('a malformed judgement is discarded rather than trusted', async () => {
  for (const junk of [{ wrote_by: 'maybe' }, { sender_name: 'Alex' }, {}]) {
    const g = await greetWith(junk, kam, KAM_REPLY);
    assert.strictEqual(g.name, 'Kam');
    assert.strictEqual(g.isDelegate, false);
  }
});

test('judgeSender is never shown the quoted thread', async () => {
  let seen = null;
  negotiation._setClient({
    messages: {
      create: async (args) => {
        seen = args.messages[0].content;
        return { content: [{ type: 'text', text: '{"sender_name":"Kam","wrote_by":"creator","confidence":"high","why":"x"}' }] };
      },
    },
  });
  try {
    await negotiation.resolveGreeting(kam, KAM_REPLY);
  } finally {
    negotiation._setClient(null);
  }
  assert.ok(seen.includes('$5,000 figure'), 'it should see what they typed');
  assert.ok(!seen.includes('- Jennifer'), 'it must not see our sign-off from the quoted thread');
});

test('a real delegate still gets the third-person instruction', async () => {
  const creator = {
    ...kam,
    first_name: 'Dua',
    email: 'dua@gmail.com',
    latest_inbound_from_email: 'alex@talentco.com',
  };
  const reply = "Hi, this is Alex, Dua's manager. She's keen — what's the timeline?\n\nBest,\nAlex";
  const capture = await classify(creator, reply);
  assert.strictEqual(greetingOrder(capture.system), 'Open with EXACTLY "Hi Alex,"');
  assert.ok(
    /on the creator Dua's behalf/.test(capture.system),
    'prompt should say Alex writes on Dua\'s behalf',
  );
});
