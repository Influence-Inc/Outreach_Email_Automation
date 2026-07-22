const express = require('express');
const {
  getGuidelines,
  getAiRepliesEnabled,
  setAiRepliesEnabled,
  setSetting,
  getReplyPromptNotes,
  setReplyPromptNotes,
  GUIDELINES_KEY,
  REPLY_NOTE_TYPES,
} = require('../services/settings');
const { getReplyPromptSnapshots } = require('../services/replyPromptSnapshots');

const router = express.Router();

// Current app-wide settings: the universal Guidelines prompt, the global AI
// auto-reply kill-switch, the per-reply prompt notes, and the read-only master
// prompt snapshots the Guidelines UI displays above each notes textarea so the
// team can see the exact directive Claude follows before writing a note.
router.get('/', async (_req, res, next) => {
  try {
    const snapshots = getReplyPromptSnapshots();
    res.json({
      guidelines: await getGuidelines(),
      ai_replies_enabled: await getAiRepliesEnabled(),
      reply_prompt_notes: await getReplyPromptNotes(),
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

// Save the per-reply prompt notes. Body: { notes: { reply1: "...", ... } }.
// Unknown keys are dropped; missing keys are treated as empty.
router.put('/reply-prompt-notes', async (req, res, next) => {
  try {
    const raw = (req.body || {}).notes;
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
      return res.status(400).json({ error: 'notes must be an object' });
    }
    const saved = await setReplyPromptNotes(raw || {});
    res.json({ reply_prompt_notes: saved, reply_note_types: REPLY_NOTE_TYPES });
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
