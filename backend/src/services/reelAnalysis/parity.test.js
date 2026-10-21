'use strict';

// The Reel analysis port must decide exactly what creator-list's Python decides. The fixture
// (__fixtures__/reelAnalysis.parity.json) is creator-list's own code run on fixed Reels and
// creators: rules.py signals and brand candidates, p03_sponsorship.detect with scripted Jev
// answers, content.py's Jev state and questions, and tools/make_review_workbook.economics
// (P6-P11 + the Estimated CPM stickers) plus p10's fee cascade with rate evidence.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const FIX = require(path.join(__dirname, '..', '__fixtures__', 'reelAnalysis.parity.json'));
const { fromApify, toReelRow, otherAccounts } = require('./reels');
const rules = require('./rules');
const sponsorship = require('./sponsorship');
const content = require('./content');
const E = require('./economics');
const cpmEstimate = require('../cpmEstimate');

const AS_OF = new Date(FIX.as_of);

function record(spec) {
  const row = spec.row || toReelRow(spec.raw);
  const r = fromApify(row, spec.creator);
  r.ocr_text = spec.ocr;
  r.transcript = spec.transcript;
  return r;
}

// Python floats print 1.0 as 1.0; compare numbers with a tolerance and everything else exactly.
function near(actual, expected, where) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${where}: ${actual} != ${expected}`);
    return;
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const k of Object.keys(expected)) near(actual == null ? undefined : actual[k], expected[k], `${where}.${k}`);
    return;
  }
  if (typeof expected === 'string' && /confidence$/.test(where) && /^(HIGH|MEDIUM|LOW|UNKNOWN)$/.test(expected)) {
    assert.strictEqual(actual, expected.toLowerCase(), where); // Python's Confidence enum values
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: not an array`);
    assert.strictEqual(actual.length, expected.length, `${where}: length`);
    expected.forEach((e, i) => near(actual[i], e, `${where}[${i}]`));
    return;
  }
  assert.deepStrictEqual(actual, expected, where);
}

class ScriptedJev {
  constructor(table) { this.table = table; }

  async decide(state, questions) {
    const t = this.table;
    if (t === 'error') throw new Error('Jev via OpenRouter: HTTP 502');
    const answers = {};
    for (const [qid, q] of Object.entries(questions)) {
      const opts = Object.keys(q.criteria);
      if (qid === 'collaboration') answers[qid] = { choice: t.collab_choice, confidence: 0.7, probabilities: t.collab_probs };
      else if (qid === 'commercial_class') answers[qid] = { choice: t.class, confidence: 0.6, probabilities: { [t.class]: 0.6 } };
      else if (qid === 'sponsor_brand') {
        const pick = opts[Math.min(t.brand_index, opts.length - 1)];
        answers[qid] = { choice: pick, confidence: 0.81, probabilities: { [pick]: 0.81 } };
      }
    }
    return { model: 'jev', answers, cost_usd: 0.0002 };
  }
}

for (const c of FIX.reels) {
  const id = c.spec.row ? c.spec.row.shortCode : c.spec.raw.shortcode;

  test(`Reel ${id}: record, signals, candidates and Jev state match creator-list`, () => {
    const r = record(c.spec);
    near({
      post_id: r.post_id, creator: r.creator, owner: r.owner, hashtags: r.hashtags, mentions: r.mentions,
      tagged: r.tagged, coauthors: r.coauthors, other_accounts: otherAccounts(r), plays: r.plays, likes: r.likes,
      duration_s: r.duration_s, original_audio: r.original_audio, thumbnail_url: r.thumbnail_url,
      published_at: r.published_at ? r.published_at.toISOString().replace('.000Z', 'Z') : null,
    }, c.record, 'record');
    assert.deepStrictEqual(rules.signals(r), c.signals);
    assert.deepStrictEqual(rules.namedBusinesses(r), c.named_businesses);
    assert.deepStrictEqual(rules.mentionedNames(r), c.mentioned_names);
    assert.deepStrictEqual([...rules.codeWords(r)].sort(), c.code_words);
    assert.deepStrictEqual([...rules.spokenNames(r)].sort(), c.spoken_names);
    assert.deepStrictEqual(rules.hashtagNames(r), c.hashtag_names);
    const cands = sponsorship.brandCandidates(r);
    assert.deepStrictEqual(cands, c.candidates);
    assert.deepStrictEqual(sponsorship.jevState(r), c.jev_state);
    assert.deepStrictEqual(sponsorship.questions(cands), c.questions);
    assert.deepStrictEqual(content.state(r), c.content_state);
  });

  test(`Reel ${id}: collaboration decision and brand match creator-list for every Jev answer`, async () => {
    const r = record(c.spec);
    for (const d of c.detect) {
      const out = await sponsorship.detect(r, new ScriptedJev(d.table));
      const s = out.sponsorship;
      near({
        decision: s.decision, confidence: s.confidence, decided_by: s.decided_by, commercial_class: s.commercial_class,
        candidate: s.candidate, sponsor_brand: out.brand.sponsor_brand, sponsor_confidence: out.brand.sponsor_confidence,
        method: out.brand.method,
      }, { ...d, table: undefined }, `detect ${JSON.stringify(d.table)}`);
    }
    const none = await sponsorship.detect(r, null);
    assert.deepStrictEqual({ decision: none.sponsorship.decision, decided_by: none.sponsorship.decided_by }, c.detect_without_jev);
  });
}

test('P5 questions are creator-list\'s taxonomy questions, word for word', () => {
  assert.deepStrictEqual(content.questions(), FIX.content.questions);
});

// A p1_p5 creator document in the shape the analysis stores (queue.pricingCopy).
function analysisOf(c) {
  const sizes = {};
  for (const [k, v] of Object.entries(FIX.brand_sizes)) sizes[k.toLowerCase()] = v;
  return {
    as_of: c.data.as_of,
    account: { instagram_country: c.instagram_country },
    brand_sizes: sizes,
    reels: c.data.posts.map((p) => ({
      post_id: p.post_id,
      published_at: p.published_at,
      plays: p.metrics.plays,
      p3: { decision: p.p3.decision },
      p4: { sponsor_brand: p.p4.sponsor_brand },
      p5: p.p5.content.attributes,
    })),
  };
}

for (const c of FIX.creators) {
  test(`creator ${c.data.creator}: views, Estimated CPM, rate and realised CPM match creator-list`, () => {
    const est = cpmEstimate.estimateForCreator({ reel_analysis: analysisOf(c) }, { now: AS_OF });
    const o = c.out;
    near(est.typical_views.value, o.typical.value, 'typical');
    assert.strictEqual(est.typical_views.method, o.typical.method);
    near(est.expected_views.value, o.ad_views.value, 'ad views');
    assert.strictEqual(est.expected_views.method, o.ad_views.method);
    near(est.cpm.value, o.est_cpm.value, 'cpm');
    near(est.cpm.low, o.est_cpm.low, 'cpm low');
    near(est.cpm.high, o.est_cpm.high, 'cpm high');
    near(est.cpm.notes, o.est_cpm.notes, 'cpm notes');
    near(est.cpm.combined_factor, o.est_cpm.combined_factor, 'combined');
    for (const [i, s] of o.est_cpm.stickers.entries()) {
      const mine = est.cpm.stickers[i];
      near({ name: mine.name, value: mine.value, label: mine.label, level: mine.level, low: mine.low, high: mine.high, evidence: mine.evidence },
        { name: s.name, value: s.value, label: s.label, level: s.level, low: s.low, high: s.high, evidence: s.evidence }, `sticker ${s.name}`);
    }
    near(est.rate.value, o.fee.value, 'fee');
    near(est.rate.low, o.fee.low, 'fee low');
    near(est.rate.high, o.fee.high, 'fee high');
    assert.strictEqual(est.rate.method, o.fee.method);
    if (o.realised.value == null) assert.strictEqual(est.realised_cpm, null);
    else {
      near(est.realised_cpm.value, o.realised.value, 'realised');
      near(est.realised_cpm.low, o.realised.low, 'realised low');
      near(est.realised_cpm.high, o.realised.high, 'realised high');
      assert.strictEqual(est.realised_cpm.inputs.basis, o.realised.inputs.basis);
    }
    assert.deepStrictEqual(est.inputs.country, { code: o.where.country, source: o.where.source, evidence: o.where.evidence });
  });

  test(`creator ${c.data.creator}: P8 / P9 match creator-list`, () => {
    const a = analysisOf(c);
    const posts = a.reels.filter((p) => p.published_at).map((p) => ({
      post_id: p.post_id, published_at: new Date(p.published_at), views: p.plays ?? null,
      views_observed_at: new Date(a.as_of), status: E.STATUS[p.p3.decision], classification_confidence: 1,
    }));
    const asOf = new Date(a.as_of);
    const base = E.currentOrganicBaseline(posts, { asOf });
    near({ value: base.value, low: base.low, high: base.high, confidence: base.confidence }, { value: c.out.base.value, low: c.out.base.low, high: c.out.base.high, confidence: c.out.base.confidence }, 'P8');
    const exp = E.expectedSponsoredViews(base, E.sponsoredMultiplier(posts, { asOf }));
    near({ value: exp.value, low: exp.low, high: exp.high, confidence: exp.confidence }, { value: c.out.expected.value, low: c.out.expected.low, high: c.out.expected.high, confidence: c.out.expected.confidence }, 'P9');
  });
}

test('the fee cascade takes rate evidence as creator-list does', () => {
  const c = FIX.creators[0];
  const a = analysisOf(c);
  for (const [name, f] of Object.entries(FIX.fee)) {
    const evidence = f.evidence.map((x) => ({ ...x, observed_at: new Date(x.observed_at), rate_type: x.rate_type, content_type: x.content_type }));
    const posts = a.reels.filter((p) => p.published_at).map((p) => ({
      post_id: p.post_id, published_at: new Date(p.published_at), views: p.plays ?? null,
      views_observed_at: new Date(a.as_of), status: E.STATUS[p.p3.decision], classification_confidence: 1,
    }));
    const asOf = new Date(a.as_of);
    const typical = E.typicalViews(posts, { asOf });
    const adViews = E.expectedAdViews(E.expectedSponsoredViews(E.currentOrganicBaseline(posts, { asOf }), E.sponsoredMultiplier(posts, { asOf })), posts, typical, { asOf });
    const cpm = cpmEstimate.estimateCpm({
      content: [{ topic: 'beauty' }], market: cpmEstimate.resolveMarket('IN'), typicalViews: typical,
      brandDeals: [{ brand: 'nykaa', followers: 2400000 }],
    });
    const fee = E.estimateFee({ asOf, rateEvidence: evidence, estimatedCpm: cpm, adViews });
    near({ value: fee.value, low: fee.low, high: fee.high, confidence: fee.confidence, method: fee.method },
      { value: f.fee.value, low: f.fee.low, high: f.fee.high, confidence: f.fee.confidence, method: f.fee.method }, name);
    near(fee.notes, f.fee.notes, `${name} notes`);
  }
});
