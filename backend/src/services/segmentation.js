'use strict';

// New-vs-old creator segmentation. Asks the Creator Database (keyed on each
// creator's Instagram handle) whether they've already participated in a campaign
// OTHER than the current one. "old" creators are routed through the offer portal
// (email + WhatsApp + iMessage negotiation) instead of email negotiation; "new"
// creators keep the existing outreach flow untouched.
//
// Runs best-effort and in the background off the dashboard load — a Creator-DB
// outage leaves creator_segment NULL (treated as "new"/unknown) and never blocks
// the dashboard. Results are cached on the creators row (segment_checked_at) and
// only refreshed once past SEGMENT_TTL_MS (or when force=true).

const db = require('../db');
const creatorDb = require('./creatorDb');

const SEGMENT_TTL_MS = Number(process.env.SEGMENT_TTL_MS || 24 * 60 * 60 * 1000);

// Instagram URL path segments that are NOT a profile handle.
const IG_NON_HANDLE = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 's']);

function parseUsernameFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
    const seg = u.pathname.split('/').filter(Boolean)[0] || null;
    if (!seg || IG_NON_HANDLE.has(seg.toLowerCase())) return null;
    return seg;
  } catch (_) {
    return null;
  }
}

function handleFor(creator) {
  let h = creator.instagram_username;
  if (!h && creator.instagram_url) h = parseUsernameFromUrl(creator.instagram_url);
  h = String(h || '').replace(/^@/, '').trim();
  return h || null;
}

// Segment a list of creator rows (each needs id, instagram_username,
// instagram_url, whatsapp, imessage, segment_checked_at). `campaignName` is used
// as the exclusion so participation in the CURRENT campaign doesn't count.
async function segmentCreators(creators, campaignName, { force = false } = {}) {
  if (!creatorDb.isConfigured()) return { skipped: 'CREATOR_DB_URL not set' };

  const now = Date.now();
  const targets = [];
  for (const c of creators || []) {
    const handle = handleFor(c);
    if (!handle) continue;
    const checkedAt = c.segment_checked_at ? new Date(c.segment_checked_at).getTime() : 0;
    if (!force && checkedAt && now - checkedAt < SEGMENT_TTL_MS) continue;
    targets.push({ id: c.id, handle });
  }
  if (!targets.length) return { checked: 0, updated: 0 };

  let resp;
  try {
    resp = await creatorDb.lookupParticipation(targets.map((t) => t.handle), campaignName);
  } catch (err) {
    console.error('[segmentation] Creator-DB lookup failed:', err.message);
    return { error: err.message };
  }

  const results = (resp && resp.results) || [];
  let updated = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    const r = results[i];
    if (!r) continue;
    const segment = r.hasPriorParticipation ? 'old' : 'new';
    const priorCampaigns = JSON.stringify(Array.isArray(r.priorCampaigns) ? r.priorCampaigns : []);
    const phone = r.contact && r.contact.phoneNumber ? r.contact.phoneNumber : null;
    try {
      // Backfill WhatsApp/iMessage contact from the Creator-DB master record when
      // we don't already have one (both default to the same phone number). Email
      // is intentionally left untouched so the existing outreach pipeline is not
      // disturbed by this background job.
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `UPDATE creators
         SET creator_segment = $2,
             prior_campaigns = $3::jsonb,
             segment_checked_at = NOW(),
             whatsapp = COALESCE(whatsapp, $4),
             imessage = COALESCE(imessage, $4),
             updated_at = NOW()
         WHERE id = $1`,
        [t.id, segment, priorCampaigns, phone],
      );
      updated += 1;
    } catch (err) {
      console.error(`[segmentation] update failed for creator ${t.id}:`, err.message);
    }
  }
  return { checked: targets.length, updated };
}

// Segment every creator in a campaign (loads them + the campaign name first).
async function segmentCampaign(campaignId, { force = false } = {}) {
  if (!creatorDb.isConfigured()) return { skipped: 'CREATOR_DB_URL not set' };
  const campaign = await db.one(`SELECT id, name FROM campaigns WHERE id = $1`, [campaignId]);
  if (!campaign) return { skipped: 'campaign not found' };
  const creators = await db.many(
    `SELECT id, instagram_username, instagram_url, whatsapp, imessage, segment_checked_at
     FROM creators WHERE campaign_id = $1`,
    [campaignId],
  );
  return segmentCreators(creators, campaign.name, { force });
}

// Segment every campaign's creators — the scheduled sweep, so Used-creator
// marking + WhatsApp/iMessage phone backfill happen without waiting on a
// dashboard load. segmentCreators skips creators already checked within
// SEGMENT_TTL_MS, so a sweep with nothing due does no Creator-DB work.
async function segmentAllCampaigns({ force = false } = {}) {
  if (!creatorDb.isConfigured()) return { skipped: 'CREATOR_DB_URL not set' };
  const campaigns = await db.many(`SELECT id FROM campaigns`);
  let checked = 0;
  let updated = 0;
  for (const c of campaigns) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await segmentCampaign(c.id, { force });
      if (r && r.checked) checked += r.checked;
      if (r && r.updated) updated += r.updated;
    } catch (err) {
      console.error(`[segmentation] scheduled sweep failed for campaign ${c.id}:`, err.message);
    }
  }
  return { campaigns: campaigns.length, checked, updated };
}

module.exports = { segmentCreators, segmentCampaign, segmentAllCampaigns, handleFor };
