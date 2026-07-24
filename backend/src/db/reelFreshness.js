'use strict';

// A creator whose newest non-pinned reel is older than STALE_REEL_MONTHS is
// dormant: bulk email / bulk IG-DM skip them so we don't burn deliverability
// on accounts that aren't posting. The per-creator send endpoints ignore this
// filter — the admin can still send outreach or an IG DM by hand from a row's
// action buttons. Also drives the "stale" highlight in the dashboard's Reach
// column and the counts that back the bulk-send buttons.
const STALE_REEL_MONTHS = 3;

// SQL predicate that stays TRUE for creators we should still bulk-send to:
// unknown upload date (never scraped or a legacy row) OR a date inside the
// window. Pass a column prefix (e.g. 'cr.') when the surrounding query aliases
// the creators table.
function recentReelSql(prefix = '') {
  const col = `${prefix}ig_scraped_data->>'latest_reel_date'`;
  return `(
      ${col} IS NULL
      OR (${col})::date >= (CURRENT_DATE - INTERVAL '${STALE_REEL_MONTHS} months')
    )`;
}

module.exports = { STALE_REEL_MONTHS, recentReelSql };
