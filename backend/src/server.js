require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const campaigns = require('./routes/campaigns');
const creators = require('./routes/creators');
const negotiation = require('./routes/negotiation');
const settings = require('./routes/settings');
const webhook = require('./routes/webhook');
const offerWebhook = require('./routes/offerWebhook');
const { api: contractsApi, page: contractPage } = require('./routes/contracts');
const { api: offersApi, page: offerPage } = require('./routes/offers');
const bot = require('./routes/bot');
const creatorDbRoutes = require('./routes/creatorDb');
const scheduler = require('./services/scheduler');
const { syncCampaigns } = require('./services/campaignsApi');
const { probeProfile, igCookieStatus } = require('./services/igScraper');
const { seedDefaultIfEmpty } = require('./services/emailTemplates');

const app = express();
app.use(cors());
app.use(express.json({
  limit: '1mb',
  // Capture the raw body so webhook handlers can verify HMAC signatures
  // against the exact bytes the sender signed (re-serializing the parsed
  // object would not match).
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/debug/ig-probe', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username query param required' });
  try {
    res.json(await probeProfile(username));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/ig-cookie', (_req, res) => res.json(igCookieStatus()));

app.use('/api/campaigns', campaigns);
app.use('/api/creators', creators);
// Negotiation admin actions live under /api/creators too (e.g. /:id/offer,
// /:id/quoted-rate). Two-segment paths fall through the creators router above.
app.use('/api/creators', negotiation);
// Creator-Database bridge: /search (Used/Unused/New lookup) + /import (create
// a creators row from a picked Creator-DB record). See routes/creatorDb.js.
app.use('/api/creator-db', creatorDbRoutes);
app.use('/api/settings', settings);
app.use('/webhook', webhook);
// Inbound WhatsApp + iMessage for the offer portal (old-creator negotiation).
app.use('/webhook', offerWebhook);
app.use('/api/contracts', contractsApi);
// Offer-portal API — the public offer page fetches data + posts accept/decline/
// counter here (resolved by unguessable token only).
app.use('/api/offers', offersApi);
// Bot API for the campaigns dashboard (influence-stats) to fetch per-creator
// contract URLs so it can render the "Contract submission" column.
app.use('/api/bot', bot);
// Public contract signing page. Registered before the SPA static handler so
// these serve the contract page, not the dashboard shell.
// - /contract/:token  (singular) is the current default — see contracts.js
//   contractUrl(). It's also what campaigns.influence.technology proxies
//   through to (see influence-stats' /contract/:token route).
// - /contracts/:token (plural) is kept so links already emailed out under the
//   old path keep working.
app.get('/contract/:token', contractPage);
app.get('/contracts/:token', contractPage);

// Public offer page (old-creator negotiation). Registered before the SPA static
// handler so /o/:token serves the offer shell, not the dashboard.
app.get('/o/:token', offerPage);

app.use('/', express.static(path.join(__dirname, '..', 'public')));

// SPA fallback: the dashboard uses real path URLs (e.g. /campaign/:id) so each
// campaign page can be refreshed, bookmarked and shared. Any GET that isn't an
// API/webhook/contract call and wasn't served as a static asset above returns
// the app shell, letting the client-side router render the right view.
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/webhook') ||
    req.path.startsWith('/contract') ||
    req.path.startsWith('/o/') ||
    req.path === '/health'
  ) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  scheduler.start();

  seedDefaultIfEmpty().catch((err) =>
    console.error('seedDefaultIfEmpty failed:', err.message),
  );

  syncCampaigns()
    .then((r) => console.log(`Synced ${r.upserted} campaigns from upstream`))
    .catch((err) => console.error('Initial campaigns sync failed:', err.message));
});
