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

Everything degrades gracefully: with no `GEMINI_API_KEY` (or when a Gemini call
fails) the judge falls back to **Claude on the profile screenshots and captions**
— the same structured verdict, so the quality bar, originality and brand safety
still run, with the hook left unmeasured because nothing watched a video — then
to a bare Claude niche score, then keyword scoring. The fraud checks (bought
views, an unengaged following, one-outlier reach) are arithmetic and run
whatever judged the creator. A creator **no** model could analyse is held in the
review queue rather than added (`reviewUnjudged`, below). The Scout page shows a
banner when Gemini or both judges are missing, and every run records which judge
gave each verdict (`stats.judgedBy`).

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
| `GEMINI_MEDIA_RESOLUTION` | `low` | `low` (cheapest) / `medium` / `high` / `off`. Not every model accepts this field — one that doesn't answers with a bare `400 INVALID_ARGUMENT` naming no field. The client probes once, retries without it, and then stops sending it; `off` skips the probe. |
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
  occasionally engage); omit for the classic search → profile flow. The feed
  navigator opens each creator's profile and reads their Reels grid, so a
  reels‑mode candidate normally gets the full deterministic rules like any other.
  Only one whose reach could **not** be read is judged on the niche match alone
  and **routed to the review queue** for a human to confirm reach.
- `targetAudience` / `genres` — fed to the Gemini judge (audience fit + on‑brand genres).
- `reviewBorderline: true` — hold **near‑threshold** passers in the **review
  queue** instead of auto‑adding. Near either threshold that can reject: a
  weighted quality score within `reviewScoreBand` (default `0.05`) of
  `creatorPassThreshold` (default `0.52`), or a niche score within `reviewBand`
  (default `0.15`) of `nicheThreshold` (default `0.1`). The reason is stored on
  the candidate (`evidence.reviewHold`) and shown in the review queue.
- `reviewUnjudged` (default **on**) — a creator no model could analyse (no
  Gemini, no Claude, or every call failed) never had the quality bar,
  originality or brand safety checked, so they are held for review rather than
  added on the reach and keyword rules alone. `reviewUnjudged: false` restores
  adding them.
- `reelsWindow` (default `12`) — how many recent reels are read. A creator needs
  `min(6, reelsWindow)` reels with readable views: the minimum never exceeds the
  window the run was asked to read.

Saving from the Scout page **merges** into the stored defaults
(`PATCH /api/sourcing/config/:campaignId`): keys the page sends replace the
stored ones, a key sent as `null` is removed, and settings the page does not show
(`targetAudience`, `genres`, `creatorWeights`, the engagement floors,
`avoidExamples`, `enabled`, …) survive a save instead of being wiped by it.

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

### Per-campaign scoring

`creatorScore` blends six components — `brandFit` (0.25), `fit` (0.20),
`creativity` (0.20), `hook` (0.15), `nicheConsistency` (0.10) and
`viewSteadiness` (0.10) by default. A skincare brand is buying production
quality, a meme brand is buying the hook, a B2B brand is buying audience fit, so
the blend is per campaign:

```json
{ "creatorWeights": { "hook": 3, "creativity": 2, "fit": 1 },
  "creatorPassThreshold": 0.65,
  "maxViewSpike": 40 }
```

Weights are relative, not required to sum to 1 — `{fit: 2, hook: 1}` means
exactly what it looks like. Unknown keys are dropped rather than diluting the
real ones, and an absent `creatorWeights` uses the defaults. (`maxViewSpike`
defaults to `12`; the `40` above is an example of a campaign loosening it.)

`creatorPassThreshold` — the **quality bar** — defaults to **0.52** (the
Scout page's *Quality bar* field). At 0.52 a creator the judge calls
"competent" across the board (≈0.58) is shortlisted and one it calls
"derivative" throughout (≈0.31) is not; the hard rejects apply whatever the
score. It was 0.72 until lowered: at that bar only creators judged
"distinctive" on most components cleared it. Campaigns whose saved defaults
still carried the old 0.72 were moved to 0.52 once, on the first boot after the
change (`data_migrations` row `quality-bar-0.72-to-0.52`); any other saved value
was left as set.

A component that was not measured — `null` or absent — drops out of the blend
and its weight goes to the rest. It is never scored as `0`: an explicit `null`
used to count as a zero, which capped every creator on a campaign with no brand
details at 0.75.

There is **no follower band**. Reach is what a campaign buys and `floor` /
`ceiling` gate on it directly; a band on followers only ever rejected creators
whose reach we had already measured and liked.

### Surviving a deploy, and a long skip streak

The command channel is **in-memory**, so every backend restart empties it. A pull
for a host with no session state therefore reports `done: true` — there is no
session, which is exactly what `done` means. Reporting `done: false` wedged the
agent permanently: it stayed inside `serveSession` pulling against a backend that
had forgotten it, never returned to claim the next run, and the phone polled into
the void until someone reopened the app. This fired on **every deploy**.

A run's freshness is `updated_at`, which only moves when a candidate is *yielded*.
Dedupe means a re-run can legitimately yield nothing for a long stretch, and a few
hundred cheap skips is fifteen minutes of correct work — the sweeper's definition
of a dead run. The navigator now calls a throttled `heartbeat` (at most once a
minute, via `sourcingStore.touchRun`, scoped to `status = 'running'` so it can
never resurrect a stopped run) while it skips.

Keyword depth is persisted per `(campaign, term)` in `sourcing_keyword_depth`, so
a re-run resumes where the last one stopped instead of re-reading the top of every
results page — which, with dedupe on, is the part guaranteed to yield nobody.

### Rate limits

`429`/`500`/`502`/`503`/`504` are retried with exponential backoff and jitter,
honouring `Retry-After` when Google sends it (`GEMINI_MAX_ATTEMPTS`, default 3).
A `400` is *our* request being wrong and is never retried. Without this a quota
blip returned `null`, and null is indistinguishable downstream from "the model
found this creator unremarkable" — so throttling silently dropped creators to
keyword scoring. Reels mode judges a batch at a time, so throttling arrives in
bursts and takes several creators with it.

### Measuring whether any of this works

Every threshold, weight and prompt here was tuned against an intuition about
quality that nothing measured. `GET /api/sourcing/metrics?campaignId=…` is the
measurement — the funnel is already in the database, it had just never been read
end to end:

| Number | What it means |
| --- | --- |
| `yieldRate` | of everything scanned, how much was worth contacting |
| `contactRate` / `replyRate` | how far the added creators actually got |
| `overturnRate` | of the creators the **rules** added alone, how many a human then rejected — the false-positive rate, and the number to drive down |
| `reviewApprovalRate` | how often the human agreed with the review queue. **Not "higher is better"**: near 100% means the queue is asking about creators the rules should have added themselves; near 0% means ones they should have rejected. Either way the human is doing the gate's work. |
| `keywords[]` | per-keyword added / contacted / replied, ranked by replies — a keyword that sources twenty creators nobody answers is worse than one that sources three who do |

### The golden set

`services/goldenSet.js` replays hand-labelled creators through the real gate
offline — no phone, no Instagram, no Gemini, no database, because `scoreCreator`
is a pure function of numbers already gathered. 20–30 labelled creators per
campaign is what stops a change that fixes one brand from quietly ruining
another.

`caseFromCandidate(row, 'add' | 'reject')` builds a case straight off a stored
candidate, so a set costs nothing but the labelling. `runGoldenSet` reports
**false adds and false rejects separately** — they cost differently (a false add
wastes an outreach; a false reject is a creator silently never seen again), and a
single accuracy number would hide the trade. `compareConfigs(cases, before, after)`
answers the question a tuning session is really asking: is this better, and which
creators did it cost.

### Engagement: a real audience vs a bought one

Reach alone cannot tell these apart — views can be bought, and a repost farm's
numbers look like a creator's until you ask how many people reacted. Likes and
comments are read off the **reel player** (the only screen that carries them; the
grid carries views, the profile carries followers) and scored as
`(likes + comments) / followers`.

`minEngagementRate` defaults to **1%**, deliberately forgiving: genuine large
accounts sit at 1–3%, and this is a hard reject on a creator we may never look at
again, so it is set to catch the obviously-bought rather than to sort average
from good. An unread count is **unmeasured, not zero** — a creator whose counts
we could not read is judged on everything else.

These checks — bought views (`minViewEngagementRate`, 0.5% of views), an
unengaged following (`minEngagementRate`) and one-outlier reach
(`maxViewSpike`) — are arithmetic on counts read off the screen, so they run
**whether or not a model analysed the creator** (`creatorScore.checkReach`).
They used to live only inside the AI gate, which let a creator the judge could
not analyse be added on bought reach.

### Taste a brand can state up front

`nicheCalibration` learns from approve/reject history — which a brand-new
campaign does not have, and its first runs are exactly the ones whose output
trains everything after them. So a campaign can also just say it:

```json
{ "idealExamples": ["home-gym coaches who film themselves mid-set"],
  "avoidExamples": ["gym meme repost pages", "supplement affiliate spammers"] }
```

Free text on purpose: these describe a *kind* of creator, which is what a
threshold cannot express. Additive to the learned examples, never a replacement.

### Never scouting the same creator twice

A creator this campaign has already looked at — added, rejected, in review, or
merely seen — is skipped. `sourcingStore.scoutedHandles` loads them at run start
and seeds the navigator's memory, so it outlives the run rather than resetting
with it.

The check also happens at the **first moment the handle is knowable**: one card
tap and one screen read into the reel player, before the recording, the profile
hop, the grid scroll and the multimodal call. The unique index on
`(campaign_id, lower(username))` always caught the duplicate, but it caught it at
persist time — after everything it cost had been spent. Overlapping keywords hit
this constantly, because the same popular accounts head the results for all of
them.

### Reels mode judges the creator, not just the reel

Reels mode judges *inside* the navigator (the analysis queue keeps the phone
scrolling while the model thinks), which makes two things easy to get wrong, and
both were:

- **The judge is built from the config handed to `scoutReels`**, so that object
  is the whole campaign config, not just pacing/clipSeconds. With only the
  mechanical knobs the prompt carried no niche, no keywords and no product — the
  model said exactly that back (*"No information provided about target niche,
  campaign keywords"*) and returned a neutral `0.50` for every creator scanned.
- **The feed reel is judged before the profile is opened**, to have a score ready
  in case engagement is on. That early verdict must NOT be pinned as the final
  one: it saw a single clip and a caption, with no bio, no reach window and no
  screenshots. Once the profile visit produces reach or pictures, the verdict is
  re-made downstream from the whole bundle, and the feed-reel verdict is kept
  alongside as `evidence.feedReelVerdict`.

### Briefing the judge on the brand, before it sees the creator

The question that decides whether an outreach is worth sending is not "is this
creator in the right niche" — it is **"could this creator put this product in one
of their own reels and have it look native rather than bought"**. Those are
different questions, and only the second predicts whether a collaboration works.

Order matters, so the brand goes in as a labelled brief **ahead of anything about
the creator**. Asked "does this creator fit?" with the brand described afterwards,
a model reasons outwards from the creator and finds a way to make almost anyone
fit; given the brand first, it has something concrete to measure against and
"no" becomes an available answer.

Three fields on the Scout Creators page feed it:

| Field | What it is for |
| --- | --- |
| **Brand name** | Who is buying. |
| **What you're selling** | The product, in one line. |
| **Brand & product details** | The room to say what a one-liner cannot: positioning, price tier, who it is for, what a natural mention looks like, and what would read as an ad. |

It renders as:

```
── THE BRAND ─────────────────────────────
Brand: Velo Running
What they sell: a carbon-plate racing shoe
About the brand and product:
A GBP 280 shoe from a small running label. Buyers are amateur marathoners
chasing a sub-4 time. It fits a training-block vlog or a race recap; it would
look bought in a generic gym-gear haul.
Who they want to reach: amateur marathoners 25-40

BRAND FIT — could THIS creator feature the product above in one of their own
reels and have it look native rather than a paid read? …
```

The answer lands in `brand_fit`, which carries the **largest single weight** in
`creatorScore`, plus a `brand_fit_reason` you can read in the review queue. A
creator in the right niche who could not plausibly hold the product scores low —
which is the whole point.

A campaign that filled none of this in sends **no brand block and no fit
question** rather than a block of "(unspecified)": nothing to measure against is
better handled by silence than by asking the model to guess. The response
template then leaves `brand_fit` out too (a model fills in every field it is
handed), any brand fit that comes back anyway is dropped, and the score treats
brand fit as **unmeasured** — its weight goes to the other components.

### How long the judge watches, and what it does with it

`clipSeconds` defaults to **12** and is **floored at 12** — a smaller configured
value is raised rather than honoured. Twelve seconds at 1 fps is twelve frames
plus the audio track: enough to see the subject, hear the delivery and read the
room. Below that the judge is guessing from a thumbnail with a soundtrack, which
is the failure the video exists to prevent. The recorder's own ceiling is 60s.

The judge is asked to **describe the reel before it scores anything** —
`video_description` is the first field in the schema and is required. A
judgement made without first saying what the reel actually *is* tends to fall
back on the caption and the handle, which is the mistake the whole video pipeline
exists to avoid. The description is kept on the verdict
(`evidence.videoDescription`) so a reviewer can check the score against the video
rather than taking the number on trust.

Only then does it weigh the **videos, the bio screenshot and the captions
together** against the campaign's brand brief, product, keywords and niche.

**Every reel recorded for the creator goes to the judge**, in the same single
call: up to `clipsPerProfile` (default 3) — their best performers plus a typical
one — so the judge can compare their best work with their everyday work. Only
the single best used to be sent; the other recordings were paid for on the phone
and never watched. Clips are included best-first while they fit Gemini's inline
request limit, and `evidence.niche.evidenceUsed` records `videos` (watched)
against `videosRecorded`.

> **If reels seem to flash past unwatched**, the recording is failing rather than
> running short. Both paths log
> `recording failed — judging without video: <cause>`.

### Knowing whether the judge ever saw a video

A run can judge every creator on bio text alone and still look completely normal
from the outside. Four separate things had to be fixed before that was visible:

1. **`log` never reached `analyseProfile`.** All three call sites left it
   defaulted to a no-op, so in profiles mode the recording-failure line — and the
   `not recording` line before it — went nowhere. The log was silent no matter
   what the phone did.
2. **A recording could come back empty without throwing.** The agent's
   `uploadClip` ends in `optString("clipId", "")`, so a failed upload returned an
   empty id; the backend's `rec.clipId || rec` then looked the whole *result
   object* up in the clip store, missed, and judged without video in silence.
   `resolveClip` now returns a reason for every no-video outcome, and the agent
   refuses to report success for an upload that produced no id.
3. **Nothing counted it.** `evidence.clipCaptured` was written and never read.
   The run summary now ends with
   `judged=<n> withVideo=<n> withoutVideo=<n>`, counting only creators who
   actually reached the model — a creator rejected on reach was never recorded
   *by design*, so counting them would make a healthy run look broken.
4. **Screen capture is not a permission that stays granted.** MediaProjection is
   a per-session consent; Android ends it when the cast notification is
   dismissed or the service is restarted, and `onStop()` then nulls the recorder.
   A phone whose operator correctly remembers granting it reported itself as
   never granted. The agent now distinguishes the two:
   *"screen capture was granted but Android has since stopped it"* means re-grant
   it; *"has not been granted"* means grant it for the first time.

**`withVideo=0` on a run that judged anyone at all** means no recording reached
the judge, whatever the phone appeared to be doing on screen. The Scout page's
run card shows the same number (*Judged with video*), in red at zero, next to
*Judged by* — which judge gave each verdict (`stats.judgedBy`). Screen capture is
needed in **both** discovery modes: profiles mode records from each creator's
grid too.

### The navigator gets the whole campaign config

Profiles mode used to forward seven mechanical knobs (pacing, jitter, clip
length…) and nothing else, because the orchestrator does the judging. The
navigator has since grown gates of its own, and all of them were reading
`undefined`: the on-device prefilter (no floor, ceiling or risk shape, so it
rejected nobody and recorded a clip for creators the orchestrator was about to
reject on reach a moment later), `prescreenNiche` (never switched on for any
campaign that asked), and the early reach reject. Both modes now spread the full
config, with session-resolved mechanical values still winning.

### Keyword depth is bounded

Depth persists per `(campaign, term)` so a re-run resumes instead of re-reading
the top of a results page. It is capped at **8 screens**, and resets to 0 when a
keyword reaches the end of its results. Unbounded it compounded — the number grew
on every visit of every run, so run 20 opened by swiping twenty screens per
keyword before scouting anybody, and eventually a whole run was spent scrolling.
A value stored before the cap existed is clamped on the way in.

### What the judge actually sees

A creator is judged from an **evidence bundle**, in one multimodal call:

| Evidence | Where it comes from |
| --- | --- |
| **Their reels** (video **+ audio**) | Recorded from the creator's own Reels grid **after** the reach gates pass: their best performers plus a typical one (`clipsPerProfile`, default 3). In reels mode, the reel the feed served. Each is labelled to the judge by where it came from and its view count — the keyword that surfaced the creator is stated separately (*Found via*), never passed off as the video. |
| **A screenshot of the bio** | Taken on the profile header before navigating away. |
| **A screenshot of the reels grid** | Taken at the top of the Reels tab — their most recent work, with view counts. |
| **Caption text + reach** | Read off the grid (`reelsWindow` reels), plus followers and the lowest / typical / highest view counts. |

The pictures are what text cannot give: whether the grid is a person on camera or
a wall of reposted memes, and whether the bio reads like a real creator. The
verdict lands on `sourced_candidates.evidence.niche`, including `evidenceUsed`
(what was actually present, and how many of the recorded reels were watched), so
a thin judgement is visible as a thin one in the review queue.

When the navigator captured no screenshots (an older host), it falls back to
judging the recorded clips individually; with no Gemini verdict at all, to
Claude on the screenshots and captions (structured, so the gate still runs),
then to a bare Claude niche score, then to keyword scoring — the pipeline always
degrades rather than stalling.

> A phone answers `screenshot` with the PNG inline as base64, which clears 1 MB
> routinely, so `/api/sourcing/hosts/:id/commands/result` parses at a 12 MB limit
> (the global JSON limit stays 1 MB). Under the smaller limit the result 413s and
> the navigator waits out a 30-second command timeout on every profile.

### Search flow: reels first

For a keyword the navigator scouts the **reels grid** IG returns, taps a card to
reach the full‑screen player, reads the real `@handle` there, and opens that
creator's profile. A reel proves the creator is actively posting the content you
searched for; an "Accounts" row only proves the handle matched the string. The
Accounts list is used as a fallback, and only when the reels path found nothing,
so one keyword is never scouted twice.

### Review queue

A creator who passed every rule gets `decision = "review"` instead of being
added when:

- their reach could not be read (a reel off the feed whose grid never loaded);
- no model analysed them (`reviewUnjudged`, on by default); or
- `reviewBorderline` is on and they are near a threshold — a quality score
  within `reviewScoreBand` (0.05) of the quality bar, or a niche score within
  `reviewBand` (0.15) of the niche floor.

The reason is stored as `evidence.reviewHold` and shown in the **Held because**
column. Admins approve/reject from the **Pending review** card on the Scout
Creators page (`GET /api/sourcing/review`,
`POST /api/sourcing/candidates/:id/approve|reject`); the quality score and the
judge's reasoning (genre / audience / why) are shown inline.

Every rejection carries its reason — including the gate's own (`not an original
creator`, `below the fit threshold`, `… views look bought`), which used to be
saved blank and counted as `unknown` in `stats.byReason`.

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
