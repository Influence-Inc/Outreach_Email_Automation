# Influence Creator Outreach Automation

End-to-end system that lets the Influence team:

1. Store every Instagram creator account link, grouped by **brand → campaign**.
2. Fetch each creator's email from Instagram with one click on the dashboard.
3. Auto-send the **fixed outreach email** from `jennifer@useinfluence.xyz` via the Gmail API.
4. Auto-send a **follow-up email** if the creator does not reply within 2 days.
5. Track whether the recipient **opened** the email via a tracking pixel.

## Components

```
backend/      Node.js + Express + Postgres API
              - Gmail OAuth + sender
              - 48h follow-up scheduler + reply detection
              - Instagram scraper (web_profile_info + HTML fallback)
              - Tracking-pixel open logging
dashboard/    Static web dashboard, served by Express at /
docs/         Setup walkthrough (Gmail OAuth, Postgres, IG session)
```

## Data model

- **campaigns** → synced from `campaigns.influence.technology` (`GET /api/bot/campaigns`).
  Upstream `id` is the primary key. `brand_name` is denormalised onto each row.
  The local UI never creates campaigns - it's read-only on this table.
- **creators** → IG URL, extracted email, status, message + thread IDs, open count.
  Linked to a campaign by upstream campaign id.
- **email_events** → audit log of sent / opened / replied / failed events
- **oauth_tokens** → Jennifer's Gmail refresh token (one-time consent)

## Email flow

```
backend boot → fetch /api/bot/campaigns → upsert into local campaigns table
                                                  ↓
admin picks a campaign → adds creator IG URL → status: pending_extraction
  ↓ user clicks "Fetch emails" once per campaign
  ↓ backend hits IG's web_profile_info endpoint, then HTML fallback
  ↓ status: email_found  (or no_email if nothing was scrapable)
  ↓ user clicks "Send outreach" on a row
  ↓ lead is enrolled in its Instantly campaign (email not yet sent)
  ↓ status: outreach_queued
  ↓ Instantly dispatches the Step 1 email → email_sent webhook confirms it
  ↓ status: outreach_sent   (only now does the dashboard show "Outreach sent")
  ↓ scheduler (every 15 min):
    · checks Gmail thread for replies → status: replied
    · if 48h elapsed and no reply → sends follow-up
  ↓ status: followup_sent
```

## Quick start

See [`docs/SETUP.md`](./docs/SETUP.md). Short version:

```bash
cd backend
cp .env.example .env   # fill in DB + Google OAuth + IG_SESSION_COOKIE
npm install
npm run migrate
npm start
open http://localhost:3000               # dashboard
open http://localhost:3000/auth/google   # one-time Gmail auth as Jennifer
```

## Dashboard access (Sign in with Slack)

The dashboard is internal-only. Team members **sign in with their Slack account**
(Slack's OpenID Connect flow) — no shared password. Set `SLACK_CLIENT_ID` and
`SLACK_CLIENT_SECRET` and every dashboard page and admin `/api/*` route sits
behind sign-in: `GET /auth/slack` bounces to Slack, `/auth/slack/callback` issues
a signed, HttpOnly session cookie (30 days), `GET /logout` clears it, and the
topbar shows who's signed in with a "Sign out" link.

Lock it down with `SLACK_ALLOWED_TEAM_ID` (your workspace) and/or
`SLACK_ALLOWED_EMAIL_DOMAINS` (e.g. `useinfluence.xyz`) — **without either, any
Slack account can sign in** (boot logs a warning).

Set-up in the Slack app config (https://api.slack.com/apps):

1. **OAuth & Permissions → Redirect URLs** → add
   `{this backend's origin}/auth/slack/callback` (this backend's own URL, not
   `campaigns.influence.technology` — that proxy only forwards creator pages).
2. Enable **Sign in with Slack** (the `openid`, `email`, `profile` scopes).
3. Copy the **Client ID + Client Secret** into the env vars above.

The **Chrome extension needs no setup** — it reuses the signed-in team member's
dashboard session: it reads the `io_session` cookie via the browser's cookies
API and forwards the same signed token as an `x-io-session` header, so as long as
the user is signed in to the dashboard the extension just works (no shared secret
ships inside it).

Truly headless clients (curl, cron scripts) have no Slack session, so they
authenticate with a machine token instead: set `DASHBOARD_API_TOKEN` and send it
as `x-api-token: <token>` (the legacy `x-site-password` header and HTTP Basic
auth also work).

Creator-facing and machine surfaces stay public — they're resolved by unguessable
token or carry their own secret: `/contract/:token`, `/o/:token`, `/go/imessage`,
`/api/contracts/*`, `/api/offers/*`, `/webhook/*`, `/api/bot/*` (`x-bot-token`)
and `/health`.

**With `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` unset the gate is off** and the
dashboard is reachable by anyone with the URL — boot logs a warning to that
effect. Set the vars in Railway to turn protection on. The allowlist and session
logic live in
[`backend/src/services/siteAuth.js`](./backend/src/services/siteAuth.js).

## Instagram scraping (two strategies)

The backend tries:

1. **`GET /api/v1/users/web_profile_info/?username=X`** with `X-IG-App-ID` header.
   Returns `business_email` (the same field the mobile "Email" button uses),
   `public_email`, `biography`, `full_name`.
2. **`GET https://www.instagram.com/{username}/`** and regex over the HTML body.
   Picks up `"business_email":"..."`, `"public_email":"..."`, bio text.

For **`business_email`** to be returned, Jennifer's IG `sessionid` cookie must be
set as `IG_SESSION_COOKIE` in `.env`. Without it, the scraper still picks up
public bios but the email button data is hidden.

## Fixed email templates

Templates live in [`backend/src/services/templates.js`](./backend/src/services/templates.js).
Variables: `{firstName}`, `{brandName}`, `{campaignName}`.

## Caveats

- **Open tracking is best-effort.** Gmail's image proxy caches the pixel; corporate
  filters strip images. Expect ~60-70% accuracy. Same limitation as Mailtrack.
- **Sender quota.** Gmail caps ~500 sends/day for consumer accounts, ~2000/day for
  Workspace. The scheduler does not currently throttle.
- **IG rate limits.** Bulk fetch sleeps 1.5–3 s between profiles. If IG starts
  returning 429s, increase the delay or use a fresh `sessionid`.
- **Reply detection** uses Gmail's thread API, so any reply on the thread from a
  non-Jennifer sender is treated as "replied".
