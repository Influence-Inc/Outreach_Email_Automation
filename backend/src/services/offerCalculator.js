'use strict';

/**
 * offerCalculator.js
 *
 * Computes the same 6-offer CPM pricing as the Python pricing_engine, then
 * optionally annotates each offer with AI notes via the Anthropic API
 * (native fetch — no extra npm packages required).
 *
 * Exports:
 *   async computeSixOffers(igData, maxCpm, creatorQuotedRate = null, handle = '')
 *     -> SuggestedOffer[]
 *
 * SuggestedOffer shape:
 *   {
 *     offer_id:              string,   // e.g. "view_1", "video_2"
 *     offer_type:            string,   // "view_based" | "video_flat"
 *     label:                 string,
 *     num_videos:            number | null,
 *     flat_fee:              number,
 *     flat_per_video:        number | null,
 *     view_guarantee:        number | null,
 *     cpm_applied:           number,
 *     satisfies_creator_rate:boolean,
 *     notes:                 string,
 *   }
 */

const RISK_BUFFER = 0.20;

/**
 * Round v up to the nearest multiple of 25 000, with a floor of 25 000.
 */
function roundViews(v) {
  const unit = 25_000;
  return Math.max(unit, Math.ceil(v / unit) * unit);
}

/**
 * Format a dollar amount to 2 decimal places as a plain number.
 */
function dollars(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Build the 6 raw offers from IG stats + effectiveCpm.
 *
 * @param {object} igData  - {min_views, p25, p50, reel_count, ...}
 * @param {number} maxCpm
 * @param {number|null} creatorQuotedRate
 * @returns {SuggestedOffer[]}
 */
function buildOffers(igData, maxCpm, creatorQuotedRate) {
  const effectiveCpm = maxCpm * (1 - RISK_BUFFER);

  const minViews = Number(igData.min_views) || 0;
  const p25      = Number(igData.p25)       || 0;
  const p50      = Number(igData.p50)       || 0;

  // ── 3 view-based offers ──────────────────────────────────────────────────
  const viewBases = [
    { id: 'view_1', label: 'View-based · min views',    views: minViews },
    { id: 'view_2', label: 'View-based · typical floor', views: p25     },
    { id: 'view_3', label: 'View-based · median',        views: p50     },
  ];

  const viewOffers = viewBases.map(({ id, label, views }) => {
    const guarantee = roundViews(views);
    const fee       = dollars((guarantee / 1000) * effectiveCpm);
    const satisfies = creatorQuotedRate != null ? fee >= creatorQuotedRate : false;
    return {
      offer_id:               id,
      offer_type:             'view_based',
      label,
      num_videos:             null,
      flat_fee:               fee,
      flat_per_video:         null,
      view_guarantee:         guarantee,
      cpm_applied:            dollars(effectiveCpm),
      satisfies_creator_rate: satisfies,
      notes:                  '',
    };
  });

  // ── 3 video-flat offers ──────────────────────────────────────────────────
  // Base unit: p25 views × effectiveCpm / 1000  (cost for ~typical reel)
  const baseVideoFee = dollars((p25 / 1000) * effectiveCpm);

  const videoOffers = [1, 2, 3].map((n) => {
    const fee       = dollars(baseVideoFee * n);
    const satisfies = creatorQuotedRate != null ? fee >= creatorQuotedRate : false;
    return {
      offer_id:               `video_${n}`,
      offer_type:             'video_flat',
      label:                  `${n} video${n > 1 ? 's' : ''} flat`,
      num_videos:             n,
      flat_fee:               fee,
      flat_per_video:         baseVideoFee,
      view_guarantee:         null,
      cpm_applied:            dollars(effectiveCpm),
      satisfies_creator_rate: satisfies,
      notes:                  '',
    };
  });

  return [...viewOffers, ...videoOffers];
}

/**
 * Call Anthropic API to annotate each of the 6 offers with a short note.
 * Returns an array of {offer_id, notes} or null on failure.
 *
 * @param {SuggestedOffer[]} offers
 * @param {object}           igData
 * @param {string}           handle
 * @returns {Promise<Array<{offer_id: string, notes: string}>|null>}
 */
async function fetchClaudeNotes(offers, igData, handle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model     = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  const brandName = process.env.BRAND_NAME  || 'the brand';

  const offerSummary = offers.map((o) => ({
    offer_id:      o.offer_id,
    offer_type:    o.offer_type,
    label:         o.label,
    flat_fee:      o.flat_fee,
    view_guarantee: o.view_guarantee,
    num_videos:    o.num_videos,
    satisfies_creator_rate: o.satisfies_creator_rate,
  }));

  const prompt = [
    `You are a brand partnerships advisor for ${brandName}.`,
    `Creator handle: @${handle || 'unknown'}.`,
    `IG stats: min_views=${igData.min_views}, p25=${igData.p25}, p50=${igData.p50}, p75=${igData.p75 || 'n/a'}, reel_count=${igData.reel_count || 'n/a'}.`,
    ``,
    `Here are 6 proposed offers (JSON):`,
    JSON.stringify(offerSummary, null, 2),
    ``,
    `For each offer write a single concise sentence (max 20 words) of negotiation advice or strategic context.`,
    `Respond with ONLY a valid JSON array of objects with keys "offer_id" and "notes".`,
    `No markdown, no explanation — pure JSON array.`,
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      console.warn('[offerCalculator] Anthropic API error:', response.status, await response.text().catch(() => ''));
      return null;
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    // Strip any accidental markdown fences.
    const cleaned = text.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[offerCalculator] Failed to get Claude notes:', err.message);
    return null;
  }
}

/**
 * Main export.
 *
 * @param {object}      igData           - IG scrape data {min_views, p25, p50, p75, reel_count, views_raw}
 * @param {number}      maxCpm           - Campaign max CPM in dollars
 * @param {number|null} creatorQuotedRate - Creator's stated rate (optional)
 * @param {string}      handle           - Instagram handle for AI context
 * @returns {Promise<SuggestedOffer[]>}
 */
async function computeSixOffers(igData, maxCpm, creatorQuotedRate = null, handle = '') {
  const offers = buildOffers(igData, maxCpm, creatorQuotedRate);

  // Attempt AI annotation — fall back silently if unavailable.
  const notes = await fetchClaudeNotes(offers, igData, handle);
  if (Array.isArray(notes)) {
    for (const note of notes) {
      const offer = offers.find((o) => o.offer_id === note.offer_id);
      if (offer && typeof note.notes === 'string') {
        offer.notes = note.notes;
      }
    }
  }

  return offers;
}

module.exports = { computeSixOffers };
