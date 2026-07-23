const express = require('express');
const db = require('../db');
const { syncCampaigns } = require('../services/campaignsApi');
const { computeOffers } = require('../services/pricing');
const { flagDismissedSql } = require('../db/flagFingerprint');
const { recentReelSql } = require('../db/reelFreshness');

const router = express.Router();

const USAGE_RIGHTS_POLICIES = ['no_rights', 'free_only', 'required'];

router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT c.id, c.name, c.brand_name, c.slug, c.synced_at,
              c.template_id, c.max_cpm, c.instantly_campaign_id, c.usage_rights_policy,
              c.ig_dm_body, c.messaging_brief,
              COUNT(cr.id)::int AS creator_count,
              -- ig_dm_queue_count feeds the "Send Instagram DMs" button:
              -- creators without an email who haven't been DM'd yet AND whose
              -- newest reel is inside the recency window (dormant accounts are
              -- excluded from bulk sends — the admin can still DM them by hand
              -- from the row menu). Keep in sync with routes/creators.js:
              -- POST /bulk/queue-ig-dm.
              COUNT(cr.id) FILTER (
                WHERE (cr.email IS NULL OR cr.email = '')
                  AND cr.ig_dm_sent_at IS NULL
                  AND cr.status IN ('no_email','pending_extraction','invalid_email')
                  AND ${recentReelSql('cr.')}
              )::int AS ig_dm_queue_count,
              COUNT(cr.id) FILTER (WHERE cr.ig_dm_sent_at IS NOT NULL)::int AS ig_dm_sent_count,
              -- email_found_count feeds the "Send outreach" confirmation dialog
              -- (creators with an email but no outreach yet); not shown as a
              -- stat. Same dormant-reel exclusion as above so the number in the
              -- confirm matches what the bulk endpoint will actually send.
              COUNT(cr.id) FILTER (
                WHERE cr.status = 'email_found'
                  AND ${recentReelSql('cr.')}
              )::int AS email_found_count,
              -- Outreach: creators we've actually reached, on ANY channel —
              -- outreach_sent_at (email, stamped when Instantly confirms) OR
              -- ig_dm_sent_at (Instagram Priority DM, stamped when the extension
              -- confirms). Includes both so the "how many reached?" number is
              -- honest regardless of the channel used. A queued-but-not-yet-sent
              -- creator is deliberately not counted here — it still reads as
              -- pending until the send truly lands.
              COUNT(cr.id) FILTER (WHERE cr.outreach_sent_at IS NOT NULL OR cr.ig_dm_sent_at IS NOT NULL)::int AS outreach_sent_count,
              -- Pending: creators we haven't reached yet on any channel — no
              -- email sent AND no IG DM sent. This includes 'outreach_queued'
              -- leads (enrolled in Instantly, email not yet confirmed) and
              -- 'ig_dm_queued' rows (DM handed to the extension, not yet
              -- confirmed). Excludes duplicates (auto-rejected) and stopped
              -- creators, which never send. Without the ig_dm_sent_at guard,
              -- DM'd creators showed up under Pending even after we'd already
              -- reached them.
              COUNT(cr.id) FILTER (
                WHERE cr.outreach_sent_at IS NULL
                  AND cr.ig_dm_sent_at IS NULL
                  AND cr.status NOT IN ('duplicate', 'stopped')
              )::int AS pending_count,
              COUNT(cr.id) FILTER (WHERE cr.status = 'replied')::int AS replied_count,
              -- Removed: creators whose outreach was explicitly stopped (removed
              -- from the campaign). The automated follow-up steps skip these.
              COUNT(cr.id) FILTER (WHERE cr.status = 'stopped')::int AS stopped_count,
              -- Contracted: creators who have SIGNED their contract. A signed
              -- contract advances pending -> signed -> completed (contracts.status),
              -- so both 'signed' and 'completed' count; 'pending' (sent but not yet
              -- signed) does not.
              COUNT(cr.id) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM contracts ct
                  WHERE ct.creator_id = cr.id AND ct.status IN ('signed', 'completed')
                )
              )::int AS contracted_count,
              COUNT(cr.id) FILTER (WHERE cr.needs_human)::int AS needs_human_count,
              -- action_count also includes accepted deals parked for the brand
              -- POC's go-ahead (no approval recorded, no contract yet) — they
              -- render as approval cards in the Delegate window.
              -- A creator the admin has dismissed (flag snoozed from the
              -- dashboard) drops out of the count until new activity re-flags it
              -- (flagDismissedSql), so the sidebar pending-dot matches the table.
              COUNT(cr.id) FILTER (
                WHERE (
                     cr.needs_human
                   OR (cr.suggested_offers IS NOT NULL AND cr.negotiation_status = 'AWAITING_APPROVAL')
                   OR (cr.negotiation_status = 'ACCEPTED' AND NOT cr.contract_approved
                       AND NOT EXISTS (SELECT 1 FROM contracts ct2 WHERE ct2.creator_id = cr.id))
                ) AND NOT ${flagDismissedSql('cr.')}
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
    const hasIgDm = Object.prototype.hasOwnProperty.call(body, 'ig_dm_body');
    const hasMessagingBrief = Object.prototype.hasOwnProperty.call(body, 'messaging_brief');
    if (!hasTemplate && !hasMaxCpm && !hasInstantly && !hasUsageRights && !hasIgDm && !hasMessagingBrief) {
      return res.status(400).json({
        error:
          'template_id, max_cpm, instantly_campaign_id, usage_rights_policy, ig_dm_body or messaging_brief is required',
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

    if (hasIgDm) {
      const raw = body.ig_dm_body;
      if (raw != null && typeof raw !== 'string') {
        return res.status(400).json({ error: 'ig_dm_body must be a string or null' });
      }
      // Trim; empty string clears the template so the Send-IG-DMs button disables.
      const value = raw == null ? null : String(raw).trim() || null;
      params.push(value);
      sets.push(`ig_dm_body = $${params.length}`);
    }

    if (hasMessagingBrief) {
      const raw = body.messaging_brief;
      if (raw != null && typeof raw !== 'string') {
        return res.status(400).json({ error: 'messaging_brief must be a string or null' });
      }
      // Trim; empty string clears it, falling back to the generic brand-name blurb.
      const value = raw == null ? null : String(raw).trim() || null;
      params.push(value);
      sets.push(`messaging_brief = $${params.length}`);
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
