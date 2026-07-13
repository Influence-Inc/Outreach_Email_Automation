const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');
const { computeOffers } = require('../services/pricing');

const router = express.Router();

const USAGE_RIGHTS_POLICIES = ['no_rights', 'free_only', 'required'];

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.name, c.brand_name, c.slug, c.synced_at,
              c.template_id, c.max_cpm, c.instantly_campaign_id, c.usage_rights_policy,
              COUNT(cr.id)::int AS creator_count,
              -- email_found_count feeds the "Send outreach" confirmation dialog
              -- (creators with an email but no outreach yet); not shown as a stat.
              COUNT(cr.id) FILTER (WHERE cr.status = 'email_found')::int AS email_found_count,
              -- Outreach: creators the outreach email has actually gone out to,
              -- regardless of any later follow-ups/replies. outreach_sent_at is
              -- set once when outreach sends and never cleared.
              COUNT(cr.id) FILTER (WHERE cr.outreach_sent_at IS NOT NULL)::int AS outreach_sent_count,
              -- Pending: creators still awaiting their outreach email. Excludes
              -- duplicates (auto-rejected) and stopped creators, which never send.
              COUNT(cr.id) FILTER (WHERE cr.outreach_sent_at IS NULL AND cr.status NOT IN ('duplicate', 'stopped'))::int AS pending_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'replied')::int AS replied_count,
              -- Contracted: creators a contract has been sent to.
              COUNT(cr.id) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM email_events ee
                  WHERE ee.creator_id = cr.id AND ee.type = 'contract_sent'
                )
              )::int AS contracted_count,
              COUNT(cr.id) FILTER (WHERE cr.needs_human)::int AS needs_human_count,
              COUNT(cr.id) FILTER (
                WHERE cr.needs_human
                   OR (cr.suggested_offers IS NOT NULL AND cr.negotiation_status = 'AWAITING_APPROVAL')
              )::int AS action_count
       FROM campaigns c
       LEFT JOIN creators cr ON cr.campaign_id = c.id
       GROUP BY c.id
       ORDER BY c.brand_name ASC, c.name ASC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/sync', async (_req, res) => {
  try {
    const result = await syncCampaigns();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('campaigns sync failed:', err);
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.one(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// Update campaign settings: template_id, max_cpm, instantly_campaign_id
// and/or usage_rights_policy.
router.patch('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const hasTemplate = Object.prototype.hasOwnProperty.call(body, 'template_id');
    const hasMaxCpm = Object.prototype.hasOwnProperty.call(body, 'max_cpm');
    const hasInstantly = Object.prototype.hasOwnProperty.call(body, 'instantly_campaign_id');
    const hasUsageRights = Object.prototype.hasOwnProperty.call(body, 'usage_rights_policy');
    if (!hasTemplate && !hasMaxCpm && !hasInstantly && !hasUsageRights) {
      return res.status(400).json({
        error: 'template_id, max_cpm, instantly_campaign_id or usage_rights_policy is required',
      });
    }

    const sets = [];
    const params = [req.params.id];

    if (hasTemplate) {
      const raw = body.template_id;
      const templateId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
      if (templateId !== null && !Number.isFinite(templateId)) {
        return res.status(400).json({ error: 'template_id must be a number or null' });
      }
      params.push(templateId);
      sets.push(`template_id = $${params.length}`);
    }

    if (hasMaxCpm) {
      const raw = body.max_cpm;
      const maxCpm = raw === null || raw === '' || raw === undefined ? null : Number(raw);
      if (maxCpm !== null && (!Number.isFinite(maxCpm) || maxCpm < 0)) {
        return res.status(400).json({ error: 'max_cpm must be a non-negative number or null' });
      }
      params.push(maxCpm);
      sets.push(`max_cpm = $${params.length}`);
    }

    if (hasInstantly) {
      const raw = body.instantly_campaign_id;
      // Trim; treat empty string as "clear it" (fall back to env default).
      const id = raw === null || raw === undefined ? null : String(raw).trim() || null;
      params.push(id);
      sets.push(`instantly_campaign_id = $${params.length}`);
    }

    if (hasUsageRights) {
      const policy = body.usage_rights_policy;
      if (!USAGE_RIGHTS_POLICIES.includes(policy)) {
        return res.status(400).json({
          error: `usage_rights_policy must be one of: ${USAGE_RIGHTS_POLICIES.join(', ')}`,
        });
      }
      params.push(policy);
      sets.push(`usage_rights_policy = $${params.length}`);
    }

    const row = await db.one(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) {
    if (err && err.code === '23503') {
      return res.status(400).json({ error: 'template_id does not reference an existing template' });
    }
    next(err);
  }
});

// Recompute the 6 offers for every creator in a campaign that has both IG
// stats and a quoted rate (e.g. after the admin changes max_cpm).
router.post('/:id/recalculate-offers', async (req, res, next) => {
  try {
    const campaign = await db.one(`SELECT id, max_cpm FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'not found' });
    const maxCpm = campaign.max_cpm != null ? Number(campaign.max_cpm) : Number(process.env.TARGET_CPM || 15);

    const creators = await db.many(
      `SELECT id, ig_scraped_data, quoted_rate FROM creators
       WHERE campaign_id = $1 AND ig_scraped_data IS NOT NULL`,
      [req.params.id],
    );
    let updated = 0;
    for (const c of creators) {
      const rate = c.quoted_rate != null ? Number(c.quoted_rate) : null;
      const offers = computeOffers(c.ig_scraped_data, maxCpm, rate);
      await db.query(
        `UPDATE creators SET suggested_offers = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [c.id, JSON.stringify(offers)],
      );
      updated += 1;
    }
    res.json({ ok: true, updated, max_cpm: maxCpm });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
