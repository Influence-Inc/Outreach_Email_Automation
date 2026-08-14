'use strict';

// Run with: npm test  (node --test)
//
// Two rules that kept slipping past the team, covered at both layers an offer
// email can be produced from — the deterministic builders AND the Claude prompt:
//
//   1. An offer email never mentions ad / usage rights, and never states a
//      posting cadence. Rights are settled in the contract; a cadence commits
//      the creator to a rhythm the offer doesn't price.
//   2. The Guidelines page has to be able to change what actually goes out, so
//      the universal guidelines are restated as the LAST instruction in every
//      email-writing prompt — after the canonical templates and the hard rules
//      that would otherwise out-argue them.
//
// Uses an injected fake Claude client (no network) that captures the system
// prompt, the same pattern as negotiationOfferDraft.test.js.
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
            { type: 'text', text: JSON.stringify({ subject: 'Re: test', body: 'DRAFTED BODY' }) },
          ],
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
  latest_inbound_text: 'I charge $8000 for a reel',
};

const OFFERS = {
  view_based: {
    offer_id: 'cfg_views',
    offer_type: 'view_based',
    flat_fee: 6000,
    view_guarantee: 250000,
  },
  video_bonus: {
    offer_id: 'cfg_bonus',
    offer_type: 'video_bonus',
    flat_fee: 6000,
    base_fee: 5000,
    num_videos: 2,
    bonus_amount: 1000,
    bonus_threshold_views: 300000,
  },
  video_based: {
    offer_id: 'cfg_video',
    offer_type: 'video_based',
    flat_fee: 6000,
    num_videos: 2,
    flat_per_video: 3000,
  },
};

const vars = { firstName: 'Gordon', brandName: 'Reve', managerName: 'Jennifer' };

// Any phrasing that would tell a creator something about ad / usage rights.
const AD_RIGHTS = /\bad rights\b|\busage rights\b|paid ads?\b|whitelist/i;
// A posting cadence/rhythm. The posted-by DATE is allowed; the pace is not.
const CADENCE = /\bcadence\b|videos? per (?:week|month|day)|steady pace|per week|weekly|twice a week/i;

// ── Layer 1: the deterministic builders ───────────────────────────────────

test('offerEmail never mentions ad rights or a cadence, for any offer type', () => {
  for (const [type, offer] of Object.entries(OFFERS)) {
    for (const combine of [false, true]) {
      const { body } = templates.offerEmail(offer, vars, { combine });
      const where = `${type} (combine=${combine})`;
      assert.ok(!AD_RIGHTS.test(body), `${where}: offer email mentions ad/usage rights:\n${body}`);
      assert.ok(!CADENCE.test(body), `${where}: offer email states a cadence:\n${body}`);
    }
  }
});

test('revisedOfferEmail never mentions ad rights or a cadence', () => {
  for (const [type, offer] of Object.entries(OFFERS)) {
    const { body } = templates.revisedOfferEmail(offer, vars);
    assert.ok(!AD_RIGHTS.test(body), `${type}: counter-offer mentions ad/usage rights:\n${body}`);
    assert.ok(!CADENCE.test(body), `${type}: counter-offer states a cadence:\n${body}`);
  }
});

test('the canonical REPLY 2 template Claude adapts carries neither', () => {
  assert.ok(!AD_RIGHTS.test(templates.REPLY2_BODY), 'REPLY 2 mentions ad/usage rights');
  assert.ok(!CADENCE.test(templates.REPLY2_BODY), 'REPLY 2 states a cadence');
});

test('a combined offer email keeps the REPLY 1 details but drops Usage Rights and the pace', () => {
  const { body } = templates.offerEmail(OFFERS.video_based, vars, { combine: true });
  // The collaboration details still lead the email...
  assert.ok(body.includes('**Content Style**'), 'combined email should keep Content Style');
  assert.ok(body.includes('**Platforms**'), 'combined email should keep Platforms');
  assert.ok(body.includes('**Timelines**'), 'combined email should keep Timelines');
  // ...but the rights section is gone and Timelines carries only a date.
  assert.ok(!body.includes('**Usage Rights**'), 'combined email must drop the Usage Rights section');
  const timelines = body.split('**Timelines**\n')[1].split('\n')[0];
  assert.ok(!CADENCE.test(timelines), `Timelines line still states a pace: ${timelines}`);
  assert.match(timelines, /posted by \w+day, \w+ \d+/, 'Timelines should still give a posted-by date');
});

test('stripCadence swaps REPLY 1 Timelines for a date-only line, leaving the rest intact', () => {
  const stripped = templates.stripCadence(templates.REPLY1_BODY);
  assert.ok(!stripped.includes('{cadence}'), 'the cadence placeholder should be gone');
  assert.ok(stripped.includes('{deadline}'), 'the posted-by date placeholder should survive');
  for (const header of ['**Content Style**', '**Deliverables & Rates**', '**Platforms**', '**Timelines**']) {
    assert.ok(stripped.includes(header), `expected ${header} to survive stripCadence`);
  }
});

// Deliberate scope boundary: only OFFER emails changed. Standalone Reply 1 is
// the collaboration-details email, not an offer, and still carries both. If this
// test starts failing because someone extended the rule to Reply 1 on purpose,
// delete it — it exists to make the boundary visible, not to freeze it.
test('standalone Reply 1 is unchanged — it still states usage rights and the cadence', () => {
  const { body } = templates.reply1(vars);
  assert.ok(body.includes('**Usage Rights**'), 'Reply 1 should still carry Usage Rights');
  assert.ok(CADENCE.test(body), 'Reply 1 should still state the posting cadence');
});

// ── Layer 2: the Claude offer prompt ──────────────────────────────────────

test('the offer prompt forbids ad rights and cadence, and shows a cadence-free REPLY 1', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator);
    await negotiation.draftOfferEmail(creator, OFFERS.video_based, ctx, { combine: true });

    assert.ok(
      capture.system.includes(templates.NO_AD_RIGHTS_OR_CADENCE_RULE),
      'the offer prompt should carry the no-ad-rights / no-cadence hard rule',
    );
    // The REPLY 1 body handed over must already be free of BOTH the cadence line
    // and the Usage Rights section — copy the model never sees is copy it cannot
    // leak into the offer email.
    assert.ok(
      !capture.system.includes('a steady pace of around'),
      'the REPLY 1 shown to Claude should have its cadence line replaced',
    );
    assert.ok(
      !capture.system.includes('**Usage Rights**'),
      'the REPLY 1 shown to Claude should have its Usage Rights section removed',
    );
    assert.ok(
      !/No exclusivity or ad rights are required/.test(capture.system),
      'the offer prompt should not contain the ad-rights copy at all',
    );
    // The cadence is still available for date math, explicitly marked internal.
    assert.ok(
      /date arithmetic ONLY/.test(capture.system),
      'the cadence should be handed over as internal date-math input',
    );
  } finally {
    negotiation._setClient(null);
  }
});

// ── Layer 2: the Guidelines actually reach the writing step ───────────────

const GUIDELINE = 'Never mention ad rights. Never mention a posting cadence.';

test('the offer prompt restates the guidelines AFTER the canonical template', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator, { guidelines: GUIDELINE });
    await negotiation.draftOfferEmail(creator, OFFERS.video_based, ctx, {});

    assert.ok(capture.system.includes(GUIDELINE), 'the guidelines should reach the offer prompt');
    assert.ok(
      /TEAM GUIDELINES/.test(capture.system),
      'the authoritative guidelines block should be present',
    );
    // The whole point: the guidelines must come AFTER the canonical template, or
    // "adapt this template, keep its content" is the last thing the model reads.
    const lastGuideline = capture.system.lastIndexOf(GUIDELINE);
    const template = capture.system.indexOf(templates.REPLY2_BODY);
    assert.ok(template !== -1, 'the canonical REPLY 2 should be in the prompt');
    assert.ok(
      lastGuideline > template,
      'the guidelines must be restated after the canonical template, not only before it',
    );
  } finally {
    negotiation._setClient(null);
  }
});

test('the reply prompt restates the guidelines after its templates too', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator, { guidelines: GUIDELINE });
    await negotiation.handleCreatorReply(creator, 'Sounds great, tell me more!', ctx);

    const lastGuideline = capture.system.lastIndexOf(GUIDELINE);
    const template = capture.system.indexOf(templates.REPLY1_BODY);
    assert.ok(template !== -1, 'the canonical REPLY 1 should be in the prompt');
    assert.ok(
      lastGuideline > template,
      'the guidelines must be restated after the canonical templates',
    );
  } finally {
    negotiation._setClient(null);
  }
});

test('no guidelines set — no guidelines block is emitted', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(creator);
    await negotiation.draftOfferEmail(creator, OFFERS.video_based, ctx, {});
    assert.ok(
      !/TEAM GUIDELINES/.test(capture.system),
      'an unset Guidelines page should add nothing to the prompt',
    );
  } finally {
    negotiation._setClient(null);
  }
});

test('the acknowledgment line carries the guidelines too', async () => {
  const capture = {};
  negotiation._setClient({
    messages: {
      create: async (args) => {
        capture.system = args.system;
        return { content: [{ type: 'text', text: 'Thanks so much for confirming!' }] };
      },
    },
  });
  try {
    const ctx = negotiation.ctxFor(creator, { guidelines: GUIDELINE });
    const line = await negotiation.draftAcknowledgmentLine(creator, ctx, {
      situation: 'The creator has just accepted the offer.',
    });
    assert.strictEqual(line, 'Thanks so much for confirming!');
    assert.ok(capture.system.includes(GUIDELINE), 'the guidelines should reach the ack-line prompt');
  } finally {
    negotiation._setClient(null);
  }
});
