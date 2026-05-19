require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const brands = require('./routes/brands');
const campaigns = require('./routes/campaigns');
const creators = require('./routes/creators');
const tracking = require('./routes/tracking');
const auth = require('./routes/auth');
const scheduler = require('./services/scheduler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/brands', brands);
app.use('/api/campaigns', campaigns);
app.use('/api/creators', creators);
app.use('/auth', auth);
app.use('/track', tracking);

// Serve the dashboard from /dashboard at root.
app.use('/', express.static(path.join(__dirname, '..', '..', 'dashboard')));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  scheduler.start();
});
