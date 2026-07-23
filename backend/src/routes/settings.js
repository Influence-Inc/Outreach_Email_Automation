const express = require('express');
const {
  getGuidelines,
  getAiRepliesEnabled,
  setAiRepliesEnabled,
  setSetting,
  getReplyPromptNotes,
  setReplyPromptNotes,
  getReplyPromptOverrides,
  setReplyPromptOverrides,
  GUIDELINES_KEY,
  REPLY_NOTE_TYPES,
  REPLY_NOTE_KEYS,
} = require('../services/settings');
const { getReplyPromptSnapshots } = require('../services/replyPromptSnapshots');
const { rewriteMasterPrompt } = require('../services/replyPromptRewrite');

const router = express.Router();

// Current app-wide settings for the Guidelines page: the universal Guidelines
// prompt, the global AI auto-reply kill-switch, the per-reply prompt notes
// (the raw instructions), the LLM-rewritten master prompt overrides that
// Claude follows at runtime, the base master-prompt snapshots so the UI can
// show the underlying default, and the schema of which reply types exist.
router.get('/', async (_req, res, next) => {
  try {
    const snapshots = getReplyPromptSnapshots();
    res.json({
      guidelines: await getGuidelines(),
      ai_replies_enabled: await getAiRepliesEnabled(),
      reply_prompt_notes: await getReplyPromptNotes(),
      reply_prompt_overrides: await getReplyPromptOverrides(),
      reply_note_types: REPLY_NOTE_TYPES,
      reply_master_prompts: snapshots.prompts,
      reply_master_prompts_framing: snapshots.global_framing,
    });
  } catch (err) {
    next(err);
  }
});

// Save the universal Guidelines prompt.
router.put('/guidelines', async (req, res, next) => {
  try {
    const raw = (req.body || {}).guidelines;
    if (raw != null && typeof raw !== 'string') {
      return res.status(400).json({ error: 'guidelines must be a string' });
    }
    await setSetting(GUIDELINES_KEY, raw == null ? '' : raw);
    res.json({ guidelines: await getGuidelines() });
  } catch (err) {
    next(err);
  }
});

// Save the per-reply prompt notes and/or master-prompt overrides in one atomic
// call. Body: { notes: { key: "..." }, overrides: { key: "..." } }. Either
// field can be omitted; unknown keys are dropped; missing keys treated as
// empty. The overrides field is what Claude actually follows at runtime — the
// notes are stored alongside as an audit trail of "what the admin asked for".
router.put('/reply-prompt-notes', async (req, res, next) => {
  try {
    const body = req.body || {};
    const notes = body.notes;
    const overrides = body.overrides;
    if (notes != null && (typeof notes !== 'object' || Array.isArray(notes))) {
      return res.status(400).json({ error: 'notes must be an object' });
    }
    if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
      return res.status(400).json({ error: 'overrides must be an object' });
    }
    const savedNotes = notes != null ? await setReplyPromptNotes(notes) : await getReplyPromptNotes();
    const savedOverrides =
      overrides != null ? await setReplyPromptOverrides(overrides) : await getReplyPromptOverrides();
    res.json({
      reply_prompt_notes: savedNotes,
      reply_prompt_overrides: savedOverrides,
      reply_note_types: REPLY_NOTE_TYPES,
    });
  } catch (err) {
    next(err);
  }
});

// Generate a proposed revised master prompt for one reply type by feeding the
// current effective prompt + the admin's plain-English instruction through
// Claude. Preview-only: does NOT persist anything. The UI shows the returned
// text in a preview block with Confirm / Cancel; on Confirm the UI writes it
// back via PUT /reply-prompt-notes with the {overrides} field. On no
// instruction, no known key, or an unavailable Claude the call errors with a
// human-readable message so the UI can surface it.
router.post('/reply-prompt-preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    const key = String(body.key || '').trim();
    const instruction = String(body.instruction || '').trim();
    if (!REPLY_NOTE_KEYS.includes(key)) {
      return res.status(400).json({ error: 'unknown reply type' });
    }
    if (!instruction) {
      return res.status(400).json({ error: 'instruction is required' });
    }
    const snapshots = getReplyPromptSnapshots();
    const base = (snapshots.prompts && snapshots.prompts[key]) || '';
    const overrides = await getReplyPromptOverrides();
    const currentPrompt = overrides[key] && overrides[key].trim() ? overrides[key] : base;
    const revised = await rewriteMasterPrompt({ currentPrompt, instruction });
    if (revised == null) {
      return res
        .status(503)
        .json({ error: 'Claude is unavailable — cannot preview the revised prompt right now.' });
    }
    res.json({ key, revised_prompt: revised, base_prompt: base });
  } catch (err) {
    next(err);
  }
});

// Flip the global AI auto-reply kill-switch. When false, every creator reply
// goes to the Delegate window instead of getting an auto-generated response.
router.put('/ai-replies-enabled', async (req, res, next) => {
  try {
    const raw = (req.body || {}).enabled;
    if (typeof raw !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    await setAiRepliesEnabled(raw);
    res.json({ ai_replies_enabled: await getAiRepliesEnabled() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
