const express = require('express');
const db = require('../db');
const { sendOutreach } = require('../services/outreach');
const { scrapeProfile } = require('../services/igScraper');
const { computeStats, computeOffers, parseViewCount } = require('../services/pricing');

// Event types that make up the per-creator "Rate" timeline (delivery-tracking
// style). A curated subset of email_events — the offer email's own
// 'sent_negotiation' event is intentionally excluded; we log a dedicated
// 'rate_offer_sent' carrying the fee/CPM instead so the timeline can describe
// the offer without the email body.
const RATE_LOG_TYPES = [
  'sent_outreach',
  'replied',
  'rate_quoted',
  'rate_offer_sent',
  'rate_counter_requested',
  'rate_accepted',
  'rate_declined',
  'sent_delegate_reply',
];

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

// Map one email_event to a human "delivery update" line for the Rate column.
// Returns { text, tone } or null to skip.
function rateLogEntry(type, detail) {
  const d = detail || {};
  switch (type) {
    case 'sent_outreach':
      return { text: 'Outreach sent', tone: 'done' };
    case 'replied':
      return { text: 'Creator replied', tone: 'done' };
    case 'rate_quoted': {
      const to = d.to != null ? fmtMoney(d.to) : null;
      if (d.by === 'creator') {
        return { text: to ? `Creator quoted ${to}` : 'Creator shared a rate', tone: 'active' };
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
    case 'rate_accepted':
      return { text: 'Creator accepted ✓', tone: 'success' };
    case 'rate_declined':
      return { text: 'Creator declined', tone: 'muted' };
    case 'sent_delegate_reply':
      return { text: 'Reply sent (from delegate)', tone: 'done' };
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
    const status = email ? 'email_found' : 'pending_extraction';
    const row = await db.one(
      `INSERT INTO creators (campaign_id, instagram_url, instagram_username, email, first_name, full_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (campaign_id, instagram_url) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, creators.email),
         first_name = COALESCE(EXCLUDED.first_name, creators.first_name),
         full_name = COALESCE(EXCLUDED.full_name, creators.full_name),
         instagram_username = COALESCE(EXCLUDED.instagram_username, creators.instagram_username),
         updated_at = NOW()
       RETURNING *`,
      [campaign_id, normalizedUrl, username, email || null, first_name || null, full_name || null, status],
    );
    res.status(201).json(row);
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
