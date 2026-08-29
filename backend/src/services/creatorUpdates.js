'use strict';

// Campaign-update messaging for SIGNED creators — the WhatsApp lane that starts
// at a creator's first signature and keeps running from one campaign to the
// next.
//
// The offer portal (offers.js) courts a creator up TO the signature and stops
// there. Everything after it — "here's your brief", "the brand approved your
// draft", "you're all done" — used to reach the creator only by email, which is
// where campaign updates go to die. This module is that same stream of updates
// delivered to the phone they already reply on.
//
// ---------------------------------------------------------------------------
// The one constraint everything here is shaped by: the 24h window
// ---------------------------------------------------------------------------
// WhatsApp does not let a business send free-form text to someone who hasn't
// messaged it in the last 24 hours. Campaign updates are, by nature, produced
// outside that window: a brief is published on Tuesday, a brand approves on
// Friday, and the creator has no reason to have written in on either day. So
// every update takes one of two routes:
//
//   • Window OPEN (they messaged us within 24h) → free-form text. Costs
//     nothing, reads naturally, carries links and full feedback verbatim.
//   • Window SHUT → a pre-approved TEMPLATE, if one is registered for that kind
//     (WHATSAPP_TEMPLATE_* env vars). A template can start a conversation, and
//     the creator's reply then opens the window for everything queued behind it.
//
// When neither route is available the update is NOT dropped and NOT sent by
// some other means behind the creator's back — it stays `pending` in
// creator_updates and the sweep delivers it the moment a window opens. That is
// why the queue exists: the alternative is silently losing the approval message
// a creator is waiting on.
//
// ---------------------------------------------------------------------------
// The two entry scenarios (see also routes/offerWebhook.js)
// ---------------------------------------------------------------------------
// Scenario 1 — the creator sends "Hi" (usually because we asked). The inbound
//   opens the window: we send the intro, then flush everything queued for them
//   in the order it happened. Handled by onInboundMessage().
// Scenario 2 — the creator signs and never writes in. requestHi() asks for that
//   inbound (template if we can start a conversation, else email with a wa.me
//   deep link). Updates queue up meanwhile and go out as templates where one is
//   configured, so a silent creator still gets their brief and their approval.
//
// ---------------------------------------------------------------------------
// After the campaign ends
// ---------------------------------------------------------------------------
// Completing deliverables does NOT unsubscribe anyone. onDeliverablesComplete
// sends the wrap-up (whose copy says so plainly) and leaves the subscription
// live, so the next campaign's outreach lands in a thread the creator already
// knows instead of a cold email. Only a STOP reply ends it — that's handled by
// the existing messaging_opted_out flag, which this module honours everywhere.

const db = require('../db');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const email = require('./offerPortal/email');
const msg = require('./offerPortal/updateMessages');

// How long a creator's inbound keeps the free-form window open. Meta's number,
// not ours — mirrored from offers.OPEN_CONVERSATION_HOURS.
const WINDOW_HOURS = 24;

// A `pending` row that has failed this many times stops being retried by the
// sweep and is surfaced as `failed` instead of being attempted forever.
const MAX_ATTEMPTS = Number(process.env.CREATOR_UPDATE_MAX_ATTEMPTS || 8);

// Every update kind, with the copy that renders it and the env var naming its
// approved WhatsApp template (for the window-shut path).
//
// `templateEnv` is a NAME, not a template: the approved copy lives in the
// WhatsApp Manager and is matched to a kind by configuration, so a kind with no
// template configured simply waits for a window instead of failing. `params`
// picks the positional {{1}}, {{2}} … variables out of the payload, and MUST
// stay in the same order as the approved body — see the .env.example notes.
const UPDATE_KINDS = {
  brief_ready: {
    render: (p) => msg.briefReady(p),
    templateEnv: 'WHATSAPP_TEMPLATE_BRIEF_READY',
    params: (p) => [p.firstName, p.brandName],
    // A template whose approved copy ends in a dynamic URL button takes the
    // link as a SUFFIX to the fixed prefix registered with Meta.
    linkOf: (p) => p.briefUrl,
  },
  review_submitted: {
    render: (p) => msg.reviewSubmitted(p),
    templateEnv: 'WHATSAPP_TEMPLATE_REVIEW_SUBMITTED',
    params: (p) => [p.firstName, p.brandName],
  },
  review_approved: {
    render: (p) => msg.reviewApproved(p),
    templateEnv: 'WHATSAPP_TEMPLATE_REVIEW_APPROVED',
    params: (p) => [p.firstName, p.brandName],
    linkOf: (p) => p.submitPostsUrl,
  },
  review_feedback: {
    render: (p) => msg.reviewFeedback(p),
    templateEnv: 'WHATSAPP_TEMPLATE_REVIEW_FEEDBACK',
    params: (p) => [p.firstName, p.brandName],
    linkOf: (p) => p.chatUrl,
  },
  post_submitted: {
    render: (p) => msg.postSubmitted(p),
    templateEnv: 'WHATSAPP_TEMPLATE_POST_SUBMITTED',
    params: (p) => [p.firstName, p.brandName],
  },
  deliverables_complete: {
    render: (p) => msg.deliverablesComplete(p),
    templateEnv: 'WHATSAPP_TEMPLATE_DELIVERABLES_COMPLETE',
    params: (p) => [p.firstName, p.brandName],
  },
  next_campaign: {
    render: (p) => msg.nextCampaignOutreach(p),
    templateEnv: 'WHATSAPP_TEMPLATE_NEXT_CAMPAIGN',
    params: (p) => [p.firstName, p.brandName],
  },
};

function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(UPDATE_KINDS, kind);
}

const firstNameOf = (c) =>
  (c && c.first_name && String(c.first_name).trim()) ||
  (c && c.full_name ? String(c.full_name).trim().split(/\s+/)[0] : '') ||
  'there';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Everything a send decision needs, in one row: contact details, subscription
// state, opt-out, and the campaign name for the copy.
async function loadCreator(creatorId) {
  return db.one(
    `SELECT c.id, c.first_name, c.full_name, c.email, c.whatsapp, c.imessage,
            c.established_channel, c.messaging_opted_out,
            c.updates_subscribed_at, c.updates_hi_requested_at,
            c.updates_intro_sent_at, c.updates_last_inbound_at, c.updates_campaign_id,
            c.campaign_id, ca.brand_name, ca.name AS campaign_name
       FROM creators c
       LEFT JOIN campaigns ca ON ca.id = COALESCE(c.updates_campaign_id, c.campaign_id)
      WHERE c.id = $1`,
    [creatorId],
  );
}

// Resolve a creator from what the Influence bot knows about them: an Instagram
// handle and/or an email, optionally scoped to a campaign.
//
// The bot's world is the campaign dashboard, which identifies creators by
// handle; ours is keyed on our own creators rows, one per creator PER campaign.
// So a handle can legitimately match several rows and we have to choose: the row
// for the named campaign first, then the most recently subscribed row (the
// campaign they're actually working on now), then the newest row. Matching on
// the subscription is what keeps an update about this month's campaign from
// landing on a two-year-old row with no phone number on it.
async function resolveCreator({ username, email: creatorEmail, campaignId } = {}) {
  const handle = String(username || '').replace(/^@/, '').trim().toLowerCase();
  const mail = String(creatorEmail || '').trim().toLowerCase();
  if (!handle && !mail) return null;

  const rows = await db.many(
    `SELECT id, campaign_id, updates_subscribed_at, created_at
       FROM creators
      WHERE ($1 <> '' AND lower(instagram_username) = $1)
         OR ($2 <> '' AND lower(email) = $2)`,
    [handle, mail],
  );
  if (!rows.length) return null;

  const wanted = String(campaignId || '').trim();
  const scored = rows.slice().sort((a, b) => {
    if (wanted) {
      const am = a.campaign_id === wanted ? 1 : 0;
      const bm = b.campaign_id === wanted ? 1 : 0;
      if (am !== bm) return bm - am;
    }
    const asub = a.updates_subscribed_at ? new Date(a.updates_subscribed_at).getTime() : 0;
    const bsub = b.updates_subscribed_at ? new Date(b.updates_subscribed_at).getTime() : 0;
    if (asub !== bsub) return bsub - asub;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return scored[0];
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

// A creator just signed their first contract — open the update lane.
//
// Idempotent on updates_subscribed_at, so the second campaign a creator signs
// for does NOT reset the subscription or re-ask for "Hi": they are already in
// the conversation, and updates_campaign_id simply moves to the new campaign.
// Called from both signing paths (routes/contracts.js and offers.signMiniContract)
// because "first contract" means the first one either way.
//
// Returns { subscribed, alreadySubscribed?, hiRequest? }.
async function onContractSigned(creatorId, { campaignId } = {}) {
  const c = await loadCreator(creatorId);
  if (!c) return { subscribed: false, reason: 'not_found' };

  const already = !!c.updates_subscribed_at;
  await db.query(
    `UPDATE creators
        SET updates_subscribed_at = COALESCE(updates_subscribed_at, NOW()),
            updates_campaign_id   = COALESCE($2, updates_campaign_id, campaign_id),
            updated_at = NOW()
      WHERE id = $1`,
    [creatorId, campaignId || null],
  );
  await db
    .query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'updates_subscribed', $2)`, [
      creatorId,
      { campaignId: campaignId || c.campaign_id || null, alreadySubscribed: already },
    ])
    .catch((err) => console.error('[creator-updates] subscribe logging failed', err.message));

  if (already) return { subscribed: true, alreadySubscribed: true };

  // Fresh subscription: ask for the inbound that makes free-form updates
  // possible. Best-effort — a failure here leaves them subscribed, and the
  // sweep re-asks.
  let hiRequest = null;
  try {
    hiRequest = await requestHi(creatorId);
  } catch (err) {
    console.error('[creator-updates] hi request failed', err.message);
  }
  return { subscribed: true, alreadySubscribed: false, hiRequest };
}

// Is this creator's free-form window open right now?
function windowOpen(c) {
  if (!c || !c.updates_last_inbound_at) return false;
  return Date.now() - new Date(c.updates_last_inbound_at).getTime() < WINDOW_HOURS * 3600_000;
}

// Can we message this creator at all on this lane? Ordered so the returned
// reason names the FIRST thing that would need fixing.
function sendability(c) {
  if (!c) return { ok: false, reason: 'not_found' };
  if (!c.updates_subscribed_at) return { ok: false, reason: 'not_subscribed' };
  if (c.messaging_opted_out) return { ok: false, reason: 'opted_out' };
  if (!c.whatsapp && !c.imessage) return { ok: false, reason: 'no_contact' };
  return { ok: true };
}

// Which channel carries this creator's updates. WhatsApp is the lane's home —
// it's the channel with a template mechanism, so it's the only one that can
// reach a creator outside a live window — but a creator who established the
// conversation on iMessage keeps it there rather than being moved.
function channelFor(c) {
  if (c.established_channel === 'imessage' && c.imessage) return 'imessage';
  if (c.whatsapp) return 'whatsapp';
  if (c.imessage) return 'imessage';
  return null;
}

function contactFor(c, channel) {
  return channel === 'imessage' ? c.imessage : c.whatsapp;
}

// The wa.me deep link that prefills "Hi", so the ask is one tap. Null unless we
// have a business number to point at.
function hiDeepLink() {
  const number = whatsapp.normalizePhone(whatsapp.businessNumber());
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent('Hi')}`;
}

// Ask a signed creator to send us "Hi".
//
// Route order is "whichever can actually start a conversation": a WhatsApp
// template first (it lands in the same thread the updates will use), then
// email carrying the wa.me link. Stamps updates_hi_requested_at on ANY
// outcome including a config skip, so a misconfigured deploy asks once and
// shows up in the logs rather than re-asking on every sweep.
async function requestHi(creatorId, { force = false } = {}) {
  const c = await loadCreator(creatorId);
  const can = sendability(c);
  // A creator with no phone number can still be emailed the ask — that's how
  // they'd get onto WhatsApp in the first place — so 'no_contact' isn't fatal
  // here the way it is for an actual update.
  if (!can.ok && can.reason !== 'no_contact') return { sent: false, reason: can.reason };
  if (!force && c.updates_hi_requested_at) return { sent: false, reason: 'already_requested' };
  if (windowOpen(c)) return { sent: false, reason: 'window_already_open' };

  const firstName = firstNameOf(c);
  const brandName = c.brand_name || 'your campaign';
  const stamp = () =>
    db.query(`UPDATE creators SET updates_hi_requested_at = NOW(), updated_at = NOW() WHERE id = $1`, [creatorId]);

  const templateName = process.env.WHATSAPP_TEMPLATE_HI_REQUEST || '';
  if (c.whatsapp && templateName && whatsapp.templatesAvailable()) {
    const result = await whatsapp.sendWhatsAppTemplate({
      to: c.whatsapp,
      name: templateName,
      bodyParams: [firstName, brandName],
    });
    if (result.sent) {
      const body = msg.hiRequestMessage({ firstName, brandName });
      await logOutbound(creatorId, 'whatsapp', body, result.id);
      await stamp();
      return { sent: true, via: 'whatsapp_template' };
    }
    console.warn(
      `[creator-updates] hi-request template to creator ${creatorId} failed — ${result.error || result.reason || 'skipped'}`,
    );
  }

  if (c.email) {
    const { subject, body } = msg.hiRequestEmail({
      firstName,
      brandName,
      whatsappLink: hiDeepLink(),
      whatsappNumber: whatsapp.businessNumber() || null,
    });
    const result = await email.sendProseEmail({ to: c.email, subject, body });
    if (result.sent) {
      await stamp();
      return { sent: true, via: 'email' };
    }
    await stamp();
    return { sent: false, reason: result.skipped ? 'email_not_configured' : result.error || 'email_failed' };
  }

  await stamp();
  return { sent: false, reason: 'no_route' };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function logOutbound(creatorId, channel, body, providerMessageId) {
  return db
    .query(
      `INSERT INTO offer_messages (creator_id, direction, channel, body, provider_message_id)
       VALUES ($1, 'outbound', $2, $3, $4)`,
      [creatorId, channel, body, providerMessageId || null],
    )
    .catch((err) => console.error('[creator-updates] outbound logging failed', err.message));
}

// Queue an update, then try to deliver it immediately.
//
// THE entry point for every campaign update (the bot API route, the brief
// publish, the deliverables sweep). Queue-first is deliberate: the write is what
// guarantees the update survives a shut window, a provider outage or a restart,
// and the immediate delivery attempt is just the happy path on top of it.
//
// `dedupKey` is the underlying event's natural key — the review id, the post
// url. The campaign dashboard fires webhooks AND is polled as a safety net, so
// the same approval genuinely arrives twice; the unique index turns the second
// one into a no-op instead of a duplicate message.
async function notify(creatorId, kind, data = {}, { dedupKey, campaignId } = {}) {
  if (!isKnownKind(kind)) return { queued: false, reason: `unknown_kind:${kind}` };

  const c = await loadCreator(creatorId);
  const can = sendability(c);
  if (!can.ok) {
    // Not queued at all when the creator can never receive it: an unsubscribed
    // or opted-out creator would otherwise accumulate a backlog that fires the
    // day someone adds a phone number to their row.
    if (can.reason === 'not_subscribed' || can.reason === 'opted_out' || can.reason === 'not_found') {
      return { queued: false, reason: can.reason };
    }
  }

  const key = dedupKey ? `${kind}:${dedupKey}` : null;
  const inserted = await db.one(
    `INSERT INTO creator_updates (creator_id, campaign_id, kind, payload, dedup_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [creatorId, campaignId || c.updates_campaign_id || c.campaign_id || null, kind, JSON.stringify(data || {}), key],
  );
  if (!inserted) return { queued: false, reason: 'duplicate', dedupKey: key };

  const result = await deliverPending(inserted.id);
  return { queued: true, id: inserted.id, ...result };
}

// Render an update row into the exact text the creator will read. Payload
// fields the caller didn't supply (the creator's own name, the brand) are
// filled from their row here, so callers only pass what's specific to the event.
function renderUpdate(row, creator) {
  const spec = UPDATE_KINDS[row.kind];
  if (!spec) return null;
  const payload = {
    firstName: firstNameOf(creator),
    brandName: (row.payload && row.payload.brandName) || creator.brand_name || 'your campaign',
    ...(row.payload || {}),
  };
  // The row's stored brandName wins when set, but an empty string in the
  // payload must not blank out the creator's real brand.
  if (!payload.brandName) payload.brandName = creator.brand_name || 'your campaign';
  return { body: spec.render(payload), payload, spec };
}

// Deliver one queued update. The single place the window/template decision is
// made, so the sweep and the immediate attempt can never diverge.
//
// Terminal outcomes mark the row; a "can't send YET" leaves it pending with the
// reason recorded, which is what makes a stuck queue diagnosable from SQL
// alone.
async function deliverPending(updateId) {
  const row = await db.one(`SELECT * FROM creator_updates WHERE id = $1`, [updateId]);
  if (!row) return { sent: false, reason: 'not_found' };
  if (row.status !== 'pending') return { sent: false, reason: `already_${row.status}` };

  const c = await loadCreator(row.creator_id);
  const can = sendability(c);
  if (!can.ok) {
    if (can.reason === 'opted_out' || can.reason === 'not_subscribed' || can.reason === 'not_found') {
      await markSkipped(row.id, can.reason);
      return { sent: false, reason: can.reason };
    }
    await markAttempt(row.id, can.reason);
    return { sent: false, pending: true, reason: can.reason };
  }

  const rendered = renderUpdate(row, c);
  if (!rendered) {
    await markSkipped(row.id, `unknown_kind:${row.kind}`);
    return { sent: false, reason: 'unknown_kind' };
  }

  const channel = channelFor(c);
  const to = contactFor(c, channel);
  if (!channel || !to) {
    await markAttempt(row.id, 'no_contact');
    return { sent: false, pending: true, reason: 'no_contact' };
  }

  // A signed creator's very first message on this lane opens with the intro —
  // who we are and what this thread is for — before the update itself, so an
  // approval notification never arrives as the first thing an unfamiliar number
  // ever said to them. Only possible inside a window (two free-form sends);
  // outside one the template carries its own branding and the intro waits.
  const open = windowOpen(c);
  if (open && !c.updates_intro_sent_at) {
    await sendIntro(c, channel, to);
  }

  let result;
  let via;
  if (open) {
    via = 'freeform';
    const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
    result = await send({ to, body: rendered.body });
  } else {
    // Window shut. Only WhatsApp can start a conversation, and only with an
    // approved template for this kind.
    const templateName = process.env[rendered.spec.templateEnv] || '';
    if (channel !== 'whatsapp' || !templateName || !whatsapp.templatesAvailable()) {
      const reason = channel !== 'whatsapp' ? 'window_shut_no_template_channel' : 'window_shut_no_template';
      await markAttempt(row.id, reason);
      return { sent: false, pending: true, reason };
    }
    via = 'template';
    const link = rendered.spec.linkOf ? rendered.spec.linkOf(rendered.payload) : null;
    result = await whatsapp.sendWhatsAppTemplate({
      to,
      name: templateName,
      bodyParams: rendered.spec.params(rendered.payload),
      buttonUrlSuffix: link ? templateLinkSuffix(link) : null,
    });
  }

  if (result.sent) {
    await db.query(
      `UPDATE creator_updates
          SET status = 'sent', channel = $2, body = $3, provider_message_id = $4,
              attempts = attempts + 1, last_error = NULL, sent_at = NOW()
        WHERE id = $1`,
      [row.id, channel, rendered.body, result.id || null],
    );
    await logOutbound(row.creator_id, channel, rendered.body, result.id);
    return { sent: true, via, channel, body: rendered.body };
  }

  const err = result.error || result.reason || 'send_failed';
  await markAttempt(row.id, err);
  return { sent: false, pending: true, reason: err };
}

// A dynamic URL button's variable is the SUFFIX to the fixed prefix registered
// with Meta (e.g. an approved `https://influence.xyz/{{1}}` plus "brief/abc").
// Passing a whole URL would render as a doubled link, so strip the scheme+host
// when we're handed one.
function templateLinkSuffix(url) {
  const s = String(url || '');
  const m = s.match(/^https?:\/\/[^/]+\/(.*)$/);
  return m ? m[1] : s;
}

async function markAttempt(updateId, reason) {
  const row = await db.one(
    `UPDATE creator_updates
        SET attempts = attempts + 1, last_error = $2
      WHERE id = $1
      RETURNING attempts`,
    [updateId, String(reason).slice(0, 500)],
  );
  // Give up eventually rather than retrying a permanently broken row on every
  // sweep forever — a `failed` row is visible in the dashboard as something a
  // human needs to look at.
  if (row && row.attempts >= MAX_ATTEMPTS) {
    await db.query(`UPDATE creator_updates SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [updateId]);
  }
}

async function markSkipped(updateId, reason) {
  return db.query(
    `UPDATE creator_updates SET status = 'skipped', last_error = $2, attempts = attempts + 1 WHERE id = $1`,
    [updateId, String(reason).slice(0, 500)],
  );
}

// Send the one-time intro and stamp it. Best-effort: a failure here must never
// stop the actual update that follows, so an un-introduced creator simply gets
// introduced on the next one.
async function sendIntro(c, channel, to) {
  const body = msg.introMessage({ firstName: firstNameOf(c), brandName: c.brand_name || '' });
  const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
  const result = await send({ to, body });
  if (!result.sent) {
    console.warn(
      `[creator-updates] intro to creator ${c.id} not sent — ${result.error || result.reason || 'skipped'}`,
    );
    return { sent: false };
  }
  await db.query(
    `UPDATE creators SET updates_intro_sent_at = COALESCE(updates_intro_sent_at, NOW()), updated_at = NOW()
      WHERE id = $1`,
    [c.id],
  );
  await logOutbound(c.id, channel, body, result.id);
  return { sent: true, body };
}

// Everything queued for one creator, oldest first — the order the events
// actually happened in, which is the only order in which they make sense
// ("approved" before "post received", never after).
//
// Stops at the first row that can't go out: a shut window blocks the whole
// queue, not just one row, and marking the rest as attempted would burn their
// retry budget for a reason that has nothing to do with them.
async function flushCreator(creatorId, { limit = 20 } = {}) {
  const rows = await db.many(
    `SELECT id FROM creator_updates
      WHERE creator_id = $1 AND status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [creatorId, limit],
  );
  let sent = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await deliverPending(r.id);
    if (result.sent) {
      sent += 1;
      continue;
    }
    if (result.pending) break;
  }
  return { considered: rows.length, sent };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

// A subscribed creator messaged us. Two things happen, in this order:
// stamp the window open, then flush what's been waiting for it.
//
// Called from the inbound webhook BEFORE the offer-portal logic, because for a
// signed creator "Hi" means "I'm here, send me my updates" — not the start of a
// negotiation. Returns { handled } — false when this creator isn't on the update
// lane at all, which tells the webhook to fall through to the offer flow.
async function onInboundMessage(creatorId, channel, { body } = {}) {
  const c = await loadCreator(creatorId);
  if (!c || !c.updates_subscribed_at) return { handled: false };

  await db.query(
    `UPDATE creators
        SET updates_last_inbound_at = NOW(),
            established_channel = COALESCE(established_channel, $2),
            updated_at = NOW()
      WHERE id = $1`,
    [creatorId, channel],
  );

  // Re-load so windowOpen() sees the stamp we just wrote.
  const fresh = await loadCreator(creatorId);
  const to = contactFor(fresh, channel);
  const introduced = !!fresh.updates_intro_sent_at;
  if (!introduced && to && !fresh.messaging_opted_out) {
    await sendIntro(fresh, channel, to);
  }

  const flushed = await flushCreator(creatorId);

  // They wrote in, we said hello, and there was nothing queued to follow it —
  // a bare "Hi" from a creator whose campaign is quiet. The intro already
  // answered them; anything else they typed is a real question for a human, so
  // acknowledge it and let the webhook flag it for review.
  const substantive = String(body || '').trim().length > 4;
  if (!flushed.sent && introduced && substantive && to && !fresh.messaging_opted_out) {
    const ack = msg.ackMessage({ firstName: firstNameOf(fresh) });
    const send = channel === 'imessage' ? imessage.sendIMessageText : whatsapp.sendWhatsAppText;
    const result = await send({ to, body: ack });
    if (result.sent) await logOutbound(creatorId, channel, ack, result.id);
    return { handled: true, flushed, acknowledged: true, needsReview: true };
  }

  return { handled: true, flushed, introSent: !introduced };
}

// ---------------------------------------------------------------------------
// Campaign lifecycle
// ---------------------------------------------------------------------------

// The campaign is done. Sends the wrap-up and — the point of this function —
// leaves the subscription in place so the creator carries into the next
// campaign. updates_campaign_id is cleared rather than the subscription: the
// lane stays open, it just isn't pointed at a live campaign until the next one
// starts.
async function onDeliverablesComplete(creatorId, { campaignId, brandName, dedupKey } = {}) {
  const result = await notify(
    creatorId,
    'deliverables_complete',
    { brandName },
    { campaignId, dedupKey: dedupKey || `creator:${creatorId}:campaign:${campaignId || 'current'}` },
  );
  await db
    .query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'updates_campaign_completed', $2)`,
      [creatorId, { campaignId: campaignId || null, queued: !!result.queued }],
    )
    .catch((err) => console.error('[creator-updates] completion logging failed', err.message));
  return result;
}

// Open a NEW campaign in a graduated creator's existing WhatsApp thread — the
// payoff for keeping them subscribed after their last campaign wrapped.
//
// Deliver-or-nothing, deliberately. A queued next_campaign message is worse than
// none: the caller (outreach.sendOutreach) falls back to the cold email when
// this returns not-sent, and a row still sitting in the queue would surface days
// later as a second, contradictory pitch for a campaign the creator already
// answered by email. So the row is queued, attempted, and marked skipped in the
// same breath if it didn't go out.
//
// Returns { sent, reason? }.
async function startNextCampaign(creatorId, { campaignId, brandName, blurb } = {}) {
  const c = await loadCreator(creatorId);
  const can = sendability(c);
  if (!can.ok) return { sent: false, reason: can.reason };

  // Nothing can reach them right now: window shut and no approved template for
  // this kind. Say so before writing a row, so the caller emails instead.
  const templateName = process.env[UPDATE_KINDS.next_campaign.templateEnv] || '';
  const canReach = windowOpen(c) || (channelFor(c) === 'whatsapp' && templateName && whatsapp.templatesAvailable());
  if (!canReach) return { sent: false, reason: 'no_open_route' };

  // Point the lane at the new campaign so later updates for it resolve the right
  // brand name and campaign row.
  await db.query(
    `UPDATE creators SET updates_campaign_id = COALESCE($2, updates_campaign_id), updated_at = NOW() WHERE id = $1`,
    [creatorId, campaignId || null],
  );

  const result = await notify(
    creatorId,
    'next_campaign',
    { brandName, blurb },
    { campaignId, dedupKey: `creator:${creatorId}:next:${campaignId || 'unknown'}` },
  );
  if (result.sent) return { sent: true, channel: result.channel, body: result.body };

  if (result.queued && result.id) {
    await markSkipped(result.id, `next_campaign_not_delivered:${result.reason || 'unknown'}`);
  }
  return { sent: false, reason: result.reason || 'not_delivered' };
}

// Creators still subscribed after finishing a campaign — the pool a new
// campaign's outreach can reach over WhatsApp instead of cold email. Opt-outs
// and creators with no number are excluded, so what comes back is a list that
// can actually be messaged.
async function listResubscribed({ limit = 500 } = {}) {
  return db.many(
    `SELECT c.id, c.first_name, c.full_name, c.instagram_username, c.email,
            c.whatsapp, c.imessage, c.established_channel,
            c.updates_subscribed_at, c.updates_last_inbound_at, c.updates_campaign_id
       FROM creators c
      WHERE c.updates_subscribed_at IS NOT NULL
        AND c.messaging_opted_out = FALSE
        AND (c.whatsapp IS NOT NULL OR c.imessage IS NOT NULL)
      ORDER BY c.updates_subscribed_at DESC
      LIMIT $1`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

// The scheduler's tick for this lane. Two jobs, both catch-ups for things that
// couldn't happen at the moment they were triggered:
//   1. Flush pending updates for creators whose window has since opened (or for
//      whom a template has since been configured).
//   2. Ask for "Hi" from creators who signed but were never asked — the
//      onContractSigned attempt failed, or they signed before this lane existed.
async function runUpdatesSweep({ hiRequestLimit = 25 } = {}) {
  const out = { flushedCreators: 0, sent: 0, hiRequested: 0 };

  const dueCreators = await db.many(
    `SELECT DISTINCT creator_id FROM creator_updates WHERE status = 'pending' ORDER BY creator_id`,
  );
  for (const row of dueCreators) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await flushCreator(row.creator_id);
      if (r.sent) {
        out.flushedCreators += 1;
        out.sent += r.sent;
      }
    } catch (err) {
      console.error(`[creator-updates] flush failed for creator ${row.creator_id}:`, err.message);
    }
  }

  const needHi = await db.many(
    `SELECT id FROM creators
      WHERE updates_subscribed_at IS NOT NULL
        AND updates_hi_requested_at IS NULL
        AND updates_last_inbound_at IS NULL
        AND messaging_opted_out = FALSE
      ORDER BY updates_subscribed_at ASC
      LIMIT $1`,
    [hiRequestLimit],
  );
  for (const row of needHi) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await requestHi(row.id);
      if (r.sent) out.hiRequested += 1;
    } catch (err) {
      console.error(`[creator-updates] hi request failed for creator ${row.id}:`, err.message);
    }
  }

  return out;
}

// What the dashboard shows for one creator: subscription state plus the recent
// update history, sent and pending alike.
async function statusFor(creatorId) {
  const c = await loadCreator(creatorId);
  if (!c) return null;
  const updates = await db.many(
    `SELECT id, kind, status, channel, body, attempts, last_error, created_at, sent_at
       FROM creator_updates WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [creatorId],
  );
  return {
    creatorId: c.id,
    subscribed: !!c.updates_subscribed_at,
    subscribedAt: c.updates_subscribed_at,
    optedOut: !!c.messaging_opted_out,
    introSentAt: c.updates_intro_sent_at,
    hiRequestedAt: c.updates_hi_requested_at,
    lastInboundAt: c.updates_last_inbound_at,
    windowOpen: windowOpen(c),
    channel: channelFor(c),
    campaignId: c.updates_campaign_id || c.campaign_id || null,
    updates,
  };
}

module.exports = {
  UPDATE_KINDS,
  WINDOW_HOURS,
  isKnownKind,
  resolveCreator,
  onContractSigned,
  requestHi,
  notify,
  deliverPending,
  flushCreator,
  onInboundMessage,
  onDeliverablesComplete,
  startNextCampaign,
  listResubscribed,
  runUpdatesSweep,
  statusFor,
  // Exposed for tests — the pure decision helpers.
  windowOpen,
  sendability,
  channelFor,
  renderUpdate,
  templateLinkSuffix,
  hiDeepLink,
};
