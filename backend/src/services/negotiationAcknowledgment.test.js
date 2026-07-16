'use strict';

// The template emails that used to go out as-is now open by acknowledging what
// the creator actually said:
//   - draftAcknowledgmentLine() writes the one-line acknowledgment for the
//     (otherwise fixed) contract email — and is deliberately conservative:
//     empty when Claude is off, when there's nothing on file, or when the model
//     tries to sneak in a price / answer at length.
//   - draftOfferEmail() feeds the creator's own message into the offer prompt so
//     the offer can react to it (their rate, a preference) instead of a cold
//     generic lead.
//
// The DB layer is a thin singleton (src/db); we stub it and inject a fake Claude
// client via _setClient (the same hooks the other negotiation tests use). A
// capturing client lets us assert what actually reached the model.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');

const origMany = db.many;

function restore() {
  db.many = origMany;
  negotiation._setClient(null);
}

// A fake client that returns `text` and records the {system, messages} it saw.
function capturingClient(text) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async ({ system, messages }) => {
        calls.push({ system, messages });
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

const baseCtxCreator = {
  id: 7,
  first_name: 'Dua',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  usage_rights_policy: 'no_rights',
  max_cpm: 3,
};

// ── draftAcknowledgmentLine ─────────────────────────────────────────────────

test('draftAcknowledgmentLine returns the model line for a creator with a message', async () => {
  db.many = async () => [];
  negotiation._setClient(capturingClient('So excited you loved the concept — thrilled to get started!'));
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: 'This is amazing, I loved the concept! Let\'s do it.' };
    const line = await negotiation.draftAcknowledgmentLine(creator, negotiation.ctxFor(creator), {
      situation: 'The creator just accepted.',
    });
    assert.strictEqual(line, 'So excited you loved the concept — thrilled to get started!');
  } finally {
    restore();
  }
});

test('draftAcknowledgmentLine returns empty when there is no creator message on file', async () => {
  db.many = async () => []; // empty thread
  negotiation._setClient(capturingClient('should never be used'));
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: null };
    const line = await negotiation.draftAcknowledgmentLine(creator, negotiation.ctxFor(creator), {
      situation: 'x',
    });
    assert.strictEqual(line, '');
  } finally {
    restore();
  }
});

test('draftAcknowledgmentLine is empty when Claude is unavailable (no client)', async () => {
  db.many = async () => [];
  negotiation._setClient(null);
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: 'Sounds great!' };
    const line = await negotiation.draftAcknowledgmentLine(creator, negotiation.ctxFor(creator), { situation: 'x' });
    assert.strictEqual(line, '');
  } finally {
    restore();
  }
});

test('draftAcknowledgmentLine rejects a line that sneaks in a price', async () => {
  db.many = async () => [];
  negotiation._setClient(capturingClient('Happy to confirm the $2,500 works for you!'));
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: 'Yes, $2,500 works.' };
    const line = await negotiation.draftAcknowledgmentLine(creator, negotiation.ctxFor(creator), { situation: 'x' });
    assert.strictEqual(line, '', 'a $-amount in the ack line is dropped, not sent');
  } finally {
    restore();
  }
});

test('draftAcknowledgmentLine drops a multi-line / overlong answer', async () => {
  db.many = async () => [];
  negotiation._setClient(capturingClient('Sure!\nHere is a long explanation of our whole process...'));
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: 'How does this work exactly?' };
    const line = await negotiation.draftAcknowledgmentLine(creator, negotiation.ctxFor(creator), { situation: 'x' });
    assert.strictEqual(line, '', 'a multi-line reply is not used as an ack line');
  } finally {
    restore();
  }
});

// ── draftOfferEmail wiring ─────────────────────────────────────────────────

test('draftOfferEmail puts the creator\'s message into the offer prompt', async () => {
  db.many = async () => [];
  const client = capturingClient(JSON.stringify({ subject: 'Re: deal', body: 'Hi Dua, thanks for the $1500 note. **Payment details** ... - Jennifer' }));
  negotiation._setClient(client);
  try {
    const creator = {
      ...baseCtxCreator,
      latest_inbound_text: 'My rate is $1500 per reel, and I can only post on weekends.',
    };
    const offer = { offer_type: 'flat', num_videos: 2, flat_fee: 3000, label: 'Flat Package' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    await negotiation.draftOfferEmail(creator, offer, ctx, { combine: false });
    assert.strictEqual(client.calls.length, 1, 'the offer email calls Claude once');
    const { system } = client.calls[0];
    assert.ok(system.includes('can only post on weekends'), 'the creator\'s own words are in the prompt');
    assert.ok(/acknowledg/i.test(system), 'the prompt instructs acknowledging their message');
    assert.ok(/do NOT change[^\n]*offer number/i.test(system), 'the numbers-are-fixed guardrail is present');
  } finally {
    restore();
  }
});

test('draftOfferEmail (revised) tells the model NOT to re-pitch the deal, uses the concise numbers', async () => {
  // A prior offer was already sent, so this send is a REVISED counter.
  db.many = async () => [];
  const client = capturingClient(JSON.stringify({ subject: 'Re: deal', body: 'Hi Joe, ... - Jennifer' }));
  negotiation._setClient(client);
  try {
    const creator = { ...baseCtxCreator, first_name: 'Joe', latest_inbound_text: 'Can you do $3,500 for 300k?' };
    const offer = { offer_type: 'view_based', flat_fee: 3500, view_guarantee: 500000, label: 'View-Based Offer' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    await negotiation.draftOfferEmail(creator, offer, ctx, { revised: true });
    const { system } = client.calls[0];
    assert.ok(/REVISED counter-offer/i.test(system), 'the prompt marks this a revised counter');
    assert.ok(system.includes('**Revised Offer ($3,500)**'), 'the concise revised numbers are supplied');
    // The full REPLY 2 template must not be injected for a revised offer. (We
    // check REPLY 2's own lead line, not "performance-based deals", since the
    // HARD RULE instruction deliberately quotes that phrase to forbid it.)
    assert.ok(!/Thanks for sharing your rates/i.test(system), 'the REPLY 2 template is not injected in a revised offer');
  } finally {
    restore();
  }
});

test('draftOfferEmail (revised) falls back to the concise template when Claude is unavailable', async () => {
  db.many = async () => [];
  negotiation._setClient(null);
  try {
    const creator = { ...baseCtxCreator, first_name: 'Joe', latest_inbound_text: 'Can you do $3,500?' };
    const offer = { offer_type: 'view_based', flat_fee: 3500, view_guarantee: 500000, label: 'View-Based Offer' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    const email = await negotiation.draftOfferEmail(creator, offer, ctx, { revised: true });
    assert.ok(email.body.includes('**Revised Offer ($3,500)**'), 'concise revised template used');
    assert.ok(!/performance-based deals/i.test(email.body), 'no deal re-pitch in the fallback');
    assert.ok(!/7 days/i.test(email.body), 'no standing-terms restatement in the fallback');
  } finally {
    restore();
  }
});

test('draftOfferEmail feeds the view-range opener into the prompt for a wide-spread creator', async () => {
  db.many = async () => [];
  const client = capturingClient(JSON.stringify({ subject: 'Re: deal', body: 'Hi Dua, ... - Jennifer' }));
  negotiation._setClient(client);
  try {
    const creator = {
      ...baseCtxCreator,
      latest_inbound_text: 'My rate is $1500.',
      ig_scraped_data: { views_raw: [60000, 150000, 400000], min_views: 60000 },
    };
    const offer = { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 400000, label: 'View-Based Offer' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    await negotiation.draftOfferEmail(creator, offer, ctx, { combine: false });
    const { system } = client.calls[0];
    assert.ok(/OPENING LINE/.test(system), 'the verbatim opener instruction is present');
    assert.ok(system.includes('your views can range anywhere from 60k to 400k+'), 'range opener given to Claude');
  } finally {
    restore();
  }
});

test('draftOfferEmail (view-based, wide spread) fallback opens with the view range', async () => {
  db.many = async () => [];
  negotiation._setClient(null);
  try {
    const creator = {
      ...baseCtxCreator,
      latest_inbound_text: 'My rate is $1500.',
      ig_scraped_data: { views_raw: [60000, 150000, 400000], min_views: 60000 },
    };
    const offer = { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 400000, label: 'View-Based Offer' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    const email = await negotiation.draftOfferEmail(creator, offer, ctx, { combine: false });
    assert.ok(email.body.includes('your views can range anywhere from 60k to 400k+'), 'range opener in the fallback body');
  } finally {
    restore();
  }
});

test('draftOfferEmail (view-based, narrow spread) fallback uses the standard opener', async () => {
  db.many = async () => [];
  negotiation._setClient(null);
  try {
    const creator = {
      ...baseCtxCreator,
      latest_inbound_text: 'My rate is $1500.',
      ig_scraped_data: { views_raw: [26000, 35000, 49000], min_views: 26000 },
    };
    const offer = { offer_type: 'view_based', flat_fee: 1500, view_guarantee: 50000, label: 'View-Based Offer' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    const email = await negotiation.draftOfferEmail(creator, offer, ctx, { combine: false });
    assert.ok(/performance-based deals/i.test(email.body), 'standard opener for a narrow spread');
    assert.ok(!/range anywhere from/i.test(email.body), 'no range line');
  } finally {
    restore();
  }
});

test('draftOfferEmail falls back to the template when Claude is unavailable', async () => {
  db.many = async () => [];
  negotiation._setClient(null);
  try {
    const creator = { ...baseCtxCreator, latest_inbound_text: 'My rate is $1500.' };
    const offer = { offer_type: 'flat', num_videos: 2, flat_fee: 3000, label: 'Flat Package' };
    const ctx = negotiation.ctxFor(creator, { approvedOffer: offer });
    const email = await negotiation.draftOfferEmail(creator, offer, ctx, { combine: false });
    assert.ok(email.body.includes('Payment details'), 'the deterministic offer template is used');
  } finally {
    restore();
  }
});

// ── latestCreatorMessage ───────────────────────────────────────────────────

test('latestCreatorMessage prefers the pending inbound, then the thread tail', async () => {
  // With a pending inbound, the thread is never consulted.
  db.many = async () => {
    throw new Error('thread should not be read when latest_inbound_text is present');
  };
  try {
    const withPending = await negotiation.latestCreatorMessage({ id: 7, latest_inbound_text: 'pending!' });
    assert.strictEqual(withPending, 'pending!');
  } finally {
    db.many = origMany;
  }

  // Without one, it returns the last INBOUND turn in the thread.
  db.many = async () => [
    { direction: 'inbound', body: 'older creator msg' },
    { direction: 'outbound', body: 'our reply' },
    { direction: 'inbound', body: 'latest creator msg' },
  ];
  try {
    const fromThread = await negotiation.latestCreatorMessage({ id: 7, latest_inbound_text: null });
    assert.strictEqual(fromThread, 'latest creator msg');
  } finally {
    db.many = origMany;
  }
});
