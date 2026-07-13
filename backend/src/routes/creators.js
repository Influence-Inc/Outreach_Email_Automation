const express = require('express');
const db = require('../db');
const { sendOutreach } = require('../services/outreach');
const { scrapeProfile } = require('../services/igScraper');
const { computeStats, computeOffers, parseViewCount } = require('../services/pricing');
const contracts = require('../services/contracts');
const { findDuplicateCreator, duplicateMatchReason } = require('../services/duplicateGuard');

// Event types that make up the per-creator "Rate" timeline (delivery-tracking
// style). A curated subset of email_events — the offer email's own
// 'sent_negotiation' event is intentionally excluded; we log a dedicated
// 'rate_offer_sent' carrying the fee/CPM instead so the timeline can describe
// the offer without the email body.
const RATE_LOG_TYPES = [
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
  'contract_sent',
  'contract_signed',
  'contract_synced',
];

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

// Map one email_event to a human "delivery update" line for the Rate column.
// Returns { text, tone } or null to skip.
function rateLogEntry(type, detail) {
  const d = detail || {};
  switch (type) {
    case 'sent_outreach':
      return { text: 'Outreach sent', tone: 'done' };
    case 'sent_followup':
      // The step number is still recorded on the event's detail for auditing,
      // but the timeline label stays clean — just "Follow-up sent".
      return { text: 'Follow-up sent', tone: 'done' };
    case 'replied':
      return { text: 'Creator replied', tone: 'done' };
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
        const text = options
          ? 'Creator quoted rates'
          : (to ? `Creator quoted ${to}` : 'Creator shared a rate');
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
    case 'sent_delegate_reply':
      return { text: 'Reply sent (from delegate)', tone: 'done' };
    case 'sent_manual_reply':
      return { text: 'Manual reply sent', tone: 'done' };
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

// Attach a `rate_log` array (oldest→newest) to each creator row, in place. One
// grouped query over the curated event types for all returned creators.
async function attachRateLog(rows) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const events = await db.many(
    `SELECT creator_id, type, detail, created_at
     FROM email_events
     WHERE creator_id = ANY($1::int[]) AND type = ANY($2::text[])
     ORDER BY creator_id, created_at ASC`,
    [ids, RATE_LOG_TYPES],
  );
  const byCreator = new Map();
  for (const e of events) {
    const entry = rateLogEntry(e.type, e.detail);
    if (!entry) continue;
    entry.at = e.created_at;
    entry.type = e.type;
    // Expose the numeric amount (offer fee / quoted rate) so the client can
    // resolve the "agreed rate" for accepted deals without parsing the label.
    const d = e.detail || {};
    if (d.fee != null) entry.amount = Number(d.fee);
    else if (d.to != null) entry.amount = Number(d.to);
    if (!byCreator.has(e.creator_id)) byCreator.set(e.creator_id, []);
    byCreator.get(e.creator_id).push(entry);
  }
  for (const r of rows) r.rate_log = byCreator.get(r.id) || [];
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
       WHERE campaign_id = $1 AND status IN ('pending_extraction','no_email')
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

    const scraped = await scrapeProfile({
      instagramUrl: creator.instagram_url,
      instagramUsername: creator.instagram_username,
    });

    const updates = [
      `instagram_username = COALESCE(creators.instagram_username, $2)`,
      `full_name = COALESCE($3, full_name)`,
      `first_name = COALESCE($4, first_name)`,
      `updated_at = NOW()`,
    ];
    const params = [creator.id, scraped.username, scraped.fullName, scraped.firstName];

    if (scraped.email) {
      params.push(scraped.email);
      updates.push(`email = $${params.length}`);
      updates.push(
        `status = CASE WHEN status IN ('pending_extraction','no_email') THEN 'email_found' ELSE status END`,
      );
    } else if (creator.status === 'pending_extraction') {
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
        scraped.email ? 'email_found' : 'no_email',
        { source: scraped.source, isBusiness: scraped.isBusiness },
      ],
    );

    res.json({ ok: true, creator: updated, source: scraped.source });
  } catch (err) {
    console.error('fetch-email failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/send-outreach', async (req, res, next) => {
  try {
    const result = await sendOutreach(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM creators WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
