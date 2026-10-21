'use strict';

// The orchestrator end to end with fake providers: what each Reel is sent to (OCR, Whisper,
// Jev), what is kept, and that the stored pricing copy prices the creator from those labels.

const test = require('node:test');
const assert = require('node:assert');
const { analyzeCreator } = require('./analyze');
const { pricingCopy } = require('./queue');
const { isOneReel } = require('../rateEvidence');
const cpmEstimate = require('../cpmEstimate');

const DAY = 86400000;
const now = Date.now();

function row(i, { deal = false } = {}) {
  return {
    shortCode: `R${i}`,
    ownerUsername: 'mia.skin',
    caption: deal ? 'My night routine with @cerave #ceravepartner' : `Skincare tip ${i}`,
    hashtags: [],
    mentions: deal ? ['cerave'] : [],
    timestamp: new Date(now - (3 + i * 4) * DAY).toISOString(),
    videoPlayCount: deal ? 30000 : 20000 + i * 1000,
    videoDuration: 30,
    displayUrl: 'https://scontent.cdninstagram.com/t.jpg',
    videoUrl: i === 3 ? '' : 'https://scontent.cdninstagram.com/v.mp4',
  };
}

function fakes() {
  const calls = { ocr: 0, transcribe: 0, lookups: [] };
  const providers = {
    scrapeReels: async (handle, { limit }) => {
      assert.strictEqual(handle, 'mia.skin');
      assert.strictEqual(limit, 30);
      const rows = Array.from({ length: 12 }, (_, i) => row(i, { deal: i % 4 === 1 }));
      return { rows: [...rows, rows[0]], cost_usd: 0.01, status: 'SUCCEEDED' };
    },
    thumbnailText: async () => { calls.ocr++; return 'NIGHT ROUTINE'; },
    transcribe: async (r) => {
      calls.transcribe++;
      if (r.post_id === 'R5') { const e = new Error('silent'); e.name = 'NoAudioTrackError'; throw e; }
      if (r.post_id === 'R7') throw new Error('Groq: HTTP 500');
      return { text: 'Here is my skincare routine for glowing skin, step one cleanse.', language: 'english', cost_usd: 0.0001 };
    },
    lookupAccounts: async (handles) => {
      calls.lookups.push(handles);
      return {
        accounts: {
          'mia.skin': { country_name: 'India', followers: 80000, found: true },
          cerave: { country_name: 'United States', followers: 3200000, found: true },
        },
        cost_usd: 0.01,
      };
    },
  };
  const jev = {
    decide: async (state, questions) => {
      const answers = {};
      const deal = /cerave/.test(state.caption || '');
      for (const [qid, q] of Object.entries(questions)) {
        const pick = (c, p = 0.9) => { answers[qid] = { choice: c, confidence: p, probabilities: { [c]: p } }; };
        if (qid === 'collaboration') pick(deal ? 'collaborated' : 'not_collaborated');
        else if (qid === 'commercial_class') pick(deal ? 'paid_partnership' : 'organic');
        else if (qid === 'sponsor_brand') pick(Object.keys(q.criteria).find((k) => /cerave/.test(k)) || 'none_of_these');
        else if (qid === 'topic') pick('beauty');
        else if (qid === 'niche') pick('skincare');
        else if (qid === 'genre') pick('informative');
        else if (qid === 'format') pick('tutorial_how_to');
      }
      return { model: 'jev', answers, cost_usd: 0.0003 };
    },
  };
  return { providers, jev, calls };
}

test('a creator is analysed Reel by Reel and priced from the result', async () => {
  const { providers, jev, calls } = fakes();
  const a = await analyzeCreator('@Mia.Skin', { providers, jev, groqRpm: 6000 });
  assert.strictEqual(a.handle, 'mia.skin');
  assert.strictEqual(a.reels.length, 12, 'duplicate rows dropped');
  assert.strictEqual(calls.ocr, 12);
  assert.strictEqual(calls.transcribe, 11, 'a Reel with no video is not sent to Whisper');
  assert.deepStrictEqual(calls.lookups, [['mia.skin', 'cerave']]);
  assert.strictEqual(a.counts.brand_deals, 3);
  assert.strictEqual(a.counts.no_audio, 1);
  assert.strictEqual(a.counts.transcript_failed, 1);
  assert.strictEqual(a.counts.classified, 12);
  assert.deepStrictEqual(a.brand_sizes, { cerave: 3200000 });
  assert.strictEqual(a.account.instagram_country, 'India');
  // Nothing a creator wrote is kept: no captions, OCR or transcripts.
  const text = JSON.stringify(a);
  assert.ok(!/Skincare tip|NIGHT ROUTINE|glowing skin/.test(text));

  const est = cpmEstimate.estimateForCreator({ reel_analysis: pricingCopy(a) });
  const s = Object.fromEntries(est.cpm.stickers.map((x) => [x.name, x]));
  assert.strictEqual(s.topic.value, 'skincare');
  assert.strictEqual(s.format.value, 'tutorial_how_to');
  assert.strictEqual(s.genre.value, 'informative');
  assert.strictEqual(s.brands.label, 'Worked with major brands');
  assert.strictEqual(s.brands.evidence, 'cerave');
  assert.strictEqual(est.inputs.country.source, 'instagram');
  assert.strictEqual(est.inputs.country.evidence, 'Account based in India');
  assert.ok(est.rate.value > 0);
  assert.strictEqual(est.rate.method, 'estimated_cpm');
  assert.deepStrictEqual(est.reels.brands, ['cerave']);
});

test('cached accounts are not looked up again', async () => {
  const { providers, jev, calls } = fakes();
  const knownAccounts = async () => ({ 'mia.skin': { country_name: 'India', found: true }, cerave: { followers: 3200000, found: true } });
  const a = await analyzeCreator('mia.skin', { providers, jev, knownAccounts, groqRpm: 6000 });
  assert.deepStrictEqual(calls.lookups, []);
  assert.strictEqual(a.brand_sizes.cerave, 3200000);
});

test('a creator with no Reels fails with the reason', async () => {
  const { providers, jev } = fakes();
  providers.scrapeReels = async () => ({ rows: [], cost_usd: 0, status: 'SUCCEEDED' });
  await assert.rejects(analyzeCreator('mia.skin', { providers, jev }), /no Reels/);
});

test('Jev errors leave a Reel UNKNOWN, never guessed', async () => {
  const { providers } = fakes();
  const jev = { decide: async () => { throw new Error('Jev via OpenRouter: HTTP 502'); } };
  const a = await analyzeCreator('mia.skin', { providers, jev, groqRpm: 6000 });
  assert.ok(a.reels.filter((r) => !r.paid_partnership).every((r) => r.p3.decision === 'UNKNOWN' && r.p5 === null));
  assert.strictEqual(a.counts.jev_errors, 12);
});

test('only an accepted offer for exactly one Reel is a campaign fee for one Reel', () => {
  assert.ok(isOneReel(['1 Reel']));
  assert.ok(isOneReel(['Instagram Reel']));
  assert.ok(isOneReel(['1 x Instagram Reel']));
  assert.ok(!isOneReel(['2 Reels']));
  assert.ok(!isOneReel(['1 Reel', '2 Stories']));
  assert.ok(!isOneReel(['1 Reel + 1 Story']));
  assert.ok(!isOneReel(['Reel and story']));
  assert.ok(!isOneReel(['1 TikTok']));
  assert.ok(!isOneReel([]));
});
