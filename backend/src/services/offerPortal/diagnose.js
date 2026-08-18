'use strict';

// "The creator texted Hi and nothing happened" — answered without sending a
// message.
//
// The inbound path (routes/offerWebhook.js) is deliberately quiet: an unknown
// sender, a creator with no number on file, or a provider send that was skipped
// for missing credentials all end in a 200 whose reason only the provider ever
// reads. This module replays the same decisions against the same data and
// reports where an inbound message from a given number WOULD stop, so a
// half-configured deploy is diagnosable from the dashboard instead of by
// texting the business number and guessing.
//
// It never sends anything, never mutates, and never returns credentials — the
// only number it echoes is the one the caller passed in.

const db = require('../../db');
const { normalizePhone, whatsappProvider } = require('./whatsapp');
const { loadContactRows, pickMatchDetailed, resolveLiveOfferRow, assertContactColumn } = require('./contactMatch');
const { offerPortalConfig, offerPortalConfigIssues } = require('./config');

// What handleInbound would do next, given the creator's offer state. Mirrors the
// stage ladder in offerWebhook.js — keep the two in step.
function predictAction({ pendingOffer, hasAnyOffer, establishedChannel }) {
  if (!pendingOffer && !hasAnyOffer) {
    return establishedChannel
      ? {
          action: 'holding_message',
          explanation:
            'Already briefed on this channel but still has no priced offer — replies with the holding line and flags the message for a human to price the offer.',
        }
      : {
          action: 'brief_first_contact',
          explanation:
            'First contact with no offer yet — sends the brand/product brief + interest check, and flags the creator in Deal Studio so an admin can price the offer.',
        };
  }
  if (pendingOffer && !pendingOffer.messaging_stage) {
    return {
      action: 'brief_offer',
      explanation:
        'A pending offer exists but has never been briefed on this channel — sends the brief + interest check (never the raw rate).',
    };
  }
  if (pendingOffer && pendingOffer.messaging_stage === 'briefed') {
    return {
      action: 'interest_gate',
      explanation:
        'Awaiting a yes/no on interest — "yes" reveals the full offer + portal link, "no" declines, anything unclear gets a Yes/No nudge.',
    };
  }
  return {
    action: 'classify_reply',
    explanation:
      'The offer is already revealed — the reply is classified as accept / decline / counter-rate, or deflected and flagged for review.',
  };
}

// Replay the inbound pipeline for `rawPhone` without sending anything.
async function diagnoseInboundNumber(rawPhone, channel = 'whatsapp') {
  const column = assertContactColumn(channel === 'imessage' ? 'imessage' : 'whatsapp');
  const digits = normalizePhone(rawPhone);
  const cfg = offerPortalConfig();
  const channelCfg = column === 'imessage' ? cfg.imessage : cfg.whatsapp;

  const out = {
    input: rawPhone == null ? null : String(rawPhone),
    channel: column,
    normalized: digits || null,
    provider: column === 'imessage' ? 'linq' : whatsappProvider(),
    // Can we actually SEND on this channel? Without this a match is moot: the
    // webhook runs to completion and the reply is silently skipped.
    channelReady: !!channelCfg.conversationReady,
    candidates: 0,
    match: null,
    wouldReply: false,
    verdict: null,
    blockers: [],
    configIssues: offerPortalConfigIssues(),
  };

  if (!channelCfg.conversationReady) {
    out.blockers.push(
      column === 'imessage'
        ? 'iMessage is not send-ready (IMESSAGE_API_KEY and/or IMESSAGE_FROM_NUMBER missing) — inbound is processed but every reply is skipped.'
        : `WhatsApp provider "${out.provider}" is not send-ready — inbound is processed but every reply is skipped. Check the provider credentials and display number.`,
    );
  }

  if (!digits) {
    out.verdict = 'invalid_number';
    out.blockers.push('No digits in the number provided — pass the sender in E.164, e.g. +919812345670.');
    return out;
  }

  const rows = await loadContactRows(column);
  out.candidates = rows.length;

  const hit = pickMatchDetailed(rows, digits);
  if (!hit) {
    out.verdict = 'unknown_sender';
    out.blockers.push(
      rows.length === 0
        ? `No creator has a ${column} number on file, so EVERY inbound message is dropped as an unknown sender. creators.${column} is only filled by the Creator-DB segmentation backfill (which needs a phone number on the master record) or by setting it directly.`
        : `None of the ${rows.length} creators with a ${column} number match ${digits} — the webhook logs "unknown_sender" and never replies. Check the stored number includes the country code.`,
    );
    return out;
  }

  // Mirror the webhook's second resolution step — a Used creator has one row per
  // campaign, and the reply belongs to whichever row holds the live offer. Read
  // only: unlike the webhook, this never persists the carried-over number.
  const { row: creator, repointed } = await resolveLiveOfferRow(column, hit.row, { persist: false });

  out.match = {
    creatorId: creator.id,
    name: creator.full_name || creator.first_name || null,
    storedNumber: hit.row.contact,
    matchedOn: hit.matchedOn,
    campaignId: creator.campaign_id || null,
    establishedChannel: creator.established_channel || null,
    optedOut: !!creator.messaging_opted_out,
    // True when the phone matched one campaign row but the conversation belongs
    // to another (the row carrying the pending offer).
    repointedToLiveOfferRow: repointed,
    matchedRowId: hit.row.id,
  };

  if (hit.matchedOn === 'suffix') {
    out.blockers.push(
      `Matched only on the last 10 digits (stored "${hit.row.contact}" vs inbound "${digits}") — it works, but storing the full E.164 number avoids collisions between creators sharing a 10-digit tail.`,
    );
  }
  if (creator.messaging_opted_out) {
    out.blockers.push(
      'This creator is opted out (replied STOP). Inbound is still answered, but no proactive send will ever go to them until they send START.',
    );
  }
  if (!creator.campaign_id) {
    out.blockers.push(
      'Creator has no campaign_id, so the brief falls back to a generic blurb with no brand name.',
    );
  }

  const pendingOffer = await db.one(
    `SELECT id, messaging_stage FROM offers WHERE creator_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [creator.id],
  );
  const anyOffer = pendingOffer
    ? pendingOffer
    : await db.one(`SELECT id FROM offers WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`, [creator.id]);

  out.match.pendingOffer = pendingOffer ? { id: pendingOffer.id, messagingStage: pendingOffer.messaging_stage || null } : null;
  out.match.hasAnyOffer = !!anyOffer;

  const predicted = predictAction({
    pendingOffer,
    hasAnyOffer: !!anyOffer,
    establishedChannel: creator.established_channel,
  });
  out.verdict = predicted.action;
  out.explanation = predicted.explanation;
  out.wouldReply = out.channelReady;

  return out;
}

module.exports = { diagnoseInboundNumber, predictAction };
