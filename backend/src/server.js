require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const campaigns = require('./routes/campaigns');
const creators = require('./routes/creators');
const tracking = require('./routes/tracking');
const auth = require('./routes/auth');
const scheduler = require('./services/scheduler');
const { syncCampaigns } = require('./services/campaignsApi');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/campaigns', campaigns);
app.use('/api/creators', creators);
app.use('/auth', auth);
app.use('/track', tracking);

app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  scheduler.start();

  // Pull brands + campaigns from campaigns.influence.technology on boot.
  syncCampaigns()
    .then((r) => console.log(`Synced ${r.upserted} campaigns from upstream`))
    .catch((err) => console.error('Initial campaigns sync failed:', err.message));
});
