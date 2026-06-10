'use strict';

// Tiny key/value store backed by the app_settings table. Currently holds the
// universal negotiation "Guidelines" prompt; kept generic for future settings.

const db = require('../db');

const GUIDELINES_KEY = 'negotiation_guidelines';

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

module.exports = { getSetting, setSetting, getGuidelines, GUIDELINES_KEY };
