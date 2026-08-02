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
//   RESEND_API_KEY           → offerPortal/email.js deliver(): with it blank,
//                              EVERY offer-portal email (invite, full offer,
//                              confirmation) is skipped. Master switch.
//
// WhatsApp runs on one of two providers (WHATSAPP_PROVIDER, auto-detected to
// 'cloud' when WHATSAPP_CLOUD_ACCESS_TOKEN is set, else 'twilio'):
//   Meta Cloud API (direct):
//     WHATSAPP_CLOUD_DISPLAY_NUMBER   → the WhatsApp number printed in the invite.
//     WHATSAPP_CLOUD_ACCESS_TOKEN     → Bearer token for the Graph send API.
//     WHATSAPP_CLOUD_PHONE_NUMBER_ID  → the sender bound to that token.
//     WHATSAPP_CLOUD_VERIFY_TOKEN     → GET webhook verification handshake.
//     WHATSAPP_CLOUD_APP_SECRET       → verifies inbound X-Hub-Signature-256.
//   Twilio (BSP):
//     TWILIO_WHATSAPP_FROM → the WhatsApp number printed in the invite AND the
//                            `From` on every send.
//     TWILIO_ACCOUNT_SID   → Basic-Auth SID for the Twilio Messages API.
//     TWILIO_AUTH_TOKEN    → Basic-Auth token + HMAC key that verifies the
//                            inbound webhook's X-Twilio-Signature.
//   IMESSAGE_FROM_NUMBER     → the iMessage number printed in the invite email,
//                              and the Linq `from` on every send.
//   IMESSAGE_API_KEY         → offerPortal/imessage.js: actually sending over
//                              iMessage.

const { whatsappProvider } = require('./whatsapp');

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

  // WhatsApp: 'cloud' (Meta Cloud API direct) or 'twilio' (BSP). Each gates on
  // its own number + creds; `hasApiKey` is true only when the send-side creds
  // are fully present, matching the gate in whatsapp.js.
  const waProvider = whatsappProvider();
  let whatsapp;
  if (waProvider === 'cloud') {
    const waNumber = strEnv('WHATSAPP_CLOUD_DISPLAY_NUMBER');
    const hasCloudCreds = boolEnv('WHATSAPP_CLOUD_ACCESS_TOKEN') && boolEnv('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
    whatsapp = {
      provider: 'cloud',
      businessNumber: waNumber,
      hasApiKey: hasCloudCreds,
      inviteReady: !!waNumber,
      conversationReady: hasCloudCreds && !!waNumber,
    };
  } else {
    const waNumber = strEnv('TWILIO_WHATSAPP_FROM');
    // Twilio needs BOTH SID and auth token to authenticate a Messages request —
    // one without the other is a Basic-Auth 401.
    const hasTwilioCreds = boolEnv('TWILIO_ACCOUNT_SID') && boolEnv('TWILIO_AUTH_TOKEN');
    whatsapp = {
      provider: 'twilio',
      businessNumber: waNumber,
      hasApiKey: hasTwilioCreds,
      // Enough to NAME WhatsApp in the invite (the number is the display value).
      inviteReady: !!waNumber,
      // Enough to actually run the conversation after the creator replies.
      conversationReady: hasTwilioCreds && !!waNumber,
    };
  }

  const imNumber = strEnv('IMESSAGE_FROM_NUMBER');
  const imessage = {
    provider: 'linq',
    businessNumber: imNumber,
    hasApiKey: boolEnv('IMESSAGE_API_KEY'),
    inviteReady: !!imNumber,
    conversationReady: boolEnv('IMESSAGE_API_KEY') && !!imNumber,
  };

  // Base URL used to build offer-portal links (/o/:token — see offers.offerUrl).
  // CRITICAL: this must be THIS outreach app's OWN public URL, because /o/:token
  // is served here (server.js). The most common misconfig is pointing it at the
  // campaigns/stats domain (CAMPAIGNS_API_BASE, e.g. campaigns.influence.technology)
  // — that domain serves the influence-stats app, which has NO offer portal, so
  // every link 404s with "This campaign doesn't exist".
  const normalizeUrl = (u) => u.replace(/\/+$/, '').toLowerCase();
  const offerBase = strEnv('PUBLIC_BASE_URL') || strEnv('OFFER_PORTAL_BASE_URL');
  const campaignsBase = strEnv('CAMPAIGNS_API_BASE') || 'https://campaigns.influence.technology';
  const offerLink = {
    // The env var whose value is used (PUBLIC_BASE_URL wins), for the message.
    source: strEnv('PUBLIC_BASE_URL') ? 'PUBLIC_BASE_URL' : strEnv('OFFER_PORTAL_BASE_URL') ? 'OFFER_PORTAL_BASE_URL' : null,
    baseUrl: offerBase || null,
    configured: !!offerBase,
    // True when the offer-link base is the campaigns/stats service instead of
    // this outreach app — the exact cause of a "This campaign doesn't exist" 404.
    pointsAtCampaignsService: !!offerBase && normalizeUrl(offerBase) === normalizeUrl(campaignsBase),
    sampleLink: `${offerBase.replace(/\/+$/, '')}/o/<token>`,
  };

  // The "text us" invite can only be sent when the invite EMAIL can go out
  // (Resend) AND there is at least one business number to put in it.
  const inviteReady = email.configured && (whatsapp.inviteReady || imessage.inviteReady);
  // Fully operational: the invite goes out AND at least one channel can carry
  // the reply conversation.
  const conversationReady =
    email.configured && (whatsapp.conversationReady || imessage.conversationReady);

  return { email, whatsapp, imessage, offerLink, inviteReady, conversationReady };
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
  const waNumberVar = c.whatsapp.provider === 'cloud' ? 'WHATSAPP_CLOUD_DISPLAY_NUMBER' : 'TWILIO_WHATSAPP_FROM';
  const waCredsHint =
    c.whatsapp.provider === 'cloud'
      ? 'WHATSAPP_CLOUD_ACCESS_TOKEN and/or WHATSAPP_CLOUD_PHONE_NUMBER_ID not set'
      : 'TWILIO_ACCOUNT_SID and/or TWILIO_AUTH_TOKEN not set';
  if (!c.whatsapp.inviteReady && !c.imessage.inviteReady) {
    issues.push(
      `neither ${waNumberVar} nor IMESSAGE_FROM_NUMBER is set — the invite has no "text us" number to show`,
    );
  }
  if (c.whatsapp.inviteReady && !c.whatsapp.hasApiKey) {
    issues.push(`${waCredsHint} — the WhatsApp number is shown but replies can't be sent`);
  }
  if (c.imessage.inviteReady && !c.imessage.hasApiKey) {
    issues.push('IMESSAGE_API_KEY is not set — the iMessage number is shown but replies can\'t be sent');
  }
  // Offer-link base URL — a wrong value here means the email/DM sends fine but the
  // /o/:token link the creator taps is dead.
  if (!c.offerLink.configured) {
    issues.push(
      'PUBLIC_BASE_URL (or OFFER_PORTAL_BASE_URL) is not set — offer-portal links (/o/:token) are built relative and won\'t open from an email',
    );
  } else if (c.offerLink.pointsAtCampaignsService) {
    issues.push(
      `${c.offerLink.source} is set to the campaigns/stats domain (${c.offerLink.baseUrl}), but /o/:token is served by THIS outreach app — every offer link 404s with "This campaign doesn't exist". Set it to the outreach app's OWN public URL.`,
    );
  }
  return issues;
}

// One-line, log-friendly summary of channel state.
function offerPortalConfigSummary() {
  const c = offerPortalConfig();
  const yn = (b) => (b ? 'on' : 'OFF');
  return (
    `email/Resend=${yn(c.email.configured)}; ` +
    `WhatsApp/${c.whatsapp.provider}(number=${yn(c.whatsapp.inviteReady)},api=${yn(c.whatsapp.hasApiKey)}); ` +
    `iMessage(number=${yn(c.imessage.inviteReady)},api=${yn(c.imessage.hasApiKey)}); ` +
    `offerLink=${c.offerLink.pointsAtCampaignsService ? 'WRONG(→campaigns/stats)' : c.offerLink.configured ? 'on' : 'OFF'}; ` +
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
