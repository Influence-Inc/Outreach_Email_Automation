'use strict';

// Splitting the phone's recording of a reel into what the judge reads:
//
//   the recording (mp4: screen video + Instagram's audio, from the agent app)
//     ├─ ffprobe   which streams are in it, and how long
//     ├─ audio     the audio track alone, as small mono 16 kHz mp3 for Groq
//     │            (Whisper), after a loudness check: a recording whose audio
//     │            is missing or silent is said to be, not sent off to come
//     │            back as an empty transcript
//     └─ frames    stills from the video, timestamps normalised first, read by
//                  Tesseract for the words on screen
//
// Every step reports what happened (`audio.state`, `frames.length`, `errors`)
// so a judgement made without speech or without on-screen text says why — a
// broken recording no longer looks the same as a reel with nothing to say.
//
// Why normalise timestamps: the agent app stamps video frames on the system
// clock and (before its fix) audio from zero, so the mp4's video track can sit
// days after its audio. `-ignore_editlist` and `setpts=PTS-STARTPTS` read the
// frames from the start of the video whatever its stamps say.
//
// Needs ffmpeg + ffprobe (and tesseract for the text); nixpacks.toml installs
// them. `tools()` reports whether they are there, for the Scout page's banner.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TOOL_TIMEOUT_MS = 60_000;

// Frames read for on-screen text: one every 2s from 1s in, up to this many.
const FRAMES = 6;
const FRAME_EVERY_S = 2;
// Instagram's own chrome is cut off before reading: the top bar (12%) and the
// bottom caption, handle and audio strip (22%). The full width is kept — the
// right-hand like/comment/share column sits low and only carries counts and
// icons, which the OCR clean-up drops, while a creator's overlay text often
// runs close to the right edge (cropping 18% off that side cut words in half).
const CROP = 'crop=iw:ih*0.66:0:ih*0.12';

// Loudest sample at or below this is silence: nothing Whisper could transcribe.
const SILENT_DB = -60;

function run(cmd, args, { timeout = TOOL_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

const why = (err) => {
  if (!err) return 'unknown error';
  if (err.code === 'ENOENT') return `${err.path || 'a tool'} is not installed`;
  const tail = String(err.stderr || '').trim().split('\n').filter(Boolean).pop();
  return tail || err.message || String(err);
};

let toolsPromise = null;
/** Whether ffmpeg, ffprobe and tesseract are installed. Checked once. */
function tools({ exec = run } = {}) {
  if (!toolsPromise || exec !== run) {
    const has = (cmd, flag) => exec(cmd, [flag]).then(() => true, () => false);
    const p = Promise.all([has('ffmpeg', '-version'), has('ffprobe', '-version'), has('tesseract', '--version')])
      .then(([ffmpeg, ffprobe, tesseract]) => ({ ffmpeg, ffprobe, tesseract }));
    if (exec !== run) return p;
    toolsPromise = p;
  }
  return toolsPromise;
}

/** The streams in a recording: { video, audio, seconds }. */
async function probe(file, { exec = run } = {}) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  const info = JSON.parse(stdout || '{}');
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  // A stream's own duration, not the container's: the container can span the
  // gap between two badly-stamped tracks.
  const secs = (s) => (s && Number.isFinite(Number(s.duration)) ? Number(s.duration) : null);
  return {
    video: !!video,
    audio: !!audio,
    seconds: secs(video) || secs(audio) || null,
    audioSeconds: secs(audio),
  };
}

/** Loudest point of the audio track, in dB (ffmpeg volumedetect), or null. */
async function loudness(file, { exec = run } = {}) {
  const { stderr } = await exec('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
  ]);
  const m = /max_volume:\s*(-?inf|-?[\d.]+)\s*dB/.exec(stderr);
  if (!m) return null;
  return /inf/.test(m[1]) ? -Infinity : Number(m[1]);
}

/**
 * Split one recording. Never throws.
 *
 * Returns {
 *   seconds,                         the video's (or audio's) length
 *   audio: { state, maxVolumeDb?, buf?, mimeType? },
 *          state: 'ok' (buf is the mp3) | 'silent' | 'none' (no audio track)
 *               | 'unchecked' (ffmpeg could not read it — buf is then the
 *                 original recording, so Groq can still try)
 *   frames: [paths],                 jpg stills, cropped to the creator's picture
 *   errors: [why],                   every step that failed
 *   cleanup(),                       removes the temporary files
 * }
 */
async function split(buf, { exec = run, frames = FRAMES, mimeType = 'video/mp4' } = {}) {
  const out = {
    seconds: null, audio: { state: 'unchecked' }, frames: [], errors: [], cleanup: async () => {},
  };
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-'));
    out.cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const video = path.join(dir, 'reel.mp4');
    await fs.writeFile(video, buf);

    let streams = null;
    try {
      streams = await probe(video, { exec });
      out.seconds = streams.seconds;
    } catch (err) {
      out.errors.push(`could not read the recording: ${why(err)}`);
    }

    // ── audio ────────────────────────────────────────────────────────────
    if (streams && !streams.audio) {
      out.audio = { state: 'none' };
    } else if (streams) {
      try {
        const db = await loudness(video, { exec });
        if (db != null && db <= SILENT_DB) {
          out.audio = { state: 'silent', maxVolumeDb: db };
        } else {
          const mp3 = path.join(dir, 'audio.mp3');
          await exec('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-i', video, '-map', '0:a:0', '-vn',
            '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-y', mp3,
          ]);
          out.audio = { state: 'ok', maxVolumeDb: db, buf: await fs.readFile(mp3), mimeType: 'audio/mpeg' };
        }
      } catch (err) {
        out.errors.push(`could not take the audio out: ${why(err)}`);
      }
    }
    if (out.audio.state === 'unchecked') {
      // ffmpeg could not help; Groq reads the mp4 itself.
      out.audio = { state: 'unchecked', buf, mimeType };
    }

    // ── frames ───────────────────────────────────────────────────────────
    if (!streams || streams.video) {
      try {
        await exec('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-ignore_editlist', '1', '-i', video, '-map', '0:v:0',
          '-vf', `setpts=PTS-STARTPTS,trim=start=1,setpts=PTS-STARTPTS,fps=1/${FRAME_EVERY_S},${CROP},scale=1080:-2`,
          '-frames:v', String(frames), path.join(dir, 'f%02d.jpg'),
        ]);
        out.frames = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
        if (!out.frames.length) out.errors.push('no frames came out of the video');
      } catch (err) {
        out.errors.push(`could not cut frames: ${why(err)}`);
      }
    } else {
      out.errors.push('the recording has no video track');
    }
  } catch (err) {
    out.errors.push(`could not prepare the recording: ${why(err)}`);
    if (out.audio.state === 'unchecked' && !out.audio.buf) out.audio = { state: 'unchecked', buf, mimeType };
  }
  return out;
}

/** Keep lines with a real word in them; Tesseract emits noise on photos (creator-list's ocr.py). */
function cleanOcr(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/).filter(Boolean).join(' '))
    .filter((l) => (l.match(/\p{L}/gu) || []).length >= 3);
}

/**
 * The words on the frames, each line once, in the order it first appears.
 * Returns { text, frames, error? }. Never throws.
 */
async function readFrames(files, { exec = run } = {}) {
  const seen = new Set();
  const lines = [];
  let read = 0;
  let error = null;
  for (const f of files || []) {
    try {
      // One thread per process: parallel runs otherwise oversubscribe the CPU.
      // eslint-disable-next-line no-await-in-loop
      const { stdout } = await exec('tesseract', [f, 'stdout', '-l', 'eng', '--psm', '11'], {
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      });
      read += 1;
      for (const l of cleanOcr(stdout)) {
        const k = l.toLowerCase();
        if (!seen.has(k)) { seen.add(k); lines.push(l); }
      }
    } catch (err) {
      error = `could not read the frames: ${why(err)}`;
      break;
    }
  }
  return { text: lines.join('\n'), frames: read, ...(error ? { error } : {}) };
}

module.exports = {
  split, readFrames, probe, loudness, tools, cleanOcr, run, CROP, FRAMES, SILENT_DB,
};
