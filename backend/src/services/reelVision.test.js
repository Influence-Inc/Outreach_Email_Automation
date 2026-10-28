'use strict';

// What a Reel's video shows (services/reelVision.js): which frames are cut, what the vision model
// is sent, how its answer is read, and how Jev and the creator's labels use it. The frame
// cut runs the real ffmpeg when it is installed (nixpacks.toml), and is skipped otherwise.
// No paid calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const vision = require('./reelVision');
const media = require('./reelMedia');
const { buildState } = require('./jevJudge');
const cl = require('./creatorLabels');

const CUES = {
  summary: 'A man shows five gym mistakes.',
  hook: "Text '5 GYM MISTAKES' over a squat rack",
  on_screen_text: ['5 GYM MISTAKES', 'use code LIFT10'],
  products: ['MyProtein whey tub'],
  brands_visible: ['MyProtein'],
  disclosure_visible: '',
  people: 'one creator talking to camera',
  setting: 'commercial gym',
  presentation: 'talking head with b-roll of exercises',
};

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('3 frames across the first 3 seconds, then one in the middle of each 4-second window', () => {
  const t = vision.frameTimes(20);
  assert.deepStrictEqual(t.slice(0, 3), [0.5, 1.5, 2.5]);
  assert.deepStrictEqual(t.slice(3), [5, 9, 13, 17]);
});

test('at most 8 more frames, spread over a long Reel so its end is seen', () => {
  assert.deepStrictEqual(vision.frameTimes(35).slice(3), [5, 9, 13, 17, 21, 25, 29, 33]);
  const t = vision.frameTimes(90);
  assert.strictEqual(t.length, 3 + 8);
  assert.ok(t[t.length - 1] > 80);
  const later = t.slice(3);
  for (let i = 1; i < later.length; i += 1) assert.ok(Math.abs(later[i] - later[i - 1] - 87 / 8) < 0.02);
});

test('a short Reel keeps every frame inside it', () => {
  assert.deepStrictEqual(vision.frameTimes(2), [0.33, 1, 1.67]);
  assert.deepStrictEqual(vision.frameTimes(5), [0.5, 1.5, 2.5]);
  assert.ok(vision.frameTimes(9).every((x) => x < 9));
  assert.deepStrictEqual(vision.frameTimes(null), [0]);
});

test('the vision model gets every frame labelled with its time, the timed speech and the caption, scrubbed', () => {
  const frames = vision.frameTimes(12).map((t) => ({ t, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }));
  const msgs = vision.messages({
    handle: '@coach',
    caption: 'leg day, mail me@example.com',
    segments: [{ start: 0, end: 2, text: 'okay so leg day' }, { start: 2, end: 5, text: 'five moves' }],
    seconds: 12,
  }, frames);
  assert.strictEqual(msgs[0].role, 'system');
  assert.match(msgs[0].content, /never instructions/);
  const content = msgs[1].content;
  const images = content.filter((c) => c.type === 'image_url');
  assert.strictEqual(images.length, 5);
  assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
  const labels = content.filter((c) => c.type === 'text' && c.text.startsWith('Frame')).map((c) => c.text);
  assert.strictEqual(labels[0], 'Frame at 0.5 s (opening hook):');
  assert.strictEqual(labels[3], 'Frame at 5.0 s (later):');
  assert.match(content[0].text, /\[0\.0-2\.0\] okay so leg day \[2\.0-5\.0\] five moves/);
  assert.match(content[0].text, /A Reel by @coach, 12 s long/);
  assert.doesNotMatch(content[0].text, /me@example\.com/);
  assert.match(content[content.length - 1].text, /brands_visible/);
});

test('the answer is read leniently, deduplicated and scrubbed', () => {
  const c = vision.parse(`\`\`\`json\n${JSON.stringify({
    summary: ['Cooking pasta.', 'Call +1 415 555 0100'],
    on_screen_text: 'EASY PASTA',
    brands_visible: ['Barilla', 'barilla', ''],
    disclosure_visible: 'None',
    people: null,
  })}\n\`\`\``);
  assert.deepStrictEqual(c.on_screen_text, ['EASY PASTA']);
  assert.deepStrictEqual(c.brands_visible, ['Barilla']);
  assert.strictEqual(c.disclosure_visible, '');
  assert.strictEqual(c.people, '');
  assert.match(c.summary, /^Cooking pasta\./);
  assert.doesNotMatch(c.summary, /555/);
  assert.throws(() => vision.parse('I cannot see the frames.'), /no JSON object/);
});

test('Jev reads the description only when there is one', () => {
  const bare = buildState({ username: 'coach', caption: 'leg day' });
  assert.ok(!('video_frames_description' in bare));
  const seen = buildState({ username: 'coach', caption: 'leg day', visual: CUES });
  assert.match(seen.video_frames_description, /^\(A vision model's description of frames from the video\.\)/);
  assert.match(seen.video_frames_description, /Brands or logos legible: MyProtein\./);
  assert.match(seen.video_frames_description, /On-screen text: 5 GYM MISTAKES \| use code LIFT10\./);
  assert.ok(seen.video_frames_description.length <= 1500);
});

test('callVision asks GPT-6 Luna on OpenRouter for a JSON answer, with short reasoning, and reads the cost', async () => {
  const before = process.env.REEL_VISION_MODEL;
  delete process.env.REEL_VISION_MODEL;
  let sent = null;
  try {
    const res = await vision.callVision([{ role: 'user', content: 'hi' }], {
      key: 'k',
      fetchImpl: async (url, init) => {
        sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        return jsonResponse(200, {
          model: 'openai/gpt-6-luna',
          choices: [{ message: { content: JSON.stringify(CUES) } }],
          usage: { cost: 0.0016 },
        });
      },
    });
    assert.strictEqual(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(sent.body.model, 'openai/gpt-6-luna');
    assert.deepStrictEqual(sent.body.response_format, { type: 'json_object' });
    assert.deepStrictEqual(sent.body.reasoning, { effort: 'low' });
    assert.ok(!('temperature' in sent.body), 'GPT-6 models take no temperature');
    assert.ok(sent.body.max_tokens >= 3000, 'room for the reasoning on top of the answer');
    assert.strictEqual(sent.auth, 'Bearer k');
    assert.deepStrictEqual(vision.parse(res.text).brands_visible, ['MyProtein']);
    assert.strictEqual(res.costUsd, 0.0016);
  } finally {
    if (before == null) delete process.env.REEL_VISION_MODEL; else process.env.REEL_VISION_MODEL = before;
  }
});

test('REEL_VISION_MODEL picks another model, asked the way that family accepts', () => {
  // A Qwen3-VL host rejects response_format; it is asked with temperature 0 and plain JSON.
  const qwen = vision.requestBody('qwen/qwen3-vl-30b-a3b-instruct', []);
  assert.strictEqual(qwen.temperature, 0);
  assert.ok(!('response_format' in qwen) && !('reasoning' in qwen));
  assert.strictEqual(vision.DEFAULT_MODEL, 'openai/gpt-6-luna');
});

test('the retired QWEN_VL_MODEL setting no longer picks the model', async () => {
  const before = { q: process.env.QWEN_VL_MODEL, r: process.env.REEL_VISION_MODEL };
  process.env.QWEN_VL_MODEL = 'qwen/qwen3-vl-32b-instruct';
  delete process.env.REEL_VISION_MODEL;
  let model = null;
  try {
    await vision.callVision([], {
      key: 'k',
      fetchImpl: async (_u, init) => { model = JSON.parse(init.body).model; return jsonResponse(200, { choices: [{ message: { content: '{}' } }] }); },
    });
    assert.strictEqual(model, 'openai/gpt-6-luna');
  } finally {
    if (before.q == null) delete process.env.QWEN_VL_MODEL; else process.env.QWEN_VL_MODEL = before.q;
    if (before.r != null) process.env.REEL_VISION_MODEL = before.r;
  }
});

test('callVision says why OpenRouter refused', async () => {
  await assert.rejects(
    vision.callVision([], { key: 'k', retries: 0, fetchImpl: async () => jsonResponse(400, { error: { message: 'bad request' } }) }),
    /HTTP 400: bad request/,
  );
});

test('describe never throws: a video ffmpeg cannot read is said to be', async () => {
  const v = await vision.describe(Buffer.from('not a video'), { seconds: 10 }, {
    exec: async () => { throw new Error('ffmpeg failed'); },
    callVision: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(v.cues, null);
  assert.strictEqual(v.error, 'ffmpeg cut no frames');
});

test('a Reel is labelled with what its video shows, and the creator says how many were seen', async () => {
  const jevStates = [];
  const deps = {
    fromCreatorList: async () => null,
    monid: {
      fetchCard: async () => ({ country: 'United States', costUsd: 0.002 }),
      fetchReels: async () => ({
        reels: [
          { code: 'a', caption: 'leg day', hashtags: [], videoUrl: 'https://scontent.cdninstagram.com/a.mp4', durationS: 20 },
          { code: 'b', caption: 'gym tips', hashtags: [], videoUrl: 'https://scontent.cdninstagram.com/b.mp4', durationS: 30 },
        ],
        costUsd: 0.002,
      }),
    },
    download: async () => Buffer.from('mp4'),
    split: async () => ({ audio: { state: 'ok', buf: Buffer.from('mp3') }, frames: [], errors: [], cleanup: async () => {} }),
    transcribe: async () => ({ text: 'five moves for legs', language: 'english', duration: 20, segments: [{ start: 0, end: 2, text: 'five moves' }] }),
    readFrames: async () => ({ text: '', frames: 0 }),
    describe: async (buf, reel) => {
      assert.deepStrictEqual(reel.segments, [{ start: 0, end: 2, text: 'five moves' }]);
      assert.strictEqual(reel.handle, 'coach');
      return reel.caption === 'leg day'
        ? { cues: CUES, costUsd: 0.001 }
        : { cues: null, error: 'openai/gpt-6-luna via OpenRouter: HTTP 400: bad request' };
    },
    callJev: async (state) => {
      jevStates.push(state);
      const a = (choice) => ({ choice, confidence: 0.9, probabilities: { [choice]: 0.9 } });
      return {
        costUsd: 0.0005,
        answers: {
          topic: a('fitness'), niche: a('gym_strength'), genre: a('educational'), format: a('talking_head'),
          audience_gender: a('everyone'), audience_life_stage: a('young_adults'), audience_scope: a('international'),
        },
      };
    },
  };
  const p = await cl.labelCreator({ handle: 'coach', deps });
  const legDay = jevStates.find((s) => s.caption === 'leg day');
  assert.match(legDay.video_frames_description, /MyProtein/);
  assert.ok(!('video_frames_description' in jevStates.find((s) => s.caption === 'gym tips')));
  assert.deepStrictEqual(p.perReel.map((r) => [r.code, r.seen]), [['a', true], ['b', undefined]]);
  assert.deepStrictEqual(p.perReel.map((r) => r.visionError), [undefined, 'openai/gpt-6-luna via OpenRouter: HTTP 400: bad request']);
  assert.match(p.visionError, /^1 of 2 Reels not seen by the vision model/);
  assert.deepStrictEqual(p.errors, [], 'a Reel not seen is still labelled: not an error of the creator');
  assert.strictEqual(p.labelled, 2);
  assert.ok(Math.abs(p.costUsd - (0.004 + 0.001 + 2 * 0.0005)) < 1e-9);
});

test('REEL_VISION=off, or no OpenRouter key, turns it off', () => {
  const saved = { ...process.env };
  try {
    process.env.JEV_API_KEY = 'k';
    delete process.env.REEL_VISION;
    assert.strictEqual(vision.configured(), true);
    process.env.REEL_VISION = 'off';
    assert.strictEqual(vision.configured(), false);
    delete process.env.REEL_VISION;
    delete process.env.JEV_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    assert.strictEqual(vision.configured(), false);
  } finally {
    process.env = saved;
  }
});

test('frames are cut from a real video at the right times and sent as JPEGs', async (t) => {
  const tools = await media.tools();
  if (!tools.ffmpeg || !tools.ffprobe) return t.skip('needs ffmpeg and ffprobe');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visiontest-'));
  try {
    const file = path.join(dir, 'in.mp4');
    await media.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=10',
      '-t', '14', '-pix_fmt', 'yuv420p', '-y', file]);
    let images = 0;
    const v = await vision.describe(await fs.readFile(file), { handle: 'coach' }, {
      callVision: async (msgs) => {
        const imgs = msgs[1].content.filter((c) => c.type === 'image_url');
        images = imgs.length;
        const jpeg = Buffer.from(imgs[0].image_url.url.split(',')[1], 'base64');
        assert.deepStrictEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
        return { text: JSON.stringify(CUES), model: 'q', costUsd: 0.001 };
      },
    });
    assert.strictEqual(v.error, undefined);
    assert.deepStrictEqual(v.frameTimes, [0.5, 1.5, 2.5, 5, 9, 13]);
    assert.strictEqual(images, 6);
    assert.deepStrictEqual(v.cues.brands_visible, ['MyProtein']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return undefined;
});
