'use strict';

// Offer-portal channel configuration diagnostics. The Used-creator "text us on
// WhatsApp / iMessage" invite (and the whole contacts-based negotiation that
// follows) only fires when several independent settings are all present. When
// any is missing the send paths skip GRACEFULLY and the creator quietly drops
// back to the ordinary Instantly cold email — so a half-configured deploy looks
// like "the messaging feature isn't working" with no error anywhere.
//
// This module makes that state observable: it reads the same env vars the send
// paths read and reports, per channel, whether it's wired up — for a boot-time
// summary log (see server.js) and a debug endpoint
// (GET /api/debug/offer-portal-config). It reports status ONLY; it never returns
// API keys, and the WhatsApp/iMessage numbers it surfaces are our own public
// business numbers (the same ones shown to creators in the invite email), never
// secrets.
//
// What each setting gates (mirror of the send code):
//   RESEND_API_KEY          → offerPortal/email.js deliver(): with it blank,
//                             EVERY offer-portal email (invite, full offer,
//                             confirmation) is skipped. Master switch.
//   AISENSY_WHATSAPP_NUMBER → the WhatsApp number printed in the invite email
//                             (offers.js inviteNumbersFor). No number → the
//                             invite can't mention WhatsApp.
//   AISENSY_API_KEY         → offerPortal/whatsapp.js: actually sending the
//                             brief / offer / replies once the creator texts in.
//   IMESSAGE_FROM_NUMBER    → the iMessage number printed in the invite email,
//                             and the Linq `from` on every send.
//   IMESSAGE_API_KEY        → offerPortal/imessage.js: actually sending over
//                             iMessage.

function boolEnv(name) {
  return !!(process.env[name] && String(process.env[name]).trim());
}
function strEnv(name) {
  return (process.env[name] || '').trim();
}

// Structured snapshot of what's configured. Pure (reads process.env only), so a
// test can set/unset vars and assert the derived flags.
function offerPortalConfig() {
  const email = {
    provider: 'resend',
    // With no key, offerPortal/email.js short-circuits every send.
    configured: boolEnv('RESEND_API_KEY'),
  };

  const waNumber = strEnv('AISENSY_WHATSAPP_NUMBER');
  const whatsapp = {
    provider: 'aisensy',
    businessNumber: waNumber,
    hasApiKey: boolEnv('AISENSY_API_KEY'),
    // Enough to NAME WhatsApp in the invite (the number is the display value).
    inviteReady: !!waNumber,
    // Enough to actually run the conversation after the creator replies.
    conversationReady: boolEnv('AISENSY_API_KEY') && !!waNumber,
  };

  const imNumber = strEnv('IMESSAGE_FROM_NUMBER');
  const imessage = {
    provider: 'linq',
    businessNumber: imNumber,
    hasApiKey: boolEnv('IMESSAGE_API_KEY'),
    inviteReady: !!imNumber,
    conversationReady: boolEnv('IMESSAGE_API_KEY') && !!imNumber,
  };

  // The "text us" invite can only be sent when the invite EMAIL can go out
  // (Resend) AND there is at least one business number to put in it.
  const inviteReady = email.configured && (whatsapp.inviteReady || imessage.inviteReady);
  // Fully operational: the invite goes out AND at least one channel can carry
  // the reply conversation.
  const conversationReady =
    email.configured && (whatsapp.conversationReady || imessage.conversationReady);

  return { email, whatsapp, imessage, inviteReady, conversationReady };
}

// Human-readable list of what's missing for the Used-creator messaging invite to
// work, most-blocking first. Empty array ⇒ fully wired. Used by the boot log and
// the fallback warning so the reason a Used creator got a plain email is legible.
function offerPortalConfigIssues() {
  const c = offerPortalConfig();
  const issues = [];
  if (!c.email.configured) {
    issues.push('RESEND_API_KEY is not set — all offer-portal emails (invite/offer/confirmation) are skipped');
  }
  if (!c.whatsapp.inviteReady && !c.imessage.inviteReady) {
    issues.push(
      'neither AISENSY_WHATSAPP_NUMBER nor IMESSAGE_FROM_NUMBER is set — the invite has no "text us" number to show',
    );
  }
  if (c.whatsapp.inviteReady && !c.whatsapp.hasApiKey) {
    issues.push('AISENSY_API_KEY is not set — the WhatsApp number is shown but replies can\'t be sent');
  }
  if (c.imessage.inviteReady && !c.imessage.hasApiKey) {
    issues.push('IMESSAGE_API_KEY is not set — the iMessage number is shown but replies can\'t be sent');
  }
  return issues;
}

// One-line, log-friendly summary of channel state.
function offerPortalConfigSummary() {
  const c = offerPortalConfig();
  const yn = (b) => (b ? 'on' : 'OFF');
  return (
    `email/Resend=${yn(c.email.configured)}; ` +
    `WhatsApp(number=${yn(c.whatsapp.inviteReady)},api=${yn(c.whatsapp.hasApiKey)}); ` +
    `iMessage(number=${yn(c.imessage.inviteReady)},api=${yn(c.imessage.hasApiKey)}); ` +
    `used-creator invite ${c.inviteReady ? 'READY' : 'DISABLED (falls back to Instantly email)'}`
  );
}

// Print the summary at boot, plus each blocking issue as a warning so a
// half-configured deploy is visible in the Railway logs instead of silent.
function logOfferPortalConfig(log = console) {
  log.log(`[offer-portal] channel config — ${offerPortalConfigSummary()}`);
  for (const issue of offerPortalConfigIssues()) {
    log.warn(`[offer-portal] ${issue}`);
  }
}

module.exports = {
  offerPortalConfig,
  offerPortalConfigIssues,
  offerPortalConfigSummary,
  logOfferPortalConfig,
};
