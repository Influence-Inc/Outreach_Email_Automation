'use strict';

// Tiny key/value store backed by the app_settings table. Holds the universal
// negotiation "Guidelines" prompt, the global AI-auto-reply kill-switch, and
// the per-reply-type prompt notes.

const db = require('../db');

const GUIDELINES_KEY = 'negotiation_guidelines';
const AI_REPLIES_KEY = 'ai_replies_enabled';
const REPLY_NOTES_KEY = 'reply_prompt_notes';

// Reply types the admin can steer with per-reply notes. Keys are injected into
// Claude prompts as action-specific guidance; labels are the UI headings.
// Keep in sync with the UI list in public/index.html.
const REPLY_NOTE_TYPES = [
  { key: 'reply1',               label: 'Reply 1 — details + ask for their rate' },
  { key: 'reply2',               label: 'Reply 2 — priced offer (first send)' },
  { key: 'counter_offer',        label: 'Counter-offer — revised numbers after their counter' },
  { key: 'accepted',             label: 'Acceptance — creator agreed to the offer' },
  { key: 'declined',             label: 'Decline — creator is not interested' },
  { key: 'answer_question',      label: 'Answer-question — factual reply about the deal' },
  { key: 'request_counter_rate', label: 'Counter-rate-request — creator pushed back without a number' },
  { key: 'references_only',      label: 'References-only — sharing past work when asked' },
];
const REPLY_NOTE_KEYS = REPLY_NOTE_TYPES.map((t) => t.key);

async function getSetting(key) {
  const row = await db.one(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

// Universal guidelines injected into every Claude negotiation prompt. Empty
// string when unset (callers treat empty as "no guidelines"). Never throws —
// a missing table / DB hiccup degrades to no guidelines.
async function getGuidelines() {
  try {
    const v = await getSetting(GUIDELINES_KEY);
    return typeof v === 'string' ? v : '';
  } catch (err) {
    console.error('[settings] getGuidelines failed:', err.message);
    return '';
  }
}

// Global kill-switch for AI auto-replies. Default TRUE on first boot — the
// negotiation flow auto-replies unless an admin turns it off in the
// dashboard. Never throws; a missing table / hiccup degrades open (AI on).
async function getAiRepliesEnabled() {
  try {
    const v = await getSetting(AI_REPLIES_KEY);
    if (v == null) return true;
    return v !== false && v !== 'false';
  } catch (err) {
    console.error('[settings] getAiRepliesEnabled failed:', err.message);
    return true;
  }
}

async function setAiRepliesEnabled(enabled) {
  await setSetting(AI_REPLIES_KEY, !!enabled);
}

// Per-reply prompt notes: a {key: string} map the admin fills in on the
// Guidelines page. Each note is free-form text injected into the Claude prompt
// that writes that specific reply type ("Reply 1", "Reply 2", etc). Returns
// a full object with every known key present (empty string when unset) so
// callers don't need to defensively read missing keys.
async function getReplyPromptNotes() {
  const empty = Object.fromEntries(REPLY_NOTE_KEYS.map((k) => [k, '']));
  try {
    const raw = await getSetting(REPLY_NOTES_KEY);
    if (!raw) return empty;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return empty;
    const out = { ...empty };
    for (const k of REPLY_NOTE_KEYS) {
      const v = parsed[k];
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (err) {
    console.error('[settings] getReplyPromptNotes failed:', err.message);
    return empty;
  }
}

// Save the per-reply notes map. Silently drops any unknown keys and coerces
// non-string values to empty — the on-disk shape is always {known_key: string}.
async function setReplyPromptNotes(notes) {
  const clean = {};
  const src = notes && typeof notes === 'object' ? notes : {};
  for (const k of REPLY_NOTE_KEYS) {
    const v = src[k];
    clean[k] = typeof v === 'string' ? v : '';
  }
  await setSetting(REPLY_NOTES_KEY, JSON.stringify(clean));
  return clean;
}

module.exports = {
  getSetting,
  setSetting,
  getGuidelines,
  getAiRepliesEnabled,
  setAiRepliesEnabled,
  getReplyPromptNotes,
  setReplyPromptNotes,
  GUIDELINES_KEY,
  AI_REPLIES_KEY,
  REPLY_NOTES_KEY,
  REPLY_NOTE_TYPES,
  REPLY_NOTE_KEYS,
};
