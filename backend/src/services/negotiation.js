'use strict';

// Creator negotiation, in-app. Claude is used ONLY to (a) understand the
// creator's plain-text reply and (b) write the email (adapting the canonical
// templates). Offer numbers are 100% formula (pricing.js). The admin approval
// gate is enforced: no offer email sends until an admin approves an offer.
//
// Everything degrades gracefully: with no ANTHROPIC_API_KEY (or on any Claude
// error) we fall back to deterministic heuristics + templates, so the flow is
// testable without the API. Set DRY_RUN=1 to log emails instead of sending.

const db = require('../db');
const pricing = require('./pricing');
const templates = require('./negotiationTemplates');
const gmail = require('./gmail');

// ── Claude client (lazy; optional dependency) ─────────────────────────────
let _client;
let _clientTried = false;
function getClient() {
  if (_clientTried) return _client;
  _clientTried = true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    _client = null;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey });
  } catch (err) {
    console.warn('[negotiation] @anthropic-ai/sdk unavailable, using templates only:', err.message);
    _client = null;
  }
  return _client;
}
const model = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaudeText(system, user, maxTokens = 1200) {
  const client = getClient();
  if (!client) return null;
  try {
    const resp = await client.messages.create({
      model: model(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    console.error('[negotiation] Claude call failed:', err.message);
    return null;
  }
}

function stripFences(s) {
  return String(s || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseJsonLoose(s) {
  if (!s) return null;
  const cleaned = stripFences(s);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

const numOrNull = (x) => {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const isDryRun = () => /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));

// ── Context ───────────────────────────────────────────────────────────────
async function loadCreator(creatorId) {
  return db.one(
    `SELECT c.*, ca.brand_name, ca.name AS campaign_name, ca.max_cpm
     FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
}

function ctxFor(creator, extra = {}) {
  return {
    firstName: creator.first_name || 'there',
    brandName: creator.brand_name || process.env.BRAND_NAME || 'the brand',
    campaignName: creator.campaign_name || null,
    cadence: process.env.CONTENT_CADENCE || process.env.CAMPAIGN_DEADLINE || '1-2 videos per week',
    managerName: process.env.MANAGER_NAME || process.env.SENDER_NAME || 'Jennifer',
    refs: templates.REFERENCE_ACCOUNTS,
    maxCpm: creator.max_cpm != null ? Number(creator.max_cpm) : pricing.TARGET_CPM,
    stage: creator.negotiation_status || null,
    hasStats: creator.ig_scraped_data != null,
    approvedOffer: extra.approvedOffer || null,
    ...extra,
  };
}

function templateVars(ctx) {
  return {
    firstName: ctx.firstName,
    brandName: ctx.brandName,
    cadence: ctx.cadence,
    refs: ctx.refs,
    managerName: ctx.managerName,
  };
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function describeStage(stage) {
  switch (stage) {
    case null:
    case undefined:
      return 'The creator just replied to our initial outreach. Negotiation is starting.';
    case 'AWAITING_RATE':
      return 'We sent the collaboration details and are waiting for the creator to share their rate.';
    case 'AWAITING_APPROVAL':
      return 'The creator shared a rate; an admin is reviewing offers internally.';
    case 'AWAITING_DECISION':
      return 'We sent an offer and are waiting for the creator to accept, decline, or counter.';
    default:
      return `Stage: ${stage}.`;
  }
}

// ── (a) Understand a reply — ONE Claude call, strict JSON ─────────────────
async function handleCreatorReply(creator, replyText, ctx) {
  const v = templateVars(ctx);
  const defaultSubject = templates.reply1(v).subject;

  const system = [
    `You are ${v.managerName}, a friendly brand-partnerships manager at INFLUENCE.`,
    `You're negotiating an Instagram collaboration with the creator ${v.firstName} for the brand "${v.brandName}"${
      ctx.campaignName ? ` (campaign: ${ctx.campaignName})` : ''
    }.`,
    `Today's date is ${todayStr()}. The desired posting cadence is "${v.cadence}". When you mention timelines, compute an APPROXIMATE "all videos posted by" calendar date from today's date, the cadence, and the number of videos in the deal — do NOT print the cadence text where a date belongs.`,
    '',
    `Current stage: ${describeStage(ctx.stage)}`,
    ctx.hasStats
      ? "We already have this creator's Instagram view stats."
      : "We do not yet have this creator's Instagram view stats.",
    ctx.approvedOffer
      ? `An admin has approved this offer to send: ${JSON.stringify(ctx.approvedOffer)}.`
      : 'No offer has been approved yet.',
    '',
    'Adapt the following canonical templates — keep their content and tone, do not free-write new structures:',
    '--- REPLY 1 (share details + ask for their rate) ---',
    templates.REPLY1_BODY,
    '--- REPLY 2 (performance / view-based offer style) ---',
    templates.REPLY2_BODY,
    '',
    'Read the creator\'s plain-text reply and respond with STRICT JSON ONLY (no prose, no markdown fences), exactly this shape:',
    '{"understanding": string, "action": "shared_rate"|"asking_details"|"accepted"|"declined"|"counter"|"other", "quoted_rate": number|null, "email": {"subject": string, "body": string} | null, "send_now": boolean}',
    '',
    'Rules:',
    '- "shared_rate": the creator stated a rate/budget/price. Put the numeric USD amount in quoted_rate (plain number, no symbols). email=null, send_now=false — an admin must approve an offer before we reply.',
    '- "counter": the creator pushed back on a prior offer with a different number/terms. Put any numeric amount in quoted_rate. email=null, send_now=false.',
    `- "asking_details": interested but no rate yet, or asked for details. Write the email by ADAPTING REPLY 1 (brand "${v.brandName}", references: ${v.refs}, sign "- ${v.managerName}"). In Timelines, propose the cadence "${v.cadence}" and an approximate posted-by date you compute from today's date for a 2-video package. send_now=true.`,
    `- "accepted": they accepted the offer. Write a short warm acceptance email signed "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    `- "declined": not interested / not available now. Write a brief gracious email signed "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    `- "other": anything else (a question, scheduling, etc.). Write a short helpful reply signed "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    '- NEVER invent specific offer numbers in any email — offer numbers only ever come from an admin-approved offer.',
    `- The creator's first name is "${v.firstName}". The email body must be plain text with line breaks.`,
  ].join('\n');

  const out = parseJsonLoose(await callClaudeText(system, replyText, 1200));
  if (out && out.action) {
    const email =
      out.email && out.email.body
        ? { subject: out.email.subject || defaultSubject, body: out.email.body }
        : null;
    return {
      understanding: out.understanding || '',
      action: out.action,
      quoted_rate: numOrNull(out.quoted_rate),
      email,
      send_now: out.send_now !== false,
    };
  }
  return heuristicReply(replyText, ctx);
}

function parseRateFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m;
  const dollar = /\$\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/g;
  while ((m = dollar.exec(s))) {
    let val = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) val *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
    if (val >= 50) return Math.round(val);
  }
  const kg = /(?:^|\s)(\d+(?:\.\d+)?)\s*([kKmM])\b/g;
  while ((m = kg.exec(s))) {
    let val = parseFloat(m[1]);
    val *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
    if (val >= 50) return Math.round(val);
  }
  return null;
}

function heuristicReply(text, ctx) {
  const v = templateVars(ctx);
  const rate = parseRateFromText(text);
  if (rate != null) {
    return {
      understanding: '(heuristic) creator shared a rate',
      action: 'shared_rate',
      quoted_rate: rate,
      email: null,
      send_now: false,
    };
  }
  if (/\b(not interested|no thanks|no longer|unfortunately|we'?ll pass|i'?ll pass|too busy|not available|maybe later|another time)\b/i.test(text)) {
    return {
      understanding: '(heuristic) creator declined',
      action: 'declined',
      quoted_rate: null,
      email: templates.declineDelay(v),
      send_now: true,
    };
  }
  return {
    understanding: '(heuristic) creator interested, no rate yet',
    action: 'asking_details',
    quoted_rate: null,
    email: templates.reply1(v),
    send_now: true,
  };
}

// ── (b) Write the offer email — Claude adapts REPLY 2 ─────────────────────
async function draftOfferEmail(creator, offer, ctx, { combine = false } = {}) {
  const v = templateVars(ctx);
  const fallback = templates.offerEmail(offer, v, { combine });

  const offerDesc =
    offer.offer_type === 'view_based'
      ? `A view-based deal: $${offer.flat_fee} for a minimum of ${offer.view_guarantee} combined total views on Instagram (views counted for 7 days per post; combined across posts; full creative freedom; no exclusivity).`
      : `A flat package: ${offer.num_videos} video(s) for $${offer.flat_fee} total (full creative freedom; no exclusivity).`;

  const system = [
    `You are ${v.managerName}, a friendly brand-partnerships manager at INFLUENCE writing to ${v.firstName} about a collaboration for "${v.brandName}".`,
    'An admin has APPROVED exactly one offer. Use its numbers EXACTLY — do not invent or change amounts, and present only this one offer.',
    `Approved offer JSON: ${JSON.stringify(offer)}`,
    `In plain words: ${offerDesc}`,
    `Today's date is ${todayStr()}. Desired posting cadence: "${v.cadence}". If you mention timelines, give an approximate posted-by date computed from today for this ${
      offer.offer_type === 'view_based' ? '1-2 post' : `${offer.num_videos}-video`
    } deal at that cadence; never print the cadence text where a date belongs.`,
    '',
    'Write ONE email by adapting this canonical offer template — keep its warm tone, the "Payment details" section, and the "- ' + v.managerName + '" sign-off:',
    '--- REPLY 2 ---',
    templates.REPLY2_BODY,
    combine
      ? [
          '',
          'This is the FIRST reply (the creator gave their rate immediately), so FIRST cover the collaboration details by adapting REPLY 1, THEN present the approved offer in the same email:',
          '--- REPLY 1 ---',
          templates.REPLY1_BODY,
          `Use brand "${v.brandName}", references: ${v.refs}, and the cadence "${v.cadence}" for timelines.`,
        ].join('\n')
      : '',
    '',
    'Respond with STRICT JSON ONLY (no markdown fences): {"subject": string, "body": string}. The body is plain text with line breaks.',
  ]
    .filter(Boolean)
    .join('\n');

  const out = parseJsonLoose(await callClaudeText(system, 'Write the offer email now.', 1500));
  if (out && out.body) return { subject: out.subject || fallback.subject, body: out.body };
  return fallback;
}

// ── Email sending (threaded; DRY_RUN logs instead) ────────────────────────
async function lastRfc822(creatorId) {
  const ev = await db.one(
    `SELECT detail FROM email_events
     WHERE creator_id = $1 AND type IN ('sent_outreach','sent_followup','sent_negotiation')
     ORDER BY created_at DESC LIMIT 1`,
    [creatorId],
  );
  return ev && ev.detail ? ev.detail.rfc822MessageId || null : null;
}

async function countSentNegotiation(creatorId) {
  const r = await db.one(
    `SELECT COUNT(*)::int AS n FROM email_events WHERE creator_id = $1 AND type = 'sent_negotiation'`,
    [creatorId],
  );
  return r ? r.n : 0;
}

async function sendNegotiationEmail(creator, email, kind) {
  let detail = { kind, subject: email.subject };
  if (isDryRun()) {
    console.log(`[negotiation][DRY_RUN] -> ${creator.email} (${kind}): ${email.subject}\n${email.body}\n`);
    detail.dryRun = true;
  } else {
    const rfc = await lastRfc822(creator.id);
    const sent = await gmail.sendEmail({
      to: creator.email,
      subject: email.subject,
      body: email.body,
      threadId: creator.outreach_thread_id || undefined,
      inReplyTo: rfc || undefined,
      references: rfc || undefined,
    });
    detail = {
      ...detail,
      gmailMessageId: sent.gmailMessageId,
      threadId: sent.threadId,
      rfc822MessageId: sent.rfc822MessageId,
    };
  }
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'sent_negotiation', $2)`,
    [creator.id, detail],
  );
  await db.query(
    `UPDATE creators SET last_negotiation_email_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [creator.id],
  );
}

// ── Orchestration (called by the scheduler) ───────────────────────────────

// Read the newest inbound message and react to it. Idempotent: a message id
// equal to last_negotiation_msg_id is a no-op. Handles the first reply and all
// subsequent ones.
async function processReply(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator || !creator.outreach_thread_id) return { skipped: 'no thread' };

  let inbound;
  try {
    inbound = await gmail.getLatestInboundText(creator.outreach_thread_id);
  } catch (err) {
    console.error(`[negotiation] read reply failed for creator ${creatorId}:`, err.message);
    return { error: err.message };
  }
  if (!inbound || !inbound.text) return { skipped: 'no inbound text' };
  if (inbound.messageId && inbound.messageId === creator.last_negotiation_msg_id) {
    return { skipped: 'already handled' };
  }

  const ctx = ctxFor(creator);
  const result = await handleCreatorReply(creator, inbound.text, ctx);
  await applyReply(creator, ctx, result);
  await db.query(
    `UPDATE creators SET last_negotiation_msg_id = $2, updated_at = NOW() WHERE id = $1`,
    [creator.id, inbound.messageId || null],
  );
  return { action: result.action };
}

async function applyReply(creator, ctx, result) {
  const v = templateVars(ctx);
  switch (result.action) {
    case 'shared_rate':
    case 'counter': {
      const rate = result.quoted_rate;
      let offers = null;
      const stats = creator.ig_scraped_data;
      if (rate != null && stats) {
        offers = pricing.computeSixOffers(stats, ctx.maxCpm, Number(rate));
      }
      await db.query(
        `UPDATE creators
         SET quoted_rate = COALESCE($2, quoted_rate),
             suggested_offers = COALESCE($3::jsonb, suggested_offers),
             negotiation_status = 'AWAITING_APPROVAL',
             updated_at = NOW()
         WHERE id = $1`,
        [creator.id, rate != null ? rate : null, offers ? JSON.stringify(offers) : null],
      );
      return;
    }
    case 'accepted': {
      if (result.send_now) await sendNegotiationEmail(creator, result.email || templates.acceptance(v), 'acceptance');
      await db.query(
        `UPDATE creators SET negotiation_status = 'ACCEPTED', updated_at = NOW() WHERE id = $1`,
        [creator.id],
      );
      return;
    }
    case 'declined': {
      if (result.send_now) await sendNegotiationEmail(creator, result.email || templates.declineDelay(v), 'decline');
      await db.query(
        `UPDATE creators SET negotiation_status = 'DECLINED', updated_at = NOW() WHERE id = $1`,
        [creator.id],
      );
      return;
    }
    default: {
      // asking_details / other
      const email = result.email || templates.reply1(v);
      if (result.send_now !== false) {
        await sendNegotiationEmail(creator, email, result.action === 'other' ? 'reply' : 'reply1');
      }
      // 'other' keeps the existing stage if there is one; otherwise wait for a rate.
      const nextStatus =
        result.action === 'other' && creator.negotiation_status ? creator.negotiation_status : 'AWAITING_RATE';
      await db.query(
        `UPDATE creators SET negotiation_status = $2, updated_at = NOW() WHERE id = $1`,
        [creator.id, nextStatus],
      );
    }
  }
}

function resolveApprovedOffer(creator) {
  if (creator.custom_offer && typeof creator.custom_offer === 'object') return creator.custom_offer;
  const offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : [];
  if (creator.selected_offer_id) {
    const f = offers.find((o) => o.offer_id === creator.selected_offer_id);
    if (f) return f;
  }
  return offers[0] || null;
}

// Send the admin-approved offer email -> AWAITING_DECISION. This runs ONLY in
// response to an admin approving an offer in the dashboard (the /offer route);
// nothing sends offers automatically. The atomic claim guards against a
// double-send if the admin double-clicks. `fromStages` limits which negotiation
// stages can send: AWAITING_APPROVAL (the canonical case) plus AWAITING_RATE
// (so the admin can proactively send an offer to an engaged creator who hasn't
// named a rate yet). An outreach thread is required so the offer goes out as a
// threaded reply, never a cold email before the intro outreach.
async function sendApprovedOffer(creatorId, { fromStages = ['AWAITING_APPROVAL'] } = {}) {
  const stagePlaceholders = fromStages.map((_, i) => `$${i + 2}`).join(', ');
  const claim = await db.one(
    `UPDATE creators SET negotiation_status = 'AWAITING_DECISION', updated_at = NOW()
     WHERE id = $1 AND offer_approved = TRUE
       AND outreach_thread_id IS NOT NULL
       AND negotiation_status IN (${stagePlaceholders})
     RETURNING id`,
    [creatorId, ...fromStages],
  );
  if (!claim) {
    // Explain why nothing was sent so the dashboard can guide the admin. The
    // approval is recorded (offer_approved stays TRUE); the admin re-approves
    // once the creator is awaiting an offer to actually send it.
    const c = await db.one(
      `SELECT outreach_thread_id, negotiation_status FROM creators WHERE id = $1`,
      [creatorId],
    );
    if (!c) return { skipped: 'creator not found' };
    if (!c.outreach_thread_id) {
      return { skipped: 'no outreach thread yet — send outreach and wait for the creator to reply first' };
    }
    return {
      skipped: `creator is not awaiting an offer (stage: ${
        c.negotiation_status ? c.negotiation_status.replace(/_/g, ' ').toLowerCase() : 'no reply yet'
      })`,
    };
  }

  const creator = await loadCreator(creatorId);
  const offer = resolveApprovedOffer(creator);
  if (!offer) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'AWAITING_APPROVAL', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    return { error: 'no offer to send' };
  }

  const ctx = ctxFor(creator, { approvedOffer: offer });
  const combine = (await countSentNegotiation(creatorId)) === 0;
  try {
    const email = await draftOfferEmail(creator, offer, ctx, { combine });
    await sendNegotiationEmail(creator, email, 'offer');
    return { sent: true };
  } catch (err) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'AWAITING_APPROVAL', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    console.error(`[negotiation] sendApprovedOffer failed for creator ${creatorId}:`, err.message);
    throw err;
  }
}

// Idle follow-up: bump once, up to NEGOTIATION_MAX_FOLLOWUPS, then CLOSED.
async function runNegotiationFollowup(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'gone' };
  if (!['AWAITING_RATE', 'AWAITING_DECISION'].includes(creator.negotiation_status)) {
    return { skipped: 'stage' };
  }
  const max = Number(process.env.NEGOTIATION_MAX_FOLLOWUPS || 2);
  const count = creator.negotiation_followup_count || 0;
  if (count >= max) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'CLOSED', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'negotiation_closed', $2)`,
      [creatorId, { reason: 'max_followups' }],
    );
    return { closed: true };
  }
  const ctx = ctxFor(creator);
  const v = templateVars(ctx);
  const awaitingRate = creator.negotiation_status === 'AWAITING_RATE';
  const email = awaitingRate ? templates.followup1(v) : templates.followup2(v);
  await sendNegotiationEmail(creator, email, awaitingRate ? 'followup1' : 'followup2');
  await db.query(
    `UPDATE creators SET negotiation_followup_count = negotiation_followup_count + 1, updated_at = NOW() WHERE id = $1`,
    [creatorId],
  );
  return { sent: true, step: count + 1 };
}

module.exports = {
  handleCreatorReply,
  draftOfferEmail,
  processReply,
  sendApprovedOffer,
  runNegotiationFollowup,
  resolveApprovedOffer,
  loadCreator,
  ctxFor,
};
