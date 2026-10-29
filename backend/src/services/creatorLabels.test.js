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
  assert.match(cl.decideFromCreator(profile({ topic: { fitness: 1 } }), targets()).reasons[0], /no target to judge against/);
  const none = cl.decideFromCreator(profile({}, 0), targets({ topics: ['fitness'] }));
  assert.strictEqual(none.decision, 'review');
  assert.match(none.reasons[0], /no reel could be labelled/);
  assert.strictEqual(none.fit, null);
});

// Too few Reels is a person's call — but the reason says what was missing and
// what the few there are show, with a provisional fit.
test('too few Reels: review, saying why plainly, with a provisional fit', () => {
  const two = cl.decideFromCreator(profile({ topic: { fitness: 1 } }, 2), targets({ topics: ['fitness'] }));
  assert.strictEqual(two.decision, 'review');
  assert.deepStrictEqual(two.reasons, ['only 2 reels to judge', 'those reels are on target']);
  assert.strictEqual(two.fit, 1);
  assert.strictEqual(two.provisional, true);
  assert.strictEqual(two.thin, true);

  const one = { ...profile({ topic: { gaming: 1 } }, 1), fallback: true, errors: ['Reels: Monid wallet is empty (HTTP 402): top it up'] };
  const d = cl.decideFromCreator(one, targets({ topics: ['fitness'] }));
  assert.strictEqual(d.decision, 'review', 'one reel is never enough to reject');
  assert.strictEqual(d.reasons[0], 'only 1 reel to judge (the one that surfaced them) — their Reels could not be collected: Reels: Monid wallet is empty (HTTP 402): top it up');
  assert.match(d.reasons[1], /^that reel: probably off-target/);
  assert.strictEqual(d.fit, 0, 'nothing matched: provisional 0');
  assert.strictEqual(d.provisional, true);

  const partly = { ...profile({ topic: { fitness: 1 } }, 2), reels: 10, errors: ['8 of 10 Reels could not be labelled (Groq: down)'] };
  assert.strictEqual(cl.decideFromCreator(partly, targets({ topics: ['fitness'] })).reasons[0], 'only 2 reels to judge of 10 collected — 8 of 10 Reels could not be labelled (Groq: down)');
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
  assert.deepStrictEqual(p.monid, { calls: 2, usd: 0.004 }, 'one card and one page of Reels: $0.004 a creator');
});

// The reel that surfaced them: recorded on the phone and labelled before their profile
// was opened (jevJudge.judgeReel). Here it is one more labelled Reel of theirs.
const recordedSource = (deps, caption = 'five moves for strong legs') => cl.labelReel(
  { code: 'source', buf: Buffer.from('screen recording'), caption, keepText: true },
  { handle: 'coach', deps },
);

test('the phone\'s recording is heard, read and seen — with Instagram\'s own buttons cropped off', async () => {
  const { deps } = fakes();
  let seenWith = null;
  deps.describe = async (buf, reel) => { seenWith = { buf: buf.toString(), ...reel }; return { cues: { summary: 'a coach demonstrates squats' }, costUsd: 0.002 }; };
  const r = await recordedSource(deps);
  assert.strictEqual(seenWith.buf, 'screen recording');
  assert.strictEqual(seenWith.screenRecording, true, 'the app\'s chrome is cropped before the vision model looks');
  assert.strictEqual(r.seen, true);
  assert.strictEqual(r.labels.topic.value, 'fitness');
  assert.strictEqual(r.transcript, 'today we train legs with five simple moves');
  assert.strictEqual(r.seenSummary, 'a coach demonstrates squats');
  assert.strictEqual(r.caption, 'five moves for strong legs');
});

test('the reel that surfaced them joins the Reels Monid collected, labelled once', async () => {
  const { deps, jevCalls } = fakes();
  const source = await recordedSource(deps);
  const p = await cl.labelCreator({ handle: 'coach', source, deps });
  assert.strictEqual(p.reels, 4, '3 collected + the one that surfaced them');
  assert.strictEqual(p.perReel[0].code, 'source');
  assert.strictEqual(jevCalls.filter((c) => c.state.caption === 'five moves for strong legs').length, 1, 'not labelled again');
  assert.strictEqual(p.fallback, undefined);
});

test('a source reel Monid also collected counts once, from its full video', async () => {
  const { deps } = fakes();
  const source = await recordedSource(deps, 'home workout for beginners');
  const p = await cl.labelCreator({ handle: 'coach', source, deps });
  assert.strictEqual(p.reels, 3);
  assert.ok(!p.perReel.some((r) => r.code === 'source'));
});

test('their Reels could not be collected: judged from the reel that surfaced them, and why is kept', async () => {
  const { deps, jevCalls } = fakes();
  deps.monid.fetchReels = async () => { throw new Error('Monid wallet is empty (HTTP 402): top it up'); };
  const source = await recordedSource(deps);
  const p = await cl.labelCreator({ handle: 'coach', source, deps });
  assert.strictEqual(p.source, 'reels');
  assert.strictEqual(p.fallback, true);
  assert.strictEqual(p.reels, 1);
  assert.strictEqual(jevCalls.length, 1, 'only the source reel, labelled before');
  assert.deepStrictEqual(p.errors, ['Reels: Monid wallet is empty (HTTP 402): top it up']);
  // One reel is always a person's call, with the reason.
  const d = cl.decideFromCreator(p, { topics: ['fitness'], niches: [], genres: [], formats: [] });
  assert.strictEqual(d.decision, 'review');
  assert.match(d.reasons[0], /only 1 reel to judge \(the one that surfaced them\) — their Reels could not be collected: Reels: Monid wallet is empty/);
});

test('Monid answering with no Reels says so', async () => {
  const { deps } = fakes();
  deps.monid.fetchReels = async () => ({ reels: [], costUsd: 0.002 });
  const p = await cl.labelCreator({ handle: 'coach', source: await recordedSource(deps), deps });
  assert.strictEqual(p.fallback, true);
  assert.deepStrictEqual(p.errors, ['Monid found no Reels on their account']);
});

test('neither creator-list nor MONID_API_KEY: judged from the source reel, and why is kept', async () => {
  const none = await cl.labelCreator({ handle: 'coach', deps: { fromCreatorList: async () => null } });
  assert.strictEqual(none.source, null, 'nothing at all to label');
  assert.match(none.reason, /MONID_API_KEY/);
  const { deps } = fakes();
  const source = await recordedSource(deps);
  delete deps.monid;
  const prev = process.env.MONID_API_KEY;
  delete process.env.MONID_API_KEY;
  try {
    const p = await cl.labelCreator({ handle: 'coach', source, deps });
    assert.strictEqual(p.fallback, true);
    assert.match(p.errors[0], /MONID_API_KEY is not set/);
  } finally {
    if (prev !== undefined) process.env.MONID_API_KEY = prev;
  }
});

test('the bio has a say in their topic and niche, none in genre, format or the Reel count', async () => {
  const { deps, jevCalls } = fakes();
  const p = await cl.labelCreator({ handle: 'coach', bio: 'Home fitness coach · free plans below', deps });
  assert.ok(jevCalls.some((c) => c.state.caption === 'Home fitness coach · free plans below'), 'the bio was labelled');
  assert.strictEqual(p.reels, 3, 'the bio is not a Reel');
  assert.strictEqual(p.labelled, 3);
  assert.deepStrictEqual(p.shares.topic, { fitness: 0.75, food_drink: 0.25 }, '2 of 3 Reels + the bio');
  assert.deepStrictEqual(p.shares.genre, { educational: 1 }, 'genre from the Reels alone');
  assert.deepStrictEqual(p.bio, { topic: 'fitness', niche: 'gym_strength' });
});

test('Monid collects a full page of 12 Reels', () => {
  assert.strictEqual(cl.REELS, 12);
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

test('only Instagram CDN video links are downloaded', () => {
  assert.ok(cl.cdnUrl('https://scontent-cph2-1.cdninstagram.com/o1/v.mp4'));
  assert.ok(cl.cdnUrl('https://video.fbcdn.net/x.mp4'));
  assert.strictEqual(cl.cdnUrl('https://evil.example.com/cdninstagram.com.mp4'), null);
  assert.strictEqual(cl.cdnUrl('http://scontent.cdninstagram.com/x.mp4'), null);
});

// ── what the admin's review notes teach (services/reviewLessons.js) ─────────

const LESSONS = { rules: [{ dim: 'genre', value: 'comedy', why: 'only memes, no real tutorials' }], basis: 3 };

test('a creator mostly making what the admin passes on is rejected with their reason', () => {
  const p = profile({ topic: { fitness: 0.9 }, genre: { comedy: 0.6, educational: 0.4 } });
  const t = targets({ topics: ['fitness'] });
  assert.strictEqual(cl.decideFromCreator(p, t).decision, 'shortlist', 'on target without the lesson');
  const d = cl.decideFromCreator(p, t, LESSONS);
  assert.strictEqual(d.decision, 'reject');
  assert.deepStrictEqual(d.reasons, ['you passed on creators like this — "only memes, no real tutorials" (Comedy in 60% of their reels)']);
  assert.strictEqual(d.lesson, true);
});

test('a lesson holds, not rejects, when too few Reels say so', () => {
  const d = cl.decideFromCreator(profile({ topic: { fitness: 1 }, genre: { comedy: 1 } }, 3), targets({ topics: ['fitness'] }), LESSONS);
  assert.strictEqual(d.decision, 'review');
  assert.match(d.reasons[0], /^you passed on creators like this/);
  assert.strictEqual(d.lesson, true);
});

test('a lesson only applies to what MOST of their Reels are', () => {
  const d = cl.decideFromCreator(profile({ topic: { fitness: 0.9 }, genre: { educational: 0.6, comedy: 0.4 } }), targets({ topics: ['fitness'] }), LESSONS);
  assert.strictEqual(d.decision, 'shortlist');
});
