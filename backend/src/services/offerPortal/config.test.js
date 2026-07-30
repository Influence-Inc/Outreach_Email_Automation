'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  offerPortalConfig,
  offerPortalConfigIssues,
  offerPortalConfigSummary,
} = require('./config');

// Snapshot + restore every env var the module reads, so tests don't leak state.
const VARS = [
  'RESEND_API_KEY',
  'AISENSY_WHATSAPP_NUMBER',
  'AISENSY_API_KEY',
  'IMESSAGE_FROM_NUMBER',
  'IMESSAGE_API_KEY',
  'PUBLIC_BASE_URL',
  'OFFER_PORTAL_BASE_URL',
  'CAMPAIGNS_API_BASE',
];
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  try {
    for (const k of VARS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('nothing configured → invite disabled and every issue reported', () => {
  withEnv({}, () => {
    const c = offerPortalConfig();
    assert.equal(c.email.configured, false);
    assert.equal(c.whatsapp.inviteReady, false);
    assert.equal(c.imessage.inviteReady, false);
    assert.equal(c.inviteReady, false);
    assert.equal(c.conversationReady, false);

    const issues = offerPortalConfigIssues();
    // Resend, "no number to show", and "no offer-link base URL" are the blockers
    // when all is blank.
    assert.equal(issues.length, 3);
    assert.equal(issues.some((i) => /RESEND_API_KEY/.test(i)), true);
    assert.equal(issues.some((i) => /AISENSY_WHATSAPP_NUMBER|IMESSAGE_FROM_NUMBER/.test(i)), true);
    assert.equal(issues.some((i) => /PUBLIC_BASE_URL/.test(i)), true);
  });
});

test('Resend + a WhatsApp number + AiSensy key → invite and conversation ready', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      AISENSY_WHATSAPP_NUMBER: '+18005551234',
      AISENSY_API_KEY: 'ai_test',
      PUBLIC_BASE_URL: 'https://outreach.example', // the outreach app's own URL
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.inviteReady, true);
      assert.equal(c.conversationReady, true);
      assert.equal(c.whatsapp.conversationReady, true);
      assert.deepEqual(offerPortalConfigIssues(), []);
    },
  );
});

test('offer-link base pointing at the campaigns/stats domain is flagged (the "This campaign doesn\'t exist" bug)', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      AISENSY_WHATSAPP_NUMBER: '+18005551234',
      AISENSY_API_KEY: 'ai_test',
      // The misconfig: offer links built against the campaigns/stats domain,
      // which serves influence-stats (no offer portal), not this outreach app.
      PUBLIC_BASE_URL: 'https://campaigns.influence.technology',
      CAMPAIGNS_API_BASE: 'https://campaigns.influence.technology',
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.offerLink.configured, true);
      assert.equal(c.offerLink.pointsAtCampaignsService, true);
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /campaigns\/stats domain/.test(i) && /outreach app/.test(i)), true);
      // The one-line summary flags it too.
      assert.match(offerPortalConfigSummary(), /offerLink=WRONG/);
    },
  );
});

test('offer-link base set to the outreach app\'s own URL is clean (trailing slash tolerated)', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      AISENSY_WHATSAPP_NUMBER: '+18005551234',
      AISENSY_API_KEY: 'ai_test',
      PUBLIC_BASE_URL: 'https://outreach.influence.technology/',
      CAMPAIGNS_API_BASE: 'https://campaigns.influence.technology',
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.offerLink.pointsAtCampaignsService, false);
      assert.equal(c.offerLink.sampleLink, 'https://outreach.influence.technology/o/<token>');
      assert.deepEqual(offerPortalConfigIssues(), []);
    },
  );
});

test('a business number without its API key surfaces a send-side issue', () => {
  withEnv(
    { RESEND_API_KEY: 're_test', IMESSAGE_FROM_NUMBER: '+18005550000' },
    () => {
      const c = offerPortalConfig();
      // The invite can still name iMessage (number is present)…
      assert.equal(c.imessage.inviteReady, true);
      assert.equal(c.inviteReady, true);
      // …but replies can't be sent without the key, so it's not conversation-ready.
      assert.equal(c.imessage.conversationReady, false);
      assert.equal(c.conversationReady, false);
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /IMESSAGE_API_KEY/.test(i)), true);
    },
  );
});

test('Resend missing is reported even when a channel is fully wired', () => {
  withEnv(
    { AISENSY_WHATSAPP_NUMBER: '+18005551234', AISENSY_API_KEY: 'ai_test' },
    () => {
      const c = offerPortalConfig();
      // No invite email can be sent, so the whole invite is disabled.
      assert.equal(c.inviteReady, false);
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /RESEND_API_KEY/.test(i)), true);
    },
  );
});

test('summary is a compact single line', () => {
  withEnv({ RESEND_API_KEY: 're_test' }, () => {
    const s = offerPortalConfigSummary();
    assert.match(s, /email\/Resend=on/);
    assert.match(s, /used-creator invite DISABLED/);
    assert.equal(s.includes('\n'), false);
  });
});
