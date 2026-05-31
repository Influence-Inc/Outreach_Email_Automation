const RISK_BUFFER = 0.20;

function roundTo25k(n) {
  return Math.max(25000, Math.round(n / 25000) * 25000);
}

function buildRawOffers(igData, maxCpm, creatorQuotedRate) {
  const effectiveCpm = maxCpm * (1 - RISK_BUFFER);
  const { min_views = 0, p25 = 0, p50 = 0 } = igData;

  const vViews = [
    { id: 'view_1', views: roundTo25k(min_views), label: 'Conservative (min views)' },
    { id: 'view_2', views: roundTo25k(p25), label: 'Standard (P25 views)' },
    { id: 'view_3', views: roundTo25k(p50), label: 'Optimistic (P50 views)' },
  ];

  const offers = [];

  for (const v of vViews) {
    const fee = Math.round((v.views / 1000) * effectiveCpm * 100) / 100;
    offers.push({
      offer_id: v.id,
      offer_type: 'view_based',
      label: v.label,
      num_videos: 1,
      flat_fee: fee,
      flat_per_video: fee,
      view_guarantee: v.views,
      cpm_applied: effectiveCpm,
      satisfies_creator_rate: creatorQuotedRate != null ? fee >= creatorQuotedRate : null,
      notes: '',
    });
  }

  for (let n = 1; n <= 3; n++) {
    const flatPerVideo = Math.round((roundTo25k(p25) / 1000) * effectiveCpm * 100) / 100;
    const fee = Math.round(flatPerVideo * n * 100) / 100;
    offers.push({
      offer_id: `video_${n}`,
      offer_type: 'video_based',
      label: `${n} video${n > 1 ? 's' : ''} flat deal`,
      num_videos: n,
      flat_fee: fee,
      flat_per_video: flatPerVideo,
      view_guarantee: 0,
      cpm_applied: effectiveCpm,
      satisfies_creator_rate: creatorQuotedRate != null ? fee >= creatorQuotedRate : null,
      notes: '',
    });
  }

  return offers;
}

async function annotateWithClaude(offers, igData, handle) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return offers;

  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  const brand = process.env.BRAND_NAME || 'our brand';

  const summary = offers.map((o) => {
    const detail = o.offer_type === 'view_based'
      ? `view guarantee: ${o.view_guarantee.toLocaleString()}`
      : `${o.num_videos} video(s) flat`;
    return `${o.offer_id}: $${o.flat_fee} (${detail})`;
  }).join('\n');

  const prompt = `You are a brand partnership negotiation expert for ${brand}.
We are evaluating 6 deal offers for Instagram creator @${handle || 'unknown'}.
Creator's IG stats: p25=${igData.p25 || 0} views, p50=${igData.p50 || 0} views, min=${igData.min_views || 0} views.

Offers:
${summary}

Return a JSON array of exactly 6 objects, one per offer in the same order, each with:
- "offer_id": string (matching the offer_id above)
- "notes": string (one concise sentence, max 15 words, on the strategic trade-off of this offer)

Respond with only valid JSON, no markdown.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return offers;

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const annotations = JSON.parse(text);

    if (!Array.isArray(annotations)) return offers;

    const noteMap = {};
    for (const a of annotations) {
      if (a.offer_id && a.notes) noteMap[a.offer_id] = a.notes;
    }

    return offers.map((o) => ({ ...o, notes: noteMap[o.offer_id] || '' }));
  } catch {
    return offers;
  }
}

async function computeSixOffers(igData, maxCpm, creatorQuotedRate = null, handle = '') {
  const offers = buildRawOffers(igData, maxCpm, creatorQuotedRate);
  return annotateWithClaude(offers, igData, handle);
}

module.exports = { computeSixOffers };
