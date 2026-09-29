'use strict';

const db = require('../db');
const { insertPendingCreator } = require('./creatorInsert');

// Creators found by the Creator Database's human scouts.
//
// A scout works for one campaign. When an admin there promotes a creator they
// scouted, the Creator Database calls in here and the creator lands on that
// campaign's page in the same state a manually added one would — status
// 'pending_extraction' — so the existing enrichment → outreach pipeline takes
// over with nothing special-cased for scouting.

function normalizeHandle(username) {
  // Trim first: ' @mery' must not leave the '@' behind, and ' @ ' must come
  // out empty rather than as a handle of '@'.
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .trim();
}

// Campaigns a scout can be assigned to. Every campaign we hold qualifies: there
// is no archived flag, and hiding one here would only make an admin wonder why
// the campaign they're looking at in Deal Studio can't be picked.
async function listCampaigns() {
  return db.many(
    `SELECT id, name, brand_name
       FROM campaigns
      ORDER BY LOWER(brand_name), LOWER(name)`,
  );
}

// The provenance note shown on the creator's row. Carries the reel the scout
// thought the creator could remake, since that's the whole reason they were
// picked and the person running outreach will want it on hand.
function buildNote({ scoutName, reelLinks }) {
  const parts = [`Scouted by ${scoutName || 'a scout'} via the Creator Database`];
  const reels = (reelLinks || []).filter(Boolean);
  if (reels.length) parts.push(`Reel to replicate: ${reels.join(' , ')}`);
  return parts.join(' · ');
}

// Add a promoted creator to a campaign. Idempotent: promoting the same creator
// twice, or promoting one the campaign already has (added by hand, or sourced
// by the bot), returns the existing row instead of adding another.
//
// That existing-row check deliberately differs from duplicateGuard. The manual
// add path writes a 'duplicate' row as an audit trail when someone re-adds a
// creator; here the caller is a system that may retry, and a promote landing on
// a creator the campaign already has is simply a success.
//
// Throws with code 'NO_CAMPAIGN' when the campaign doesn't exist, so the caller
// can tell a stale assignment apart from a transient failure.
async function addScoutedCreator({
  campaignId,
  username,
  fullName = null,
  scoutName = null,
  reelLinks = [],
  sourceRef = null,
}) {
  const handle = normalizeHandle(username);
  if (!campaignId || !handle) {
    throw Object.assign(new Error('campaign_id and instagram_username are required'), {
      code: 'BAD_REQUEST',
    });
  }

  const campaign = await db.one(
    'SELECT id, name, brand_name FROM campaigns WHERE id = $1',
    [campaignId],
  );
  if (!campaign) {
    throw Object.assign(new Error(`No campaign with id ${campaignId}`), { code: 'NO_CAMPAIGN' });
  }

  const url = `https://www.instagram.com/${handle}/`;
  const existing = await db.one(
    `SELECT id, status, instagram_username
       FROM creators
      WHERE campaign_id = $1
        AND status <> 'duplicate'
        AND (instagram_url = $2 OR LOWER(instagram_username) = LOWER($3))
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [campaignId, url, handle],
  );
  if (existing) return { created: false, creator: existing, campaign };

  const creator = await insertPendingCreator({
    campaignId,
    username: handle,
    fullName,
    note: buildNote({ scoutName, reelLinks }),
    sourcedVia: {
      mode: 'scouting',
      scout: scoutName || null,
      reelLinks: (reelLinks || []).filter(Boolean),
      // The Creator Database's own row id, so either side can find the other.
      creatorDbEntryId: sourceRef || null,
    },
  });
  return { created: true, creator, campaign };
}

// Scouted creators in a campaign that still need their Instagram scrape.
//
// A manually added creator is scraped because the dashboard page that added
// them hands the row to the Chrome extension. A scouted creator arrives through
// a server-to-server call, so no page ever does that — the dashboard asks for
// them here instead and treats them as freshly added.
//
// Deliberately narrow: only scouted rows, only while still 'pending_extraction'
// with no reel data. That is what keeps this from sweeping in the campaign's
// other pending creators, which the add flow has always been careful not to do.
// Cheap on purpose (a few columns, one indexed campaign) because it is polled.
async function awaitingScrape(campaignId) {
  if (!campaignId) return [];
  return db.many(
    `SELECT id, instagram_url, instagram_username, status
       FROM creators
      WHERE campaign_id = $1
        AND status = 'pending_extraction'
        AND sourced_via->>'mode' = 'scouting'
        AND (ig_scraped_data IS NULL OR ig_scraped_data->>'reel_count' IS NULL)
      ORDER BY created_at ASC, id ASC`,
    [campaignId],
  );
}

module.exports = { listCampaigns, addScoutedCreator, buildNote, awaitingScrape };
