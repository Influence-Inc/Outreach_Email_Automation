'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cl = require('./creatorLabels');
const PARITY = require('./__fixtures__/creatorTopics.parity.json');

const reelsOf = (rows) => rows.map((r) => ({ labels: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v, confidence: 0.9 }])) }));

test('shares and own topics, niches and genres match creator-list on recorded cases', () => {
  for (const [i, c] of PARITY.cases.entries()) {
    const a = cl.aggregate(reelsOf(c.reels));
    assert.deepStrictEqual({ shares: a.shares, own: a.own }, c.out, `case ${i}`);
  }
});

test('a dedicated topic needs half the reels, a broad one a fifth', () => {
  const fit = cl.aggregate(reelsOf([
    ...Array(5).fill({ topic: 'fitness', niche: 'unclear', genre: 'educational', format: 'tutorial_how_to' }),
    ...Array(5).fill({ topic: 'food_drink', niche: 'unclear', genre: 'comedy', format: 'skit' }),
  ]));
  assert.deepStrictEqual(fit.own.topics, ['fitness', 'food_drink'], 'fitness 50% (dedicated), food 50% (broad)');
  const few = cl.aggregate(reelsOf([
    ...Array(2).fill({ topic: 'fitness', niche: 'unclear', genre: 'educational', format: 'skit' }),
    ...Array(8).fill({ topic: 'beauty', niche: 'unclear', genre: 'educational', format: 'skit' }),
  ]));
  assert.deepStrictEqual(few.own.topics, ['beauty'], 'two fitness reels in ten do not make a fitness creator');
});

const targets = (o = {}) => ({ topics: [], niches: [], genres: [], formats: [], ...o });
const profile = (shares, labelled = 10) => {
  const p = { reels: labelled, labelled, shares: { topic: {}, niche: {}, genre: {}, format: {}, ...shares } };
  p.own = cl.aggregate([]).own;
  const own = (kind, s, t) => Object.keys(s).filter((k) => cl.qualifies(kind, k, s, t));
  p.own = { topics: own('topic', p.shares.topic), niches: own('niche', p.shares.niche, p.shares.topic), genres: own('genre', p.shares.genre) };
  return p;
};

test('shortlisted when the targeted topic and format are theirs', () => {
  const d = cl.decideFromCreator(profile({ topic: { fitness: 0.8, food_drink: 0.2 }, format: { tutorial_how_to: 0.4, skit: 0.6 } }), targets({ topics: ['fitness'], formats: ['tutorial_how_to'] }));
  assert.strictEqual(d.decision, 'shortlist');
  assert.strictEqual(d.fit, 0.4);
});

test('some on-target reels, not enough to be their own: review, saying how many', () => {
  const d = cl.decideFromCreator(profile({ topic: { beauty: 0.7, fitness: 0.3 } }), targets({ topics: ['fitness'] }));
  assert.strictEqual(d.decision, 'review');
  assert.match(d.reasons[0], /Fitness in 30% of their reels — not enough to be their own \(mostly Beauty 70%, Fitness 30%\)/);
});

test('none of their reels on target: rejected, but only with enough reels to say so', () => {
  const many = cl.decideFromCreator(profile({ topic: { gaming: 1 } }, 8), targets({ topics: ['fitness'] }));
  assert.strictEqual(many.decision, 'reject');
  assert.match(many.reasons[0], /their reels are about Gaming 100%, not Fitness/);
  const few = cl.decideFromCreator(profile({ topic: { gaming: 1 } }, 4), targets({ topics: ['fitness'] }));
  assert.strictEqual(few.decision, 'review');
});

test('too few labelled reels, or nothing to judge against: review', () => {
  assert.match(cl.decideFromCreator(profile({ topic: { fitness: 1 } }, 2), targets({ topics: ['fitness'] })).reasons[0], /only 2 of their 2 reels could be labelled/);
  assert.match(cl.decideFromCreator(profile({ topic: { fitness: 1 } }), targets()).reasons[0], /no target to judge against/);
});

test('a target niche whose parent topic is theirs: review as "right topic, other niche"', () => {
  const d = cl.decideFromCreator(profile({ topic: { fitness: 1 }, niche: { yoga_pilates: 1 } }), targets({ niches: ['gym_strength'] }));
  assert.strictEqual(d.decision, 'review');
  assert.match(d.reasons[0], /right topic \(Fitness\), other niche/);
});

// ── labelling a creator ─────────────────────────────────────────────────────

function fakes(over = {}) {
  const jevCalls = [];
  const deps = {
    fromCreatorList: async () => null,
    monid: {
      fetchCard: async () => ({ country: 'United States', costUsd: 0.002 }),
      fetchReels: async () => ({
        reels: [
          { code: 'a', caption: 'home workout for beginners', hashtags: ['fitness'], videoUrl: 'https://scontent.cdninstagram.com/a.mp4', durationS: 20 },
          { code: 'b', caption: 'leg day at the gym', hashtags: [], videoUrl: 'https://scontent.cdninstagram.com/b.mp4', durationS: 30 },
          { code: 'c', caption: 'my morning smoothie', hashtags: [], videoUrl: null },
        ],
        costUsd: 0.002,
      }),
    },
    download: async () => Buffer.from('mp4'),
    split: async () => ({ audio: { state: 'ok', buf: Buffer.from('mp3'), mimeType: 'audio/mpeg' }, frames: ['f1'], errors: [], cleanup: async () => {} }),
    transcribe: async () => ({ text: 'today we train legs with five simple moves', language: 'english', duration: 20 }),
    readFrames: async () => ({ text: 'LEG DAY', frames: 1 }),
    callJev: async (state, questions) => {
      jevCalls.push({ state, questions: Object.keys(questions) });
      const food = /smoothie/.test(state.caption);
      const a = (choice, confidence = 0.9) => ({ choice, confidence, probabilities: { [choice]: confidence } });
      return {
        costUsd: 0.0005,
        answers: {
          topic: a(food ? 'food_drink' : 'fitness'),
          niche: a(food ? 'unclear' : 'gym_strength'),
          genre: a('educational'),
          format: a('tutorial_how_to'),
          audience_gender: a('everyone'),
          audience_life_stage: a('young_adults'),
          audience_scope: a('international'),
        },
      };
    },
    ...over,
  };
  return { deps, jevCalls };
}

test('a creator creator-list does not have is labelled from their newest Reels, creator-list\'s way', async () => {
  const { deps, jevCalls } = fakes();
  const p = await cl.labelCreator({ handle: '@Coach', deps });
  assert.strictEqual(p.source, 'reels');
  assert.strictEqual(p.reels, 3);
  assert.strictEqual(p.labelled, 3);
  assert.deepStrictEqual(p.shares.topic, { fitness: 0.67, food_drink: 0.33 });
  assert.deepStrictEqual(p.own.topics, ['fitness', 'food_drink']);
  const call = (caption) => jevCalls.find((c) => c.state.caption === caption);
  const first = call('home workout for beginners');
  assert.deepStrictEqual(first.questions, ['topic', 'niche', 'genre', 'format', 'audience_gender', 'audience_life_stage', 'audience_scope']);
  assert.strictEqual(first.state.speech, 'today we train legs with five simple moves');
  assert.strictEqual(first.state.on_screen_text, 'LEG DAY');
  assert.deepStrictEqual(first.state.hashtags, ['fitness']);
  assert.strictEqual(call('my morning smoothie').state.speech, '', 'a Reel with no video is judged on its caption');
  assert.strictEqual(p.audience.geography.primary_country, 'US');
  assert.ok(p.costUsd > 0);
});

test('the phone\'s recording counts as one more Reel, unless it is one already collected', async () => {
  const { deps, jevCalls } = fakes();
  const recorded = { state: { creator: 'coach', caption: 'brand new reel', hashtags: [], on_screen_text: '', speech: 'five moves for strong legs every day', has_speech: true, duration_seconds: 12, uses_original_audio: null } };
  const p = await cl.labelCreator({ handle: 'coach', recorded, deps });
  assert.strictEqual(p.reels, 4);
  assert.strictEqual(jevCalls.length, 4);
  const again = fakes();
  const dup = await cl.labelCreator({ handle: 'coach', recorded: { state: { ...recorded.state, caption: 'Leg day at the gym' } }, deps: again.deps });
  assert.strictEqual(dup.reels, 3, 'the same caption: already among the collected Reels');
});

test('creator-list\'s own labels are used first, at no cost', async () => {
  let asked = null;
  const p = await cl.fromCreatorList('Coach', {
    configured: () => true,
    call: async (h, o) => { asked = [h, o]; return {
      status: 'indexed',
      creator: {
        reels_analysed: 30, as_of: '2026-10-20', topics: { fitness: 0.7, food_drink: 0.3 }, niches: { gym_strength: 0.5 }, genres: { educational: 0.6 }, formats: { tutorial_how_to: 0.5 },
        audience: { female: 0.4, lean: 'balanced', age_main: ['18-24', '25-34'], primary_country: 'US', countries: [['US', 0.6]], confidence: { gender: 'medium' }, calibrated: false },
      },
    }; },
  });
  assert.deepStrictEqual(asked, ['coach', { queue: false }], 'looked up, never queued from here');
  assert.strictEqual(p.source, 'creator-list');
  assert.strictEqual(p.reels, 30);
  assert.deepStrictEqual(p.own.topics, ['fitness', 'food_drink'], 'food at 30% clears the fifth a broad topic needs');
  assert.deepStrictEqual(p.own.niches, ['gym_strength']);
  assert.strictEqual(p.audience.gender.lean, 'balanced');
  assert.strictEqual(p.audience.geography.primary_country, 'US');
  // Not indexed, or too few Reels analysed: null, and the Reels are collected instead.
  assert.strictEqual(await cl.fromCreatorList('x', { configured: () => true, call: async () => ({ status: 'not_indexed' }) }), null);
  assert.strictEqual(await cl.fromCreatorList('x', { configured: () => false, call: async () => { throw new Error('not called'); } }), null);
});

test('neither creator-list nor MONID_API_KEY: says why, for the one-reel fallback', async () => {
  const p = await cl.labelCreator({ handle: 'coach', deps: { fromCreatorList: async () => null } });
  assert.strictEqual(p.source, null);
  assert.match(p.reason, /MONID_API_KEY/);
});

test('only Instagram CDN video links are downloaded', () => {
  assert.ok(cl.cdnUrl('https://scontent-cph2-1.cdninstagram.com/o1/v.mp4'));
  assert.ok(cl.cdnUrl('https://video.fbcdn.net/x.mp4'));
  assert.strictEqual(cl.cdnUrl('https://evil.example.com/cdninstagram.com.mp4'), null);
  assert.strictEqual(cl.cdnUrl('http://scontent.cdninstagram.com/x.mp4'), null);
});
