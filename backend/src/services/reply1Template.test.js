'use strict';

// Run with: npm test  (node --test)
//
// Per-campaign "E-2 letter template" (campaigns.reply1_template, edited in Deal
// Studio). When a campaign has its own letter, it must replace the built-in
// REPLY 1 everywhere: in the Claude prompt (the sample letter Claude adapts)
// and in the deterministic fallback sent when Claude is unavailable. A blank
// template falls back to the built-in default.
const test = require('node:test');
const assert = require('node:assert');
const negotiation = require('./negotiation');
const templates = require('./negotiationTemplates');

const CUSTOM = `Hi {salutation},

Thanks for getting back to us about {brandName}! CUSTOM-E2-MARKER

**Deliverables & Rates**
- One reel to start.

Let me know your rate :)

- {managerName}`;

const baseCreator = {
  id: 7,
  first_name: 'Gordon',
  brand_name: 'Suno',
  campaign_name: 'Suno Campaign',
  max_cpm: 15,
  negotiation_status: null,
  ig_scraped_data: null,
  usage_rights_policy: 'no_rights',
};

function fakeClaude(capture) {
  return {
    messages: {
      create: async (args) => {
        capture.system = args.system;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                understanding: 'interested',
                action: 'asking_details',
                quoted_rate: null,
                email: { subject: 'Re: x', body: 'DRAFT' },
                send_now: true,
              }),
            },
          ],
        };
      },
    },
  };
}

test('reply1TemplateOrDefault: blank or null falls back to the built-in letter', () => {
  assert.strictEqual(templates.reply1TemplateOrDefault(null), templates.REPLY1_BODY);
  assert.strictEqual(templates.reply1TemplateOrDefault('   \n '), templates.REPLY1_BODY);
  assert.strictEqual(templates.reply1TemplateOrDefault(CUSTOM), CUSTOM.trim());
});

test('reply1() fills the campaign template instead of the default', () => {
  const { body } = templates.reply1({ firstName: 'Gordon', brandName: 'Suno' }, { template: CUSTOM });
  assert.match(body, /CUSTOM-E2-MARKER/);
  assert.match(body, /Thanks for getting back to us about Suno!/);
  assert.doesNotMatch(body, /\{brandName\}|\{salutation\}/);
  assert.doesNotMatch(body, /Content Style/, 'the built-in letter must not leak in');
});

test('ctxFor carries the campaign template; blank means default', () => {
  assert.strictEqual(negotiation.ctxFor({ ...baseCreator, reply1_template: CUSTOM }).reply1Template, CUSTOM);
  assert.strictEqual(negotiation.ctxFor({ ...baseCreator, reply1_template: '  ' }).reply1Template, null);
  assert.strictEqual(negotiation.ctxFor(baseCreator).reply1Template, null);
});

test('Claude is handed the campaign E-2 letter as its sample, not the built-in one', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const creator = { ...baseCreator, reply1_template: CUSTOM };
    const ctx = negotiation.ctxFor(creator);
    await negotiation.handleCreatorReply(creator, 'Great, share more details!', ctx);
    assert.ok(capture.system.includes('CUSTOM-E2-MARKER'), 'custom letter must be in the prompt');
    assert.ok(!capture.system.includes(templates.REPLY1_BODY), 'built-in letter must not be in the prompt');
  } finally {
    negotiation._setClient(null);
  }
});

test('without a campaign template Claude still gets the built-in letter', async () => {
  const capture = {};
  negotiation._setClient(fakeClaude(capture));
  try {
    const ctx = negotiation.ctxFor(baseCreator);
    await negotiation.handleCreatorReply(baseCreator, 'Great, share more details!', ctx);
    assert.ok(capture.system.includes(templates.REPLY1_BODY));
  } finally {
    negotiation._setClient(null);
  }
});
