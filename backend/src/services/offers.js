'use strict';

// Offer-portal service. Originally replicated from Influence-CDB-portal
// (src/lib/offers.ts, adapted from Prisma to this app's pg layer). THE single
// backend path for creating offers and accepting / declining / counter-
// negotiating them. Used for OLD creators (see creator_segment): instead of
// email negotiation, the admin's approved offer is minted here.
//
// Delivery depends on whether the creator has ALREADY messaged us on a channel
// (creators.established_channel — "subscribed"):
//   • NOT established yet → we don't cold-push. The outreach email reveals the
//     negotiation link AND invites them to text us on WhatsApp/iMessage; if they
//     text (buttons prefill "Hi"), the conversation runs in TWO steps
//     (offers.messaging_stage): a brand/product brief with a yes/no interest
//     check (sendOfferBriefing), then — only once they say yes — the full offer
//     as a free-form reply (deliverOfferOverChannel).
//   • ALREADY established → the deal is delivered DIRECTLY on that channel
//     (deliverOfferOverChannel), no "Hi" re-trigger and no interest brief.
// A creator with no usable messaging channel falls back to the full offer email
// with the direct /o/:token web link, so they're always reachable.

const { randomBytes } = require('crypto');
const db = require('../db');
const { formatDate, formatMoney, fillTemplate } = require('./offerPortal/format');
const email = require('./offerPortal/email');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const { offerPortalConfig } = require('./offerPortal/config');
const {
  acceptedAwaitingSignatureMessage,
  thankYouMessage,
  politeCloseMessage,
  notAFitCloseMessage,
  renderBriefIntro,
  INTEREST_QUESTION,
  INTEREST_BUTTONS,
  INTEREST_FALLBACK_HINT,
} = require('./offerPortal/replies');
const creatorDb = require('./creatorDb');
const campaignDashboard = require('./campaignDashboard');

// 4-day respond-by (matches the "Respond by …" line shown only in the outreach
// email + WhatsApp — the portal itself doesn't render it, see offer.js). Overridable
// via OFFER_EXPIRY_DAYS if a specific campaign needs a longer / shorter window.
const DEFAULT_EXPIRY_DAYS = Number(process.env.OFFER_EXPIRY_DAYS || 4);

// Cryptographically random, unguessable, URL-safe token (~192 bits of entropy).
function generateOfferToken() {
  return randomBytes(24).toString('base64url');
}

function offerUrl(token) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.OFFER_PORTAL_BASE_URL || '').replace(/\/$/, '');
  return `${base}/o/${token}`;
}

const firstNameOf = (creator) =>
  (creator.first_name && String(creator.first_name).trim()) ||
  (creator.full_name ? String(creator.full_name).trim().split(/\s+/)[0] : '') ||
  'there';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Creates an offer and its initial `sent` event in one transaction. Retries on
// the (astronomically unlikely) token collision.
async function createOffer(input) {
  const expiresInDays = input.expiresInDays || DEFAULT_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000);
  const deliverables = JSON.stringify(Array.isArray(input.deliverables) ? input.deliverables : []);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = generateOfferToken();
    try {
      return await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO offers
             (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
           RETURNING *`,
          [
            input.creatorId,
            input.campaignId || null,
            token,
            input.brandName,
            deliverables,
            input.rate,
            input.currency || 'USD',
            input.expectedImpressions != null ? input.expectedImpressions : null,
            expiresAt,
          ],
        );
        const offer = rows[0];
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
          [offer.id],
        );
        return offer;
      });
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }
  throw new Error('Could not generate a unique offer token');
}

// ---------------------------------------------------------------------------
// Respond (accept / decline)
// ---------------------------------------------------------------------------

// THE single backend path for accepting/declining an offer. The web offer page
// (channel 'web') and the WhatsApp/iMessage inbound handlers (channel
// 'whatsapp'/'imessage') all call this — identical state transition, identical
// logging — so a WhatsApp "yes" and a web Accept can never drift apart.
async function respondToOffer({ token, response, channel, declineReason }) {
  const offer = await db.one(`SELECT id, status, expires_at FROM offers WHERE token = $1`, [token]);
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // Atomic, idempotent transition: the guarded UPDATE only flips a still-pending
  // offer, so concurrent responses (a fast double-tap) can't double-fire.
  const transitioned = await db.withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE offers SET status = $2, decline_reason = $3 WHERE id = $1 AND status = 'pending'`,
      [offer.id, response, response === 'declined' ? declineReason || null : null],
    );
    if (upd.rowCount === 0) return false; // lost the race — already responded
    await client.query(
      `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, $2, $3)`,
      [offer.id, response, channel],
    );
    return true;
  });

  if (!transitioned) return { ok: false, reason: 'already_responded' };

  // Follow-up runs from this convergence point, so a web Accept and a WhatsApp
  // "yes" trigger identical messages. A failed send never fails the response —
  // the status transition already committed.
  await onOfferResponded(offer.id, response);
  return { ok: true, status: response };
}

// Append-only view log. Called on each load of the public offer page.
async function logOfferViewed(offerId) {
  await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'viewed', 'web')`, [offerId]);
}

// ---------------------------------------------------------------------------
// Outbound delivery (email + WhatsApp + iMessage)
// ---------------------------------------------------------------------------

// A messaging send that didn't go out is the most common reason a creator hears
// nothing after texting "Hi". The send helpers return { sent: false } rather
// than throwing (so one dead channel never breaks a flow), which means without
// this the only trace is a `*_failed` string in an HTTP response nobody reads.
// Pass every messaging send result through here.
function logSendResult(where, channel, creatorId, result) {
  if (!result || result.sent) return result;
  const why = result.error || result.reason || 'unknown error';
  if (result.skipped) {
    console.warn(`[offers] ${where}: ${channel} send to creator ${creatorId} SKIPPED — provider credentials not configured`);
  } else {
    console.error(`[offers] ${where}: ${channel} send to creator ${creatorId} FAILED — ${why}`);
  }
  return result;
}

// The creator's current offer, when the deal is still live or already agreed.
// 'declined' and 'expired' are finished, so pricing a fresh offer after one of
// those is a legitimate re-approach rather than a duplicate. Scoped to this
// creator ROW, which is per-campaign — a Used creator pulled into a new campaign
// has no offers on the new row, so this never blocks a genuine new-campaign
// offer.
async function liveOfferFor(creatorId) {
  return db.one(
    `SELECT id, token, status FROM offers
      WHERE creator_id = $1 AND status IN ('pending', 'accepted')
      ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
}

// How long an inbound message keeps the conversation open. Both WhatsApp and
// iMessage only permit a free-form reply inside the window the creator's own
// message opens — the reason established_channel exists at all.
const OPEN_CONVERSATION_HOURS = 24;

// The channel this creator has actually initiated contact on, if any — see
// established_channel's schema comment. Null means "not yet."
async function establishedMessagingChannel(creatorId) {
  const row = await db.one(`SELECT established_channel FROM creators WHERE id = $1`, [creatorId]);
  return (row && row.established_channel) || null;
}

// The last 10 digits of a contact's number — the identity key used to recognise
// the same PERSON across their many per-campaign creators rows.
const phoneTailOf = (contact) => {
  const phone = (contact && (contact.whatsapp || contact.imessage)) || null;
  return phone ? String(phone).replace(/\D/g, '').slice(-10) : '';
};

// Has this PERSON opted out anywhere? Compliance is cross-campaign: one STOP on
// any row silences every row.
async function optedOutAnywhere(contact) {
  const tail = phoneTailOf(contact);
  if (!tail) return !!(contact && contact.messaging_opted_out);
  const norm = `right(regexp_replace(coalesce(whatsapp, imessage, ''), '[^0-9]', '', 'g'), 10)`;
  const row = await db.one(
    `SELECT bool_or(messaging_opted_out) AS opted_out FROM creators WHERE ${norm} = $1`,
    [tail],
  );
  return !!(row && row.opted_out);
}

// Which channel this creator is SUBSCRIBED on — i.e. they have messaged our
// business number at some point and never opted out.
//
// Subscription is PER PERSON, not per campaign: texting our number once opts
// them in for good, across every campaign they are ever pulled into. It used to
// be scoped to the current campaign row, so a creator who had been chatting with
// us for months was emailed "text Hi to continue" every time a new campaign
// added a fresh row — asking someone already in the conversation to re-introduce
// themselves. The person is identified by phone tail, the same identity rule the
// opt-out check and the inbound webhook's sender matching already use.
//
// NOTE: subscribed does NOT mean we may send right now — see openChannelFor.
// Returns the channel, or null. `contact` needs whatsapp, imessage,
// established_channel, messaging_opted_out.
async function subscribedChannelFor(contact) {
  if (await optedOutAnywhere(contact)) return null;

  // This row already knows the channel — no lookup needed.
  if (contact.established_channel) return contact.established_channel;

  const tail = phoneTailOf(contact);
  if (!tail) return null;

  // Any other row for the same person carries the subscription.
  const row = await db.one(
    `SELECT established_channel
       FROM creators
      WHERE right(regexp_replace(coalesce(whatsapp, imessage, ''), '[^0-9]', '', 'g'), 10) = $1
        AND established_channel IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [tail],
  );
  const channel = (row && row.established_channel) || null;
  // Only usable when THIS row carries a number for that channel — the reply needs
  // a destination, or deliverOfferOverChannel bails with no_contact_for_channel.
  if (channel === 'whatsapp' && contact.whatsapp) return 'whatsapp';
  if (channel === 'imessage' && contact.imessage) return 'imessage';
  return null;
}

// Record the subscription: this PERSON has messaged our business number, so
// EVERY creators row sharing their phone becomes reachable on that channel —
// not just the campaign row the message happened to match. That is what makes
// "text Hi once and you're subscribed" hold: a campaign added months later
// inherits it instead of emailing them to re-introduce themselves.
//
// COALESCE, never overwrite: a creator already established on iMessage isn't
// flipped to WhatsApp by one stray message on the other channel.
async function subscribeCreatorChannel(creatorId, channel) {
  const row = await db.one(`SELECT whatsapp, imessage FROM creators WHERE id = $1`, [creatorId]);
  const tail = phoneTailOf(row || {});
  if (!tail) {
    await db.query(
      `UPDATE creators SET established_channel = COALESCE(established_channel, $2), updated_at = NOW() WHERE id = $1`,
      [creatorId, channel],
    );
    return 1;
  }
  const res = await db.query(
    `UPDATE creators
        SET established_channel = COALESCE(established_channel, $2), updated_at = NOW()
      WHERE right(regexp_replace(coalesce(whatsapp, imessage, ''), '[^0-9]', '', 'g'), 10) = $1`,
    [tail, channel],
  );
  return (res && res.rowCount) || 0;
}

// Is the provider's free-form window currently open for this person? WhatsApp
// and iMessage both reject a free-form message to someone who hasn't written to
// us in the last 24h (Meta 131047/131026, Twilio 63016) — a platform rule, not
// a policy of ours, and the reason a subscription alone is not permission to
// send. Only an inbound message reopens it.
async function conversationWindowOpen(contact) {
  const tail = phoneTailOf(contact);
  if (!tail) return false;
  const recent = await db.one(
    `SELECT 1 AS open
       FROM offer_messages m
       JOIN creators c ON c.id = m.creator_id
      WHERE m.direction = 'inbound'
        AND m.sent_at > NOW() - make_interval(hours => $2)
        AND right(regexp_replace(coalesce(c.whatsapp, c.imessage, ''), '[^0-9]', '', 'g'), 10) = $1
      LIMIT 1`,
    [tail, OPEN_CONVERSATION_HOURS],
  );
  return !!recent;
}

// The channel we may PROACTIVELY message on right now: subscribed AND inside the
// provider's free-form window. Callers that push a message the creator did not
// just ask for (a new offer, a new-campaign invite) must use this rather than
// subscribedChannelFor — otherwise the send is rejected by the provider and the
// creator silently hears nothing, which is strictly worse than the email invite
// they would otherwise have received.
//
// Sending outside the window needs a Meta-approved message TEMPLATE (a paid,
// business-initiated conversation); none is configured here yet, so a closed
// window falls back to email. See .env.example's WhatsApp section.
async function openChannelFor(contact) {
  const channel = await subscribedChannelFor(contact);
  if (!channel) return null;
  return (await conversationWindowOpen(contact)) ? channel : null;
}

// Which of our own business messaging numbers to show a creator in the invite
// ("text Hi to this number"): a channel is included only when the creator has a
// number on file for it, isn't opted out, AND that channel is fully operational
// on our side — its business number is set AND its provider API key is present,
// so a reply on it can actually be answered. Advertising a channel we can't send
// back on (e.g. a WhatsApp number with no Twilio SID/token) would route the
// creator into a dead end where they text "Hi" and hear nothing, so those are
// withheld. Returns { whatsappNumber, imessageNumber } — either may be null.
function inviteNumbersFor(contact) {
  const optedOut = !!contact.messaging_opted_out;
  const cfg = offerPortalConfig();
  return {
    whatsappNumber:
      !optedOut && contact.whatsapp && cfg.whatsapp.conversationReady
        ? whatsapp.businessNumber() || null
        : null,
    imessageNumber:
      !optedOut && contact.imessage && cfg.imessage.conversationReady
        ? imessage.businessNumber() || null
        : null,
  };
}

// Ask a question with tappable options where the channel supports them, and the
// same question with the options written out where it doesn't. iMessage (Linq)
// has no button concept, so it always takes the written form.
function sendChoiceOn(channel, { to, body, buttons, fallbackHint }) {
  if (channel === 'imessage') {
    return imessage.sendIMessageText({ to, body: fallbackHint ? `${body}\n\n${fallbackHint}` : body });
  }
  return whatsapp.sendWhatsAppChoice({ to, body, buttons, fallbackHint });
}

// Open a messaging conversation as TWO messages, not one merged paragraph: the
// brand pitch, then — as its own message, once the pitch has landed — the
// interest question (tappable buttons where the channel supports them). Mirrors
// how someone actually pitches a partnership over chat: send it, then ask,
// rather than a wall of text ending in a question mark.
//
// Returns a result shaped for logSendResult/offer_messages logging:
//   { sent, skipped?, error?, reason?, intro: {sent, id, body, ...}, question: {...}|null }
// The top-level fields mirror whichever message is the meaningful outcome: the
// question's result once the intro landed (the CTA is what callers gate
// established_channel/messaging_stage on), or the intro's own failure when it
// never sent — there is no interest question to ask if the pitch didn't arrive.
async function sendBriefMessages(channel, { to, firstName, blurb }) {
  const introBody = renderBriefIntro(firstName, blurb);
  const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
  const introResult = await send({ to, body: introBody });
  if (!introResult.sent) {
    return { ...introResult, intro: { ...introResult, body: introBody }, question: null };
  }

  const questionResult = await sendChoiceOn(channel, {
    to,
    body: INTEREST_QUESTION,
    buttons: INTEREST_BUTTONS,
    fallbackHint: INTEREST_FALLBACK_HINT,
  });
  return {
    ...questionResult,
    intro: { ...introResult, body: introBody },
    question: { ...questionResult, body: INTEREST_QUESTION },
  };
}

// Log both legs of a sendBriefMessages() result into offer_messages — the intro
// whenever it actually sent (worth keeping in the conversation history even if
// the follow-up question then failed), the question whenever IT sent. `insert`
// is one of the two INSERT shapes the call sites already use (with or without
// offer_id) so this stays a thin, shared tail rather than another shape to keep
// in sync.
async function logBriefMessages(result, insert) {
  if (result.intro && result.intro.sent) await insert(result.intro.body, result.intro.id);
  if (result.question && result.question.sent) await insert(result.question.body, result.question.id);
}

// Send the brand/product brief + a yes/no interest check to a used creator who
// has messaged us but has NO priced offer yet — the offer-less counterpart of
// sendOfferBriefing. This is what lets the WhatsApp/iMessage bot OPEN with brand
// details + an interest gauge before anything is priced (instead of a generic
// holding line); the actual offer + portal link follows once an admin prices it
// and it delivers on this same channel. Uses the campaign's custom
// messaging_brief when set, else a generic brand blurb. Marks the channel
// established. Returns the send result ({ sent, reason?/error? }).
async function sendUsedCreatorBrief(creatorId, channel) {
  const c = await db.one(
    `SELECT c.id, c.first_name, c.full_name, c.whatsapp, c.imessage,
            ca.name AS campaign_name, ca.brand_name, ca.messaging_brief
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!c) return { sent: false, reason: 'not_found' };

  const to = channel === 'imessage' ? c.imessage : c.whatsapp;
  if (!to) return logSendResult('sendUsedCreatorBrief', channel, c.id, { sent: false, reason: 'no_contact_for_channel' });

  const firstName = firstNameOf(c);
  const custom = c.messaging_brief && String(c.messaging_brief).trim();
  const brandBlurb = custom
    ? fillTemplate(custom, { firstName, brandName: c.brand_name || 'INFLUENCE', campaignName: c.campaign_name || '' })
    : `We're running a paid collaboration campaign with ${c.brand_name || 'a brand'} and think you'd be a great fit.`;
  const result = logSendResult(
    'sendUsedCreatorBrief',
    channel,
    c.id,
    await sendBriefMessages(channel, { to, firstName, blurb: brandBlurb }),
  );
  await logBriefMessages(result, (body, providerId) =>
    db.query(
      `INSERT INTO offer_messages (creator_id, direction, channel, body, provider_message_id)
       VALUES ($1, 'outbound', $2, $3, $4)`,
      [c.id, channel, body, providerId || null],
    ),
  );
  if (result.sent) {
    await subscribeCreatorChannel(c.id, channel);
  }
  return result;
}

// Send the brand/product brief — the FIRST message in this offer's messaging
// conversation (see offers.messaging_stage), sent before any rate/deliverables.
// Ends with a yes/no interest check; only a "yes" (handled in offerWebhook.js)
// goes on to reveal the actual offer via deliverOfferOverChannel. Uses the
// campaign's custom messaging_brief when an admin has set one (placeholder-
// filled), else a generic brand-name-only blurb. Marks the channel established
// (sticky) on success, same as deliverOfferOverChannel.
async function sendOfferBriefing(offerId, channel) {
  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name, c.whatsapp, c.imessage,
            ca.name AS campaign_name, ca.messaging_brief
     FROM offers o
     JOIN creators c ON c.id = o.creator_id
     LEFT JOIN campaigns ca ON ca.id = o.campaign_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return { sent: false, reason: 'not_found' };

  const to = channel === 'imessage' ? offer.imessage : offer.whatsapp;
  if (!to) return { sent: false, reason: 'no_contact_for_channel' };

  const firstName = firstNameOf(offer);
  const custom = offer.messaging_brief && String(offer.messaging_brief).trim();
  const brandBlurb = custom
    ? fillTemplate(custom, { firstName, brandName: offer.brand_name, campaignName: offer.campaign_name || '' })
    : `We're running a paid collaboration campaign with ${offer.brand_name} and think you'd be a great fit.`;
  const result = logSendResult(
    'sendOfferBriefing',
    channel,
    offer.creator_id,
    await sendBriefMessages(channel, { to, firstName, blurb: brandBlurb }),
  );
  await logBriefMessages(result, (body, providerId) =>
    db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
       VALUES ($1, $2, 'outbound', $3, $4, $5)`,
      [offer.creator_id, offer.id, channel, body, providerId || null],
    ),
  );
  if (result.sent) {
    await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'briefed', $2)`, [offer.id, channel]);
    await db.query(`UPDATE offers SET messaging_stage = 'briefed' WHERE id = $1`, [offer.id]);
    await subscribeCreatorChannel(offer.creator_id, channel);
  }
  return result;
}

// Deliver an offer's full details directly over an ALREADY-established
// messaging channel, as a free-form reply. Only ever called once the creator
// has confirmed interest at the brief stage (or, for a counter-offer, mid-
// negotiation where a brief has no place — see negotiateBudget). Marks
// messaging_stage 'revealed' and the channel established (sticky) on success.
async function deliverOfferOverChannel(offerId, channel) {
  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name, c.whatsapp, c.imessage
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return { sent: false, reason: 'not_found' };

  const to = channel === 'imessage' ? offer.imessage : offer.whatsapp;
  if (!to) return { sent: false, reason: 'no_contact_for_channel' };

  const params = {
    firstName: firstNameOf(offer),
    brandName: offer.brand_name,
    offerUrl: offerUrl(offer.token),
    expiryDate: formatDate(offer.expires_at),
  };

  // The full text-with-link copy — what actually goes out on iMessage/Twilio,
  // and what's recorded in offer_messages either way so the dashboard history
  // always shows the link, even when the live bubble carried it on a button
  // instead of in the text (see renderOfferOutreachIntro).
  const loggedBody =
    channel === 'imessage' ? imessage.renderOfferOutreachBody(params) : whatsapp.renderOfferOutreachBody(params);

  const send =
    channel === 'imessage'
      ? () => imessage.sendIMessageText({ to, body: loggedBody })
      : () =>
          whatsapp.sendWhatsAppLink({
            to,
            body: whatsapp.renderOfferOutreachIntro(params),
            buttonText: 'View Offer',
            url: params.offerUrl,
            fallbackBody: loggedBody,
          });

  const result = logSendResult('deliverOfferOverChannel', channel, offer.creator_id, await send());
  if (result.sent) {
    await db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
       VALUES ($1, $2, 'outbound', $3, $4, $5)`,
      [offer.creator_id, offer.id, channel, loggedBody, result.id || null],
    );
    await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', $2)`, [offer.id, channel]);
    await db.query(`UPDATE offers SET messaging_stage = 'revealed' WHERE id = $1`, [offer.id]);
    await subscribeCreatorChannel(offer.creator_id, channel);
  }
  return result;
}

// Deliver a just-published content brief to the creator over whichever
// channel reaches them fastest — called once by the /brief/publish route,
// right after briefs.publishBrief, and only on a creator's FIRST publish (a
// re-publish after editing content direction / video links must not re-notify
// them). Priority mirrors sendOfferOutreach:
//   1. An already-established WhatsApp/iMessage conversation — a short
//      free-form text with the link. Most used/returning creators land here:
//      they signed their mini-contract in a chat-adjacent flow already.
//   2. A live cold-outreach negotiation thread (instantly_reply_uuid) — a
//      threaded reply in the SAME Gmail thread as their contract email,
//      fulfilling the "I'll share a quick content brief" line that email ends
//      on. Delegates to negotiation.sendBriefEmail (lazy-required: negotiation.js
//      already requires offers.js at load time, so the reverse edge has to
//      stay lazy or the two modules would deadlock loading each other).
//   3. A plain email address with neither of the above — a direct
//      transactional email over the same Resend channel as the rest of the
//      portal.
// Best-effort throughout — every branch returns a result object, and a
// failure in step 2 falls back to step 3 rather than giving up; nothing here
// ever throws, so a delivery failure can never undo the publish that
// triggered it.
async function deliverBriefToCreator(creatorId, briefUrl) {
  const c = await db.one(
    `SELECT c.id, c.first_name, c.full_name, c.email, c.whatsapp, c.imessage,
            c.established_channel, c.messaging_opted_out, c.instantly_reply_uuid,
            ca.brand_name
       FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
      WHERE c.id = $1`,
    [creatorId],
  );
  if (!c) return { sent: false, reason: 'not_found' };
  const firstName = firstNameOf(c);
  const brandName = c.brand_name || 'the brand';

  const logDelivered = (channel) =>
    db.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'brief_delivered', $2)`, [
      c.id,
      { channel, briefUrl },
    ]);

  // A SIGNED creator's brief belongs on the campaign-update lane
  // (services/creatorUpdates.js): it is the first of the updates that lane
  // exists to carry, and routing it there is what lets it reach a creator whose
  // 24h window is shut — queued now, delivered as an approved template or the
  // moment they write in. The branches below stay for everyone the lane doesn't
  // cover: a creator mid-negotiation who hasn't signed, or one who opted out.
  try {
    const queued = await require('./creatorUpdates').notify(
      c.id,
      'brief_ready',
      { brandName, briefUrl },
      { dedupKey: `creator:${c.id}:brief:${briefUrl}` },
    );
    if (queued.queued) {
      if (queued.sent) await logDelivered(queued.channel || 'whatsapp');
      return { sent: !!queued.sent, queued: true, channel: queued.channel || 'whatsapp', reason: queued.reason };
    }
    // 'duplicate' means this exact brief URL was already handed to the lane —
    // a re-publish of an unchanged brief. Don't fall through and email it again.
    if (queued.reason === 'duplicate') return { sent: false, queued: true, reason: 'duplicate' };
  } catch (err) {
    console.error('[offers] creator-updates brief delivery failed, falling back:', err.message);
  }

  // Fallback for the creators the update lane doesn't cover (mid-negotiation,
  // or opted out): person-level subscription AND an open free-form window, the
  // same rule as every other proactive send. A shut window falls through to the
  // email below rather than having the provider reject the send.
  const channel = await openChannelFor(c);
  const to = channel === 'imessage' ? c.imessage : channel === 'whatsapp' ? c.whatsapp : null;
  if (channel && to) {
    const mod = channel === 'imessage' ? imessage : whatsapp;
    const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
    const body = mod.renderContentBriefReadyBody({ firstName, brandName, briefUrl });
    const result = await send({ to, body });
    if (result.sent) {
      await db.query(
        `INSERT INTO offer_messages (creator_id, direction, channel, body, provider_message_id)
         VALUES ($1, 'outbound', $2, $3, $4)`,
        [c.id, channel, body, result.id || null],
      );
      await logDelivered(channel);
    }
    return { ...result, channel };
  }

  if (c.instantly_reply_uuid) {
    try {
      const result = await require('./negotiation').sendBriefEmail(c.id, briefUrl);
      if (result.sent) {
        await logDelivered('email_thread');
        return { ...result, channel: 'email_thread' };
      }
    } catch (err) {
      console.error('[offers] threaded brief email failed, falling back to direct email:', err.message);
    }
    // Falls through to the direct-email branch below on any miss/failure.
  }

  if (c.email) {
    const result = await email.sendBriefReadyEmail({ to: c.email, firstName, brandName, briefUrl });
    if (result.sent) await logDelivered('email');
    return { ...result, channel: 'email' };
  }

  return { sent: false, reason: 'no_contact' };
}

// Top-level dispatcher for a NEW offer. Three outcomes:
//   established_channel set → the creator already messaged us on this channel
//     (subscribed), so deliver the DEAL directly there (deliverOfferOverChannel)
//     — no "Hi" re-trigger and no interest brief; the offer link goes straight to
//     their WhatsApp/iMessage.
//   not set, WA/iMessage usable → offer email that BOTH reveals the negotiation
//     link AND invites them to text us on WhatsApp/iMessage (they choose the web
//     portal or a chat; a "Hi" text still briefs them — see offerWebhook.js).
//   neither usable (opted out / no number / vendor unconfigured) → the full offer
//     email with the direct web link, so it's always reachable.
async function sendOfferOutreach(offerId) {
  const offer = await db.one(
    `SELECT o.*, c.email AS creator_email, c.first_name, c.full_name, c.whatsapp, c.imessage,
            c.messaging_opted_out, c.established_channel
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return;

  const firstName = firstNameOf(offer);
  const url = offerUrl(offer.token);
  const expiry = formatDate(offer.expires_at);
  const logSend = (channel, body) =>
    db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body)
       VALUES ($1, $2, 'outbound', $3, $4)`,
      [offer.creator_id, offer.id, channel, body],
    );

  // Have they subscribed AND is the provider's free-form window open right now?
  const subscribedChannel = await openChannelFor(offer);
  if (subscribedChannel) {
    try {
      // They've already opted in on this channel, so send the DEAL directly (no
      // "Hi" re-trigger, no interest brief) — the full offer + link goes straight
      // to their WhatsApp/iMessage.
      await deliverOfferOverChannel(offer.id, subscribedChannel);
    } catch (err) {
      console.error('[offers] direct offer delivery failed', err.message);
    }
    // …and by email as well, carrying the same link. The chat is where they are
    // right now, but the inbox is what survives a scrolled-past conversation, and
    // a creator should never have to work out which of the two is authoritative.
    // Best-effort and isolated: a failed email never costs them the chat message.
    if (offer.creator_email) {
      try {
        const res = await email.sendOfferEmail({
          to: offer.creator_email,
          firstName,
          brandName: offer.brand_name,
          offerUrl: url,
          expiryDate: expiry,
        });
        if (res.sent) {
          await logSend('email', `Offer email — "New collaboration opportunity — ${offer.brand_name}" (${url})`);
        }
      } catch (err) {
        console.error('[offers] offer email alongside the messaging send failed', err.message);
      }
    }
    return;
  }

  // Nothing established: we never cold-push WhatsApp/iMessage, so the offer goes
  // by email — with a "text Hi" invite when a messaging channel is usable.
  if (!offer.creator_email) {
    console.warn(
      `[offers] offer ${offer.id}: creator ${offer.creator_id} has no established messaging channel and no email — nothing sent`,
    );
    return;
  }
  console.log(
    `[offers] offer ${offer.id}: no open messaging conversation with creator ${offer.creator_id} — ` +
      'sending the email invite rather than a direct WhatsApp/iMessage offer',
  );

  const { whatsappNumber: waNumber, imessageNumber: imNumber } = inviteNumbersFor(offer);

  try {
    if (waNumber || imNumber) {
      // Offer email that BOTH reveals the negotiation link and invites a chat on
      // WhatsApp/iMessage. messaging_stage is deliberately left unset: the phone
      // buttons prefill "Hi", so a creator who texts still gets the staged brief
      // (offerWebhook.js), while the web link is a parallel self-serve path.
      const res = await email.sendOfferWithContactEmail({
        to: offer.creator_email,
        firstName,
        brandName: offer.brand_name,
        offerUrl: url,
        expiryDate: expiry,
        whatsappNumber: waNumber,
        imessageNumber: imNumber,
      });
      if (res.sent) {
        const via = [waNumber && 'WhatsApp', imNumber && 'iMessage'].filter(Boolean).join(' / ');
        await logSend('email', `Offer email — link (${url}) + text "Hi" on ${via} option`);
        await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'invited', 'email')`, [
          offer.id,
        ]);
      }
    } else {
      // Reveals the full offer directly (no brief/interest-check phase over
      // email) — stamp 'revealed' so a later, unexpected WhatsApp/iMessage
      // contact from this creator isn't mistakenly briefed again.
      const res = await email.sendOfferEmail({ to: offer.creator_email, firstName, brandName: offer.brand_name, offerUrl: url, expiryDate: expiry });
      if (res.sent) {
        await logSend('email', `Offer email — "New collaboration opportunity — ${offer.brand_name}" (${url})`);
        await db.query(`UPDATE offers SET messaging_stage = 'revealed' WHERE id = $1`, [offer.id]);
      }
    }
  } catch (err) {
    console.error('[offers] outreach email failed', err.message);
  }
}

// Send the standalone messaging invite to a USED creator at INITIAL outreach,
// before any offer has been priced. Two paths:
//   • established_channel set (they've already messaged us — subscribed): reach
//     out DIRECTLY on that channel with a proactive interest message; no "text
//     Hi" email, no re-trigger from them. No priced offer exists yet, so this is
//     a brand/interest note — the approved offer is delivered over the same
//     channel once the admin prices it (see sendOfferOutreach).
//   • otherwise: the "text Hi on WhatsApp / iMessage to continue" invite email.
// Returns { sent, reason?, channels? }; the caller (outreach.sendOutreach) falls
// back to the normal email-outreach path when sent is false, so a used creator
// with no phone on file (or opted out, or no vendor configured) is never left
// uncontacted.
async function sendUsedCreatorInvite(creatorId) {
  const creator = await db.one(
    `SELECT c.id, c.email, c.first_name, c.full_name, c.whatsapp, c.imessage,
            c.messaging_opted_out, c.established_channel, ca.brand_name
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return { sent: false, reason: 'not_found' };

  // Subscribed (they've texted our number before, on any campaign) AND the
  // provider's free-form window is open → outreach goes straight to the chat, no
  // "Hi" needed. A closed window falls back to the email invite below, since a
  // free-form send would just be rejected by the provider.
  const subscribedChannel = await openChannelFor(creator);
  if (subscribedChannel) {
    const channel = subscribedChannel;
    const to = channel === 'imessage' ? creator.imessage : creator.whatsapp;
    if (to) {
      const firstName = firstNameOf(creator);
      const blurb = `We're running a new paid collaboration campaign${
        creator.brand_name ? ` with ${creator.brand_name}` : ''
      } and thought you'd be a great fit.`;
      const result = await sendBriefMessages(channel, { to, firstName, blurb });
      await logBriefMessages(result, (body, providerId) =>
        db.query(
          `INSERT INTO offer_messages (creator_id, direction, channel, body, provider_message_id)
           VALUES ($1, 'outbound', $2, $3, $4)`,
          [creator.id, channel, body, providerId || null],
        ),
      );
      if (result.sent) {
        // Establish this campaign's row too, so a reply here is handled in context.
        await subscribeCreatorChannel(creator.id, channel);
        return { sent: true, channels: [channel === 'imessage' ? 'iMessage' : 'WhatsApp'] };
      }
      // Channel send failed — fall through to the email invite below.
    }
  }

  if (!creator.email) return { sent: false, reason: 'no_email' };

  const { whatsappNumber, imessageNumber } = inviteNumbersFor(creator);
  if (!whatsappNumber && !imessageNumber) return { sent: false, reason: 'no_messaging_channel' };

  const res = await email.sendPortalInviteEmail({
    to: creator.email,
    firstName: firstNameOf(creator),
    brandName: creator.brand_name || 'INFLUENCE',
    whatsappNumber,
    imessageNumber,
  });
  if (!res.sent) {
    return { sent: false, reason: res.skipped ? 'email_not_configured' : res.error || 'send_failed' };
  }
  return {
    sent: true,
    channels: [whatsappNumber && 'WhatsApp', imessageNumber && 'iMessage'].filter(Boolean),
  };
}

// The CPM to auto-price a USED creator's new-campaign offer at. Chains, in the
// order the user asked for:
//   1. Creator-DB `cpm` — the canonical negotiated CPM across every campaign
//      this creator has done with us (creator-database's Creator model)
//   2. Bot-API `bookedCpm` from THIS creator's row on some campaign we've synced
//      — a per-campaign snapshot (campaigns.data on the local campaigns row)
//   3. Campaign `max_cpm` — the campaign's ceiling, our long-standing default
//      when no per-creator CPM is on file
// Returns { cpm, source }. cpm is always a positive finite number; source names
// where it came from for logging + tests.
async function resolvePriorCpm(creator, campaign) {
  const record = await creatorDb.lookupCpmFromCreatorDb({
    email: creator.email,
    instagramUsername: creator.instagram_username,
  });
  if (record != null) return { cpm: record, source: 'creator_db' };

  // campaigns.data may hold the raw bot-API payload with per-creator commercials
  // (creators[].commercials.bookedCpm). Match by lowercased email OR IG handle.
  const rows = (campaign && campaign.data && Array.isArray(campaign.data.creators)) ? campaign.data.creators : [];
  const em = String(creator.email || '').toLowerCase();
  const un = String(creator.instagram_username || '').toLowerCase().replace(/^@/, '');
  for (const r of rows) {
    const rem = String(r.email || '').toLowerCase();
    const run = String(r.username || '').toLowerCase().replace(/^@/, '');
    if ((em && rem === em) || (un && run === un)) {
      const c = r.commercials && r.commercials.bookedCpm;
      const n = c != null ? Number(c) : null;
      if (Number.isFinite(n) && n > 0) return { cpm: n, source: 'bot_api_bookedCpm' };
      break;
    }
  }

  const defaultCpm = Number(process.env.TARGET_CPM || 15);
  const cap = campaign && campaign.max_cpm != null ? Number(campaign.max_cpm) : defaultCpm;
  return { cpm: Number.isFinite(cap) && cap > 0 ? cap : defaultCpm, source: 'campaign_max_cpm' };
}

// Build a single auto-approved offer at the given CPM. Deterministic 1-video
// flat deal (creators can accept, decline, or counter on the portal). Uses p25
// as the conservative expected-views estimate — same percentile the pricing
// engine's per-video video-deal path uses (see pricing.computeOffers). Returns
// null when there are no view stats to price against.
function computeAutoOffer(stats, cpm) {
  const p25 = stats && Number(stats.p25);
  if (!Number.isFinite(p25) || p25 <= 0 || !Number.isFinite(cpm) || cpm <= 0) return null;
  const flatFee = Math.round((p25 * cpm) / 1000);
  return {
    offer_id: 'auto_video_1',
    offer_type: 'video_based',
    label: '1 Video Auto-Priced',
    num_videos: 1,
    flat_fee: flatFee,
    flat_per_video: flatFee,
    view_guarantee: 0,
    cpm_applied: +cpm.toFixed(2),
    satisfies_creator_rate: null,
    notes: '',
  };
}

// USED-creator outreach for a NEW campaign (called from outreach.sendOutreach
// when the "Send email" button fires). This is the auto-priced entry point:
// clicking IS the approval — no separate offer_approved step for Used creators.
//   • Load the creator + their campaign, gather the prior CPM.
//   • Auto-price a 1-video flat offer against their view stats and mint an offer
//     row (createOffer).
//   • Already messaging us in THIS campaign → deliver the offer DIRECTLY on that
//     channel (deliverOfferOverChannel, no "text Hi" step).
//   • Otherwise → send the friendly new-campaign offer email
//     (sendNewCampaignOfferEmail): offer link only, no chat buttons. The
//     graduation email is the one-time WhatsApp/iMessage connect invite; this
//     email doesn't repeat it.
// No view stats → this returns { sent: false, reason: 'no_stats' } and the
// caller (outreach.sendOutreach) falls back to the pre-Part-2 messaging invite
// so the creator still gets contacted while an admin gets stats + a proper
// priced offer in place.
async function sendUsedCreatorOffer(creatorId) {
  const creator = await db.one(
    `SELECT c.*, ca.brand_name AS campaign_brand_name, ca.max_cpm, ca.data AS campaign_data
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return { sent: false, reason: 'not_found' };
  if (creator.messaging_opted_out) return { sent: false, reason: 'opted_out' };

  // Never mint a second offer while one is live or already agreed. Every re-run
  // of outreach — a second dashboard click, a scheduler sweep, a retry — used to
  // create a fresh offer with a fresh token and deliver it, so the creator
  // collected a stack of competing links, and one that landed AFTER they had
  // accepted reopened a deal they had already signed.
  const live = await liveOfferFor(creatorId);
  if (live) {
    console.warn(
      `[offers] creator ${creatorId} already has a ${live.status} offer (${live.id}) — not pricing a second one`,
    );
    return { sent: false, reason: `offer_already_${live.status}`, offerId: live.id, token: live.token };
  }

  if (!creator.ig_scraped_data) return { sent: false, reason: 'no_stats' };

  const campaignForCpm = { max_cpm: creator.max_cpm, data: creator.campaign_data };
  const { cpm, source } = await resolvePriorCpm(creator, campaignForCpm);
  const approved = computeAutoOffer(creator.ig_scraped_data, cpm);
  if (!approved) return { sent: false, reason: 'no_stats' };

  const brandName = creator.campaign_brand_name || 'INFLUENCE';
  const terms = offerTermsFromApproved(
    { ...creator, brand_name: brandName, campaign_brand_name: brandName },
    approved,
  );
  const offer = await createOffer({ creatorId, ...terms });
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'offer_auto_priced', $2)`,
    [creatorId, { offer_id: offer.id, token: offer.token, cpm, cpm_source: source, flat_fee: approved.flat_fee }],
  );

  const firstName = firstNameOf(creator);
  const url = offerUrl(offer.token);
  const expiry = formatDate(offer.expires_at);

  // Subscribed and the window is open → DM the offer directly, no email.
  const subscribedChannel = await openChannelFor(creator);
  if (subscribedChannel) {
    try {
      await deliverOfferOverChannel(offer.id, subscribedChannel);
    } catch (err) {
      console.error('[offers] used-creator direct offer delivery failed', err.message);
    }
    return { sent: true, via: 'messaging', channels: [subscribedChannel === 'imessage' ? 'iMessage' : 'WhatsApp'], offerId: offer.id, token: offer.token, url };
  }

  // Not messaging us yet → friendly offer-link email (no chat CTAs — Used
  // creators were invited onto WhatsApp/iMessage by the graduation email).
  if (!creator.email) return { sent: false, reason: 'no_email', offerId: offer.id, token: offer.token };

  const res = await email.sendNewCampaignOfferEmail({
    to: creator.email,
    firstName,
    brandName,
    offerUrl: url,
    expiryDate: expiry,
  });
  if (!res.sent) {
    return { sent: false, reason: res.skipped ? 'email_not_configured' : res.error || 'send_failed', offerId: offer.id, token: offer.token };
  }
  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body)
     VALUES ($1, $2, 'outbound', 'email', $3)`,
    [creatorId, offer.id, `New-campaign offer email — link (${url})`],
  );
  await db.query(
    `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'email')`,
    [offer.id],
  );
  return { sent: true, via: 'email', channels: ['Email'], offerId: offer.id, token: offer.token, url };
}

// ONE reminder email to a USED creator who got the messaging invite but never
// engaged (no "Hi", no reply) after USED_INVITE_FOLLOWUP_HOURS. If an admin has
// already priced an offer, the reminder carries the portal link (view / accept /
// decline / counter); otherwise it re-nudges them to text "Hi". Idempotent:
// stamps creators.invite_followup_at on any non-transient outcome (the scheduler
// only picks rows where it's NULL), so a silent invitee is nudged at most once.
// A transient send failure is NOT stamped, so it retries next tick. Returns
// { sent, reason? }.
async function sendUsedCreatorInviteFollowup(creatorId) {
  const creator = await db.one(
    `SELECT c.id, c.email, c.first_name, c.full_name, c.whatsapp, c.imessage,
            c.messaging_opted_out, c.established_channel, ca.brand_name
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return { sent: false, reason: 'not_found' };

  const stamp = () =>
    db.query(`UPDATE creators SET invite_followup_at = NOW(), updated_at = NOW() WHERE id = $1`, [creatorId]);

  // Defensive re-checks (the scheduler already filters on these): once a creator
  // has engaged or opted out there's nothing to nudge — stamp so we don't retry.
  if (!creator.email) {
    await stamp();
    return { sent: false, reason: 'no_email' };
  }
  if (creator.messaging_opted_out || creator.established_channel) {
    await stamp();
    return { sent: false, reason: creator.established_channel ? 'already_engaged' : 'opted_out' };
  }

  const { whatsappNumber, imessageNumber } = inviteNumbersFor(creator);
  const brandName = creator.brand_name || 'INFLUENCE';
  const firstName = firstNameOf(creator);

  // Include the portal link only if a live (pending) offer already exists.
  const pending = await db.one(
    `SELECT token, expires_at FROM offers WHERE creator_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );

  // Nothing actionable: no live offer link AND no reachable messaging number to
  // invite them to. Stamp so we stop reconsidering this creator.
  if (!pending && !whatsappNumber && !imessageNumber) {
    await stamp();
    return { sent: false, reason: 'nothing_to_send' };
  }

  const res = pending
    ? await email.sendOfferWithContactEmail({
        to: creator.email,
        firstName,
        brandName,
        offerUrl: offerUrl(pending.token),
        expiryDate: formatDate(pending.expires_at),
        whatsappNumber,
        imessageNumber,
        reminder: true,
      })
    : await email.sendPortalInviteEmail({
        to: creator.email,
        firstName,
        brandName,
        whatsappNumber,
        imessageNumber,
        reminder: true,
      });
  if (!res.sent) {
    // Email provider not configured → nothing will ever send; stamp to stop.
    // A real transient error → leave unstamped so the next tick retries.
    if (res.skipped) {
      await stamp();
      return { sent: false, reason: 'email_not_configured' };
    }
    return { sent: false, reason: res.error || 'send_failed' };
  }

  await stamp();
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'invite_followup_sent', $2)`,
    [
      creatorId,
      {
        channels: [whatsappNumber && 'WhatsApp', imessageNumber && 'iMessage'].filter(Boolean),
        with_offer_link: !!pending,
      },
    ],
  );
  return { sent: true };
}

// One-time reminder for a pending offer that's been sitting open. Sends over
// the creator's established messaging channel (WhatsApp/iMessage) — the same
// channel the offer link went out on originally. Marks reminder_sent_at so a
// creator is never nudged twice about the same offer. Best-effort: a provider
// failure leaves the row unmarked so the next sweep can retry.
//
// The reminder deliberately doesn't include the rate or expiry countdown —
// this is a "still interested?" tap, not a new offer, and re-quoting the terms
// invites a re-negotiation on a link they've already seen.
async function sendOfferReminder(offerId) {
  const { offerReminderMessage } = require('./offerPortal/replies');
  const offer = await db.one(
    `SELECT o.id, o.token, o.status, o.brand_name, o.expires_at, o.reminder_sent_at,
            o.creator_id, c.first_name, c.full_name, c.whatsapp, c.imessage,
            c.messaging_opted_out, c.established_channel
     FROM offers o JOIN creators c ON c.id = o.creator_id
     WHERE o.id = $1`,
    [offerId],
  );
  if (!offer) return { sent: false, reason: 'not_found' };
  if (offer.reminder_sent_at) return { sent: false, reason: 'already_reminded' };
  if (offer.status !== 'pending') return { sent: false, reason: `not_pending:${offer.status}` };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { sent: false, reason: 'expired' };
  if (offer.messaging_opted_out) return { sent: false, reason: 'opted_out' };

  const channel = offer.established_channel;
  const to = channel === 'imessage' ? offer.imessage : channel === 'whatsapp' ? offer.whatsapp : null;
  if (!channel || !to) return { sent: false, reason: 'no_messaging_channel' };

  const body = offerReminderMessage({
    firstName: firstNameOf(offer),
    brandName: offer.brand_name,
    expiryFormatted: formatDate(offer.expires_at),
    offerUrl: offerUrl(offer.token),
  });

  try {
    const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
    const res = await send({ to, body });
    if (!res.sent) return { sent: false, reason: res.error || res.reason || 'send_failed' };
    // Stamp + log the send. Atomic on reminder_sent_at (`IS NULL` guard) so a
    // concurrent tick can never send two reminders for the same offer.
    const marked = await db.query(
      `UPDATE offers SET reminder_sent_at = NOW()
        WHERE id = $1 AND reminder_sent_at IS NULL`,
      [offer.id],
    );
    if (marked.rowCount === 0) return { sent: false, reason: 'raced' };
    await db.query(
      `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
       VALUES ($1, $2, 'outbound', $3, $4, $5)`,
      [offer.creator_id, offer.id, channel, body, res.id || null],
    );
    return { sent: true, channel };
  } catch (err) {
    console.error('[offers] reminder send failed', err.message);
    return { sent: false, reason: err.message };
  }
}

// Scheduled sweep: find pending offers that have been open for at least
// OFFER_REMINDER_AFTER_HOURS and still have at least
// OFFER_REMINDER_MIN_EXPIRY_MARGIN_HOURS to run before expiry, and send one
// reminder each. The min-margin guards against reminding at the last minute
// when the creator no longer has time to react — that's a bad experience worse
// than no reminder.
async function runOfferRemindersSweep({ limit = 25 } = {}) {
  const afterHours = Number(process.env.OFFER_REMINDER_AFTER_HOURS || 24);
  const marginHours = Number(process.env.OFFER_REMINDER_MIN_EXPIRY_MARGIN_HOURS || 6);
  if (!(afterHours > 0)) return { sent: 0, considered: 0 };

  const due = await db.many(
    `SELECT o.id
       FROM offers o
       JOIN creators c ON c.id = o.creator_id
      WHERE o.status = 'pending'
        AND o.reminder_sent_at IS NULL
        AND c.messaging_opted_out = FALSE
        AND c.established_channel IN ('whatsapp', 'imessage')
        AND o.created_at <= NOW() - ($1 || ' hours')::interval
        AND o.expires_at  >= NOW() + ($2 || ' hours')::interval
      ORDER BY o.created_at ASC
      LIMIT $3`,
    [afterHours, marginHours, limit],
  );

  let sent = 0;
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await sendOfferReminder(row.id);
      if (r.sent) sent += 1;
    } catch (err) {
      console.error(`[offers] reminder for offer ${row.id} failed:`, err.message);
    }
  }
  return { sent, considered: due.length };
}

// Follow-up dispatch on accept / decline. Best-effort across all channels.
//   accept  → email confirmation + WhatsApp/iMessage thank-you
//   decline → WhatsApp/iMessage polite close
async function onOfferResponded(offerId, response) {
  try {
    const offer = await db.one(
      `SELECT o.*, c.email AS creator_email, c.first_name, c.full_name, c.whatsapp, c.imessage,
              c.messaging_opted_out, c.established_channel
       FROM offers o JOIN creators c ON c.id = o.creator_id
       WHERE o.id = $1`,
      [offerId],
    );
    if (!offer) return;

    // Responding to one deal-option counter retires its siblings: a two-option
    // counter mints view-based + video-based children under one parent, and
    // acting on either (accept OR decline) resolves the whole set — the creator
    // can't then accept a leftover shape. Idempotent, and a no-op for a
    // single-counter child (no siblings). Covers web + WhatsApp/iMessage alike.
    if (offer.parent_offer_id != null) {
      try {
        await db.query(
          `UPDATE offers SET status = 'expired'
           WHERE parent_offer_id = $1 AND status = 'pending' AND id <> $2`,
          [offer.parent_offer_id, offer.id],
        );
      } catch (err) {
        console.error('[offers] sibling-option expiry failed', err.message);
      }
    }

    const firstName = firstNameOf(offer);
    const logSend = (channel, body, providerMessageId = null) =>
      db.query(
        `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
         VALUES ($1, $2, 'outbound', $3, $4, $5)`,
        [offer.creator_id, offer.id, channel, body, providerMessageId],
      );

    // Note: we deliberately DON'T send an acceptance-confirmation email here.
    // The old "our team will follow up in 1–2 business days" copy is obsolete
    // now that a used creator's next step (sign the mini-contract, then get
    // their personalised brief link) starts immediately on the same portal
    // page — an extra inbox email would set the wrong expectation.

    // WhatsApp / iMessage nudge / polite-close — only over an ALREADY-
    // established channel. A web response has nowhere to send this and doesn't
    // need to: accepting on the page advances straight to the sign view.
    //
    // Accept: the deal isn't confirmed until the mini contract is signed, so the
    // celebratory confirmation copy is DEFERRED to signMiniContract. Here we
    // just send the sign link so a messaged accept has a way to reach the page.
    // Decline: the polite-close copy stands as before.
    let body;
    if (response === 'accepted') {
      body = `${acceptedAwaitingSignatureMessage(firstName)}\n\n${offerUrl(offer.token)}`;
    } else if (offer.decline_reason === 'Not a fit') {
      // "Not a fit" gets the warmer, forward-looking close (see notAFitCloseMessage).
      body = notAFitCloseMessage(firstName);
    } else {
      body = politeCloseMessage(firstName);
    }
    const msgChannel = offer.messaging_opted_out ? null : offer.established_channel;
    if (msgChannel === 'whatsapp') {
      try {
        const res = await whatsapp.sendWhatsAppText({ to: offer.whatsapp, body });
        if (res.sent) await logSend('whatsapp', body, res.id);
      } catch (err) {
        console.error('[offers] follow-up WhatsApp failed', err.message);
      }
    } else if (msgChannel === 'imessage') {
      try {
        const res = await imessage.sendIMessageText({ to: offer.imessage, body });
        if (res.sent) await logSend('imessage', body, res.id);
      } catch (err) {
        console.error('[offers] follow-up iMessage failed', err.message);
      }
    }

    // Bridge back into the Deal Studio negotiation state so a portal accept /
    // decline advances the deal exactly like an admin-accepted rate:
    //   accept  → ACCEPTED (rate locked) + parked for the brand-POC contract
    //             approval (isContractApprovalPending → "Approve deal")
    //   decline → CLOSED
    // Best-effort and idempotent (guarded so a re-fire can't double-log).
    try {
      if (response === 'accepted') {
        const claimed = await db.one(
          `UPDATE creators
             SET negotiation_status = 'ACCEPTED', quoted_rate = $2,
                 offer_approved = FALSE, contract_approved = FALSE,
                 needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
                 updated_at = NOW()
           WHERE id = $1 AND negotiation_status IS DISTINCT FROM 'ACCEPTED'
           RETURNING id`,
          [offer.creator_id, Number(offer.rate)],
        );
        if (claimed) {
          // Attach the offer's pricing breakdown to the rate_accepted event so
          // the timeline can show HOW the accepted number was reached (same
          // format as rate_offer_sent — "N videos x V per-video views x $C CPM"
          // for video-based, "V views x $C CPM" for view-based). Fields come
          // from the creator's approved offer (custom_offer wins over the
          // selected suggested offer). If unavailable, we still log a plain
          // fee-only event — the admin just sees the total.
          const cr = await db.one(
            `SELECT custom_offer, selected_offer_id, suggested_offers FROM creators WHERE id = $1`,
            [offer.creator_id],
          );
          const acc =
            (cr && cr.custom_offer) ||
            (cr && cr.selected_offer_id && Array.isArray(cr.suggested_offers)
              ? cr.suggested_offers.find((o) => o && o.offer_id === cr.selected_offer_id)
              : null) ||
            (cr && Array.isArray(cr.suggested_offers) ? cr.suggested_offers[0] : null) ||
            null;
          const detail = { fee: Number(offer.rate), by: 'creator', source: 'offer_portal' };
          if (acc) {
            if (acc.offer_type) detail.offer_type = acc.offer_type;
            if (acc.cpm_applied != null) detail.cpm = Number(acc.cpm_applied);
            if (acc.view_guarantee != null) detail.views = Number(acc.view_guarantee);
            // Only video-shaped deals name a video count — leaving `videos`
            // out of a view-based detail lets the timeline render its total
            // views line instead of the per-video split.
            if ((acc.offer_type === 'video_based' || acc.offer_type === 'video_bonus') && acc.num_videos != null) {
              detail.videos = Number(acc.num_videos);
            }
            if (acc.bonus_amount != null) detail.bonus_amount = Number(acc.bonus_amount);
            if (acc.bonus_threshold_views != null) detail.bonus_threshold_views = Number(acc.bonus_threshold_views);
          }
          // Fallback: derive CPM from the offer row's rate + expected views
          // when the approved offer wasn't reachable (older rows / mid-flight
          // sync). Same math the rate_offer_sent renderer already does.
          if (detail.cpm == null && offer.expected_impressions && Number(offer.expected_impressions) > 0) {
            detail.views = detail.views != null ? detail.views : Number(offer.expected_impressions);
            detail.cpm = Number(((Number(offer.rate) * 1000) / Number(offer.expected_impressions)).toFixed(2));
          }
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_accepted', $2)`,
            [offer.creator_id, detail],
          );
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_approval_requested', $2)`,
            [offer.creator_id, { fee: Number(offer.rate) }],
          );
        }
      } else if (response === 'declined') {
        const claimed = await db.one(
          `UPDATE creators SET negotiation_status = 'CLOSED', updated_at = NOW()
           WHERE id = $1 AND negotiation_status IS DISTINCT FROM 'ACCEPTED'
           RETURNING id`,
          [offer.creator_id],
        );
        if (claimed) {
          await db.query(
            `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'negotiation_closed', $2)`,
            [offer.creator_id, { reason: 'offer_declined', via: 'offer_portal', declineReason: offer.decline_reason || null }],
          );
        }
      }
    } catch (err) {
      console.error('[offers] deal-studio bridge failed', err.message);
    }
  } catch (err) {
    console.error('[offers] onOfferResponded failed', err.message);
  }
}

// Update an OUTBOUND message's delivery state from a provider status callback
// (sent / delivered / read / failed), correlated by the id the gateway returned
// on send. A status we can't match to a row (unknown id) is a no-op, never an
// error — status callbacks and sends race, and some sends predate id capture.
async function recordDeliveryStatus({ channel, providerMessageId, status }) {
  if (!providerMessageId || !status) return { ok: false, reason: 'incomplete' };
  const res = await db.query(
    `UPDATE offer_messages
        SET delivery_status = $3, delivery_status_at = NOW()
      WHERE provider_message_id = $1 AND channel = $2 AND direction = 'outbound'`,
    [providerMessageId, channel, status],
  );
  return { ok: true, updated: res.rowCount };
}

// ---------------------------------------------------------------------------
// Budget negotiation (CPM-based counter) — ported from offers.ts
// ---------------------------------------------------------------------------

function cpmToleranceAbs() {
  const raw = Number(process.env.COUNTER_CPM_TOLERANCE);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.5;
}
function legacyRateTolerancePct() {
  const raw = Number(process.env.COUNTER_RATE_TOLERANCE_PCT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.15;
}
// How far above the creator's established PRIOR-campaign CPM a counter-ask may
// reach before we decline it outright. Default 1.0 → a request more than 2× the
// prior CPM is "too high" (the standing offer stays live so they can still take
// it); anything at or under 2× is answered with counter deal options. Anchored
// to the prior CPM — not the current offer's — so the ceiling doesn't creep
// upward across a chain of counters. Overridable via MAX_CPM_INCREASE_PCT.
function maxCpmIncreasePct() {
  const raw = Number(process.env.MAX_CPM_INCREASE_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}
function computeCounterRate(originalRate, requestedRate) {
  if (process.env.COUNTER_STRATEGY === 'match') return requestedRate;
  const midpoint = Math.round((originalRate + requestedRate) / 2);
  return Math.min(midpoint, requestedRate);
}

function parseDeliverableLine(line) {
  const match = String(line).trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  return { count: Number(match[1]), label: match[2] };
}
function totalDeliverableUnits(deliverables) {
  const parsed = deliverables.map(parseDeliverableLine);
  if (parsed.every((p) => p !== null)) return parsed.reduce((sum, p) => sum + p.count, 0);
  return deliverables.length;
}
function expandDeliverables(deliverables, extraUnits) {
  const parsed = deliverables.map(parseDeliverableLine);
  if (parsed.every((p) => p !== null)) {
    let bumpIndex = 0;
    for (let i = 1; i < parsed.length; i += 1) {
      if (parsed[i].count > parsed[bumpIndex].count) bumpIndex = i;
    }
    const bumped = parsed[bumpIndex];
    const next = [...deliverables];
    next[bumpIndex] = `${bumped.count + extraUnits} ${bumped.label}`;
    return { deliverables: next, addedLabel: `${extraUnits} more ${bumped.label}` };
  }
  const lastLabel = deliverables[deliverables.length - 1];
  return {
    deliverables: [...deliverables, `${extraUnits} extra ${lastLabel}`],
    addedLabel: `${extraUnits} extra ${lastLabel}`,
  };
}

// Round a view count to a clean number for display + guarantee. Rounds UP to the
// nearest 5,000 (min 5,000) so the guaranteed impressions are always >= what the
// CPM math requires — i.e. our effective CPM lands at or below the cap, never above.
function roundViewsUp(views) {
  const step = 5000;
  return Math.max(step, Math.ceil(views / step) * step);
}
// Compact human view label, e.g. 250000 -> "250K", 1500000 -> "1.5M".
function formatViews(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

// Pure. Express ONE "pay the creator their requestedRate while holding OUR CPM at
// capCpm" deal two ways so the creator can choose the shape they prefer:
//   • view_based  — we guarantee the impressions needed to hit capCpm at that rate
//   • video_based — that same impression target expressed as whole Reels at the
//                   creator's CURRENT median per-video views (medianViews)
// Both carry the same rate; only the deliverable shape differs. Returns
// [viewOption, videoOption], each { dealType, label, deliverables[], rate,
// expectedImpressions, viewGuarantee|null, numVideos|null }. Unit-testable with no
// DB — mirrors the requiredImpressions math already used by expand_deliverables.
function buildCounterOptions({ requestedRate, capCpm, medianViews }) {
  const requiredImpressions = (requestedRate * 1000) / capCpm;
  const viewGuarantee = roundViewsUp(requiredImpressions);
  const numVideos = Math.max(1, Math.ceil(requiredImpressions / medianViews));
  const noun = numVideos === 1 ? 'Reel' : 'Reels';
  return [
    {
      dealType: 'view_based',
      label: 'View-based',
      deliverables: [`Guaranteed ${formatViews(viewGuarantee)} views`],
      rate: requestedRate,
      expectedImpressions: viewGuarantee,
      viewGuarantee,
      numVideos: null,
    },
    {
      dealType: 'video_based',
      label: 'Video-based',
      deliverables: [`${numVideos} ${noun}`],
      rate: requestedRate,
      expectedImpressions: Math.round(numVideos * medianViews),
      viewGuarantee: null,
      numVideos,
    },
  ];
}

// Judge a creator's counter-ask by CPM (see offers.ts for the full rationale).
// `channel` scopes the two-deal-option flow to the web offer page ('web'); a
// counter that arrives over WhatsApp/iMessage keeps the single-counter behavior
// (options need the interactive portal to choose between).
async function negotiateBudget({ token, requestedRate, channel = 'web' }) {
  if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
    return { ok: false, reason: 'invalid_rate' };
  }

  const offer = await db.one(`SELECT * FROM offers WHERE token = $1`, [token]);
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  const originalRate = Number(offer.rate);
  const impressions = offer.expected_impressions != null ? Number(offer.expected_impressions) : null;
  const deliverablesArr = Array.isArray(offer.deliverables) ? offer.deliverables : [];

  // The creator's established prior-campaign CPM sets the hard ceiling for how
  // far a counter can push (see maxCpmIncreasePct). Best-effort: if we can't
  // resolve it, the ceiling falls back to the current offer's own CPM below.
  let priorCpm = null;
  let medianViews = null;
  try {
    const ctx = await db.one(
      `SELECT c.email, c.instagram_username, c.ig_scraped_data, ca.max_cpm, ca.data AS campaign_data
         FROM creators c
         LEFT JOIN campaigns ca ON ca.id = $2
        WHERE c.id = $1`,
      [offer.creator_id, offer.campaign_id],
    );
    if (ctx) {
      const resolved = await resolvePriorCpm(
        { email: ctx.email, instagram_username: ctx.instagram_username },
        { max_cpm: ctx.max_cpm, data: ctx.campaign_data },
      );
      if (resolved && Number.isFinite(resolved.cpm) && resolved.cpm > 0) priorCpm = resolved.cpm;
      // Current per-video views from Deal Studio stats — median (p50), then p25 —
      // used to size the video-based counter option. Null → no options, single
      // counter fallback.
      const stats = ctx.ig_scraped_data;
      const p50 = stats && Number(stats.p50);
      const p25 = stats && Number(stats.p25);
      medianViews = Number.isFinite(p50) && p50 > 0 ? p50 : Number.isFinite(p25) && p25 > 0 ? p25 : null;
    }
  } catch (err) {
    console.error('[offers] prior-CPM ceiling lookup failed', err.message);
  }

  let plan;
  if (impressions && impressions > 0) {
    const cpmOriginal = (originalRate / impressions) * 1000;
    const cpmRequested = (requestedRate / impressions) * 1000;
    const cpmTolerance = cpmToleranceAbs();

    // Hard ceiling first: a counter more than maxCpmIncreasePct above the
    // creator's prior-campaign CPM is declined outright — the standing offer
    // stays live so they can go back to it. Anchor to the prior CPM (not the
    // current offer's, so the ceiling can't creep up a chain of counters), but
    // never below "our own offer + tolerance" so a small ask over a standing
    // offer we already priced high is never rejected as too-high.
    const ceilingBaseCpm = priorCpm != null ? priorCpm : cpmOriginal;
    const ceilingCpm = Math.max(ceilingBaseCpm * (1 + maxCpmIncreasePct()), cpmOriginal + cpmTolerance);

    if (cpmRequested > ceilingCpm) {
      plan = { kind: 'too_high' };
    } else if (cpmRequested - cpmOriginal <= cpmTolerance) {
      // Within tolerance of our offer → counter at (roughly) their rate.
      plan = { kind: 'same_terms', rate: computeCounterRate(originalRate, requestedRate) };
    } else {
      // Higher than our offer, but at/under 2× the prior CPM. Hold OUR CPM at the
      // cap while paying their rate.
      const capCpm = cpmOriginal + cpmTolerance;
      // On the web portal, when we have current view stats, present the deal as a
      // CHOICE between a view-based and a video-based shape (sized from the
      // creator's median views). Otherwise (messaging counter, or no stats) keep
      // the single "match the rate, add a deliverable" counter.
      if (channel === 'web' && medianViews != null) {
        plan = {
          kind: 'offer_options',
          rate: requestedRate,
          options: buildCounterOptions({ requestedRate, capCpm, medianViews }),
        };
      } else {
        const requiredImpressions = (requestedRate * 1000) / capCpm;
        const extraImpressions = requiredImpressions - impressions;
        const totalUnits = totalDeliverableUnits(deliverablesArr);
        const perUnitImpressions = impressions / totalUnits;
        const extraUnits = Math.ceil(extraImpressions / perUnitImpressions);
        const { deliverables, addedLabel } = expandDeliverables(deliverablesArr, extraUnits);
        plan = {
          kind: 'expand_deliverables',
          rate: requestedRate,
          deliverables,
          expectedImpressions: Math.round(impressions + extraUnits * perUnitImpressions),
          addedLabel,
        };
      }
    }
  } else {
    const maxAcceptableRate = originalRate * (1 + legacyRateTolerancePct());
    plan =
      requestedRate <= maxAcceptableRate
        ? { kind: 'same_terms', rate: computeCounterRate(originalRate, requestedRate) }
        : { kind: 'too_high' };
  }

  // Too high → don't touch the offer. Record the ask, keep it pending.
  if (plan.kind === 'too_high') {
    await db.query(
      `UPDATE offers SET requested_rate = $2 WHERE id = $1 AND status = 'pending'`,
      [offer.id, requestedRate],
    );
    return {
      ok: true,
      outcome: 'too_high',
      originalRateFormatted: formatMoney(offer.rate, offer.currency),
      requestedRateFormatted: formatMoney(requestedRate, offer.currency),
    };
  }

  // Two-option counter (web portal): decline the original and mint one child
  // offer per deal shape (view-based + video-based); the creator picks on the page.
  if (plan.kind === 'offer_options') {
    return mintCounterOptions(offer, requestedRate, plan.options);
  }

  // Otherwise → decline the original (recording the ask) and mint a counter-offer
  // atomically. Retry the whole transaction on a token collision.
  const counterDeliverables = plan.kind === 'expand_deliverables' ? plan.deliverables : deliverablesArr;
  const counterImpressions =
    plan.kind === 'expand_deliverables' ? plan.expectedImpressions : offer.expected_impressions;

  let counterId = null;
  let raced = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counterToken = generateOfferToken();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await db.withTransaction(async (client) => {
        const declined = await client.query(
          `UPDATE offers SET status = 'declined', decline_reason = 'Budget', requested_rate = $2
           WHERE id = $1 AND status = 'pending'`,
          [offer.id, requestedRate],
        );
        if (declined.rowCount === 0) return { raced: true, counterId: null };
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'declined', 'web')`,
          [offer.id],
        );
        const { rows } = await client.query(
          `INSERT INTO offers
             (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, parent_offer_id, expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            offer.creator_id,
            offer.campaign_id,
            counterToken,
            offer.brand_name,
            JSON.stringify(counterDeliverables),
            plan.rate,
            offer.currency,
            counterImpressions != null ? counterImpressions : null,
            offer.id,
            new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400000),
          ],
        );
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
          [rows[0].id],
        );
        return { raced: false, counterId: rows[0].id };
      });
      raced = result.raced;
      counterId = result.counterId;
      break;
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }

  if (raced || !counterId) return { ok: false, reason: 'already_responded' };

  // Deliver the counter directly ONLY if this creator already has an
  // established messaging channel (mid-conversation on WhatsApp/iMessage) — a
  // web-originated counter is already shown right on the offer page the creator
  // is looking at, so no extra send (and no cold-outreach invite email) is
  // needed there.
  try {
    const channel = await establishedMessagingChannel(offer.creator_id);
    if (channel) await deliverOfferOverChannel(counterId, channel);
  } catch (err) {
    console.error('[offers] counter delivery failed', err.message);
  }

  const counter = await db.one(`SELECT * FROM offers WHERE id = $1`, [counterId]);
  if (!counter) return { ok: false, reason: 'already_responded' };

  return {
    ok: true,
    outcome: 'countered',
    counter: {
      token: counter.token,
      brandName: counter.brand_name,
      deliverables: counter.deliverables,
      rate: Number(counter.rate),
      currency: counter.currency,
      rateFormatted: formatMoney(counter.rate, counter.currency),
      expiresFormatted: formatDate(counter.expires_at),
      deliverablesChanged: plan.kind === 'expand_deliverables',
      addedLabel: plan.kind === 'expand_deliverables' ? plan.addedLabel : null,
    },
  };
}

// Web-portal two-option counter. Decline the parent offer (recording the ask)
// and mint ONE child offer per deal shape (view-based + video-based) — both
// carrying the creator's requested rate, differing only in deliverables. The
// creator picks one on the offer page; accepting it retires the sibling (see the
// parent_offer_id sweep in onOfferResponded). Every row shares the parent's
// brand/currency/campaign and a single expiry. The whole mint is one transaction
// retried as a unit on a token collision, so the two children are always created
// together (never a half-set). Returns { ok, outcome:'options', options:[…] }.
async function mintCounterOptions(offer, requestedRate, options) {
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400000);
  let minted = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const withTokens = options.map((opt) => ({ ...opt, token: generateOfferToken() }));
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await db.withTransaction(async (client) => {
        const declined = await client.query(
          `UPDATE offers SET status = 'declined', decline_reason = 'Budget', requested_rate = $2
           WHERE id = $1 AND status = 'pending'`,
          [offer.id, requestedRate],
        );
        if (declined.rowCount === 0) return { raced: true, options: null };
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'declined', 'web')`,
          [offer.id],
        );
        for (const opt of withTokens) {
          // eslint-disable-next-line no-await-in-loop
          const { rows } = await client.query(
            `INSERT INTO offers
               (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, parent_offer_id, expires_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
             RETURNING id`,
            [
              offer.creator_id,
              offer.campaign_id,
              opt.token,
              offer.brand_name,
              JSON.stringify(opt.deliverables),
              opt.rate,
              offer.currency,
              opt.expectedImpressions != null ? opt.expectedImpressions : null,
              offer.id,
              expiresAt,
            ],
          );
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
            [rows[0].id],
          );
        }
        return { raced: false, options: withTokens };
      });
      if (result.raced) return { ok: false, reason: 'already_responded' };
      minted = result.options;
      break;
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }

  if (!minted) return { ok: false, reason: 'already_responded' };

  return {
    ok: true,
    outcome: 'options',
    options: minted.map((opt) => ({
      token: opt.token,
      dealType: opt.dealType,
      label: opt.label,
      brandName: offer.brand_name,
      deliverables: opt.deliverables,
      rate: Number(opt.rate),
      currency: offer.currency,
      rateFormatted: formatMoney(opt.rate, offer.currency),
      expiresFormatted: formatDate(expiresAt),
      viewGuarantee: opt.viewGuarantee,
      numVideos: opt.numVideos,
    })),
  };
}

// ---------------------------------------------------------------------------
// Schedule negotiation (a "Timing" decline) — ask the creator when they're free
// and either re-offer for their dates or park the deal for an admin follow-up.
// ---------------------------------------------------------------------------

// How soon a proposed start date must be for us to accommodate it automatically
// (re-offer the same terms on their dates). Beyond this the deal goes on hold
// for an admin schedule-counter. Default 14 days; override SCHEDULE_THRESHOLD_DAYS.
function scheduleThresholdDays() {
  const raw = Number(process.env.SCHEDULE_THRESHOLD_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
}

// Parse a creator-supplied availability date. Accepts an ISO 'YYYY-MM-DD' (what
// <input type="date"> posts) or anything Date.parse understands. Returns a Date
// at local midnight, or null when unparseable.
function parseAvailableDate(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(Date.parse(s));
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// Whole days from local today to `date` (negative when in the past).
function daysUntil(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 86400000);
}

function isoDate(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const da = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// Decline `offer` for Timing and mint a fresh SAME-terms offer carrying the
// creator's requested start date, atomically. Mirrors negotiateBudget's
// counter-mint (retry on token collision). Returns { raced, counterId }.
async function mintScheduledOffer(offer, startDateIso) {
  const deliverables = Array.isArray(offer.deliverables) ? offer.deliverables : [];
  let counterId = null;
  let raced = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counterToken = generateOfferToken();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await db.withTransaction(async (client) => {
        const declined = await client.query(
          `UPDATE offers SET status = 'declined', decline_reason = 'Timing', schedule_hold = FALSE
           WHERE id = $1 AND status = 'pending'`,
          [offer.id],
        );
        if (declined.rowCount === 0) return { raced: true, counterId: null };
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'declined', 'web')`,
          [offer.id],
        );
        const { rows } = await client.query(
          `INSERT INTO offers
             (creator_id, campaign_id, token, brand_name, deliverables, rate, currency, expected_impressions, parent_offer_id, requested_start_date, expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            offer.creator_id,
            offer.campaign_id,
            counterToken,
            offer.brand_name,
            JSON.stringify(deliverables),
            offer.rate,
            offer.currency,
            offer.expected_impressions != null ? offer.expected_impressions : null,
            offer.id,
            startDateIso,
            new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400000),
          ],
        );
        await client.query(
          `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'sent', 'web')`,
          [rows[0].id],
        );
        return { raced: false, counterId: rows[0].id };
      });
      raced = result.raced;
      counterId = result.counterId;
      break;
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // token collision — retry
      throw err;
    }
  }
  return { raced, counterId };
}

// The creator picked "Timing" and told us when they're free. Within the
// accommodation window → re-offer the same terms on their dates (a fresh offer
// they can accept right on the portal). Further out → park the deal on hold and
// flag Deal Studio so an admin can send a schedule-counter.
async function negotiateSchedule({ token, availableDate }) {
  const date = parseAvailableDate(availableDate);
  if (!date) return { ok: false, reason: 'invalid_date' };
  if (daysUntil(date) < 0) return { ok: false, reason: 'invalid_date' };

  const offer = await db.one(`SELECT * FROM offers WHERE token = $1`, [token]);
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // Within the window → accommodate automatically with a fresh same-terms offer.
  if (daysUntil(date) <= scheduleThresholdDays()) {
    const { raced, counterId } = await mintScheduledOffer(offer, isoDate(date));
    if (raced || !counterId) return { ok: false, reason: 'already_responded' };

    // Deliver directly only over an already-established messaging channel — a
    // web-originated re-offer is already shown on the page the creator is on.
    try {
      const channel = await establishedMessagingChannel(offer.creator_id);
      if (channel) await deliverOfferOverChannel(counterId, channel);
    } catch (err) {
      console.error('[offers] rescheduled offer delivery failed', err.message);
    }

    const counter = await db.one(`SELECT * FROM offers WHERE id = $1`, [counterId]);
    if (!counter) return { ok: false, reason: 'already_responded' };
    return {
      ok: true,
      outcome: 'rescheduled',
      counter: {
        token: counter.token,
        brandName: counter.brand_name,
        deliverables: counter.deliverables,
        rate: Number(counter.rate),
        currency: counter.currency,
        rateFormatted: formatMoney(counter.rate, counter.currency),
        expiresFormatted: formatDate(counter.expires_at),
        startDateFormatted: counter.requested_start_date ? formatDate(counter.requested_start_date) : null,
      },
    };
  }

  // Further out than the window → park on hold (NOT closed) for an admin
  // schedule-counter, and surface it in Deal Studio.
  const held = await db.one(
    `UPDATE offers SET schedule_hold = TRUE, requested_start_date = $2
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [offer.id, isoDate(date)],
  );
  if (!held) return { ok: false, reason: 'already_responded' };
  await db.query(
    `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'schedule_hold', 'web')`,
    [offer.id],
  );
  // Bridge to Deal Studio: park the deal on hold (never over an ACCEPTED one).
  try {
    await db.query(
      `UPDATE creators SET negotiation_status = 'ON_HOLD', updated_at = NOW()
       WHERE id = $1 AND negotiation_status IS DISTINCT FROM 'ACCEPTED'`,
      [offer.creator_id],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'schedule_hold', $2)`,
      [offer.creator_id, { available_date: isoDate(date), via: 'offer_portal' }],
    );
  } catch (err) {
    console.error('[offers] schedule-hold bridge failed', err.message);
  }
  return { ok: true, outcome: 'on_hold', startDateFormatted: formatDate(date) };
}

// Admin action from Deal Studio for an on-hold (or any latest) offer: send the
// creator a fresh same-terms offer on a revised start date the admin chooses.
// Reuses mintScheduledOffer, then delivers over every available channel
// (email + WhatsApp/iMessage) via sendOfferOutreach so a parked creator is
// actually re-contacted. Clears the hold + ON_HOLD deal state.
async function sendRescheduledOffer({ creatorId, startDate }) {
  const date = parseAvailableDate(startDate);
  if (!date) return { ok: false, reason: 'invalid_date' };
  if (daysUntil(date) < 0) return { ok: false, reason: 'invalid_date' };

  const offer = await db.one(
    `SELECT * FROM offers WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
  if (!offer) return { ok: false, reason: 'no_offer' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_responded' };

  const { raced, counterId } = await mintScheduledOffer(offer, isoDate(date));
  if (raced || !counterId) return { ok: false, reason: 'already_responded' };

  // The parked deal is live again — clear the hold state.
  try {
    await db.query(
      `UPDATE creators SET negotiation_status = NULL, updated_at = NOW()
       WHERE id = $1 AND negotiation_status = 'ON_HOLD'`,
      [creatorId],
    );
  } catch (err) {
    console.error('[offers] reschedule state clear failed', err.message);
  }

  let sendResult = null;
  try {
    sendResult = await sendOfferOutreach(counterId);
  } catch (err) {
    console.error('[offers] rescheduled offer send failed', err.message);
  }

  const counter = await db.one(`SELECT * FROM offers WHERE id = $1`, [counterId]);
  return {
    ok: true,
    token: counter.token,
    url: offerUrl(counter.token),
    startDateFormatted: counter.requested_start_date ? formatDate(counter.requested_start_date) : null,
    send_result: sendResult,
  };
}

// ---------------------------------------------------------------------------
// Page data + Deal Studio entry point
// ---------------------------------------------------------------------------

// The mini contract shown on the offer page after acceptance — deliberately
// only the collaboration essentials the creator signs off on, NO contact/bank
// details (that's the heavy full-contract system's job). Deliverables/brand/
// campaign come from real data; platforms + timeline default to sensible
// standard terms (these creators are Instagram-first; the deliverables are
// Reels). `offer` must carry brand_name, deliverables, campaign_name,
// first_name/full_name.
// Instagram Reels drive every offer-portal deal, so Instagram is always in the
// contract; TikTok and YouTube Shorts are opt-in and picked by the creator in
// the interstitial step between accept and sign. INSTAGRAM must stay the first
// element — the contract snapshot and the outbound sync both rely on that order.
const CONTRACT_PLATFORMS_DEFAULT = ['Instagram'];
const CONTRACT_PLATFORM_OPTIONAL = ['TikTok', 'YouTube Shorts'];
const CONTRACT_PLATFORMS_ALL = ['Instagram', ...CONTRACT_PLATFORM_OPTIONAL];
const CONTRACT_TIMELINE_DEFAULT = 'Content to be posted within 3 weeks of signing.';

// Normalise a user-supplied platforms array to the canonical token order and
// deduplicate. Instagram is always included. Unknown tokens are dropped
// (defense-in-depth against a hand-crafted POST). Case-insensitive, so 'tiktok'
// / 'youtube shorts' from anywhere in the flow still lands on the right token.
function normalizeContractPlatforms(raw) {
  const wanted = new Set(['Instagram']);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const lower = String(item || '').trim().toLowerCase();
      for (const canon of CONTRACT_PLATFORMS_ALL) {
        if (canon.toLowerCase() === lower) wanted.add(canon);
      }
    }
  }
  return CONTRACT_PLATFORMS_ALL.filter((p) => wanted.has(p));
}

function creatorFullName(creator) {
  return (
    (creator.full_name && String(creator.full_name).trim()) ||
    (creator.first_name && String(creator.first_name).trim()) ||
    'Creator'
  );
}

function miniContractTerms(offer) {
  // A schedule-negotiated offer (requested_start_date set) carries the agreed
  // start date into the contract timeline instead of the standard boilerplate.
  const startDate = offer.requested_start_date ? formatDate(offer.requested_start_date) : null;
  // Platforms come from the creator's post-accept picker when they've completed
  // it; before that (or for legacy offers) the sensible Instagram-only default
  // stands in so the contract preview never renders empty.
  const picked = Array.isArray(offer.contract_platforms) ? offer.contract_platforms : null;
  const platforms = picked && picked.length ? normalizeContractPlatforms(picked) : CONTRACT_PLATFORMS_DEFAULT.slice();
  // Prefer the campaign's explicit posting deadline over the "3 weeks from
  // signing" boilerplate — the offer portal now renders this as an accurate
  // calendar date under a "Deadline" row instead of the vague "Timeline".
  const deadline = offer.campaign_deadline_date
    ? formatDate(offer.campaign_deadline_date)
    : null;
  return {
    creatorName: creatorFullName(offer),
    brandName: offer.brand_name,
    campaignName: (offer.campaign_name && String(offer.campaign_name).trim()) || null,
    deliverables: Array.isArray(offer.deliverables) ? offer.deliverables : [],
    platforms,
    // `deadline` is the accurate calendar date the portal shows verbatim;
    // `timeline` is kept for the signed-contract snapshot fallback (and for
    // any legacy consumer still reading the old field) so old rows still
    // render sensibly.
    deadline: deadline || null,
    timeline: deadline
      ? `Content to be posted by ${deadline}.`
      : startDate
        ? `Content to be posted around ${startDate}.`
        : CONTRACT_TIMELINE_DEFAULT,
  };
}

// Data the public offer page renders (mirrors o/[token]/page.tsx). Logs a view.
async function getOfferForPage(token) {
  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name,
            ca.name AS campaign_name,
            ca.deadline_date AS campaign_deadline_date
     FROM offers o
     JOIN creators c ON c.id = o.creator_id
     LEFT JOIN campaigns ca ON ca.id = o.campaign_id
     WHERE o.token = $1`,
    [token],
  );
  if (!offer) return null;

  try {
    await logOfferViewed(offer.id);
  } catch (_) {
    /* never let a logging failure break the page */
  }

  const expired = offer.status === 'pending' && new Date(offer.expires_at).getTime() < Date.now();
  const onHold = offer.status === 'pending' && offer.schedule_hold;
  const signed = !!offer.contract_signed_at;
  // A used creator picks their posting platforms (Instagram required, TikTok +
  // YouTube Shorts optional) right after acceptance, before the mini contract
  // renders. `platforms` fires only for accepted-but-unsigned offers with no
  // saved picker choice — a reload lands them back on the picker until they
  // continue through to the contract.
  const platformsChosen = Array.isArray(offer.contract_platforms) && offer.contract_platforms.length > 0;
  const initialState =
    offer.status === 'accepted'
      ? signed
        ? 'signed'
        : platformsChosen
          ? 'contract'
          : 'platforms'
      : offer.status === 'declined'
        ? 'declined'
        : onHold
          ? 'on_hold'
          : expired
            ? 'expired'
            : 'active';

  // The signed snapshot (immutable) wins over the live-computed terms once signed.
  const contract =
    signed && offer.contract_terms && typeof offer.contract_terms === 'object'
      ? offer.contract_terms
      : miniContractTerms(offer);

  return {
    token: offer.token,
    firstName: firstNameOf(offer),
    brandName: offer.brand_name,
    deliverables: Array.isArray(offer.deliverables) ? offer.deliverables : [],
    rate: Number(offer.rate),
    currency: offer.currency,
    rateFormatted: formatMoney(offer.rate, offer.currency),
    expiresFormatted: formatDate(offer.expires_at),
    initialState,
    // When this offer is a schedule-negotiated one, the date the creator asked
    // for (so the active view can reassure them it's on their dates), plus the
    // on-hold flag for the "we'll be in touch" view.
    scheduleHold: !!offer.schedule_hold,
    startDateFormatted: offer.requested_start_date ? formatDate(offer.requested_start_date) : null,
    contract,
    contractSigned: signed,
    signerName: offer.contract_signer_name || null,
    signedAtFormatted: offer.contract_signed_at ? formatDate(offer.contract_signed_at) : null,
    // Post-accept platform picker: the required + optional tokens the page
    // renders as checkboxes, and any already-picked selection so a reload
    // pre-checks their previous choice.
    platformOptions: {
      required: CONTRACT_PLATFORMS_DEFAULT.slice(),
      optional: CONTRACT_PLATFORM_OPTIONAL.slice(),
    },
    selectedPlatforms: platformsChosen ? offer.contract_platforms.slice() : null,
  };
}

// Save the platforms the creator picked in the interstitial step between accept
// and sign. Guarded so it only applies to an accepted-but-unsigned offer;
// re-callable up until the moment they sign (so the "back" affordance can move
// the picker forward again). Best-effort event log.
async function selectContractPlatforms({ token, platforms }) {
  const offer = await db.one(
    `SELECT id, status, contract_signed_at, creator_id FROM offers WHERE token = $1`,
    [token],
  );
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'accepted') return { ok: false, reason: 'not_accepted' };
  if (offer.contract_signed_at) return { ok: false, reason: 'already_signed' };

  const normalized = normalizeContractPlatforms(platforms);
  const upd = await db.query(
    `UPDATE offers SET contract_platforms = $2::jsonb
      WHERE id = $1 AND status = 'accepted' AND contract_signed_at IS NULL`,
    [offer.id, JSON.stringify(normalized)],
  );
  if (upd.rowCount === 0) return { ok: false, reason: 'already_signed' };

  try {
    await db.query(
      `INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'platforms_selected', 'web')`,
      [offer.id],
    );
  } catch (err) {
    console.error('[offers] platforms_selected event log failed', err.message);
  }
  return { ok: true, platforms: normalized };
}

// Record the creator's signature on the mini contract. Guarded: the offer must
// be accepted and not already signed. Snapshots the exact terms shown at signing
// into contract_terms (immutable record). Best-effort event logging.
async function signMiniContract({ token, signature, signerName, ip }) {
  // The signature is the creator's drawn image (a data:image/png|jpeg URL, same
  // as the full contract's signature pad). Guard its shape and cap its size so
  // an oversized / foreign payload can't be stored.
  const sig = typeof signature === 'string' ? signature : '';
  if (!/^data:image\/(png|jpe?g);base64,/i.test(sig) || sig.length > 2000000) {
    return { ok: false, reason: 'signature_required' };
  }

  const offer = await db.one(
    `SELECT o.*, c.first_name, c.full_name,
            ca.name AS campaign_name,
            ca.deadline_date AS campaign_deadline_date
     FROM offers o
     JOIN creators c ON c.id = o.creator_id
     LEFT JOIN campaigns ca ON ca.id = o.campaign_id
     WHERE o.token = $1`,
    [token],
  );
  if (!offer) return { ok: false, reason: 'not_found' };
  if (offer.status !== 'accepted') return { ok: false, reason: 'not_accepted' };
  if (offer.contract_signed_at) return { ok: false, reason: 'already_signed' };
  // The picker must be completed before signing — the UI walks the creator
  // through it, but a direct POST that skips it is refused here as well so the
  // snapshot never captures an implicit "Instagram only" the creator never saw.
  if (!Array.isArray(offer.contract_platforms) || offer.contract_platforms.length === 0) {
    return { ok: false, reason: 'platforms_required' };
  }

  // Signer name for the record: an explicitly provided name wins, else the known
  // creator name (returning creators are already identified) — no typing needed.
  const name = String(signerName || offer.full_name || offer.first_name || '').trim() || 'Creator';

  const terms = miniContractTerms(offer);
  // RETURNING the row gives the emailed copy below the stored signature and the
  // server's own signed_at, rather than a client-side reconstruction of them.
  const signedRow = await db.one(
    `UPDATE offers
        SET contract_signed_at = NOW(), contract_signer_name = $2,
            contract_signer_ip = $3, contract_terms = $4::jsonb,
            contract_signature = $5
      WHERE id = $1 AND status = 'accepted' AND contract_signed_at IS NULL
      RETURNING *`,
    [offer.id, name, ip || null, JSON.stringify(terms), sig],
  );
  if (!signedRow) return { ok: false, reason: 'already_signed' };

  try {
    await db.query(`INSERT INTO offer_events (offer_id, event, channel) VALUES ($1, 'signed', 'web')`, [offer.id]);
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'mini_contract_signed', $2)`,
      [offer.creator_id, { by: name, offerToken: token }],
    );
  } catch (err) {
    console.error('[offers] mini-contract sign logging failed', err.message);
  }

  // A used creator's portal signature IS their contract — Deal Studio already
  // holds their prior-campaign details and the offer portal covers acceptance
  // + a drawn signature, so there's no separate contract to email and nothing
  // for admin to approve. Auto-set contract_approved so the row skips the
  // "Approve deal" delegate, and start the personalised brief immediately.
  // Best-effort — the signature is already saved; failures here never block it.
  try {
    await db.query(
      `UPDATE creators SET contract_approved = TRUE, updated_at = NOW()
        WHERE id = $1 AND contract_approved = FALSE`,
      [offer.creator_id],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_auto_approved_portal_signed', $2)`,
      [offer.creator_id, { offerToken: token }],
    );
  } catch (err) {
    console.error('[offers] auto-approve on portal sign failed', err.message);
  }

  // Push the signed creator into the CURRENT campaign's dashboard row, same as
  // routes/contracts.js does for new/unused creators on the full contract flow.
  // The comment above is about Creator-DB (cross-campaign identity, already
  // known for a returning creator) — the campaign dashboard row is per-campaign,
  // so a used creator still needs one created here, or they never show up on
  // the campaign page. Best-effort — the signature is already saved; failures
  // here never block it.
  if (campaignDashboard.isConfigured()) {
    try {
      const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [offer.creator_id]);
      await campaignDashboard.syncSignedCreator(
        { token: offer.token, data: { platforms: terms.platforms } },
        creator,
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_dashboard_synced', $2)`,
        [offer.creator_id, { offerToken: offer.token, ok: true }],
      );
    } catch (err) {
      console.error('[offers] campaign-dashboard sync failed', err.message);
    }
  } else {
    console.warn('[offers] CAMPAIGN_DASHBOARD_URL not set — skipping dashboard sync');
  }

  try {
    await require('./briefs').flagBriefPending(offer.creator_id);
  } catch (err) {
    console.error('[offers] flagBriefPending failed', err.message);
  }

  // Open the WhatsApp campaign-update lane — the same one routes/contracts.js
  // opens on the full contract. A used creator signing here has usually already
  // been messaging us, so onContractSigned finds the window open and skips
  // straight past the "send us a Hi" ask. Lazily required: creatorUpdates
  // requires nothing from offers.js today, but the brief/offer paths make that a
  // plausible future edge, and every other cross-service call in this file
  // already takes the lazy form for exactly that reason.
  try {
    await require('./creatorUpdates').onContractSigned(offer.creator_id, { campaignId: offer.campaign_id });
  } catch (err) {
    console.error('[offers] creator-updates subscribe failed', err.message);
  }

  // Email the creator their executed copy with the signed PDF attached — the
  // same courtesy the full contract flow gives (routes/contracts.js). A used
  // creator's portal signature IS their contract, so this is the only copy they
  // ever get. Best-effort: the signature is already saved, and the scheduler's
  // retry sweep picks up anything that doesn't go out now.
  let copyEmailed = false;
  try {
    const sendResult = await require('./signedContractEmail').sendMiniContractCopy({
      ...signedRow,
      // The portal query's joined columns aren't on the RETURNING row.
      first_name: offer.first_name,
      full_name: offer.full_name,
      campaign_name: offer.campaign_name,
    });
    copyEmailed = !!sendResult.sent;
    if (!sendResult.sent && !sendResult.skipped) {
      console.error('[offers] mini-contract copy email failed:', sendResult.error);
    }
  } catch (err) {
    console.error('[offers] mini-contract copy email threw:', err.message);
  }

  // WhatsApp / iMessage confirmation — the deal is now truly confirmed, and
  // this is the message where the "🎉" earns its place. Sent only over an
  // ALREADY-established channel, same rule as respondToOffer, and carrying a
  // link back to the (now-signed) portal so they can pull up the agreement.
  // Best-effort: the signature is already saved, so a send failure here never
  // undoes anything.
  const msgChannel = offer.messaging_opted_out ? null : offer.established_channel;
  if (msgChannel === 'whatsapp' || msgChannel === 'imessage') {
    const firstName = firstNameOf(offer);
    const body = `${thankYouMessage(firstName)}\n\nView your agreement here: ${offerUrl(offer.token)}`;
    const to = msgChannel === 'imessage' ? offer.imessage : offer.whatsapp;
    if (to) {
      try {
        const send = msgChannel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
        const res = await send({ to, body });
        if (res.sent) {
          await db.query(
            `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
             VALUES ($1, $2, 'outbound', $3, $4, $5)`,
            [offer.creator_id, offer.id, msgChannel, body, res.id || null],
          );
        }
      } catch (err) {
        console.error('[offers] sign-confirmation message failed', err.message);
      }
    }
  }

  return { ok: true, signerName: name, signedAtFormatted: formatDate(new Date()), copyEmailed };
}

// Translate an admin-approved Deal Studio offer (pricing.js shape) into portal
// terms. Deliverables become "<n> Reels"; the CPM math needs an impression
// estimate — the guaranteed views for a view-based deal, else the creator's
// median reel views × the number of videos.
function offerTermsFromApproved(creator, approved) {
  const numVideos = Number(approved.num_videos) || 1;
  const rate = Number(approved.flat_fee);
  const noun = numVideos === 1 ? 'Reel' : 'Reels';
  const deliverables = [`${numVideos} ${noun}`];

  let expectedImpressions = null;
  if (approved.offer_type === 'view_based' && Number(approved.view_guarantee) > 0) {
    expectedImpressions = Math.round(Number(approved.view_guarantee));
  } else {
    const stats = creator.ig_scraped_data;
    const median = stats && Number(stats.p50) > 0 ? Number(stats.p50) : null;
    if (median) expectedImpressions = Math.round(median * numVideos);
  }

  return {
    brandName: creator.brand_name || creator.campaign_brand_name || 'INFLUENCE',
    deliverables,
    rate,
    currency: process.env.OFFER_CURRENCY || 'USD',
    expectedImpressions,
    campaignId: creator.campaign_id || null,
  };
}

// Deal Studio entry point for OLD creators. Mints the approved offer as an
// offer-portal offer and sends its link over email + WhatsApp + iMessage.
// Returns the offer id/token/url (or a skip reason when no contact channel).
async function sendPortalOffer(creatorId, approved) {
  const creator = await db.one(
    `SELECT c.*, ca.brand_name AS campaign_brand_name
     FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
  if (!creator) return { skipped: 'creator not found' };
  if (!approved || approved.flat_fee == null) return { skipped: 'no approved offer to send' };
  if (!creator.email && !creator.whatsapp && !creator.imessage) {
    return { skipped: 'no email / WhatsApp / iMessage on file for this creator' };
  }

  // Same duplicate guard as sendUsedCreatorOffer — a second click on "send
  // offer" must not put a competing link in front of the creator, and must never
  // land a new offer on top of one they have already accepted.
  const live = await liveOfferFor(creatorId);
  if (live) {
    return {
      skipped: `creator already has a ${live.status} offer — decline or expire it before sending another`,
      offerId: live.id,
      token: live.token,
      url: offerUrl(live.token),
    };
  }

  const terms = offerTermsFromApproved(creator, approved);
  const offer = await createOffer({ creatorId, ...terms });
  await sendOfferOutreach(offer.id);
  return { offerId: offer.id, token: offer.token, url: offerUrl(offer.token) };
}

// Attach a `portal_offer` summary to each dashboard creator row: the current
// (latest) offer, its status, and per-channel activity (email/WhatsApp/iMessage
// sends + replies) so the Status column can show the offer-portal + messaging
// updates. Batched across all rows. Rows with no offer are left untouched.
async function attachOffers(rows) {
  if (!rows || !rows.length) return;
  const ids = rows.map((r) => r.id);

  const latest = await db.many(
    `SELECT DISTINCT ON (creator_id) *
     FROM offers WHERE creator_id = ANY($1::int[])
     ORDER BY creator_id, created_at DESC`,
    [ids],
  );
  if (!latest.length) return;

  const offerByCreator = new Map(latest.map((o) => [o.creator_id, o]));
  const offerIds = latest.map((o) => o.id);

  const [events, msgs] = await Promise.all([
    db.many(
      `SELECT offer_id, event, channel, occurred_at
       FROM offer_events WHERE offer_id = ANY($1::int[])
       ORDER BY occurred_at ASC`,
      [offerIds],
    ),
    db.many(
      `SELECT creator_id, direction, channel, needs_review, delivery_status, sent_at
       FROM offer_messages WHERE creator_id = ANY($1::int[])
       ORDER BY sent_at ASC`,
      [ids],
    ),
  ]);

  const eventsByOffer = new Map();
  for (const e of events) {
    if (!eventsByOffer.has(e.offer_id)) eventsByOffer.set(e.offer_id, []);
    eventsByOffer.get(e.offer_id).push(e);
  }
  const msgByCreator = new Map();
  for (const m of msgs) {
    if (!msgByCreator.has(m.creator_id)) msgByCreator.set(m.creator_id, []);
    msgByCreator.get(m.creator_id).push(m);
  }

  const newer = (a, b) => new Date(a).getTime() > new Date(b).getTime();

  for (const r of rows) {
    const o = offerByCreator.get(r.id);
    if (!o) continue;
    const evs = eventsByOffer.get(o.id) || [];
    const cms = msgByCreator.get(r.id) || [];

    const channels = {
      email: { sent: false },
      whatsapp: { sent: false, replied: false, delivery: null },
      imessage: { sent: false, replied: false, delivery: null },
    };
    let needsReview = false;
    let lastActivityAt = o.created_at;

    for (const m of cms) {
      const ch = channels[m.channel];
      if (ch) {
        if (m.direction === 'outbound') {
          ch.sent = true;
          // Latest outbound wins (rows are ordered by sent_at ASC).
          if ('delivery' in ch && m.delivery_status) ch.delivery = m.delivery_status;
        } else if (m.direction === 'inbound' && 'replied' in ch) ch.replied = true;
      }
      if (m.needs_review) needsReview = true;
      if (newer(m.sent_at, lastActivityAt)) lastActivityAt = m.sent_at;
    }
    for (const e of evs) {
      if (newer(e.occurred_at, lastActivityAt)) lastActivityAt = e.occurred_at;
    }
    // Whether the creator has actually seen the offer page (a `viewed` event).
    const viewed = evs.some((e) => e.event === 'viewed');

    r.portal_offer = {
      token: o.token,
      status: o.status,
      url: offerUrl(o.token),
      rate: Number(o.rate),
      currency: o.currency,
      rateFormatted: formatMoney(o.rate, o.currency),
      // The creator's higher counter-ask recorded on a still-live offer (a
      // "too high" pushback) — so the admin can see what they wanted vs. what's
      // on the table. Null unless they've pushed back.
      requestedRate: o.requested_rate != null ? Number(o.requested_rate) : null,
      requestedRateFormatted: o.requested_rate != null ? formatMoney(o.requested_rate, o.currency) : null,
      // Why they declined (Budget / Timing / Not a fit), when they told us.
      declineReason: o.decline_reason || null,
      // Schedule negotiation: a still-live offer parked because the creator's
      // availability is beyond the accommodation window (awaiting an admin
      // schedule-counter), plus the date they asked for.
      scheduleHold: !!o.schedule_hold,
      requestedStartFormatted: o.requested_start_date ? formatDate(o.requested_start_date) : null,
      requestedStartISO: o.requested_start_date
        ? String(o.requested_start_date instanceof Date ? o.requested_start_date.toISOString() : o.requested_start_date).slice(0, 10)
        : null,
      expiresAt: o.expires_at,
      // Whether they've signed the portal mini-contract — the dashboard's
      // "Approve deal" pop-up uses this to show that approving starts the brief
      // (no separate contract is sent) rather than emailing a contract.
      signed: !!o.contract_signed_at,
      isCounter: o.parent_offer_id != null,
      viewed,
      events: evs.map((e) => ({ event: e.event, channel: e.channel, at: e.occurred_at })),
      channels,
      needsReview,
      lastActivityAt,
    };
  }
}

// ---------------------------------------------------------------------------
// needs_review inbox — inbound replies the bot couldn't confidently action
// ---------------------------------------------------------------------------

// List flagged inbound messages with the creator + offer context the admin inbox
// renders. Newest first.
async function listNeedsReview({ limit = 200 } = {}) {
  return db.many(
    `SELECT m.id, m.creator_id, m.channel, m.body, m.sent_at, m.offer_id,
            c.first_name, c.full_name, c.instagram_username, c.whatsapp, c.imessage,
            o.token AS offer_token, o.status AS offer_status,
            o.rate AS offer_rate, o.currency AS offer_currency
       FROM offer_messages m
       JOIN creators c ON c.id = m.creator_id
       LEFT JOIN offers o ON o.id = m.offer_id
      WHERE m.direction = 'inbound' AND m.needs_review = TRUE
      ORDER BY m.sent_at DESC
      LIMIT $1`,
    [limit],
  );
}

// Send an admin's free-form reply on the creator's channel and clear the flag on
// the inbound message it answers. Returns { ok, reason? }.
async function replyToNeedsReview({ messageId, body }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, reason: 'empty_body' };

  const msg = await db.one(
    `SELECT m.id, m.creator_id, m.channel, m.offer_id, c.whatsapp, c.imessage, c.messaging_opted_out
       FROM offer_messages m JOIN creators c ON c.id = m.creator_id
      WHERE m.id = $1 AND m.direction = 'inbound'`,
    [messageId],
  );
  if (!msg) return { ok: false, reason: 'not_found' };
  if (msg.messaging_opted_out) return { ok: false, reason: 'creator_opted_out' };

  const to = msg.channel === 'imessage' ? msg.imessage : msg.channel === 'whatsapp' ? msg.whatsapp : null;
  if (!to) return { ok: false, reason: 'no_contact_for_channel' };

  let sendResult;
  if (msg.channel === 'whatsapp') sendResult = await whatsapp.sendWhatsAppText({ to, body: text });
  else if (msg.channel === 'imessage') sendResult = await imessage.sendIMessageText({ to, body: text });
  else return { ok: false, reason: 'unsupported_channel' };

  if (!sendResult.sent) {
    return { ok: false, reason: sendResult.skipped ? 'channel_not_configured' : sendResult.error || 'send_failed' };
  }

  await db.query(
    `INSERT INTO offer_messages (creator_id, offer_id, direction, channel, body, provider_message_id)
     VALUES ($1, $2, 'outbound', $3, $4, $5)`,
    [msg.creator_id, msg.offer_id, msg.channel, text, sendResult.id || null],
  );
  await db.query(`UPDATE offer_messages SET needs_review = FALSE WHERE id = $1`, [messageId]);
  return { ok: true };
}

// Clear the flag without replying (dismiss).
async function resolveNeedsReview({ messageId }) {
  const res = await db.query(
    `UPDATE offer_messages SET needs_review = FALSE
      WHERE id = $1 AND direction = 'inbound' AND needs_review = TRUE`,
    [messageId],
  );
  return { ok: true, cleared: res.rowCount };
}

module.exports = {
  generateOfferToken,
  offerUrl,
  establishedMessagingChannel,
  subscribedChannelFor,
  subscribeCreatorChannel,
  openChannelFor,
  conversationWindowOpen,
  optedOutAnywhere,
  inviteNumbersFor,
  sendUsedCreatorInvite,
  sendUsedCreatorOffer,
  resolvePriorCpm,
  computeAutoOffer,
  sendUsedCreatorInviteFollowup,
  sendOfferReminder,
  runOfferRemindersSweep,
  sendUsedCreatorBrief,
  sendOfferBriefing,
  deliverOfferOverChannel,
  deliverBriefToCreator,
  createOffer,
  respondToOffer,
  listNeedsReview,
  replyToNeedsReview,
  resolveNeedsReview,
  logOfferViewed,
  sendOfferOutreach,
  recordDeliveryStatus,
  negotiateBudget,
  buildCounterOptions,
  negotiateSchedule,
  sendRescheduledOffer,
  getOfferForPage,
  miniContractTerms,
  signMiniContract,
  selectContractPlatforms,
  normalizeContractPlatforms,
  sendPortalOffer,
  offerTermsFromApproved,
  attachOffers,
};
