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
