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
    // Resend + "no number to show" are the two blockers when all is blank.
    assert.equal(issues.length, 2);
    assert.match(issues[0], /RESEND_API_KEY/);
    assert.match(issues[1], /AISENSY_WHATSAPP_NUMBER|IMESSAGE_FROM_NUMBER/);
  });
});

test('Resend + a WhatsApp number + AiSensy key → invite and conversation ready', () => {
  withEnv(
    {
      RESEND_API_KEY: 're_test',
      AISENSY_WHATSAPP_NUMBER: '+18005551234',
      AISENSY_API_KEY: 'ai_test',
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
