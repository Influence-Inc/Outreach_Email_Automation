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
  'WHATSAPP_PROVIDER',
  'AISENSY_API_KEY',
  'AISENSY_WHATSAPP_NUMBER',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_DISPLAY_NUMBER',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
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
    assert.equal(issues.some((i) => /TWILIO_WHATSAPP_FROM|IMESSAGE_FROM_NUMBER/.test(i)), true);
    assert.equal(issues.some((i) => /PUBLIC_BASE_URL/.test(i)), true);
  });
});

test('Resend + a WhatsApp number + Twilio SID/token → invite and conversation ready', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      TWILIO_WHATSAPP_FROM: '+18005551234',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok_test',
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

test('AiSensy provider auto-detects when its API key is set and reports readiness', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      AISENSY_API_KEY: 'ai_test',
      AISENSY_WHATSAPP_NUMBER: '+13322879678',
      PUBLIC_BASE_URL: 'https://outreach.example',
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.whatsapp.provider, 'aisensy'); // auto-detected, no explicit flag
      assert.equal(c.whatsapp.conversationReady, true);
      assert.equal(c.conversationReady, true);
      assert.deepEqual(offerPortalConfigIssues(), []);
      assert.match(offerPortalConfigSummary(), /WhatsApp\/aisensy/);
    },
  );
});

test('AiSensy provider with a number but no key flags a send-side issue naming AISENSY_API_KEY', () => {
  withEnv(
    { RESEND_API_KEY: 're_test', WHATSAPP_PROVIDER: 'aisensy', AISENSY_WHATSAPP_NUMBER: '+13322879678' },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.whatsapp.provider, 'aisensy');
      assert.equal(c.whatsapp.inviteReady, true);
      assert.equal(c.whatsapp.conversationReady, false);
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /AISENSY_API_KEY/.test(i)), true);
    },
  );
});

test('Cloud API provider auto-detects when its access token is set and reports readiness', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAG_test',
      WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLOUD_DISPLAY_NUMBER: '+18005551234',
      PUBLIC_BASE_URL: 'https://outreach.example',
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.whatsapp.provider, 'cloud'); // auto-detected, no explicit flag
      assert.equal(c.whatsapp.conversationReady, true);
      assert.equal(c.conversationReady, true);
      assert.deepEqual(offerPortalConfigIssues(), []);
      assert.match(offerPortalConfigSummary(), /WhatsApp\/cloud/);
    },
  );
});

test('Cloud provider with a number but no token flags a send-side issue naming the Cloud var', () => {
  withEnv(
    { RESEND_API_KEY: 're_test', WHATSAPP_PROVIDER: 'cloud', WHATSAPP_CLOUD_DISPLAY_NUMBER: '+18005551234' },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.whatsapp.provider, 'cloud');
      assert.equal(c.whatsapp.inviteReady, true); // number shows in the invite…
      assert.equal(c.whatsapp.conversationReady, false); // …but replies can't send
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /WHATSAPP_CLOUD_ACCESS_TOKEN/.test(i)), true);
    },
  );
});

test('a WhatsApp number with only ONE of SID/token → invite ready but conversation not', () => {
  // Twilio Basic Auth needs BOTH; either alone is a 401. The invite still shows
  // WhatsApp (the number is public), but the "reply" side is not ready and a
  // TWILIO_ACCOUNT_SID/TOKEN issue is surfaced.
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      TWILIO_WHATSAPP_FROM: '+18005551234',
      TWILIO_ACCOUNT_SID: 'ACtest',
      // TWILIO_AUTH_TOKEN intentionally missing
      PUBLIC_BASE_URL: 'https://outreach.example',
    },
    () => {
      const c = offerPortalConfig();
      assert.equal(c.whatsapp.inviteReady, true);
      assert.equal(c.whatsapp.hasApiKey, false);
      assert.equal(c.whatsapp.conversationReady, false);
      const issues = offerPortalConfigIssues();
      assert.equal(issues.some((i) => /TWILIO_ACCOUNT_SID/.test(i) && /TWILIO_AUTH_TOKEN/.test(i)), true);
    },
  );
});

test('offer-link base pointing at the campaigns/stats domain is flagged (the "This campaign doesn\'t exist" bug)', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      TWILIO_WHATSAPP_FROM: '+18005551234',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok_test',
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
      TWILIO_WHATSAPP_FROM: '+18005551234',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok_test',
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
    { TWILIO_WHATSAPP_FROM: '+18005551234', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok_test' },
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
