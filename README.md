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

- **brands** → high-level brand accounts
- **campaigns** → each brand has many campaigns
- **creators** → IG URL, extracted email, status, message + thread IDs, open count
- **email_events** → audit log of sent / opened / replied / failed events
- **oauth_tokens** → Jennifer's Gmail refresh token (one-time consent)

## Email flow

```
add IG URL → status: pending_extraction
  ↓ user clicks "Fetch emails" once per campaign
  ↓ backend hits IG's web_profile_info endpoint, then HTML fallback
  ↓ status: email_found  (or no_email if nothing was scrapable)
  ↓ user clicks "Send outreach" on a row
  ↓ Gmail API sends as jennifer@useinfluence.xyz with tracking pixel
  ↓ status: outreach_sent
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
