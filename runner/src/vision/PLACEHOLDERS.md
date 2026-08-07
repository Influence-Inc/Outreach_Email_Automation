# Vision surface — how the screen reader works now

The Instagram Navigator (`../navigator/instagram.js`) is driver-agnostic on
purpose. It never hard-codes on-screen coordinates — every tap decision goes
through `ScreenReader.read(screenshot)`, the vision layer that turns a phone
screen into structured data:

```js
{
  screen: 'search' | 'search_results' | 'profile' | 'reels_tab' | 'unknown',
  targets: {
    // pixel coordinates the navigator taps. Only the fields relevant to the
    // current screen need to be present.
    searchTab?:  { x, y },
    searchBox?:  { x, y },
    back?:       { x, y },
    reelsTab?:   { x, y },
    'result:<handle>'?: { x, y },   // one per search-result row
  },
  results?: string[],               // ordered @handles on a results screen
  fullName?, followers?, bio?,      // profile header
  reels?: Array<{ views: number, caption? }>,   // reels tab overlays
}
```

## Where the interpretation lives (server-side)

Two readers implement the contract:

- **`MockScreenReader`** (`../navigator/screenReader.js`) — pattern-matches a
  canned `screenName`. Used by the unit tests + `RUNNER_DRIVER=mock`.
- **`RealScreenReader`** (`./RealScreenReader.js`) — the production reader for
  `RUNNER_DRIVER=android`. It is a **thin client**: it captures the phone's UI
  tree (`driver.dumpUi()` → `adb shell uiautomator dump`) plus the device pixel
  size, and POSTs them to the Deal Studio backend
  (`POST /api/sourcing/vision/read`). The backend
  (`backend/src/services/screenVision.js`) does all the interpretation and
  returns the shape above.

Interpretation runs **on the backend** so scouting logic ships by deploying Deal
Studio — the paired host never needs a code update. The abstract `ScreenReader`
stub that used to `throw 'not implemented'` is gone from the real path.

## Why the UI tree instead of pixel-guessing a vision model

`uiautomator` bounds are **exact and deterministic**, so taps land where they
should instead of where a model estimated a pixel. Accessibility labels
("Search", "Reels", "Back") are far more stable across Instagram releases than
resource-ids or coordinates. A screenshot can still be handed to a vision model
in a later phase to enrich screens the tree can't fully resolve (that's what the
optional `image` field on the endpoint is reserved for), but the Phase‑1 reader
reads purely from the element tree.

## Calibrating the match signals against a real device

The classification + target signals live in `SIGNALS` and the extractors in
`backend/src/services/screenVision.js`. They match on resource-id suffixes and
accessibility labels that are *plausible* for current Instagram but need a
one-time confirmation against the real app:

1. On a paired phone, dump a few screens and eyeball the attributes:
   ```bash
   adb shell uiautomator dump /sdcard/window_dump.xml && adb exec-out cat /sdcard/window_dump.xml
   ```
   Do this on: a typed **search results** screen, a **profile** header, and the
   **reels tab**.
2. If a target comes back missing or wrong, add/adjust the resource-id or label
   in `SIGNALS` (navigation targets) or the extractor heuristics (results,
   profile fields, reel view counts). These are just strings — no navigator or
   driver change needed.
3. Add the real values as a fixture case in
   `backend/src/services/screenVision.test.js` so the reader is locked against
   future Instagram UI drift.

Because the reader **degrades to `screen: 'unknown'`** (never throws) when it
can't classify, a mis-calibrated signal makes the navigator fall back to a
hardware Back / a human take-over via the live mirror — it doesn't crash the
standing run.

## Failure modes the reader already guards

- **Abbreviated counts** ("23.4K", "1.2M") are parsed through
  `sourcingFilters.parseCount()` so the same normalization runs everywhere.
- **Ambiguous reel thumbnails** — only cleanly-read view counts are returned;
  the scoring rules gate on `reels.length >= minReels`.
- **Light/dark mode + font size** — irrelevant to the UI tree (text/desc are
  theme-independent), unlike OCR.
- **Suspicious-activity / login walls** — no known signals match, so the reader
  returns `screen: 'unknown'` and the navigator/human recover.

## Non-goals

- **Do NOT** try to read per-reel captions off the reels-tab thumbnails —
  captions only appear after opening a reel. If Rule 3 needs per-reel captions,
  that's a separate "open a reel" flow, kept best-effort per the spec.
- **Do NOT** infer growth trends in the reader — `sourcingFilters.growthTrend`
  does that from the reported view window.
