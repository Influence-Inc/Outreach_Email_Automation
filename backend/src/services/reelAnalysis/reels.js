'use strict';

// Reel records as creator-list's P1-P5 see them (services/enrichment/enrichment/reels.py and
// creator-lab's toReelRow): one Apify row of instagram-scraper/instagram-profile-reels-scraper,
// converted to the apify/instagram-reel-scraper row shape, then to a ReelRecord.

const { py, finditer, strip, lstrip, rstrip } = require('./pyre');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = py('(?<!\\w)\\+?\\d[\\d\\s().-]{8,}\\d(?!\\w)');
const HASHTAG = py('#(\\w+)');
const MENTION = /(?<![\p{L}\p{N}_.])@([A-Za-z0-9_.]{1,30})/gu;

// Remove email addresses and phone numbers before anything is stored or sent to a model.
function scrub(text) {
  if (!text) return '';
  const t = String(text).replace(/\r/g, ' ').replace(/\n/g, ' ');
  return t.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

const handle = (raw) => rstrip(lstrip(strip(String(raw || '')), '@'), '.').toLowerCase();

// Trial Reels are shown to non-followers only, pinned Reels are old hits: both excluded
// (creator-list decision 2026-10-06). Instagram allows at most 3 pinned Reels.
const PINNED_MAX = 3;
const isTrial = (row) => row.clips_trial != null;
const isPinned = (row) => Boolean(
  (row.clips_tab_pinned_user_ids && row.clips_tab_pinned_user_ids.length)
  || (row.timeline_pinned_user_ids && row.timeline_pinned_user_ids.length)
  || row.isPinned,
);

function toReelRow(row) {
  if (row.shortCode) return row;
  const user = row.user || {};
  const caption = row.caption;
  const thumbs = (row.image_versions2 || {}).candidates || [];
  const sound = (row.clips_metadata || {}).audio_type;
  const hidden = Boolean(row.like_and_view_counts_disabled);
  const person = (u) => ({ username: u.username || '', full_name: u.full_name || '' });
  return {
    id: String(row.pk || row.id || ''),
    shortCode: row.shortcode,
    url: `https://www.instagram.com/reel/${row.shortcode}/`,
    ownerUsername: user.username || '',
    ownerFullName: user.full_name || '',
    ownerId: String(user.pk || user.id || ''),
    type: 'Video',
    productType: row.product_type,
    caption: typeof caption === 'string' ? caption : (caption || {}).text || '',
    hashtags: (row.hashtags || []).map((h) => String(h).replace(/^#/, '')),
    mentions: (row.mentions || []).map((m) => String(m).replace(/^@/, '')),
    taggedUsers: (row.tagged_user || []).map(person),
    coauthorProducers: (row.coauthor_producers || []).map(person),
    paidPartnership: row.is_paid_partnership ?? null,
    timestamp: row.taken_at || null,
    videoPlayCount: row.play_count ?? null,
    videoViewCount: null,
    likesCount: hidden ? null : row.like_count ?? null,
    likesHidden: hidden,
    commentsCount: row.comment_count ?? null,
    videoDuration: row.video_duration ?? null,
    displayUrl: thumbs[0] ? thumbs[0].url : '',
    videoUrl: row.video_url || '',
    audioUrl: '',
    musicInfo: { uses_original_audio: sound == null ? null : sound === 'original_sounds' },
    source: 'instagram-profile-reels-scraper',
  };
}

const nonNegInt = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);

function parseTimestamp(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return new Date(ts * 1000);
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

// reels.from_apify
function fromApify(row, creator) {
  const code = row.shortCode;
  const caption = row.caption || '';
  const tags = new Set([
    ...(row.hashtags || []).map((h) => String(h).toLowerCase()),
    ...finditer(HASHTAG, caption).map((m) => m[1].toLowerCase()),
  ]);
  return {
    post_id: code,
    url: `https://www.instagram.com/reel/${code}/`,
    creator: handle(creator),
    owner: handle(row.ownerUsername || creator),
    published_at: parseTimestamp(row.timestamp),
    caption,
    hashtags: [...tags].sort(),
    mentions: (row.mentions || []).map(handle),
    tagged: (row.taggedUsers || []).map((t) => handle(t.username || '')),
    coauthors: (row.coauthorProducers || []).filter((c) => c.username).map((c) => handle(c.username)),
    paid_partnership: row.paidPartnership ?? null,
    plays: nonNegInt(row.videoPlayCount),
    views: nonNegInt(row.videoViewCount),
    likes: nonNegInt(row.likesCount),
    comments: nonNegInt(row.commentsCount),
    duration_s: row.videoDuration ?? null,
    original_audio: (row.musicInfo || {}).uses_original_audio ?? null,
    thumbnail_url: row.displayUrl || '',
    video_url: row.videoUrl || '',
    audio_url: row.audioUrl || '',
    transcript: null,
    transcript_status: 'missing',
    transcript_language: null,
    ocr_text: '',
  };
}

const coauthored = (r) => r.owner !== r.creator;

// Accounts tagged, mentioned or co-authoring, other than the creator.
function otherAccounts(r) {
  const found = new Set([...r.tagged, ...r.mentions, ...r.coauthors].map(handle));
  for (const m of finditer(MENTION, r.caption)) found.add(handle(m[1]));
  if (coauthored(r)) found.add(r.owner);
  found.delete(r.creator);
  found.delete('');
  return [...found].sort();
}

module.exports = { scrub, handle, PINNED_MAX, isTrial, isPinned, toReelRow, fromApify, coauthored, otherAccounts };
