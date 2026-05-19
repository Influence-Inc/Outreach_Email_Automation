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

## 6. Daily workflow

1. In the dashboard, add a **brand** and a **campaign**.
2. Add each creator's Instagram URL one-by-one. Leave email blank.
3. Click **Fetch emails** at the top of the campaign creator table. The backend
   scrapes every creator with status `pending_extraction` or `no_email`. Rows
   move to `email_found` (with an email filled in) or stay as `no_email`.
4. Click **Send outreach** on each `email_found` row. The backend sends via the
   Gmail API with a tracking pixel. Status → `outreach_sent`.
5. Leave the backend running. Every 15 minutes the scheduler:
   - Checks Gmail threads for replies (→ `replied`).
   - Sends follow-ups for any outreach that's >48h old with no reply (→ `followup_sent`).
6. The dashboard's **Opens** column updates as the tracking pixel is loaded.

## Deployment notes

- Public deploy needs HTTPS for the Gmail OAuth callback. Update
  `GOOGLE_REDIRECT_URI` and `PUBLIC_BASE_URL` in `.env`, and add the same
  redirect URI in Google Cloud Credentials.
- The tracking pixel is served from `${PUBLIC_BASE_URL}/track/open/:id.png`.
  This must be publicly reachable for opens to register.
- The IG scraper makes outbound requests from your server's IP. If IG starts
  rate-limiting, route through a residential proxy.
