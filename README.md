# Influence Creator Outreach Automation

End-to-end system that lets the Influence team:

1. Store every Instagram creator account link, grouped by **brand → campaign**.
2. Extract each creator's email from their Instagram bio using a Chrome extension.
3. Auto-send the **fixed outreach email** from `jennifer@useinfluence.xyz` via the Gmail API.
4. Auto-send a **follow-up email** if the creator does not reply within 2 days.
5. Track whether the recipient **opened** the email via a tracking pixel.

## Components

```
backend/      Node.js + Express + Postgres API (Gmail OAuth, sending, scheduler, tracking pixel)
dashboard/    Static web dashboard for brands / campaigns / creators
extension/    Chrome extension - extracts emails from Instagram, pushes to backend
docs/         Setup walkthrough (Gmail OAuth, Postgres, extension load)
```

## Data model

- **brands** → high-level brand accounts
- **campaigns** → each brand has many campaigns
- **creators** → IG URL, extracted email, status, message + thread IDs, open count
- **email_events** → audit log of sent / opened / replied / failed events
- **oauth_tokens** → Jennifer's Gmail refresh token (one-time consent)

## Email flow

```
add IG URL  →  extension extracts email  →  status: email_found
       →  user clicks "Send outreach" (or batch send)
       →  Gmail API sends as jennifer@useinfluence.xyz with tracking pixel
       →  status: outreach_sent
       →  scheduler (every 15 min):
              · checks Gmail thread for replies → status: replied
              · if 48h elapsed and no reply → sends follow-up
       →  status: followup_sent
```

## Quick start

See [`docs/SETUP.md`](./docs/SETUP.md) for the full walkthrough. Short version:

```bash
# 1. Backend
cd backend
cp .env.example .env   # fill in Postgres + Google OAuth creds
npm install
npm run migrate
npm start

# 2. Dashboard
open http://localhost:3000   # served by the backend

# 3. Gmail OAuth (one-time, as Jennifer)
open http://localhost:3000/auth/google

# 4. Chrome extension
chrome://extensions  →  Developer mode  →  Load unpacked  →  pick extension/
```

## Fixed email templates

Templates live in [`backend/src/services/templates.js`](./backend/src/services/templates.js).
Variables: `{firstName}`, `{brandName}`, `{campaignName}`.

## Caveats

- **Open tracking is best-effort.** Gmail's image proxy caches the pixel; corporate
  filters strip images. Expect ~60-70% accuracy. Same limitation Mailtrack/MailSuite have.
- **Sender quota.** Gmail caps ~500 sends/day for consumer accounts, ~2000/day for
  Workspace. The scheduler does not currently throttle - add a cap if you hit it.
- **Reply detection** uses Gmail's thread API, so any reply on the thread from a
  non-Jennifer sender is treated as "replied".
