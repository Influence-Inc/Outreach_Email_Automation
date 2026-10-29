'use strict';

// The split runs the real ffmpeg / ffprobe / tesseract when they are installed
// (they are on the deployed backend: nixpacks.toml), and is skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const media = require('./reelMedia');

async function have() {
  const t = await media.tools();
  return t.ffmpeg && t.ffprobe;
}

/**
 * A phone-like recording: portrait video with overlay text where a creator puts
 * it, Instagram chrome above and below, and the given audio. `skew` puts the
 * video track that many seconds after the audio, the way the agent app stamped
 * its tracks on two clocks.
 */
async function recording({ audio = 'sine=f=440:duration=6', skew = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reeltest-'));
  const v = path.join(dir, 'v.mp4');
  const a = path.join(dir, 'a.m4a');
  const out = path.join(dir, 'out.mp4');
  await media.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x334455:size=720x1600:rate=30:duration=6',
    '-vf', 'drawbox=x=60:y=600:w=600:h=120:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', v]);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (skew) args.push('-itsoffset', String(skew));
  args.push('-i', v);
  if (audio) {
    await media.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', audio, '-t', '6', '-c:a', 'aac', '-y', a]);
    args.push('-i', a, '-map', '0:v', '-map', '1:a');
  }
  args.push('-c', 'copy', '-y', out);
  await media.run('ffmpeg', args);
  const buf = await fs.readFile(out);
  await fs.rm(dir, { recursive: true, force: true });
  return buf;
}

test('a recording splits into an mp3 for Groq and frames for the text', async (t) => {
  if (!(await have())) return t.skip('ffmpeg is not installed here');
  const s = await media.split(await recording());
  try {
    assert.strictEqual(s.audio.state, 'ok');
    assert.strictEqual(s.audio.mimeType, 'audio/mpeg');
    assert.ok(s.audio.buf.length > 1000);
    assert.ok(s.frames.length >= 2, `frames: ${s.frames.length}`);
    assert.strictEqual(Math.round(s.seconds), 6);
    assert.deepStrictEqual(s.errors, []);
  } finally {
    await s.cleanup();
  }
});

test('video stamped days after its audio still gives frames and audio', async (t) => {
  if (!(await have())) return t.skip('ffmpeg is not installed here');
  const s = await media.split(await recording({ skew: 432000 }));
  try {
    assert.strictEqual(s.audio.state, 'ok');
    assert.ok(s.frames.length >= 2);
    assert.strictEqual(Math.round(s.seconds), 6, 'the stream\'s length, not the container\'s');
  } finally {
    await s.cleanup();
  }
});

test('silent audio and a missing audio track are told apart', async (t) => {
  if (!(await have())) return t.skip('ffmpeg is not installed here');
  const silent = await media.split(await recording({ audio: 'anullsrc=r=44100:cl=mono' }));
  const none = await media.split(await recording({ audio: null }));
  try {
    assert.strictEqual(silent.audio.state, 'silent');
    assert.ok(!silent.audio.buf);
    assert.strictEqual(none.audio.state, 'none');
    assert.ok(none.frames.length >= 2, 'frames still come out');
  } finally {
    await silent.cleanup();
    await none.cleanup();
  }
});

test('a file that is not a video says so and hands the bytes on for Groq to try', async () => {
  const exec = async () => { const e = new Error('Invalid data'); e.stderr = 'Invalid data found when processing input'; throw e; };
  const s = await media.split(Buffer.from('nope'), { exec });
  try {
    assert.strictEqual(s.audio.state, 'unchecked');
    assert.strictEqual(s.audio.buf.toString(), 'nope');
    assert.match(s.errors[0], /could not read the recording: Invalid data/);
  } finally {
    await s.cleanup();
  }
});

test('a missing tool is named', async () => {
  const exec = async (cmd) => { const e = new Error(`spawn ${cmd} ENOENT`); e.code = 'ENOENT'; e.path = cmd; throw e; };
  const s = await media.split(Buffer.from('x'), { exec });
  await s.cleanup();
  assert.match(s.errors[0], /ffprobe is not installed/);
  assert.deepStrictEqual(await media.tools({ exec }), { ffmpeg: false, ffprobe: false, tesseract: false });
});

test('OCR keeps each real line once, in order', async () => {
  const outs = ['5 GYM MISTAKES\n12.3K\n', 'BEGINNERS MAKE\n5 GYM MISTAKES\n'];
  let i = 0;
  const r = await media.readFrames(['a.jpg', 'b.jpg'], { exec: async () => ({ stdout: outs[i++] }) });
  assert.deepStrictEqual(r, { text: '5 GYM MISTAKES\nBEGINNERS MAKE', frames: 2 });
  const broken = await media.readFrames(['a.jpg'], { exec: async () => { const e = new Error('x'); e.code = 'ENOENT'; e.path = 'tesseract'; throw e; } });
  assert.match(broken.error, /tesseract is not installed/);
});

// The phone app used to upload its recording before finishing it: an MP4 with no
// index, which ffprobe calls "Invalid data". The reason names the fix.
test('an unfinished MP4 from an old phone app says to install the latest build', async () => {
  const exec = async (cmd) => {
    if (cmd === 'ffprobe') throw Object.assign(new Error('x'), { stderr: '/tmp/reel-x/reel.mp4: Invalid data found when processing input' });
    throw new Error('not reached');
  };
  // An MP4's opening `ftyp` box and its samples (`mdat`), but no `moov` index.
  const unfinished = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom\0\0\x02\0isomiso2'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const out = await media.split(unfinished, { exec });
  try {
    assert.match(out.errors[0], /not a finished MP4.*install the latest app/);
  } finally {
    await out.cleanup();
  }
});
