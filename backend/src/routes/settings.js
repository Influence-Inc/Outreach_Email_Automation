const express = require('express');
const { getGuidelines, setSetting, GUIDELINES_KEY } = require('../services/settings');

const router = express.Router();

// Current app-wide settings. Right now just the universal Guidelines prompt.
router.get('/', async (_req, res, next) => {
  try {
    res.json({ guidelines: await getGuidelines() });
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

module.exports = router;
