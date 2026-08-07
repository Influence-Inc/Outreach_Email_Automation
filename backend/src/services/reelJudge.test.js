'use strict';

const test = require('node:test');
const assert = require('node:assert');
const reelJudge = require('./reelJudge');

const fakeGemini = (verdict) => ({
  available: () => true,
  classifyReelVideo: async () => verdict,
});

const clipCandidate = {
  username: 'home.fit.mia',
  bio: 'home fitness coach',
  clip: { dataBase64: 'AAAA', mimeType: 'video/mp4' },
  reels: [{ caption: 'home gym workout' }],
};

test('buildPrompt embeds the rules, target audience, genres, bio + captions', () => {
  const p = reelJudge.buildPrompt(clipCandidate, {
    niche: 'fitness',
    keywords: ['gym'],
    targetAudience: 'women 25-34 starting to work out',
    genres: ['fitness', 'wellness'],
  });
  assert.match(p, /Target niche\/genre: fitness/);
  assert.match(p, /Brand target audience: women 25-34 starting to work out/);
  assert.match(p, /Allowed genres: fitness, wellness/);
  assert.match(p, /home gym workout/);
  assert.match(p, /"niche_score"/);
  assert.match(p, /audio/i); // instructs the model to use the audio
});

test('classifyWithGemini returns a rich verdict when a clip + key are present', async () => {
  const gemini = fakeGemini({
    niche_score: 0.88, audience_match: 0.7, genre: 'home fitness',
    language: 'en', spoken_topic: 'quick home workout', confidence: 0.9, reason: 'clearly fitness',
  });
  const r = await reelJudge.classifyWithGemini(clipCandidate, { niche: 'fitness' }, { gemini });
  assert.strictEqual(r.source, 'gemini-video');
  assert.strictEqual(r.score, 0.88);
  assert.strictEqual(r.evidence.genre, 'home fitness');
  assert.strictEqual(r.evidence.audienceMatch, 0.7);
  assert.strictEqual(r.evidence.spokenTopic, 'quick home workout');
});

test('classifyWithGemini returns null with no clip, or when Gemini is unavailable', async () => {
  const gemini = fakeGemini({ niche_score: 1 });
  assert.strictEqual(await reelJudge.classifyWithGemini({ username: 'a' }, {}, { gemini }), null);
  assert.strictEqual(
    await reelJudge.classifyWithGemini(clipCandidate, {}, { gemini: { available: () => false } }),
    null,
  );
});

test('classifyWithGemini returns null when the model output lacks a niche_score', async () => {
  const r = await reelJudge.classifyWithGemini(clipCandidate, {}, { gemini: fakeGemini({ genre: 'x' }) });
  assert.strictEqual(r, null);
});

test('makeClassifier reuses a precomputed _nicheVerdict (no double judging)', async () => {
  let called = 0;
  const classify = reelJudge.makeClassifier({
    gemini: { available: () => { called += 1; return true; }, classifyReelVideo: async () => ({ niche_score: 0.9 }) },
    claudeClassify: async () => { called += 1; return { score: 0.1 }; },
  });
  const cand = { username: 'a', _nicheVerdict: { score: 0.8, reason: 'pre', source: 'gemini-video' } };
  const r = await classify(cand, {});
  assert.strictEqual(r.score, 0.8);
  assert.strictEqual(called, 0, 'neither Gemini nor Claude was invoked');
});

test('makeClassifier prefers Gemini, falling back to Claude when there is no clip', async () => {
  const classify = reelJudge.makeClassifier({
    gemini: fakeGemini({ niche_score: 0.8, genre: 'fitness' }),
    claudeClassify: async () => ({ score: 0.2, reason: 'claude-thumbnails' }),
  });
  const withClip = await classify(clipCandidate, {});
  assert.strictEqual(withClip.source, 'gemini-video');

  const noClip = await classify({ username: 'a', bio: 'x' }, {});
  assert.strictEqual(noClip.reason, 'claude-thumbnails');
});
