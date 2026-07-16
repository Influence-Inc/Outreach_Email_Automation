'use strict';

// Run with: npm test  (node --test)
//
// Covers the "Draft with AI" review-before-send capability at the layer that
// matters: the account manager's free-text notes are handed to Claude to shape
// the OFFER email, while the approved offer numbers stay locked. Uses an
// injected fake Claude client (no network) that captures the system prompt.
const test = require('node:test');
const assert = require('node:assert');
const negotiation = require('./negotiation');

// A fake Anthropic client: records the system prompt it was called with and
// returns a fixed JSON offer email, so we can assert on what the prompt carried.
function fakeClaude(capture) {
  return {
    messages: {
      create: async (args) => {
        capture.system = args.system;
        capture.messages = args.messages;
        return {
          content: [{ type: 'text', text: JSON.stringify({ subject: 'Re: test', body: 'DRAFTED BODY' }) }],
        };
      },
    },
  };
}

const creator = {
  id: 1,
  first_name: 'Gordon',
  brand_name: 'Reve',
  campaign_name: null,
  max_cpm: 15,
  negotiation_status: 'AWAITING_APPROVAL',
  ig_scraped_data: null,
  usage_rights_policy: 'no_rights',
  // Present so draftOfferEmail reads it directly and never touches the DB thread.
  latest_inbound_text: '$8000 base plus a bonus per 200k views for one reel',
};

const offer = {
  offer_id: 'cfg_video',
  offer_type: 'video_based',
  label: 'Video-based deal',
  flat_fee: 6000,
  num_videos: 1,
  flat_per_video: 6000,
  view_guarantee: 250000,
  cpm_applied: 24,
};

test('draftOfferEmail weaves the account manager notes into the Claude prompt', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator);
    const notes = 'push back on the per-view bonus and lean into the long-term retainer';
    const email = await negotiation.draftOfferEmail(creator, offer, ctx, { extraInstructions: notes });

    assert.strictEqual(email.body, 'DRAFTED BODY');
    assert.ok(capture.system.includes(notes), 'the admin notes should appear in the system prompt');
    assert.ok(/account manager/i.test(capture.system), 'prompt should flag the notes as manager-authored');
    // The fixed offer number must still be in the prompt — notes shape wording,
    // never the price.
    assert.ok(capture.system.includes('6000'), 'the approved flat_fee should stay in the prompt');
  } finally {
    negotiation._setClient(null);
  }
});

test('draftOfferEmail omits the notes block when no instructions are given', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator);
    await negotiation.draftOfferEmail(creator, offer, ctx, {});
    assert.ok(
      !/account manager's notes/i.test(capture.system),
      'no notes block should be present without instructions',
    );
  } finally {
    negotiation._setClient(null);
  }
});
