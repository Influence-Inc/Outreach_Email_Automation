'use strict';

// Labelling a scouted creator the way creator-list labels every creator it indexes —
// from many of their Reels, not from the one reel the phone happened to record.
//
//   1. creator-list already has them  → its labels (topic / niche / genre / format shares
//      over the Reels it analysed, and its estimated audience), through the partner API.
//      Free and instant.
//   2. otherwise, creator-list's own pipeline, run here for this creator. The username is the
//      one the phone read off their profile; the phone records nothing.
//        TikHub via Monid  → their newest 10 Reels (pinned and trial Reels left out): caption,
//                            hashtags, video link                      (services/monid.js)
//        each Reel         → video downloaded from Instagram's CDN, split: audio to Groq
//                            (Whisper), frames to Tesseract           (services/reelMedia.js)
//                          → 3 frames of the first 3 s and up to 8 more (one per 4 s) to
//                            GPT-6 Luna, which describes what the video shows
//                                                                     (services/reelVision.js)
//                          → one Jev call: creator-list's four content questions (taxonomy 2.3)
//                            and its three audience questions        (classify/content.py)
//      Jev reads text only, so the frames reach it as the words on them and as GPT-6 Luna's
//      description of them, as in creator-list (enrichment/classify/visual.py).
//      When no Reels can be collected, the caption of the reel that surfaced them is labelled
//      instead — one reel, said as much, with a provisional fit.
//   3. creator level, as creator-list builds its creator documents:
//        shares of Reels per topic / niche / genre / format ('unclear' and 'other' left out;
//        a niche only where it belongs to the Reel's topic), and which are the creator's OWN —
//        a dedicated topic (fitness, gaming…) in at least half their Reels, a broad one
//        (beauty, fashion…) in a fifth (creator_topics.py, reference/creator_topics.json);
//        and the estimated target audience (services/audienceEstimate.js, audience.py).
//
// Path 2 costs about $0.004 of TikHub calls plus Groq, GPT-6 Luna (~$0.001 a Reel) and Jev for
// up to 10 Reels — about 2 cents a creator — and only runs for creators who already passed the
// viral rule.
//
//   MONID_API_KEY   path 2 (the same key creator-list's worker uses); without it, a creator
//                   creator-list does not have is labelled from one caption.

const monid = require('./monid');
const reelMedia = require('./reelMedia');
const reelVision = require('./reelVision');
const audience = require('./audienceEstimate');
const creatorList = require('./creatorList');
const reviewLessons = require('./reviewLessons');
const TAXONOMY = require('./cpmReference/content_taxonomy.json');
const TOPIC_RULES = require('./cpmReference/creator_topics.json');

const DIMENSIONS = ['topic', 'niche', 'genre', 'format'];
const NICHE_PARENTS = (TAXONOMY.questions.niche && TAXONOMY.questions.niche.parents) || {};
const EPS = 1e-9;

// Reels labelled per creator, from one TikHub page.
const REELS = 10;
// Reels worked on at once.
const CONCURRENCY = 4;
// Frames read per Reel for on-screen text: one every 2s from 1s in (reelMedia.split).
const FRAMES_PER_REEL = 4;
// Fewer Reels with a known topic than this and the creator cannot be judged from their Reels.
const MIN_LABELLED = 3;
// A creator is only rejected as off-target when at least this many Reels say so.
const MIN_TO_REJECT = 5;
const CDN = ['cdninstagram.com', 'fbcdn.net'];

// Python's round(x, 2), ties to even: shares match creator-list's to the cent.
const round2 = (n) => audience.pyRound(n, 2);

// ── creator-list's creator_topics.py ────────────────────────────────────────

/** A Reel's niche when it belongs to the Reel's topic (or the topic is unknown), else null. */
function nicheOf(topic, niche) {
  if (!niche || niche === 'unclear' || niche === 'other') return null;
  if (!topic || topic === 'unclear' || topic === 'other') return niche;
  return NICHE_PARENTS[niche] === topic ? niche : null;
}

function classOf(kind, key) {
  if (kind === 'niche') return classOf('topic', NICHE_PARENTS[key] || '');
  const table = TOPIC_RULES[kind === 'genre' ? 'genres' : 'topics'] || {};
  return String((table[key] && table[key].class) || 'broad');
}

const minShare = (kind, key) => Number(TOPIC_RULES.share[classOf(kind, key)]);

/** Whether `key` counts as the creator's own, given their shares of Reels. */
function qualifies(kind, key, shares, topics = {}) {
  const need = minShare(kind, key);
  const own = shares[key] || 0;
  if (own + EPS >= need) return true;
  const parent = topics[NICHE_PARENTS[key] || ''] || 0;
  return kind === 'niche' && own + EPS >= TOPIC_RULES.share.broad && parent + EPS >= need;
}

const own = (kind, shares, topics) => Object.keys(shares).filter((k) => qualifies(kind, k, shares, topics));

/** {value: share} over the known values, most Reels first (build_creator_index._shares). */
function sharesOf(values) {
  const known = values.filter((v) => v && v !== 'unclear' && v !== 'other');
  if (!known.length) return {};
  const tally = new Map();
  for (const v of known) tally.set(v, (tally.get(v) || 0) + 1);
  return Object.fromEntries([...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, round2(n / known.length)]));
}

// ── one Reel ────────────────────────────────────────────────────────────────

function cdnUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !CDN.some((d) => h === d || h.endsWith(`.${d}`))) return null;
  return u.href;
}

/** A Reel's video from Instagram's CDN (redirects followed only within it). */
async function download(raw, { fetchImpl = fetch, maxBytes = 60 * 1024 * 1024 } = {}) {
  let url = cdnUrl(raw);
  if (!url) throw new Error('not an Instagram CDN video link');
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (r.status >= 300 && r.status < 400) {
      url = cdnUrl(new URL(r.headers.get('location'), url).href);
      if (!url) throw new Error('redirected off Instagram\'s CDN');
      continue;
    }
    if (!r.ok) throw new Error(`video download failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('video too large');
    return buf;
  }
  throw new Error('too many redirects');
}

function jevLib() {
  // Lazily: jevJudge requires this module.
  return require('./jevJudge'); // eslint-disable-line global-require
}

/** The questions for one Reel: creator-list's four content questions and three audience ones. */
function reelQuestions() {
  const jev = jevLib();
  return { ...jev.buildQuestions(), ...audience.questions(jev.GUARD) };
}

/**
 * Label one Reel the way creator-list does. Never throws: a failed step leaves that Reel
 * with what it has (a Reel that cannot be downloaded is still judged on its caption, and one
 * GPT-6 Luna could not describe on its words alone).
 * Returns { code, labels, usedSpeech, signals, words, seen, visionError?, error? }.
 */
async function labelReel(row, { handle, deps = {} } = {}) {
  const jev = jevLib();
  const out = { code: row.code || null, labels: null, usedSpeech: false, signals: {}, words: 0 };
  let transcript = { text: '', language: null, duration: row.durationS || null };
  let screen = { text: '' };
  let visual = null;
  const errors = [];
  // What the video shows (GPT-6 Luna): on with the OpenRouter key Jev uses, unless REEL_VISION=off.
  const see = deps.describe || (reelVision.configured() ? reelVision.describe : null);

  if (row.state) {
    // The phone's recording, already heard and read.
    transcript = { text: row.state.speech || '', language: row.language || null, duration: row.state.duration_seconds };
    screen = { text: row.state.on_screen_text || '' };
  } else if (row.videoUrl) {
    let split = null;
    try {
      const buf = await (deps.download || download)(row.videoUrl, { fetchImpl: deps.fetchImpl });
      split = await (deps.split || reelMedia.split)(buf, { frames: FRAMES_PER_REEL });
      const a = split.audio || {};
      const [t, s] = await Promise.all([
        ['ok', 'unchecked'].includes(a.state) && a.buf && row.hasAudio !== false
          ? (deps.transcribe || jev.transcribe)(a.buf, a.mimeType || 'video/mp4', { fetchImpl: deps.fetchImpl })
            .catch((err) => { errors.push(`Groq: ${err.message}`); return { text: '', language: null, duration: null }; })
          : Promise.resolve({ text: '', language: null, duration: null }),
        (deps.readFrames || reelMedia.readFrames)(split.frames || []),
      ]);
      transcript = { ...t, duration: t.duration || row.durationS || null };
      screen = s;
      if (see) {
        const v = await see(buf, {
          handle, caption: row.caption, transcript: t.text, segments: t.segments, seconds: transcript.duration,
        }, { fetchImpl: deps.fetchImpl });
        visual = v.cues || null;
        out.costUsd = (out.costUsd || 0) + (v.costUsd || 0);
        if (v.error) out.visionError = v.error;
      }
    } catch (err) {
      errors.push(err.message);
    } finally {
      if (split && split.cleanup) await split.cleanup();
    }
  }

  const caption = row.state ? row.state.caption : row.caption;
  const state = row.state || jev.buildState({
    username: handle,
    caption,
    transcript: transcript.text,
    onScreenText: screen.text,
    durationSeconds: transcript.duration,
    visual,
  });
  out.seen = !!visual;
  if (!row.state && Array.isArray(row.hashtags) && row.hashtags.length) {
    state.hashtags = [...new Set([...state.hashtags, ...row.hashtags])].slice(0, 30);
  }
  if (!row.state && row.originalAudio != null) state.uses_original_audio = row.originalAudio;
  out.usedSpeech = !!state.has_speech;
  out.words = String(state.speech || '').split(/\s+/).filter(Boolean).length;
  out.signals = audience.textSignals({
    caption: state.caption, transcript: state.speech, onScreenText: state.on_screen_text, language: transcript.language,
  });

  if (!state.has_speech && !state.caption && !state.on_screen_text && !state.hashtags.length && !state.video_frames_description) {
    out.error = errors[0] || 'nothing to read';
    return out;
  }
  try {
    const res = await (deps.callJev || jev.callJev)(state, reelQuestions(), { fetchImpl: deps.fetchImpl, key: deps.jevKey });
    out.labels = jev.toLabels(res.answers);
    out.costUsd = (out.costUsd || 0) + (res.costUsd || 0);
  } catch (err) {
    errors.push(err.message);
  }
  if (errors.length) out.error = errors.join('; ');
  return out;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i); // eslint-disable-line no-await-in-loop
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ── the creator ─────────────────────────────────────────────────────────────

/** Shares, own labels and the audience estimate from labelled Reels. */
function aggregate(reels, { country = null, countrySource = 'unknown' } = {}) {
  const labelled = reels.filter((r) => r.labels);
  const value = (r, dim) => r.labels[dim] && r.labels[dim].value;
  const shares = {
    topic: sharesOf(labelled.map((r) => value(r, 'topic'))),
    niche: sharesOf(labelled.map((r) => nicheOf(value(r, 'topic'), value(r, 'niche')))),
    genre: sharesOf(labelled.map((r) => value(r, 'genre'))),
    format: sharesOf(labelled.map((r) => value(r, 'format'))),
  };
  const ownLabels = {
    topics: own('topic', shares.topic),
    niches: own('niche', shares.niche, shares.topic),
    genres: own('genre', shares.genre),
  };
  const est = labelled.length
    ? audience.estimate(labelled.map((r) => audience.reelInputs({ labels: r.labels, usedSpeech: r.usedSpeech, signals: r.signals })), {
      country, countrySource,
    })
    : null;
  return {
    reels: reels.length,
    labelled: labelled.filter((r) => { const t = value(r, 'topic'); return t && t !== 'unclear'; }).length,
    shares,
    own: ownLabels,
    audience: est,
  };
}

/** creator-list's document for this creator, as a profile — or null when it has none. */
async function fromCreatorList(handle, { call = creatorList.call, configured = creatorList.configured } = {}) {
  if (!configured()) return null;
  let res;
  try {
    res = await call(String(handle).toLowerCase(), { queue: false });
  } catch (_) {
    return null;
  }
  const c = res && res.status === 'indexed' && res.creator;
  if (!c || !(Number(c.reels_analysed) >= MIN_LABELLED) || !c.topics || !Object.keys(c.topics).length) return null;
  const shares = {
    topic: c.topics || {}, niche: c.niches || {}, genre: c.genres || {}, format: c.formats || {},
  };
  const a = c.audience || null;
  return {
    source: 'creator-list',
    as_of: c.as_of || null,
    reels: Number(c.reels_analysed),
    labelled: Number(c.reels_analysed),
    shares,
    own: {
      topics: own('topic', shares.topic),
      niches: own('niche', shares.niche, shares.topic),
      genres: own('genre', shares.genre),
    },
    audience: a ? {
      gender: { female: a.female, lean: a.lean },
      age: { main: a.age_main || [] },
      geography: { primary_country: a.primary_country || null, countries: (a.countries || []).map(([cc, s]) => ({ country_code: cc, share: s })) },
      confidence: a.confidence || null,
      calibrated: !!a.calibrated,
    } : null,
    costUsd: 0,
    errors: [],
  };
}

/**
 * Label a creator from their Reels. Returns a profile
 * { source: 'creator-list' | 'reels', reels, labelled, shares, own, audience, perReel?, costUsd, errors }
 * or { source: null, reason } when neither way is available. Never throws.
 *
 * @param {object} o
 * @param {string} o.handle
 * @param {object} [o.recorded]  the reel that led to them, as { state (jevJudge.buildState),
 *                               language } — labelled only when none of their Reels can be
 *                               collected
 */
async function labelCreator({ handle, recorded = null, deps = {} } = {}) {
  const who = String(handle || '').replace(/^@/, '').trim().toLowerCase();
  if (!who) return { source: null, reason: 'no handle' };

  const indexed = await (deps.fromCreatorList || fromCreatorList)(who);
  if (indexed) return indexed;

  const configured = deps.monid ? true : monid.configured();
  const errors = [];
  let costUsd = 0;
  let card = null;
  let rows = [];
  if (!configured) {
    errors.push('MONID_API_KEY is not set, so their Reels could not be collected');
  } else {
    const tikhub = deps.monid || monid;
    const opts = { fetchImpl: deps.fetchImpl };
    let page;
    [card, page] = await Promise.all([
      tikhub.fetchCard(who, opts).catch((err) => { errors.push(`card: ${err.message}`); return null; }),
      tikhub.fetchReels(who, { ...opts, limit: REELS }).catch((err) => { errors.push(`Reels: ${err.message}`); return null; }),
    ]);
    if (card) costUsd += card.costUsd || 0;
    if (page) costUsd += page.costUsd || 0;
    rows = page ? page.reels : [];
    if (page && !rows.length) errors.push('Monid found no Reels on their account');
  }

  // No Reels of theirs: the reel that surfaced them is all there is.
  const fallback = !rows.length && !!(recorded && recorded.state);
  if (fallback) rows = [{ code: 'source', state: recorded.state, language: recorded.language || null }];
  if (!rows.length) return { source: null, reason: errors[0] || 'no Reels to label' };

  const perReel = await pool(rows, CONCURRENCY, (row) => labelReel(row, { handle: who, deps }));
  for (const r of perReel) costUsd += r.costUsd || 0;
  const country = card && card.country ? audience.countryCode(card.country) : null;
  const agg = aggregate(perReel, { country, countrySource: country ? 'instagram' : 'unknown' });
  const failed = perReel.filter((r) => r.error && !r.labels).length;
  if (failed) errors.push(`${failed} of ${perReel.length} Reels could not be labelled (${perReel.find((r) => r.error && !r.labels).error})`);
  // Kept apart from `errors`: a Reel GPT-6 Luna could not describe is still labelled from its
  // words, so the creator is not thin for it — but the page says why nothing was "seen".
  const unseen = perReel.filter((r) => r.visionError);
  const visionError = unseen.length ? `${unseen.length} of ${perReel.length} Reels not seen by the vision model (${unseen[0].visionError})` : undefined;
  return {
    source: 'reels',
    // Labelled from the caption of the reel that surfaced them, their Reels not collected.
    fallback: fallback || undefined,
    ...agg,
    perReel: perReel.map((r) => ({
      code: r.code,
      ...Object.fromEntries(DIMENSIONS.map((d) => [d, r.labels && r.labels[d] ? r.labels[d].value : null])),
      words: r.words,
      // Whether GPT-6 Luna described the video (and why not, when it tried and failed).
      seen: r.seen || undefined,
      visionError: r.visionError || undefined,
    })),
    costUsd: Math.round(costUsd * 10000) / 10000,
    errors,
    visionError,
  };
}

// ── new search terms from what an on-target creator tags ────────────────────

// ── deciding against the run's targets ──────────────────────────────────────

/**
 * Shortlist, review or reject a creator from their profile, against what the keywords name.
 *
 *   shortlist  every targeted subject / genre is the creator's own (by creator-list's share
 *              rules), and every targeted format is in at least a fifth of their Reels;
 *   review     some of their Reels are on target but not enough to be their own, too few
 *              Reels could be labelled, or nothing to judge against;
 *   reject     at least MIN_TO_REJECT labelled Reels, and none on a targeted subject or genre;
 *              or mostly something the admin's review notes pass on (`lessons`).
 */
function decideFromCreator(p, targets, lessons = null) {
  const { labelOf } = jevLib();
  const pct = (x) => `${Math.round(x * 100)}%`;
  const share = (dim, key) => (p.shares[dim] || {})[key] || 0;
  const mix = (dim) => Object.entries(p.shares[dim] || {}).slice(0, 2).map(([k, v]) => `${labelOf(dim, k)} ${pct(v)}`).join(', ') || 'nothing clear';
  const names = (dim, keys) => keys.map((k) => labelOf(dim, k)).join(' or ');
  const fits = [];
  const doubts = [];
  const offs = [];

  const wantsSubject = targets.topics.length || targets.niches.length;
  if (!wantsSubject && !targets.genres.length && !targets.formats.length) {
    return { decision: 'review', reasons: ['no target to judge against — the keywords name no topic, niche, genre or format'], fit: null };
  }
  if (!p.labelled) {
    return { decision: 'review', reasons: [thinReason(p)], fit: null, thin: true };
  }
  const canReject = p.labelled >= MIN_TO_REJECT;

  if (wantsSubject) {
    const ownTopic = targets.topics.find((t) => p.own.topics.includes(t));
    const ownNiche = targets.niches.find((n) => p.own.niches.includes(n));
    if (ownTopic || ownNiche) {
      fits.push(ownNiche ? share('niche', ownNiche) : share('topic', ownTopic));
    } else {
      const some = targets.topics.find((t) => share('topic', t) > 0) || targets.niches.find((n) => share('niche', n) > 0);
      const parent = targets.niches.map((n) => NICHE_PARENTS[n]).find((t) => t && p.own.topics.includes(t));
      if (some) {
        const dim = targets.topics.includes(some) ? 'topic' : 'niche';
        doubts.push(`${labelOf(dim, some)} in ${pct(share(dim, some))} of their reels — not enough to be their own (mostly ${mix('topic')})`);
      } else if (parent) {
        doubts.push(`right topic (${labelOf('topic', parent)}), other niche: ${mix('niche')}`);
      } else if (canReject) {
        offs.push(`their reels are about ${mix('topic')}, not ${names(targets.topics.length ? 'topic' : 'niche', targets.topics.length ? targets.topics : targets.niches)}`);
      } else {
        doubts.push(`probably off-target: their reels are about ${mix('topic')}`);
      }
    }
  }

  if (targets.genres.length) {
    const hit = targets.genres.find((g) => p.own.genres.includes(g));
    const some = targets.genres.find((g) => share('genre', g) > 0);
    if (hit) fits.push(share('genre', hit));
    else if (some) doubts.push(`${labelOf('genre', some)} in ${pct(share('genre', some))} of their reels (mostly ${mix('genre')})`);
    else if (canReject) offs.push(`none of their reels is ${names('genre', targets.genres)} (mostly ${mix('genre')})`);
    else doubts.push(`probably not ${names('genre', targets.genres)}: ${mix('genre')}`);
  }

  if (targets.formats.length) {
    const broad = TOPIC_RULES.share.broad;
    const hit = targets.formats.find((f) => share('format', f) + EPS >= broad);
    const some = targets.formats.find((f) => share('format', f) > 0);
    if (hit) fits.push(share('format', hit));
    else if (some) doubts.push(`${labelOf('format', some)} in only ${pct(share('format', some))} of their reels`);
    else doubts.push(`no ${names('format', targets.formats)} reels among them (mostly ${mix('format')})`);
  }

  let d;
  if (offs.length) d = { decision: 'reject', reasons: offs, fit: 0 };
  else if (doubts.length) d = { decision: 'review', reasons: doubts, fit: fits.length ? round2(Math.min(...fits)) : null };
  else d = { decision: 'shortlist', reasons: [], fit: round2(Math.min(...fits)) };

  // What the admin's review notes taught (services/reviewLessons.js): a creator
  // whose Reels are mostly something the admin keeps passing on is rejected with
  // the admin's own reason — or held, when too few Reels say so to reject.
  const passed = reviewLessons.matches(lessons, p.shares);
  if (passed.length && d.decision !== 'reject') {
    const said = passed.map(({ rule, share }) => `you passed on creators like this — "${rule.why}" (${labelOf(rule.dim, rule.value)} in ${pct(share)} of their reels)`);
    d = p.labelled >= MIN_TO_REJECT
      ? { decision: 'reject', reasons: said, fit: 0, lesson: true }
      : { decision: 'review', reasons: [...said, ...d.reasons], fit: d.fit, lesson: true };
  }

  // Too few Reels to decide on: always a person's call, but say plainly why, and
  // what the Reels there are show — with a provisional fit (0 when nothing matched).
  if (p.labelled < MIN_LABELLED) {
    const those = p.labelled === 1 ? 'that reel' : 'those reels';
    const shows = d.decision === 'shortlist' ? `${those} ${p.labelled === 1 ? 'is' : 'are'} on target` : `${those}: ${d.reasons.join('; ')}`;
    return {
      decision: 'review', reasons: [thinReason(p), shows], fit: d.fit != null ? d.fit : 0, provisional: true, thin: true,
    };
  }
  return d;
}

/** "only 1 reel to judge (the one that surfaced them) — their Reels could not be collected: …" */
function thinReason(p) {
  const n = p.labelled;
  const what = !n ? 'no reel could be labelled' : `only ${n} reel${n === 1 ? '' : 's'} to judge`;
  const which = p.fallback ? ' (the one that surfaced them)' : (p.reels > n ? ` of ${p.reels} collected` : '');
  const err = (p.errors || [])[0];
  const why = p.fallback ? ` — their Reels could not be collected${err ? `: ${err}` : ''}` : (err ? ` — ${err}` : '');
  return `${what}${which}${why}`;
}

/** The profile's top value per dimension, shaped like Jev's per-reel labels, for the page. */
function labelsOf(p) {
  const out = {};
  for (const dim of DIMENSIONS) {
    const ranked = Object.entries(p.shares[dim] || {});
    if (!ranked.length) continue;
    out[dim] = { value: ranked[0][0], confidence: ranked[0][1], runnerUp: ranked[1] ? ranked[1][0] : null, share: true };
  }
  return out;
}

module.exports = {
  labelCreator,
  labelReel,
  aggregate,
  fromCreatorList,
  decideFromCreator,
  labelsOf,
  nicheOf,
  qualifies,
  sharesOf,
  cdnUrl,
  download,
  MIN_LABELLED,
  MIN_TO_REJECT,
  REELS,
};
