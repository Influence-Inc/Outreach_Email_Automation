'use strict';

// "Graduation" flow: the moment a creator FIRST completes all the deliverables of
// a campaign, congratulate them and invite them onto WhatsApp/iMessage so every
// future collaboration runs over messaging instead of cold email.
//
// The completion signal is authoritative on the campaign dashboard
// (campaigns.influence.technology): each creator carries deliverables.allComplete
// on GET /api/bot/campaigns — the same payload campaignsApi already pulls. We
// sweep it, match completed creators to our own rows (by email / IG handle), and
// send the email ONCE per person (deduped by email, guarded by
// creators.graduation_email_at). The congrats line is written by Claude, with a
// static fallback when Claude isn't configured.

const db = require('../db');
const claude = require('./claudeClient');
const email = require('./offerPortal/email');
const campaignsApi = require('./campaignsApi');
const { offerPortalConfig } = require('./offerPortal/config');

const firstNameOf = (c) =>
  (c.first_name && String(c.first_name).trim()) ||
  (c.full_name ? String(c.full_name).trim().split(/\s+/)[0] : '') ||
  'there';

// Our own business numbers for the "send Hi" connect buttons — a channel is
// offered only when it's fully operational on our side (business number set AND
// its provider API key present), so we never invite a creator onto a channel we
// can't answer on. Unlike inviteNumbersFor, this doesn't depend on the creator
// having a number — the graduation email invites them TO connect.
function businessConnectNumbers() {
  const cfg = offerPortalConfig();
  return {
    whatsappNumber: cfg.whatsapp.conversationReady ? cfg.whatsapp.businessNumber || null : null,
    imessageNumber: cfg.imessage.conversationReady ? cfg.imessage.businessNumber || null : null,
  };
}

const CONGRATS_SYSTEM =
  'You write short, warm, genuinely personal congratulations notes for an influencer marketing agency (INFLUENCE) to a creator who just finished a campaign. Friendly and professional; never salesy or effusive. Plain text only.';

function congratsUser(firstName, brandName) {
  return [
    `Write a 2-3 sentence congratulations message to the creator ${firstName}, who just completed all the deliverables for the ${brandName} campaign.`,
    `Congratulate them on finishing, say it was a pleasure working with them, and that we'd love to stay in touch and collaborate again on future campaigns.`,
    `Do NOT include a greeting ("Hi ..."), a sign-off, links, phone numbers, or any call to action — those are added around your text. Return only the message sentences, plain text.`,
  ].join(' ');
}

function fallbackCongrats(brandName) {
  return `Congratulations on wrapping up all your deliverables for ${brandName} — it's been a genuine pleasure working with you. We'd love to stay in touch and team up again on future campaigns.`;
}

// Returns { line, personalized }. Claude writes the line; on any failure (no key,
// SDK missing, error) callClaudeText returns null and we use the static fallback.
async function personalizedCongrats(firstName, brandName) {
  const out = await claude.callClaudeText(CONGRATS_SYSTEM, congratsUser(firstName, brandName), 300);
  const line = out && out.trim();
  if (line) return { line, personalized: true };
  return { line: fallbackCongrats(brandName), personalized: false };
}

// Local creator rows matching a dashboard creator, by email OR Instagram handle.
async function matchLocalCreators(dashboardCreator) {
  const em = String(dashboardCreator.email || '').trim().toLowerCase();
  const un = String(dashboardCreator.username || '').replace(/^@/, '').trim().toLowerCase();
  if (!em && !un) return [];
  return db.many(
    `SELECT id FROM creators
      WHERE ($1 <> '' AND email IS NOT NULL AND lower(email) = $1)
         OR ($2 <> '' AND instagram_username IS NOT NULL AND lower(instagram_username) = $2)`,
    [em, un],
  );
}

// Send the graduation email to ONE creator, once per person. Stamps
// graduation_email_at on success (and on the dedup skip) so it never repeats; a
// transient send failure or a config gap is left unstamped so a later sweep
// retries once things are configured. Returns { sent, reason? }.
async function sendGraduationEmailForCreator(creatorId, { brandName } = {}) {
  const creator = await db.one(
    `SELECT id, email, first_name, full_name, graduation_email_at FROM creators WHERE id = $1`,
    [creatorId],
  );
  if (!creator) return { sent: false, reason: 'not_found' };
  if (creator.graduation_email_at) return { sent: false, reason: 'already_sent' };
  if (!creator.email) return { sent: false, reason: 'no_email' };

  const stamp = () =>
    db.query(`UPDATE creators SET graduation_email_at = NOW(), updated_at = NOW() WHERE id = $1`, [creatorId]);

  // Once per PERSON: if any row sharing this email already graduated, don't send
  // again — but stamp this row so we stop reconsidering it.
  const prior = await db.one(
    `SELECT 1 FROM creators WHERE lower(email) = lower($1) AND graduation_email_at IS NOT NULL LIMIT 1`,
    [creator.email],
  );
  if (prior) {
    await stamp();
    return { sent: false, reason: 'already_graduated' };
  }

  const { whatsappNumber, imessageNumber } = businessConnectNumbers();
  if (!whatsappNumber && !imessageNumber) return { sent: false, reason: 'no_messaging_channel' };

  const firstName = firstNameOf(creator);
  const brand = brandName || 'INFLUENCE';
  const { line, personalized } = await personalizedCongrats(firstName, brand);

  const res = await email.sendGraduationEmail({
    to: creator.email,
    firstName,
    brandName: brand,
    congratsLine: line,
    whatsappNumber,
    imessageNumber,
  });
  if (!res.sent) {
    // Provider off / transient — do NOT stamp, so a one-time congrats still goes
    // out once RESEND is configured (or the blip clears).
    return { sent: false, reason: res.skipped ? 'email_not_configured' : res.error || 'send_failed' };
  }

  await stamp();
  await db.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'graduation_email_sent', $2)`, [
    creatorId,
    { brand, personalized },
  ]);
  return { sent: true };
}

// Sweep the campaign dashboard for creators who've completed all deliverables and
// send each their one-time graduation email. Gated on prerequisites so a misconfig
// never burns Claude calls or hammers the upstream. Best-effort per creator.
async function runGraduationSweep() {
  if (!process.env.RESEND_API_KEY) return { skipped: 'email_not_configured' };
  if (!process.env.CAMPAIGNS_API_TOKEN) return { skipped: 'campaigns_api_not_configured' };
  const { whatsappNumber, imessageNumber } = businessConnectNumbers();
  if (!whatsappNumber && !imessageNumber) return { skipped: 'no_messaging_channel' };

  let campaigns;
  try {
    campaigns = await campaignsApi.fetchUpstreamCampaigns();
  } catch (err) {
    console.error('[graduation] campaigns fetch failed:', err.message);
    return { skipped: 'fetch_failed' };
  }

  let sent = 0;
  for (const camp of campaigns || []) {
    const brandName = camp.brandName || camp.name || 'INFLUENCE';
    for (const cr of camp.creators || []) {
      if (!cr || !cr.deliverables || cr.deliverables.allComplete !== true) continue;
      let matches = [];
      try {
        matches = await matchLocalCreators(cr);
      } catch (err) {
        console.error('[graduation] match failed:', err.message);
        continue;
      }
      for (const local of matches) {
        try {
          const r = await sendGraduationEmailForCreator(local.id, { brandName });
          if (r.sent) sent += 1;
        } catch (err) {
          console.error(`[graduation] send failed for creator ${local.id}:`, err.message);
        }
      }
    }
  }
  return { sent };
}

module.exports = {
  businessConnectNumbers,
  personalizedCongrats,
  fallbackCongrats,
  matchLocalCreators,
  sendGraduationEmailForCreator,
  runGraduationSweep,
};
