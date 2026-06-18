# Setup walkthrough

## 1. Postgres

Locally:

```bash
createdb influence_outreach
```

Or use a managed Postgres (Railway, Supabase, Neon). Copy the connection string
into `backend/.env` as `DATABASE_URL`.

## 2. Google Cloud OAuth client (for Gmail sending)

The backend sends mail as `jennifer@useinfluence.xyz` via the Gmail API. That
requires a one-time OAuth consent from Jennifer.

1. Open <https://console.cloud.google.com/> → create a project (e.g. `influence-outreach`).
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (or **Internal** if `useinfluence.xyz` is on Workspace).
   - App name: `Influence Outreach`.
   - Scopes: add `.../auth/gmail.send` and `.../auth/gmail.readonly`.
   - Test users: add `jennifer@useinfluence.xyz` (skip if Internal).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
     (and your production URL once deployed).
5. Copy the **Client ID** and **Client secret** into `backend/.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
SENDER_EMAIL=jennifer@useinfluence.xyz
SENDER_NAME=Jennifer
```

## 3. Instagram session cookie (optional but recommended)

The dashboard's "Fetch emails" button works without this, but most creators
only expose their email through Instagram's mobile "Email" button — that's
stored in the `business_email` field, which IG hides from anonymous requests.

To unlock it:

1. Log into <https://www.instagram.com/> as Jennifer.
2. Open Chrome DevTools → **Application → Cookies → instagram.com**.
3. Copy the **`sessionid`** value.
4. Paste it into `backend/.env`:

```
IG_SESSION_COOKIE=<the sessionid value>
```

Rotate this whenever Jennifer logs out of Instagram (it'll start returning 401s).

## 4. Backend

```bash
cd backend
cp .env.example .env   # edit it
npm install
npm run migrate
npm start
```

The dashboard is served at <http://localhost:3000/>.

## 5. Authorize Gmail (one-time)

While logged in to Chrome as `jennifer@useinfluence.xyz`, visit:

```
http://localhost:3000/auth/google
```

Approve the consent screen. The backend stores the refresh token in Postgres.
The dashboard top bar will show `Sending as jennifer@useinfluence.xyz`.

## 6. Campaigns sync (campaigns.influence.technology)

Brands and campaigns are pulled from the upstream campaigns app, not created
in the dashboard. In `backend/.env`:

```
CAMPAIGNS_API_BASE=https://campaigns.influence.technology
CAMPAIGNS_API_TOKEN=<your x-bot-token>
```

The backend hits `GET /api/bot/campaigns` on boot and upserts every campaign
into the local DB. Click **Refresh** in the sidebar to re-sync on demand.

## 7. Daily workflow

1. Open the dashboard. Sidebar shows brands grouped from upstream.
2. Pick a campaign.
3. Paste each creator's Instagram URL into the **Add creator's Instagram link**
   field and submit. Repeat for the whole list.
4. Click **Fetch emails** at the top of the creators table. The backend
   scrapes every creator with status `pending_extraction` or `no_email`. Rows
   move to `email_found` (with an email filled in) or stay as `no_email`.
5. Click **Send outreach** on each `email_found` row. The backend sends via the
   Gmail API with a tracking pixel. Status → `outreach_sent`.
6. Leave the backend running. Every 15 minutes the scheduler:
   - Checks Gmail threads for replies (→ `replied`).
   - Sends follow-ups for any outreach that's >48h old with no reply (→ `followup_sent`).
7. The dashboard's **Opens** column updates as the tracking pixel is loaded.

## Deployment notes

- Public deploy needs HTTPS for the Gmail OAuth callback. Update
  `GOOGLE_REDIRECT_URI` and `PUBLIC_BASE_URL` in `.env`, and add the same
  redirect URI in Google Cloud Credentials.
- The tracking pixel is served from `${TRACKING_BASE_URL}/o/:id.gif` (or
  `${PUBLIC_BASE_URL}` as a fallback). This must be publicly reachable for
  opens to register.
- The IG scraper makes outbound requests from your server's IP. If IG starts
  rate-limiting, route through a residential proxy.

## Deliverability (avoiding the spam folder)

Outreach from `jennifer@useinfluence.xyz` can land in spam for two
independent reasons: **email authentication** (out of this repo's control,
configured in DNS) and **message hygiene** (handled by this app). Both need
to be right.

### 1. Move sending onto Google Workspace for `useinfluence.xyz`

If `jennifer@useinfluence.xyz` is currently a **consumer Gmail account with
a "Send mail as" alias**, the Gmail API signs DKIM with `d=gmail.com` and
the Return-Path is a `gmail.com` address — so **DMARC alignment with
`useinfluence.xyz` fails**. Recipients see "via gmail.com" next to the From
name. This single factor is enough to send most cold outreach to spam.

Fix:

1. Provision `useinfluence.xyz` on Google Workspace.
2. Move Jennifer's mailbox onto the Workspace tenant.
3. Re-grant OAuth from `http://localhost:3000/auth/google` while logged in
   to the Workspace account so the refresh token in `oauth_tokens` belongs
   to the new account.

### 2. Configure SPF / DKIM / DMARC on `useinfluence.xyz`

Once Workspace is the sending account, publish these DNS records:

- **SPF** (TXT on `@`):
  ```
  v=spf1 include:_spf.google.com ~all
  ```
- **DKIM**: Workspace Admin Console → Apps → Google Workspace → Gmail →
  Authenticate email → generate a 2048-bit key. Publish the TXT it
  shows you at the `google._domainkey` host.
- **DMARC** (TXT on `_dmarc`):
  ```
  v=DMARC1; p=none; rua=mailto:dmarc@useinfluence.xyz
  ```
  Start at `p=none` and watch reports for two clean weeks, then ramp to
  `p=quarantine; pct=25` and eventually `p=reject`.

Verify on a delivered message: "Show original" in Gmail must list
`dkim=pass header.d=useinfluence.xyz` and `dmarc=pass`. Run
<https://www.mail-tester.com> and target ≥9/10.

### 3. Aligned tracking subdomain

The open-tracking pixel and the unsubscribe endpoints are served from the
backend. A cross-domain remote-image fetch on cold mail is a spam signal,
so point them at a subdomain of your sending domain:

1. Add an A/AAAA/CNAME record for `track.useinfluence.xyz` pointing at the
   production backend.
2. Issue a TLS cert for it (Caddy / Let's Encrypt is fine).
3. Set `TRACKING_BASE_URL=https://track.useinfluence.xyz` in
   production `.env`.

The pixel URL becomes `https://track.useinfluence.xyz/o/:id.gif` and the
unsubscribe URL `https://track.useinfluence.xyz/unsubscribe/:id/:token`.

### 4. Unsubscribe (RFC 8058)

Set `UNSUBSCRIBE_SECRET` in `.env` (32+ random bytes). When set, every
outreach and follow-up carries:

- A `List-Unsubscribe` header with `mailto:` and `https:` URLs and a
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` companion (the
  "Easy Unsubscribe" pip in Gmail).
- A grey footer link in the email body.

POSTing the URL adds the recipient to `email_suppressions`, and future
`sendOutreach` / `sendFollowup` calls skip them.

### 5. Postmaster Tools + warm-up

Enroll `useinfluence.xyz` in <https://postmaster.google.com>. Watch the
Domain Reputation, Spam Rate, Authentication, and Encryption dashboards.
Pause sending if Spam Rate exceeds 0.1%.

If the domain is new (or you've just migrated to Workspace), warm it up:

| Week | Sends/day |
|------|-----------|
| 1    | 20        |
| 2    | 50        |
| 3    | 100       |
| 4    | 200       |
| 5+   | 300       |

Keep `SEND_PACING_MS=60000`. Don't ramp through the table all at once.
