'use strict';

// The creator's own fees, as creator-list's fee cascade takes them (economics/fee.py): only
// real observations, never estimates, per Reel, newest 18 months.
//   CAMPAIGN_ACTUAL  — an offer the creator accepted for exactly one Reel
//   CREATOR_REPORTED — a rate the creator quoted in negotiation ('rate_quoted' by the creator)
// Gathered across every campaign the creator (by Instagram handle) has been in.

const db = require('../db');

// "1 Reel", "Reel", "1 x Instagram Reel" — one Reel and nothing else.
function isOneReel(deliverables) {
  const lines = (Array.isArray(deliverables) ? deliverables : []).map((l) => String(l || '').trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  const l = lines[0].toLowerCase();
  return /\breels?\b/.test(l)
    && !/\b(?:[2-9]|\d{2,})\b|\b(?:two|three|four|five|six)\b/.test(l)
    && !/\b(?:stor(?:y|ies)|posts?|carousels?|tiktoks?|youtube|shorts?|videos|and|plus)\b|[+&,]/.test(l);
}

async function rateEvidenceFor(handle) {
  const h = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!h) return [];
  const [quotes, offers] = await Promise.all([
    db.many(
      `SELECT e.id, e.detail, e.created_at
         FROM email_events e JOIN creators c ON c.id = e.creator_id
        WHERE lower(c.instagram_username) = $1 AND e.type = 'rate_quoted'
          AND e.detail->>'by' = 'creator'`,
      [h],
    ),
    db.many(
      `SELECT o.id, o.rate, o.currency, o.deliverables, o.created_at
         FROM offers o JOIN creators c ON c.id = o.creator_id
        WHERE lower(c.instagram_username) = $1 AND o.status = 'accepted'`,
      [h],
    ),
  ]);
  const out = [];
  for (const o of offers) {
    const amount = Number(o.rate);
    if (!(amount > 0) || !isOneReel(o.deliverables)) continue;
    out.push({
      amount, currency: String(o.currency || 'USD').toUpperCase(), rate_type: 'CAMPAIGN_ACTUAL', content_type: 'reel',
      observed_at: new Date(o.created_at), source: `offer:${o.id}`,
    });
  }
  for (const q of quotes) {
    const amount = Number((q.detail || {}).to);
    if (!(amount > 0)) continue;
    out.push({
      amount, currency: 'USD', rate_type: 'CREATOR_REPORTED', content_type: 'reel',
      observed_at: new Date(q.created_at), source: `rate_quoted:${q.id}`,
    });
  }
  return out;
}

module.exports = { rateEvidenceFor, isOneReel };
