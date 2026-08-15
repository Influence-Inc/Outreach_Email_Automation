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

// ── judging a creator from three reels (§5) ─────────────────────────────────

// A gemini double that answers per call: the clip passes come first (one per
// clip, in order), and the creator-level pass — the only one with no video —
// comes last.
function scriptedGemini(clipReplies, creatorReply = null) {
  const calls = [];
  let i = 0;
  return {
    calls,
    available: () => true,
    classifyReelVideo: async (opts) => {
      calls.push(opts);
      if (!opts.videoBase64) return creatorReply;
      return clipReplies[i++] ?? clipReplies[clipReplies.length - 1];
    },
  };
}

const threeClips = {
  username: 'mia',
  bio: 'home fitness',
  reels: [{ views: 50000 }, { views: 52000 }, { views: 48000 }],
  clips: [
    { dataBase64: 'AAA', mimeType: 'video/mp4' },
    { dataBase64: 'BBB', mimeType: 'video/mp4' },
    { dataBase64: 'CCC', mimeType: 'video/mp4' },
  ],
};

test('every recorded clip is judged, not just the first', async () => {
  const gemini = scriptedGemini(
    [
      { niche_score: 0.9, creativity: 9, hook_strength: 8, is_original_creator: true },
      { niche_score: 0.6, creativity: 6, hook_strength: 6, is_original_creator: true },
      { niche_score: 0.3, creativity: 4, hook_strength: 5, is_original_creator: true },
    ],
    { fit_score: 78, consistency_of_niche: 7 },
  );

  const r = await reelJudge.judgeClips(threeClips, { niche: 'fitness' }, { gemini });

  const videoCalls = gemini.calls.filter((c) => c.videoBase64);
  assert.deepStrictEqual(videoCalls.map((c) => c.videoBase64), ['AAA', 'BBB', 'CCC']);
  assert.strictEqual(r.clips.length, 3, 'three clip analyses came back');
  assert.ok(Math.abs(r.score - 0.6) < 0.001, 'the score is the mean, not the best');
});

// The mean alone hides "0.9 / 0.2 / 0.85", which is a different proposition
// from a steady 0.65.
test('the individual clip scores are kept, not just their mean', async () => {
  const gemini = scriptedGemini([
    { niche_score: 0.9 }, { niche_score: 0.2 }, { niche_score: 0.85 },
  ]);
  const r = await reelJudge.judgeClips(threeClips, {}, { gemini });
  assert.deepStrictEqual(r.evidence.clipScores, [0.9, 0.2, 0.85]);
});

// fit_score and consistency_of_niche are the two numbers the deterministic gate
// weighs most heavily, and only the creator-level pass produces them.
test('the creator-level analysis runs once, from the clip analyses', async () => {
  const gemini = scriptedGemini(
    [{ niche_score: 0.8, creativity: 8 }],
    { fit_score: 91, consistency_of_niche: 9, primary_niche: 'home fitness' },
  );

  const r = await reelJudge.judgeClips(threeClips, { niche: 'fitness' }, { gemini });

  const creatorCalls = gemini.calls.filter((c) => !c.videoBase64);
  assert.strictEqual(creatorCalls.length, 1, 'one creator pass, not one per clip');
  assert.match(creatorCalls[0].promptText, /judging an Instagram CREATOR/);
  assert.match(creatorCalls[0].promptText, /typical 50000/, 'the reach window is in the prompt');
  assert.strictEqual(r.creatorAnalysis.fit_score, 91);
  assert.strictEqual(r.evidence.creator.consistency_of_niche, 9);
});

test('a failed creator pass still yields the clip analyses', async () => {
  const gemini = {
    available: () => true,
    classifyReelVideo: async (opts) => {
      if (!opts.videoBase64) throw new Error('gemini is down');
      return { niche_score: 0.7, creativity: 7 };
    },
  };
  const r = await reelJudge.judgeClips(threeClips, {}, { gemini });
  assert.strictEqual(r.creatorAnalysis, null);
  assert.strictEqual(r.clips.length, 3, 'the clip work is not thrown away');
});

// Nothing about a one-clip capture changes.
test('a single clip takes the original path', async () => {
  const gemini = scriptedGemini([{ niche_score: 0.75, genre: 'fitness' }]);
  const one = { ...threeClips, clips: [{ dataBase64: 'AAA' }], clip: { dataBase64: 'AAA' } };

  const r = await reelJudge.judgeClips(one, {}, { gemini });

  assert.strictEqual(gemini.calls.length, 1, 'no creator pass for a lone clip');
  assert.strictEqual(r.score, 0.75);
  assert.strictEqual(r.evidence.genre, 'fitness');
});

test('the composite classifier uses every clip when there are several', async () => {
  const gemini = scriptedGemini([{ niche_score: 0.5 }], { fit_score: 60 });
  const classify = reelJudge.makeClassifier({ gemini });

  const r = await classify(threeClips, {});
  assert.strictEqual(gemini.calls.filter((c) => c.videoBase64).length, 3);
  assert.strictEqual(r.evidence.creator.fit_score, 60);
});
