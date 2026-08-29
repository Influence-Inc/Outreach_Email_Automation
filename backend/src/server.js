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
const contractPdf = require('./routes/contractPdf');
const { api: offersApi, page: offerPage } = require('./routes/offers');
const { api: briefsApi, page: briefPage } = require('./routes/briefs');
const offerReview = require('./routes/offerReview');
const bot = require('./routes/bot');
const creatorDbRoutes = require('./routes/creatorDb');
const sourcing = require('./routes/sourcing');
const scheduler = require('./services/scheduler');
const { syncCampaigns } = require('./services/campaignsApi');
const { probeProfile, igCookieStatus } = require('./services/igScraper');
const { seedDefaultIfEmpty } = require('./services/emailTemplates');
const {
  offerPortalConfig,
  offerPortalConfigIssues,
  logOfferPortalConfig,
} = require('./services/offerPortal/config');
const offerImessage = require('./services/offerPortal/imessage');
const { diagnoseInboundNumber } = require('./services/offerPortal/diagnose');
const creatorUpdates = require('./services/creatorUpdates');
const siteAuth = require('./services/siteAuth');
const { preGateHostToken } = require('./services/hostTokens');

const app = express();
// Railway terminates TLS in front of us, so req.secure / req.ip are only
// correct once the proxy headers are trusted. The Slack sign-in gate relies on
// them (Secure cookie flag, request-derived OAuth redirect URI).
app.set('trust proxy', 1);
app.use(cors());
// A paired phone answers a `screenshot` command with the PNG inline as base64,
// and a full-resolution phone screen easily clears 1 MB once base64-encoded.
// Under the global 1 MB parser below that POST 413s, the agent's result never
// reaches the awaiting navigator, and the backend sits on a 30-second command
// timeout for every profile it photographs — far worse than having no
// screenshots at all. Parsing this one route first (body-parser marks the body
// as read, so the global parser then skips it) keeps the larger limit tightly
// scoped to the route that needs it.
app.use('/api/sourcing/hosts/:id/commands/result', express.json({ limit: '12mb' }));
app.use(express.json({
  limit: '1mb',
  // Capture the raw body so webhook handlers can verify HMAC signatures
  // against the exact bytes the sender signed (re-serializing the parsed
  // object would not match).
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
// Twilio POSTs its inbound WhatsApp messages + status callbacks as
// application/x-www-form-urlencoded (see /webhook/whatsapp). express.json
// above only parses application/json bodies, so add urlencoded parsing so the
// form fields (`From`, `Body`, `MessageSid`, `MessageStatus`, …) land on
// req.body for verifyTwilioSignature and the handler.
app.use(express.urlencoded({ limit: '1mb', extended: false }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Sign in with Slack gate -----------------------------------------------
// Everything below is private-by-default: the dashboard shell, its assets and
// every admin API route require a Slack session cookie. Team members sign in
// with their Slack account (Slack OpenID Connect); creator-facing pages
// (/contract/:token, /o/:token), the data they fetch, the inbound webhooks and
// the token-authenticated /api/bot/* endpoints stay open — the allowlist lives
// in services/siteAuth.js. With SLACK_CLIENT_ID / SLACK_CLIENT_SECRET unset the
// gate is a no-op (a warning is logged at boot).
app.get('/login', siteAuth.showLogin);
app.get('/auth/slack', siteAuth.beginSlackLogin);
app.get('/auth/slack/callback', siteAuth.handleSlackCallback);
app.get('/logout', siteAuth.handleLogout);
app.post('/logout', siteAuth.handleLogout);
// /api/sourcing/* accepts a per-host sourcing token from a paired runner in
// addition to the normal Slack session / DASHBOARD_API_TOKEN. This pre-gate
// middleware validates the per-host token asynchronously and marks the request;
// the sync gate below then honors that marker.
app.use('/api/sourcing', preGateHostToken);
app.use(siteAuth.gate);

// Who's signed in (drives the "signed in as …" chip in the topbar). Behind the
// gate above, so it only answers for an authenticated browser session.
app.get('/api/me', siteAuth.handleMe);

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

// Offer-portal channel readiness: is the Used-creator "text us on WhatsApp /
// iMessage" invite actually wired up, or is it silently falling back to the
// Instantly cold email? Reports status only — never API keys (the WhatsApp/
// iMessage numbers it returns are our own public business numbers, the same ones
// shown to creators in the invite). Hit this after setting the Railway vars to
// confirm inviteReady/conversationReady flip to true.
app.get('/api/debug/offer-portal-config', (_req, res) =>
  res.json({ ...offerPortalConfig(), issues: offerPortalConfigIssues() }),
);

// "The creator texted Hi and nothing came back" — replays the inbound pipeline
// for one number WITHOUT sending anything, and reports where it would stop
// (unknown sender, channel not send-ready, opted out, …) plus what the bot would
// reply with if it got through. Answers in one call what otherwise takes a round
// of live texting and log-reading.
//   GET /api/debug/messaging-inbound?phone=+919812345670[&channel=whatsapp]
app.get('/api/debug/messaging-inbound', async (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone query param required, e.g. ?phone=+919812345670' });
  const channel = String(req.query.channel || 'whatsapp').trim().toLowerCase();
  if (channel !== 'whatsapp' && channel !== 'imessage') {
    return res.status(400).json({ error: "channel must be 'whatsapp' or 'imessage'" });
  }
  try {
    res.json(await diagnoseInboundNumber(phone, channel));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Did the creator actually get their brief / approval on WhatsApp?" — the
// campaign-update lane's state for one creator: whether they're subscribed,
// whether their 24h free-form window is open right now, and every update sent
// or still queued for them, with the reason each pending one hasn't gone out.
// Reports state only; the bodies it returns are messages we sent, never creds.
//   GET /api/debug/creator-updates?creatorId=123
app.get('/api/debug/creator-updates', async (req, res) => {
  const creatorId = parseInt(req.query.creatorId, 10);
  if (!Number.isFinite(creatorId)) {
    return res.status(400).json({ error: 'creatorId query param required, e.g. ?creatorId=123' });
  }
  try {
    const status = await creatorUpdates.statusFor(creatorId);
    if (!status) return res.status(404).json({ error: 'Creator not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/campaigns', campaigns);
app.use('/api/creators', creators);
// Negotiation admin actions live under /api/creators too (e.g. /:id/offer,
// /:id/quoted-rate). Two-segment paths fall through the creators router above.
app.use('/api/creators', negotiation);
// Creator-Database bridge: /search (Used/Unused/New lookup) + /import (create
// a creators row from a picked Creator-DB record). See routes/creatorDb.js.
app.use('/api/creator-db', creatorDbRoutes);
// Automated Instagram creator sourcing (scout config, runs, host candidate ingest).
app.use('/api/sourcing', sourcing);
app.use('/api/settings', settings);
app.use('/webhook', webhook);
// Inbound WhatsApp + iMessage for the offer portal (old-creator negotiation).
app.use('/webhook', offerWebhook);
app.use('/api/contracts', contractsApi);
// Signed-contract PDF download. NOT under /api/contracts — that prefix is
// public (the creator signing page fetches it), and this returns the creator's
// submitted details, so it stays behind the Slack gate above.
app.use('/api/contract-pdf', contractPdf);
// Offer-portal API — the public offer page fetches data + posts accept/decline/
// counter here (resolved by unguessable token only).
app.use('/api/offers', offersApi);
app.use('/api/offer-review', offerReview);
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

// Public content-brief page. The brief link handed to a signed creator resolves
// here (proxied through campaigns.influence.technology, like /contract/). The
// page fetches its snapshot from /api/briefs/:token.
app.use('/api/briefs', briefsApi);
app.get('/brief/:token', briefPage);

// Public iMessage redirect. The email "Text us on iMessage" button links here
// (an https link email clients keep clickable, unlike a raw sms: link Gmail
// strips); this opens the visitor's Messages app to our business number.
app.get('/go/imessage', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(offerImessage.renderRedirectPage());
});

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
    req.path.startsWith('/brief') ||
    req.path.startsWith('/o/') ||
    req.path.startsWith('/go/') ||
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

  // Say plainly whether the dashboard requires Slack sign-in or is wide open, so
  // a deploy that forgot the Slack credentials is visible in the logs.
  siteAuth.logSiteAuthConfig();

  // Surface offer-portal channel config at boot so a half-configured deploy (the
  // Used-creator messaging invite silently falling back to Instantly email) is
  // visible in the logs instead of a mystery. See services/offerPortal/config.js.
  logOfferPortalConfig();

  seedDefaultIfEmpty().catch((err) =>
    console.error('seedDefaultIfEmpty failed:', err.message),
  );

  syncCampaigns()
    .then((r) => console.log(`Synced ${r.upserted} campaigns from upstream`))
    .catch((err) => console.error('Initial campaigns sync failed:', err.message));
});
