'use strict';

const db = require('../db');

// Duplicate-creator detection for the campaign creator list.
//
// A creator is a DUPLICATE when the same person is already in the campaign under
// a separate creator row — matched case-insensitively by Instagram handle OR by
// email. Instagram usernames are case-insensitive and the same person is often
// reachable at one email, so either match means outreach would go to someone
// we're already contacting in this campaign.
//
// The exact same instagram_url is NOT treated as a duplicate: re-adding an
// identical URL is an idempotent upsert handled by the POST ON CONFLICT clause,
// so `excludeUrl` drops that row from the search. Rows already flagged
// 'duplicate' are ignored too, so a run of re-adds all resolve back to the one
// original that actually receives outreach.
//
// Returns the ORIGINAL (oldest) matching row, or null when this is the first
// time we've seen the creator in the campaign.
async function findDuplicateCreator({ campaignId, username, email, excludeUrl }) {
  if (!campaignId) return null;
  const uname = username ? String(username).trim() : null;
  const mail = email ? String(email).trim() : null;
  if (!uname && !mail) return null;
  return db.one(
    `SELECT id, instagram_username, email, instagram_url
       FROM creators
      WHERE campaign_id = $1
        AND status <> 'duplicate'
        AND ($2::text IS NULL OR instagram_url <> $2)
        AND (
          ($3::text IS NOT NULL AND LOWER(instagram_username) = LOWER($3))
          OR ($4::text IS NOT NULL AND LOWER(email) = LOWER($4))
        )
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [campaignId, excludeUrl || null, uname, mail],
  );
}

// Which field tied the new creator to the existing one — 'handle' when the
// Instagram usernames match, otherwise 'email'. Used for the audit event + note.
function duplicateMatchReason({ username, dup }) {
  if (
    username &&
    dup.instagram_username &&
    String(dup.instagram_username).toLowerCase() === String(username).toLowerCase()
  ) {
    return 'handle';
  }
  return 'email';
}

module.exports = { findDuplicateCreator, duplicateMatchReason };
