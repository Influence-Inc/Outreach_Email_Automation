'use strict';

const db = require('../db');

// Insert a freshly-sourced creator into a campaign in the SAME shape the manual
// "add creator" path produces (routes/creators.js POST /): a normalized Instagram
// URL and status 'pending_extraction', so the existing enrichment → outreach
// pipeline takes over untouched. Idempotent on (campaign_id, instagram_url).
//
// Dedup against creators we're already contacting is the CALLER's responsibility
// (the sourcing orchestrator runs duplicateGuard.findDuplicateCreator first), so
// this stays a plain upsert.
// `sourcedVia` / `note` carry the scout's provenance — which mode and keyword
// found this creator — and are simply absent on the manual add path.
async function insertPendingCreator({
  campaignId, username, fullName = null, firstName = null, sourcedVia = null, note = null,
}) {
  const handle = String(username || '')
    .replace(/^@/, '')
    .trim();
  if (!campaignId || !handle) throw new Error('campaignId and username are required');
  const url = `https://www.instagram.com/${handle}/`;
  return db.one(
    `INSERT INTO creators
       (campaign_id, instagram_url, instagram_username, first_name, full_name, status, notes, sourced_via)
     VALUES ($1, $2, $3, $4, $5, 'pending_extraction', $6, $7)
     ON CONFLICT (campaign_id, instagram_url) DO UPDATE SET
       instagram_username = COALESCE(EXCLUDED.instagram_username, creators.instagram_username),
       first_name = COALESCE(EXCLUDED.first_name, creators.first_name),
       full_name = COALESCE(EXCLUDED.full_name, creators.full_name),
       sourced_via = COALESCE(EXCLUDED.sourced_via, creators.sourced_via),
       updated_at = NOW()
     RETURNING *`,
    [
      campaignId,
      url,
      handle,
      firstName,
      fullName,
      note || 'Sourced via Instagram scouting',
      sourcedVia ? JSON.stringify(sourcedVia) : null,
    ],
  );
}

module.exports = { insertPendingCreator };
