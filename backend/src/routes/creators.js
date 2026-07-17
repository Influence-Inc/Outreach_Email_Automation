const express = require('express');
const db = require('../db');
const { sendOutreach } = require('../services/outreach');
const instantly = require('../services/instantly');
const { scrapeProfile } = require('../services/igScraper');
const { enrichEmail } = require('../services/emailEnrich');
const { computeStats, computeOffers, parseViewCount } = require('../services/pricing');
const contracts = require('../services/contracts');
const { findDuplicateCreator, duplicateMatchReason } = require('../services/duplicateGuard');
const { summarizeMessage, summarizeAndStore, deliverableForAmount } = require('../services/timelineSummary');

// Assemble the off-Instagram email-enrichment context for a creator: the links
// captured by the extension (creators.bio_links) plus anything a fresh scrape
// surfaced (external_url / bio links / biography). Deduped.
function buildEnrichContext(creator, scraped) {
  const links = [];
  if (scraped && scraped.externalUrl) links.push(scraped.externalUrl);
  if (scraped && Array.isArray(scraped.bioLinks)) links.push(...scraped.bioLinks);
  if (Array.isArray(creator.bio_links)) links.push(...creator.bio_links);
  return {
    fullName: (scraped && scraped.fullName) || creator.full_name,
    instagramUsername: creator.instagram_username,
    externalUrl: null,
    bioLinks: [...new Set(links.filter(Boolean))],
    biography: (scraped && scraped.biography) || null,
  };
}

// Run off-Instagram enrichment for one creator: prefer the links the extension
// captured (creators.bio_links); if none, try a server-side scrape to obtain
// them (which may itself surface the IG email). Then follow the links to a
// verified contact email. Returns { email, source } — both null when nothing
// is found. Scrape failures are swallowed (best-effort).
async function enrichCreator(creator) {
  let scraped = null;
  if (!Array.isArray(creator.bio_links) || !creator.bio_links.length) {
    scraped = await scrapeProfile({
      instagramUrl: creator.instagram_url,
      instagramUsername: creator.instagram_username,
    }).catch(() => null);
  }
  if (scraped && scraped.email) return { email: scraped.email, source: scraped.source };
  const enriched = await enrichEmail(buildEnrichContext(creator, scraped));
  if (enriched && enriched.email) return { email: enriched.email, source: enriched.source };
  return { email: null, source: null };
}

// Event types that make up the per-creator "Rate" timeline (delivery-tracking
// style). A curated subset of email_events — the offer email's own
// 'sent_negotiation' event is intentionally excluded; we log a dedicated
// 'rate_offer_sent' carrying the fee/CPM instead so the timeline can describe
// the offer without the email body.
const RATE_LOG_TYPES = [
  'outreach_queued',
  'sent_outreach',
  'sent_followup',
  'replied',
  'rate_quoted',
  'rate_offer_sent',
  'rate_counter_requested',
  'rate_accepted',
  'rate_declined',
  'sent_delegate_reply',
  'sent_manual_reply',
  'contract_approval_requested',
  'contract_approved',
  'contract_sent',
  'contract_signed',
  'contract_synced',
  'outreach_stopped',
];

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

// Map one email_event to a human "delivery update" line for the Rate column.
// Returns { text, tone } or null to skip.
//
// `msg` is the body of the email this event is about — the creator's inbound
// reply for 'replied'/'rate_quoted', or the reply we sent for the delegate /
// manual reply events — paired from the stored thread in attachRateLog. It lets
// each line summarize what was actually said instead of a content-free label
// like "Creator replied". Always optional: when the thread has nothing on file
// (e.g. very old creators) the entry degrades to its plain label.
//
// `summary` is an optional pre-generated Claude recap of the whole email (cached
// on email_messages.summary). When present it's used verbatim for the free-text
// gist rows ("Replied: …" / "Sent: …") instead of the deterministic first-
// sentence gist, so the timeline reflects the ENTIRE message. It is deliberately
// NOT used for 'rate_quoted', whose label is mined from the raw text ("Creator
// quoted $X for Y") rather than free-form.
function rateLogEntry(type, detail, msg, summary) {
  const d = detail || {};
  switch (type) {
    case 'outreach_queued':
      // The lead was enrolled in Instantly but the outreach email hasn't gone
      // out yet — Instantly sends it on its own schedule. Shown as a distinct,
      // in-progress step so the timeline never claims "sent" before it is.
      return { text: 'Outreach queued', tone: 'active' };
    case 'sent_outreach':
      return { text: 'Outreach sent', tone: 'done' };
    case 'sent_followup':
      // The step number is still recorded on the event's detail for auditing,
      // but the timeline label stays clean — just "Follow-up sent".
      return { text: 'Follow-up sent', tone: 'done' };
    case 'replied': {
      // Never a bare "Creator replied" — surface a recap of what the creator
      // actually wrote: the Claude summary of the whole email when we have one,
      // otherwise the deterministic first-sentence gist.
      const gist = summary || summarizeMessage(msg);
      return { text: gist ? `Replied: “${gist}”` : 'Creator replied', tone: 'done' };
    }
    case 'rate_quoted': {
      const to = d.to != null ? fmtMoney(d.to) : null;
      // If the creator quoted MULTIPLE rates in one reply, attach them to the
      // entry so the client can render this step as an expandable group
      // ("Creator quoted (3) ▾") — same collapse-and-reveal pattern used for
      // repeated "Creator replied" runs. Each option renders as a substep.
      const options = Array.isArray(d.options) && d.options.length > 1
        ? d.options
            .filter((o) => o && Number.isFinite(Number(o.amount)))
            .map((o) => ({
              amount: Number(o.amount),
              label: typeof o.label === 'string' ? o.label.trim() : '',
            }))
        : null;
      if (d.by === 'creator') {
        // Single quote: spell out the deliverable the money is for ("Creator
        // quoted $3,500 for 300,000 combined views") by mining the reply that
        // named it — a single stored option only ever carries "$X" as its
        // label, so the deliverable has to come from the reply text. Multiple
        // quotes stay collapsed; each option already carries its own
        // deliverable label as a substep.
        let text;
        if (options) {
          text = 'Creator quoted rates';
        } else if (to) {
          const deliverable = d.to != null ? deliverableForAmount(msg, Number(d.to)) : '';
          text = deliverable ? `Creator quoted ${to} ${deliverable}` : `Creator quoted ${to}`;
        } else {
          text = 'Creator shared a rate';
        }
        return { text, tone: 'active', ...(options ? { options } : {}) };
      }
      if (d.from != null && d.to != null) {
        return { text: `Rate updated ${fmtMoney(d.from)} → ${fmtMoney(d.to)}`, tone: 'active' };
      }
      return { text: to ? `Rate set to ${to}` : 'Rate updated', tone: 'active' };
    }
    case 'rate_offer_sent': {
      const fee = d.fee != null ? fmtMoney(d.fee) : null;
      const cpm = d.cpm != null ? ` · CPM $${d.cpm}` : '';
      const via = d.source === 'delegate' ? ' (from delegate)' : '';
      return { text: fee ? `Offer sent — ${fee}${cpm}${via}` : `Offer sent${via}`, tone: 'active' };
    }
    case 'rate_counter_requested':
      return { text: 'Asked creator for their counter rate', tone: 'active' };
    case 'rate_accepted': {
      const fee = d.fee != null ? fmtMoney(d.fee) : null;
      // by:'admin' means WE accepted the creator's own quoted rate (via the
      // "Accept creator's rate" button), not the creator accepting our offer.
      if (d.by === 'admin') {
        return { text: fee ? `Accepted creator's rate ✓ — ${fee}` : "Accepted creator's rate ✓", tone: 'success' };
      }
      return { text: fee ? `Creator accepted ✓ — ${fee}` : 'Creator accepted ✓', tone: 'success' };
    }
    case 'rate_declined':
      return { text: 'Creator declined', tone: 'muted' };
    case 'sent_delegate_reply': {
      const gist = summary || summarizeMessage(msg);
      return { text: gist ? `Sent: “${gist}”` : 'Reply sent (from delegate)', tone: 'done' };
    }
    case 'sent_manual_reply': {
      const gist = summary || summarizeMessage(msg);
      return { text: gist ? `Sent: “${gist}”` : 'Manual reply sent', tone: 'done' };
    }
    case 'outreach_stopped':
      return { text: d.removed ? 'Outreach stopped (removed from campaign)' : 'Outreach stopped', tone: 'muted' };
    case 'contract_approval_requested':
      // The deal is agreed but parked for the brand POC's go-ahead — the
      // contract is generated + sent only once it's approved in Delegate.
      return { text: 'Awaiting brand approval to send contract', tone: 'active' };
    case 'contract_approved':
      return { text: 'Deal approved ✓', tone: 'success' };
    case 'contract_sent':
      return { text: 'Contract sent', tone: 'active' };
    case 'contract_signed':
      return { text: 'Contract signed ✓', tone: 'success' };
    case 'contract_synced':
      // Only the successful sync closes out the deal on the timeline; a failed
      // sync stays quiet (it's retried) so the creator row never shows an error.
      return d.ok ? { text: 'Contract completed ✓', tone: 'success' } : null;
    default:
      return null;
  }
}

// Collapse superseded placeholder steps out of a creator's rate_log (oldest→
// newest, each entry carrying a `type`). "Outreach queued" is only a stand-in
// for the send that hasn't gone out yet; once "Outreach sent" lands it fully
// replaces the queued step, so the queued entry is dropped rather than left
// taking up its own timeline row above the sent one. Returns a new array.
function collapseSupersededSteps(log) {
  const entries = Array.isArray(log) ? log : [];
  if (!entries.some((e) => e.type === 'sent_outreach')) return entries.slice();
  return entries.filter((e) => e.type !== 'outreach_queued');
}

// The events whose timeline label summarizes an inbound creator reply vs. an
// outbound reply we sent. Each is paired with the nearest matching message from
// the stored thread so the label can quote what was actually said.
const INBOUND_MSG_EVENTS = new Set(['replied', 'rate_quoted']);
const OUTBOUND_MSG_EVENTS = new Set(['sent_delegate_reply', 'sent_manual_reply']);

// The events whose timeline label is a free-text recap of an email (as opposed
// to a mined "Creator quoted $X" label). Only these warrant a Claude summary —
// 'rate_quoted' is excluded because its label comes from the raw text, not a
// free-form gist.
const GIST_MSG_EVENTS = new Set(['replied', 'sent_delegate_reply', 'sent_manual_reply']);

// Safety net for un-summarized gist messages. Summaries are normally generated
// on receipt (thread.recordMessage), so this only catches rows that predate
// that (legacy) or whose receipt-time generation failed (Claude was down).
// Fire-and-forget: the current response already rendered the deterministic
// gist; the summary lands in the DB for the next load. summarizeAndStore dedupes
// by id, so this never races the receipt-time call.
function backfillSummaries(pending) {
  for (const { id, body } of pending) {
    summarizeAndStore(id, body).catch((e) =>
      console.warn(`[timeline] summary generation failed for message ${id}: ${e.message}`),
    );
  }
}

// Attach a `rate_log` array (oldest→newest) to each creator row, in place. One
// grouped query over the curated event types for all returned creators.
async function attachRateLog(rows) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const [events, messages] = await Promise.all([
    db.many(
      `SELECT creator_id, type, detail, created_at
       FROM email_events
       WHERE creator_id = ANY($1::int[]) AND type = ANY($2::text[])
       ORDER BY creator_id, created_at ASC`,
      [ids, RATE_LOG_TYPES],
    ),
    // The conversation turns a timeline label can quote: every inbound reply,
    // plus the outbound replies we log a step for (delegate / manual). The
    // templated outbound sends (outreach, follow-up, offer emails) get their own
    // descriptive labels, so their bodies aren't needed here.
    db.many(
      `SELECT id, creator_id, direction, subject, body, summary, created_at
       FROM email_messages
       WHERE creator_id = ANY($1::int[])
         AND (direction = 'inbound' OR kind IN ('delegate_reply', 'manual_reply'))
       ORDER BY creator_id, created_at ASC`,
      [ids],
    ),
  ]);

  // Per-creator, per-direction message lists (already time-sorted), used to find
  // the message that triggered an event. The webhook / negotiation code records
  // the message within the same request that writes the event, so the message's
  // timestamp lands within a second or two of the event's.
  const inboundByCreator = new Map();
  const outboundByCreator = new Map();
  for (const m of messages) {
    const map = m.direction === 'inbound' ? inboundByCreator : outboundByCreator;
    if (!map.has(m.creator_id)) map.set(m.creator_id, []);
    map.get(m.creator_id).push(m);
  }
  // The message an event describes: the latest one of the right direction at or
  // just before the event's time. A small forward slack absorbs the sub-second
  // gap when the message row is written just after the event row. Returns the
  // full row (id, body, summary) so the caller can both render and cache.
  const msgForEvent = (creatorId, type, at) => {
    const map = INBOUND_MSG_EVENTS.has(type)
      ? inboundByCreator
      : OUTBOUND_MSG_EVENTS.has(type)
        ? outboundByCreator
        : null;
    if (!map) return null;
    const list = map.get(creatorId);
    if (!list || !list.length) return null;
    const cutoff = new Date(at).getTime() + 2000;
    let found = null;
    for (const m of list) {
      if (new Date(m.created_at).getTime() <= cutoff) found = m;
      else break;
    }
    return found || null;
  };

  const byCreator = new Map();
  // Messages that back a free-text timeline row but have no cached summary yet,
  // deduped by id — handed to Claude in the background after this response.
  const pendingSummaries = new Map();
  for (const e of events) {
    const m = msgForEvent(e.creator_id, e.type, e.created_at);
    const entry = rateLogEntry(e.type, e.detail, m ? m.body : null, m ? m.summary : null);
    if (m && GIST_MSG_EVENTS.has(e.type) && m.summary == null && !pendingSummaries.has(m.id)) {
      pendingSummaries.set(m.id, { id: m.id, body: m.body });
    }
    if (!entry) continue;
    entry.at = e.created_at;
    entry.type = e.type;
    // Attach the full email backing this step (when there is one) so the client
    // can offer an "expand" affordance to read the ACTUAL message — the creator's
    // inbound reply, or the reply we sent — not just its one-line summary. Only
    // the message-backed events (replied / rate_quoted / delegate|manual reply)
    // resolve a message here; templated sends carry no body.
    if (m) {
      entry.email = {
        body: m.body,
        subject: m.subject || null,
        at: m.created_at,
        direction: m.direction,
      };
    }
    // Expose the numeric amount (offer fee / quoted rate) so the client can
    // resolve the "agreed rate" for accepted deals without parsing the label.
    const d = e.detail || {};
    if (d.fee != null) entry.amount = Number(d.fee);
    else if (d.to != null) entry.amount = Number(d.to);
    if (!byCreator.has(e.creator_id)) byCreator.set(e.creator_id, []);
    byCreator.get(e.creator_id).push(entry);
  }
  for (const r of rows) r.rate_log = collapseSupersededSteps(byCreator.get(r.id) || []);

  // Kick off Claude summary generation for any un-summarized gist messages.
  // Fire-and-forget: this response already went out with the deterministic
  // gist; the summaries land in the DB and show on the next load.
  if (pendingSummaries.size) backfillSummaries(pendingSummaries.values());
}

const router = express.Router();

function parseUsername(url) {
  try {
    const u = new URL(url);
    if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { campaign_id, status } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });
    const params = [campaign_id];
    let where = 'WHERE campaign_id = $1';
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    const rows = await db.many(
      `SELECT * FROM creators ${where} ORDER BY created_at DESC`,
      params,
    );
    await attachRateLog(rows);
    await contracts.attachContracts(rows);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { campaign_id, instagram_url, email, first_name, full_name } = req.body || {};
    if (!campaign_id || !instagram_url) {
      return res.status(400).json({ error: 'campaign_id and instagram_url are required' });
    }
    const username = parseUsername(instagram_url);
    const normalizedUrl = username
      ? `https://www.instagram.com/${username}/`
      : instagram_url;

    // Auto-reject a creator the campaign is already reaching out to (same
    // handle or email under a different row), so the outreach email never goes
    // out twice. The exact same URL is an idempotent re-add, not a duplicate —
    // that path falls through to the ON CONFLICT upsert below.
    const dup = await findDuplicateCreator({
      campaignId: campaign_id,
      username,
      email,
      excludeUrl: normalizedUrl,
    });

    let status;
    let notes = null;
    if (dup) {
      status = 'duplicate';
      const ref = dup.instagram_username ? `@${dup.instagram_username}` : `creator #${dup.id}`;
      notes = `Duplicate of ${ref} already in this campaign — auto-rejected so outreach isn't sent twice`;
    } else {
      status = email ? 'email_found' : 'pending_extraction';
    }

    const row = await db.one(
      `INSERT INTO creators (campaign_id, instagram_url, instagram_username, email, first_name, full_name, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (campaign_id, instagram_url) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, creators.email),
         first_name = COALESCE(EXCLUDED.first_name, creators.first_name),
         full_name = COALESCE(EXCLUDED.full_name, creators.full_name),
         instagram_username = COALESCE(EXCLUDED.instagram_username, creators.instagram_username),
         updated_at = NOW()
       RETURNING *`,
      [campaign_id, normalizedUrl, username, email || null, first_name || null, full_name || null, status, notes],
    );

    // Only when the row was actually inserted as a duplicate (not an ON CONFLICT
    // re-add of the same URL, which keeps its own status) do we log the audit
    // event that surfaces on the creator's timeline.
    if (dup && row.status === 'duplicate') {
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'duplicate_rejected', $2)`,
        [
          row.id,
          {
            of: dup.id,
            matchedOn: duplicateMatchReason({ username, dup }),
            handle: dup.instagram_username || null,
            email: email || null,
          },
        ],
      );
    }

    res.status(201).json(row);
  } catch (err) { next(err); }
});

// Single enriched creator for the Chrome extension's Instagram side panel.
// Resolvable two ways so the panel works both from the dashboard "Decide offer"
// launcher (which knows the creator id) and when opened standalone on an IG
// profile (which only knows the username):
//   GET /api/creators/panel?creator_id=123
//   GET /api/creators/panel?username=foo[&campaign_id=...]
// By username we return the most relevant row: prefer one that still needs a
// human (an offer awaiting approval, or an AI hand-off), else the most recently
// updated match. The response carries the same rate_log + contract the dashboard
// uses, so the panel renders the identical timeline / offer state.
// Registered before '/:id' so the literal "panel" segment isn't read as an id.
router.get('/panel', async (req, res, next) => {
  try {
    const { creator_id, username, campaign_id } = req.query;
    let row;
    if (creator_id) {
      row = await db.one(`SELECT * FROM creators WHERE id = $1`, [creator_id]);
    } else if (username) {
      const uname = String(username).trim().replace(/^@/, '');
      const params = [uname];
      let where = 'WHERE LOWER(instagram_username) = LOWER($1)';
      if (campaign_id) {
        params.push(campaign_id);
        where += ` AND campaign_id = $${params.length}`;
      }
      // Rank actionable rows first (offer awaiting approval / AI hand-off),
      // then most recently touched, so the panel opens on the row that needs us.
      row = await db.one(
        `SELECT * FROM creators ${where}
         ORDER BY
           (negotiation_status IN ('AWAITING_APPROVAL','AWAITING_RATE')) DESC,
           needs_human DESC,
           updated_at DESC
         LIMIT 1`,
        params,
      );
    } else {
      return res.status(400).json({ error: 'creator_id or username is required' });
    }
    if (!row) return res.status(404).json({ error: 'not found' });
    await attachRateLog([row]);
    await contracts.attachContracts([row]);
    res.json(row);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    const events = await db.many(
      `SELECT * FROM email_events WHERE creator_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    res.json({ ...row, events });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = ['email', 'first_name', 'full_name', 'instagram_username', 'notes'];
    const updates = [];
    const params = [req.params.id];
    for (const f of fields) {
      // Present-but-null clears the column (e.g. blanking the email cell);
      // absent fields are left untouched.
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        params.push(body[f] === '' ? null : body[f]);
        updates.push(`${f} = $${params.length}`);
      }
    }

    // Reel-view ingestion from the Chrome extension. Compute IG percentile
    // stats from the raw views, then (re)compute the 6 offers. Offer fees are
    // derived purely from the view stats + the campaign CPM ceiling; the
    // creator's quoted rate (if known) only annotates whether each offer
    // satisfies it. So we compute offers as soon as we have views — the admin
    // can review / edit / approve them right after scraping, without waiting
    // for the creator to share a rate.
    if (Array.isArray(body.reel_views)) {
      const views = body.reel_views
        .map((v) => (typeof v === 'number' ? v : parseViewCount(v)))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (views.length) {
        const stats = computeStats(views);
        params.push(JSON.stringify(stats));
        updates.push(`ig_scraped_data = $${params.length}::jsonb`);

        const ctx = await db.one(
          `SELECT c.quoted_rate, ca.max_cpm
           FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
           WHERE c.id = $1`,
          [req.params.id],
        );
        const quotedRate = ctx && ctx.quoted_rate != null ? Number(ctx.quoted_rate) : null;
        const maxCpm =
          ctx && ctx.max_cpm != null ? Number(ctx.max_cpm) : Number(process.env.TARGET_CPM || 15);
        const offers = computeOffers(stats, maxCpm, quotedRate);
        params.push(JSON.stringify(offers));
        updates.push(`suggested_offers = $${params.length}::jsonb`);
      }
    }

    // Off-Instagram links from the extension scrape (external_url + bio-hub
    // links). Stored so the email-enrichment fallback can follow them later
    // without re-reading Instagram (which the backend's IP can't do reliably).
    if (Array.isArray(body.bio_links)) {
      const links = body.bio_links
        .map((l) => (typeof l === 'string' ? l : l && l.url))
        .filter((s) => typeof s === 'string' && s.trim())
        .slice(0, 25);
      params.push(JSON.stringify(links));
      updates.push(`bio_links = $${params.length}::jsonb`);
    }

    // email_source travels with the email: an explicit source from the scrape
    // (e.g. 'instagram_contact') is stored; clearing the email clears the source.
    // A PATCH with `scraped: true` came from the extension, which only reads
    // Instagram — so an email it sends without an explicit source is still from
    // Instagram, never a hand-typed "manual" entry. Only a bare human edit (no
    // source, no `scraped` flag) is marked 'manual'.
    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      let src;
      if (body.email === '' || body.email == null) src = null;
      else if (body.email_source) src = String(body.email_source);
      else if (body.scraped === true) src = 'instagram';
      else src = 'manual';
      params.push(src);
      updates.push(`email_source = $${params.length}`);
    }

    // A completed extension scrape that found no email marks a still-pending
    // creator 'no_email' (the automatic enrichment pass runs next and can still
    // fill it). `scraped: true` distinguishes this from an ordinary field edit.
    if (!Object.prototype.hasOwnProperty.call(body, 'email') && body.scraped === true) {
      updates.push(`status = CASE WHEN status = 'pending_extraction' THEN 'no_email' ELSE status END`);
    }

    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
    if (body.email) {
      // Setting/fixing the email re-arms a creator that had no usable address
      // (incl. one we flagged 'invalid_email' from a failed verification).
      updates.push(
        `status = CASE WHEN status IN ('pending_extraction','no_email','invalid_email') THEN 'email_found' ELSE status END`,
      );
    }
    updates.push('updated_at = NOW()');
    const row = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    res.json(row);
  } catch (err) { next(err); }
});

router.post('/bulk/fetch-email', async (req, res) => {
  try {
    const { campaign_id } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const pending = await db.many(
      `SELECT id FROM creators
       WHERE campaign_id = $1 AND status = 'pending_extraction'
       ORDER BY created_at ASC`,
      [campaign_id],
    );
    const results = [];
    for (const row of pending) {
      try {
        const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [row.id]);
        const scraped = await scrapeProfile({
          instagramUrl: creator.instagram_url,
          instagramUsername: creator.instagram_username,
        });
        const params = [creator.id, scraped.fullName, scraped.firstName];
        const updates = [
          `full_name = COALESCE($2, full_name)`,
          `first_name = COALESCE($3, first_name)`,
          `updated_at = NOW()`,
        ];
        if (scraped.email) {
          params.push(scraped.email);
          updates.push(`email = $${params.length}`);
          updates.push(`status = 'email_found'`);
        } else {
          updates.push(`status = 'no_email'`);
        }
        await db.query(
          `UPDATE creators SET ${updates.join(', ')} WHERE id = $1`,
          params,
        );
        await db.query(
          `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, $2, $3)`,
          [creator.id, scraped.email ? 'email_found' : 'no_email', { source: scraped.source }],
        );
        results.push({ id: creator.id, email: scraped.email, source: scraped.source });
      } catch (err) {
        results.push({ id: row.id, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
    res.json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error('bulk fetch-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Batch off-Instagram enrichment for every emailless creator in a campaign.
// Uses the links the extension captured (creators.bio_links); for rows without
// captured links it also tries a server-side scrape. Paced so a run doesn't
// hammer external sites. Registered before /:id/enrich-email so "bulk" isn't
// swallowed as an :id.
router.post('/bulk/enrich-email', async (req, res) => {
  try {
    const { campaign_id, creator_ids } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    // Optional scope. When creator_ids is provided, enrichment is limited to
    // those rows (used by the post-add flow so it stays on the creators just
    // added and never touches the campaign's other emailless rows). A given-
    // but-empty/invalid list means "nothing to enrich" rather than "everyone".
    let scoped = null;
    if (creator_ids !== undefined) {
      scoped = (Array.isArray(creator_ids) ? creator_ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n));
      if (!scoped.length) return res.json({ ok: true, processed: 0, found: 0, results: [] });
    }

    const params = [campaign_id];
    let where = `campaign_id = $1
         AND (email IS NULL OR email = '')
         AND status IN ('no_email','pending_extraction','invalid_email')`;
    if (scoped) {
      params.push(scoped);
      where += ` AND id = ANY($${params.length}::int[])`;
    }
    const targets = await db.many(
      `SELECT id FROM creators WHERE ${where} ORDER BY created_at ASC`,
      params,
    );
    const results = [];
    let found = 0;
    for (const t of targets) {
      const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [t.id]);
      if (!creator || creator.email) continue;
      try {
        const { email, source } = await enrichCreator(creator);
        const updates = [`updated_at = NOW()`];
        const params = [creator.id];
        if (email) {
          params.push(email);
          updates.push(`email = $${params.length}`);
          params.push(source || null);
          updates.push(`email_source = $${params.length}`);
          updates.push(
            `status = CASE WHEN status IN ('pending_extraction','no_email','invalid_email') THEN 'email_found' ELSE status END`,
          );
          found += 1;
        }
        await db.query(`UPDATE creators SET ${updates.join(', ')} WHERE id = $1`, params);
        await db.query(
          `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, $2, $3)`,
          [creator.id, email ? 'email_enriched' : 'enrich_no_email', { source }],
        );
        results.push({ id: creator.id, email, source });
      } catch (err) {
        results.push({ id: creator.id, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    res.json({ ok: true, processed: results.length, found, results });
  } catch (err) {
    console.error('bulk enrich-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete every creator in a campaign (email_events cascade). Guarded by a
// confirm dialog on the dashboard.
router.post('/bulk/delete', async (req, res, next) => {
  try {
    const { campaign_id } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const result = await db.query(`DELETE FROM creators WHERE campaign_id = $1`, [campaign_id]);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) { next(err); }
});

router.post('/bulk/send-outreach', async (req, res) => {
  try {
    const { campaign_id } = req.body || {};
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const pending = await db.many(
      `SELECT id FROM creators
       WHERE campaign_id = $1
         AND status = 'email_found'
         AND email IS NOT NULL
         AND outreach_sent_at IS NULL
       ORDER BY created_at ASC`,
      [campaign_id],
    );
    const results = [];
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      let didSend = false;
      try {
        const r = await sendOutreach(row.id);
        results.push({ id: row.id, ok: true, trackingId: r.trackingId });
        sent += 1;
        didSend = true;
      } catch (err) {
        results.push({ id: row.id, ok: false, error: err.message });
        failed += 1;
      }
      // Pace only after an actual send — skipped invalids (and other no-sends)
      // shouldn't burn the inter-send delay.
      if (didSend && row !== pending[pending.length - 1]) {
        const baseMs = Number(process.env.SEND_PACING_MS) || 60_000;
        const jitterMs = Math.floor(baseMs * 0.2 * (Math.random() * 2 - 1));
        await new Promise((r) => setTimeout(r, Math.max(0, baseMs + jitterMs)));
      }
    }
    res.json({ ok: true, processed: results.length, sent, failed, results });
  } catch (err) {
    console.error('bulk send-outreach failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/fetch-email', async (req, res) => {
  try {
    const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    if (!creator) return res.status(404).json({ error: 'not found' });

    // Scraping only runs while a creator is still awaiting extraction. Once we
    // have an email (or the creator has moved into outreach / negotiation, or is
    // a rejected duplicate), re-scraping would waste an IG request and risk
    // overwriting good data, so we refuse it.
    if (creator.status !== 'pending_extraction') {
      return res.status(409).json({
        error: `Scraping only runs for creators pending extraction (creator ${creator.id} is '${creator.status}')`,
      });
    }

    const scraped = await scrapeProfile({
      instagramUrl: creator.instagram_url,
      instagramUsername: creator.instagram_username,
    });

    // Off-Instagram fallback: when the profile has no email, follow the
    // creator's own links (site / Linktree) to find a contact address. Free +
    // best-effort; gate off with EMAIL_ENRICH=0.
    let email = scraped.email;
    let source = scraped.source;
    if (!email && process.env.EMAIL_ENRICH !== '0') {
      const enriched = await enrichEmail(buildEnrichContext(creator, scraped));
      if (enriched && enriched.email) {
        email = enriched.email;
        source = enriched.source;
      }
    }

    const updates = [
      `instagram_username = COALESCE(creators.instagram_username, $2)`,
      `full_name = COALESCE($3, full_name)`,
      `first_name = COALESCE($4, first_name)`,
      `updated_at = NOW()`,
    ];
    const params = [creator.id, scraped.username, scraped.fullName, scraped.firstName];

    // status is guaranteed 'pending_extraction' here (guarded above), so the
    // transition is unconditional: found → email_found, nothing → no_email.
    if (email) {
      params.push(email);
      updates.push(`email = $${params.length}`);
      params.push(source || null);
      updates.push(`email_source = $${params.length}`);
      updates.push(`status = 'email_found'`);
    } else {
      updates.push(`status = 'no_email'`);
    }

    const updated = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, detail)
       VALUES ($1, $2, $3)`,
      [
        creator.id,
        email ? 'email_found' : 'no_email',
        { source, isBusiness: scraped.isBusiness, enriched: source ? /^web:|^provider:/.test(source) : false },
      ],
    );

    res.json({ ok: true, creator: updated, source });
  } catch (err) {
    console.error('fetch-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Off-Instagram email discovery for a single creator who has no email. Explicit
// endpoint — always runs regardless of the EMAIL_ENRICH flag (that flag only
// gates the automatic fallback during a normal scrape). Refuses a creator that
// already has an email so it can't overwrite good data.
router.post('/:id/enrich-email', async (req, res, next) => {
  try {
    const creator = await db.one(`SELECT * FROM creators WHERE id = $1`, [req.params.id]);
    if (!creator) return res.status(404).json({ error: 'not found' });
    if (creator.email) {
      return res.status(409).json({ error: `creator ${creator.id} already has an email` });
    }

    const { email, source } = await enrichCreator(creator);

    const updates = [`updated_at = NOW()`];
    const params = [creator.id];
    if (email) {
      params.push(email);
      updates.push(`email = $${params.length}`);
      params.push(source || null);
      updates.push(`email_source = $${params.length}`);
      updates.push(
        `status = CASE WHEN status IN ('pending_extraction','no_email','invalid_email') THEN 'email_found' ELSE status END`,
      );
    } else {
      updates.push(`status = CASE WHEN status = 'pending_extraction' THEN 'no_email' ELSE status END`);
    }
    const updated = await db.one(
      `UPDATE creators SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, $2, $3)`,
      [creator.id, email ? 'email_enriched' : 'enrich_no_email', { source }],
    );

    res.json({ ok: true, creator: updated, email, source });
  } catch (err) { next(err); }
});

router.post('/:id/send-outreach', async (req, res, next) => {
  try {
    const result = await sendOutreach(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stop outreach for a creator — scoped to THIS campaign only. Instantly owns
// the follow-up sequence, so halting it means removing the creator's lead from
// this campaign on Instantly's side (pausing our local row does nothing to the
// queued follow-ups). We deliberately do NOT use Instantly's workspace block
// list: that would stop the address across every campaign in the workspace and
// leave it permanently blocked, whereas removing the campaign lead frees the
// same person to be enrolled in a different campaign later. We:
//   1. remove the creator's lead from this campaign on Instantly (the step that
//      actually stops the follow-ups), best-effort so a missing API key /
//      unmapped campaign doesn't fail the whole action; and
//   2. mark this creator row 'stopped' with an audit event. That status is
//      per-creator-per-campaign, so our own send paths (prepareOutreach, the
//      bulk sender) and the negotiation scheduler skip THIS creator without
//      affecting the same email in any other campaign.
// Reports whether the Instantly lead was actually removed so the caller can
// warn the operator to remove it by hand if it wasn't.
router.post('/:id/stop-outreach', async (req, res, next) => {
  try {
    const creator = await db.one(
      `SELECT c.*, ca.instantly_campaign_id AS instantly_campaign_id
       FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!creator) return res.status(404).json({ error: 'not found' });

    const instantlyCampaignId =
      creator.instantly_campaign_id || process.env.INSTANTLY_CAMPAIGN_ID || null;

    let removed = false;
    let warning = null;
    if (creator.email) {
      if (!process.env.INSTANTLY_API_KEY) {
        warning = 'INSTANTLY_API_KEY is unset — marked stopped locally, but remove the lead from this campaign in Instantly to halt follow-ups.';
      } else if (!instantlyCampaignId) {
        warning = 'No Instantly campaign is mapped for this campaign — marked stopped locally, but remove the lead in Instantly to halt follow-ups.';
      } else {
        try {
          const n = await instantly.removeLeadFromCampaign({
            email: creator.email,
            campaignId: instantlyCampaignId,
          });
          removed = n > 0;
          // n === 0 simply means the creator was never enrolled in that
          // campaign (e.g. outreach never actually sent) — not an error.
        } catch (err) {
          warning = `Instantly lead removal failed: ${err.message}. Remove the lead from this campaign in Instantly to halt follow-ups.`;
          console.error(`[stop-outreach] creator ${creator.id} lead removal failed:`, err.message);
        }
      }
    }

    const updated = await db.one(
      `UPDATE creators
         SET status = 'stopped',
             notes = 'outreach stopped',
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [creator.id],
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'outreach_stopped', $2)`,
      [creator.id, { email: creator.email || null, instantlyCampaignId, removed }],
    );

    res.json({ ok: true, creator: updated, removed, warning });
  } catch (err) {
    console.error('stop-outreach failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM creators WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Exposed for unit tests (same pattern as routes/webhook.js): rateLogEntry is a
// pure label builder and collapseSupersededSteps a pure log transform, so both
// can be asserted without a DB.
router.rateLogEntry = rateLogEntry;
router.collapseSupersededSteps = collapseSupersededSteps;

module.exports = router;
