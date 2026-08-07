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
default) **+ 32 tokens/sec audio**. On `gemini-2.5-flash-lite` + low res, judging
~12 s per reel is **~$1.50 for 5,000 reels** (well under budget). See the model
docs for current rates.

## Configuration

### Backend env

| Var | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(unset)* | Enables the multimodal judge. Unset ⇒ falls back to Claude/keywords. |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Judge model. |
| `GEMINI_MEDIA_RESOLUTION` | `low` | `low` (cheapest) / `medium` / `high`. |
| `SOURCING_REMOTE_CONTROL` | off | `on` enables backend‑driven scouting + the reel pipeline (agent mode). |
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

### Scouting rules (per campaign)

- `discovery: "reels"` — use the explore/scroll reel‑feed flow (watch + hear +
  occasionally engage); omit for the classic search → profile flow.
- `targetAudience` / `genres` — fed to the Gemini judge (audience fit + on‑brand genres).
- `reviewBorderline: true` (+ optional `reviewBand`, default `0.15`) — hold
  near‑threshold AI matches in the **review queue** instead of auto‑adding.

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

## Host setup: scrcpy (for audio capture)

`adb screenrecord` cannot capture audio, so the host needs **scrcpy 2.0+** on
`PATH` (Android **11+** for audio; 12+ works out of the box):

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
