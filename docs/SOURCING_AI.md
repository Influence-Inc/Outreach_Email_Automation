# AI creator sourcing — multimodal reel judging, explore/scroll & engagement

This is the Phase‑3 layer on top of the paired‑phone sourcing stack. The backend
drives a real Instagram app (no IG API), and now:

1. **Watches *and hears* reels** — a short clip (video **+ audio**) is recorded on
   the phone with `scrcpy` and judged by **Gemini** (frames at 1 fps + the audio
   track), so niche/genre come from the visuals and spoken topic / music /
   language come from the audio.
2. **Explores + scrolls** — a reels‑feed navigator drops into the full‑screen reel
   player for a keyword and scrolls, evaluating each reel.
3. **(Optionally) engages** — very occasionally likes/saves the clearly on‑brand
   reels to warm Instagram's Explore/Reels algorithm toward the target niche.

Everything degrades gracefully: with no `GEMINI_API_KEY` the judge falls back to
Claude‑on‑thumbnails, then keyword scoring — the pipeline still runs.

## Cost

Gemini bills video at 1 fps: **66 tokens/frame** at `media_resolution=low` (258 at
default) **+ 32 tokens/sec audio**. On the flash-lite tier + low res, judging
~12 s per reel runs a few dollars per 5,000 reels (well under budget). See the
model docs for current rates.

## Configuration

### Backend env

| Var | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(unset)* | Enables the multimodal judge. Unset ⇒ falls back to Claude/keywords. **Paste the raw value — no surrounding quotes, no leading space.** |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Judge model. Quotes/whitespace are stripped. The default is Google's rolling alias for the current flash-lite model — a pinned generation (e.g. `gemini-2.5-flash-lite`) can 404 later with `"this model is no longer available to new users"` even though nothing in this repo changed; pin a dated snapshot only if you need reproducibility across a model upgrade. |
| `GEMINI_MEDIA_RESOLUTION` | `low` | `low` (cheapest) / `medium` / `high`. |
| `SOURCING_REMOTE_CONTROL` | off | `on` enables backend‑driven scouting + the reel pipeline (agent mode). |
| `SOURCING_AI_SEARCH_TERMS` | on when `GEMINI_API_KEY` is set | `off` disables AI search‑term expansion (see *Search terms* below). |
| `SOURCING_ENGAGEMENT` | off | `on` allows like/save. **Off = watch‑only (near‑zero ban risk).** |
| `SOURCING_ENGAGE_MIN_SCORE` | `0.75` | Only engage reels at/above this niche score. |
| `SOURCING_ENGAGE_LIKE_PROB` | `0.2` | Per‑eligible‑reel like probability (keeps it occasional). |
| `SOURCING_ENGAGE_SAVE_PROB` | `0.1` | Save probability. |
| `SOURCING_ENGAGE_SHARE_PROB` | `0` | Share probability (share action is deferred — see below). |
| `SOURCING_ENGAGE_MAX_LIKES` / `_SAVES` / `_SHARES` | `20` / `10` / `3` | Per‑session hard caps. |
| `SOURCING_PACING_MS` | `1800` | Human‑like delay between actions (jittered ±40%). |
| `SOURCING_CAPTURE_CAP` | `500` | Safety cap on captures per run. |
| `SOURCING_TAP_JITTER_PX` | `5` | Random ± pixels added to every tap (anti‑flag). |
| `SOURCING_ACTIVE_HOURS` | *(unset = always)* | Only scout inside this local‑time window, e.g. `8-23` or overnight `22-6`. Outside it the agent idle‑polls. |

> **Verify the key/model without the phone:** hit `GET /api/sourcing/gemini/health`
> (admin-authed) — it does a tiny text-only call and returns the real
> `{ ok, status, error, model }`. `ok:true` ⇒ Gemini is reachable; a `404` ⇒ the
> model name is wrong/misquoted/deprecated for your key (the response also lists
> `availableModels` — the exact ids your key can use); a `403/400` ⇒ the key
> itself. This is the fastest way to tell a Gemini misconfig from a phone/
> navigation problem.

### Scouting rules (per campaign)

- `discovery: "reels"` — use the explore/scroll reel‑feed flow (watch + hear +
  occasionally engage); omit for the classic search → profile flow. A reel off
  the feed has no multi‑reel view window, so reels‑mode candidates are scored on
  the Gemini niche match **only** (the floor/risk/stability rules don't apply)
  and are **always routed to the review queue** — a human confirms reach before
  they're added. (Profiles mode keeps the full deterministic rules + auto‑add.)
- `targetAudience` / `genres` — fed to the Gemini judge (audience fit + on‑brand genres).
- `reviewBorderline: true` (+ optional `reviewBand`, default `0.15`) — hold
  near‑threshold AI matches in the **review queue** instead of auto‑adding.

### Search terms

`services/searchTerms.js` decides what the scout actually types into Instagram
search. **A comma separates keywords; a space does not.** So
`iphone photos, instagram story ideas` is two searches — `iphone photos`, then
`instagram story ideas` — each typed with its spaces intact.

Order is `hashtags → keywords → seedAccounts → (niche, only if nothing else was
configured) → AI suggestions`, de‑duplicated and capped at 24 searches per run.
A keyword you typed is taken exactly as typed; stopword/length filtering applies
only to single words *derived* for you (from the niche, or suggested by Gemini).

With `GEMINI_API_KEY` set, the run additionally asks Gemini for extra
single‑word terms from the campaign's `niche` / `genres` / `targetAudience`.
These are **purely additive and always last**, so your own keywords are searched
first. Disable with `SOURCING_AI_SEARCH_TERMS=off`. With no key, or on any
model/network failure, expansion returns nothing and scouting proceeds on the
configured terms.

### Search flow: reels first

For a keyword the navigator scouts the **reels grid** IG returns, taps a card to
reach the full‑screen player, reads the real `@handle` there, and opens that
creator's profile. A reel proves the creator is actively posting the content you
searched for; an "Accounts" row only proves the handle matched the string. The
Accounts list is used as a fallback, and only when the reels path found nothing,
so one keyword is never scouted twice.

### Review queue

When `reviewBorderline` is on, a passer whose niche score is within `reviewBand`
of the threshold gets `decision = "review"` instead of being added. Admins
approve/reject from the **Pending review** card on the Scout Creators page
(`GET /api/sourcing/review`, `POST /api/sourcing/candidates/:id/approve|reject`);
the Gemini reasoning (genre / audience / why) is shown inline.

### Scouting rules (per campaign)

`campaigns.sourcing_defaults` gains two fields the reel judge uses:

- `targetAudience` — free‑text description of who the brand wants to reach (fed to
  Gemini so it scores *audience fit*, not just topic).
- `genres` — optional allow‑list of on‑brand genres.

Set `discovery: "reels"` (and optionally `clipSeconds`, default 12) on a run's
config to use the **explore/scroll reel‑feed flow**; omit it for the classic
search → profile flow.

The Gemini verdict (`genre`, `audienceMatch`, `language`, `spokenTopic`, `reason`)
is stored on `sourced_candidates.evidence.niche` so every match is auditable.

## Host setup: audio capture

**On the Android app host ([`android-agent/`](../android-agent)) there is
nothing to install.** The app captures screen + internal audio natively through
`MediaProjection` + `AudioPlaybackCapture`, so the rest of this section applies
only to the legacy laptop runner. (One caveat: an app may set
`allowAudioPlaybackCapture="false"`, in which case the clip records with silent
audio — video always works.)

### Legacy laptop runner: scrcpy

`adb screenrecord` cannot capture audio, so a **laptop** host needs **scrcpy
2.0+** on `PATH` (Android **11+** for audio; 12+ works out of the box):

- macOS: `brew install scrcpy`
- Ubuntu: `sudo apt install scrcpy` (or the Genymobile release)
- Windows: download the scrcpy release and add it to `PATH`

The agent records with `scrcpy --no-window --no-control --record-format=mp4
--time-limit=<sec> --record=<file>` and uploads the mp4 to the backend, which
sends it to Gemini.

## ⚠️ Engagement safety

Automated like/save is what Instagram's anti‑automation targets, so it is:

- **off by default** (watch‑only usually);
- **strong‑match only** (`minScore`), **low probability**, **hard per‑session caps**;
- **stopped immediately** when an "Action Blocked" screen is detected;
- **never re‑likes** an already‑liked reel.

Use a **dedicated, warmed‑up** account, and ramp engagement slowly. **Sharing is
deferred** — it's multi‑step (share sheet → recipient) and the highest risk; the
policy supports it but the navigator performs only like/save in v1.

## Calibration

Like Phase 1, the reader's element signals for the reel player (like/save/share
buttons, the reel author, the action‑block dialog) are *plausible for current IG
but need a one‑time confirmation on a real device* — dump a full‑screen reel with
`adb shell uiautomator dump` and adjust `SIGNALS` in
`backend/src/services/screenVision.js` if a target is missed. The reader degrades
to `screen: unknown` rather than crashing, so mis‑calibration is safe.
