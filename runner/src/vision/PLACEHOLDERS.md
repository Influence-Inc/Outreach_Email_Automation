# Vision surface — what `ScreenReader.read()` must return

The Instagram Navigator (`../navigator/instagram.js`) is driver-agnostic on
purpose. It never hard-codes on-screen coordinates — every tap decision goes
through `ScreenReader.read(screenshot)`, which is the vision layer that turns
a phone screenshot into structured data:

```js
// screen classification + tap-target coordinates + captured data
{
  screen: 'search' | 'search_results' | 'profile' | 'reels_tab' | 'unknown',
  targets: {
    // pixel coordinates the navigator will tap. Only the fields relevant to
    // the current screen need to be present.
    searchTab?:  { x, y },
    searchBox?:  { x, y },
    back?:       { x, y },
    reelsTab?:   { x, y },
    'result:<handle>'?: { x, y },   // one per search-result row
  },
  // Populated on 'search_results'
  results?: string[],               // ordered @handles visible on the results screen
  // Populated on 'profile'
  fullName?: string | null,
  followers?: number | null,
  bio?: string | null,
  // Populated on 'reels_tab'
  reels?: Array<{ views: number, likes?: number, comments?: number, caption?: string }>,
}
```

The **mock** driver ships with a `MockScreenReader` (in `../navigator/screenReader.js`)
that pattern-matches on a canned `screenName` field. That is what the unit
tests + `RUNNER_DRIVER=mock` use.

The **real** Android / iOS drivers are wired to the abstract `ScreenReader`
stub — `read()` throws `not implemented` — *by design*. Nothing about the
real Instagram UI is guessed from a specification; we build the real reader
against actual screenshots. `runner/src/diagnose.js` catches this exact error
and prints an actionable "capture screens and share them" hint.

## When Track D lands screenshots

The plan for Track D step 8: capture three PNGs off the phone with
`adb exec-out screencap -p > screen-N.png` and ship them:

- **screen-1-search-results.png** — after typing a keyword in Search; whatever
  the top ~5 accounts row looks like now.
- **screen-2-profile.png** — after tapping one of those accounts; header with
  handle / bio / followers / the tab strip (Grid | Reels | Tagged).
- **screen-3-reels-tab.png** — Reels tab, so the ▷ view-count overlay on each
  reel thumbnail is visible.

With those three, the follow-up work is:

1. **Choose the vision strategy.** Two viable paths:
   - **Claude vision** via `backend/src/services/claudeClient.js` `callClaudeMessages`
     — send the screenshot + a JSON-strict prompt asking for the structured
     shape above. Highest fidelity for bio/captions; costs an API call per
     screen; the backend already loads `@anthropic-ai/sdk` so no new dep.
   - **Local OCR + heuristics** (Tesseract or `@nut-tree/nut-js`) — cheaper
     per screen, no API dependency, more brittle when IG changes the layout.
   Recommendation: Claude vision for the first cut, revisit later if per-run
     cost is a concern.
2. **Implement `RealScreenReader`** in this directory (`vision/RealScreenReader.js`)
   with `read(shot)` → the shape above.
3. **Wire it into `../index.js`** — replace the `ScreenReader` stub used for
   `android` / `ios` drivers with `RealScreenReader`.
4. **Add a fixture test** — decode each of the three real screenshots into
   the structured shape and assert the values; that's how we lock the reader
   against future IG UI drift.

## Failure modes to guard against in the real reader

- **Abbreviated counts.** IG shows "23.4K", "1.2M" — always parse through
  `backend/src/services/sourcingFilters.js` `parseCount()` (already exported)
  so the same numeric normalization runs everywhere.
- **Ambiguous reel thumbnails.** Some thumbnails don't show a view count
  (photo posts on the Reels tab if IG mixes them; older reels with the
  overlay hidden). The reader must return only the *reels* it read cleanly
  and let the scoring rules gate on `reels.length >= minReels`.
- **Light/dark mode + system font size.** IG on a personal phone can be in
  either theme. The reader must handle both. If Claude vision is used, this
  is essentially free; for OCR it needs two calibrations.
- **Suspicious-activity / login walls.** When IG throws one of these the
  screen won't match any known classification. `screen: 'unknown'` is the
  correct return; the navigator's `back` gesture then falls back to a
  hardware Back and the live-mirror + take-over feature (Phase 3c) lets an
  admin resolve it manually.

## Non-goals for the vision reader

- **Do NOT** try to read individual reel captions off the Reels tab thumbnail
  overlay — captions only show after opening a reel. If Rule 3 (caption keyword
  relevance) needs per-reel captions, that's a separate "open a reel" flow
  costed at 12x per candidate; keep it best-effort per the spec.
- **Do NOT** interpret follower counts as anything but display integers —
  IG rounds/truncates aggressively.
- **Do NOT** infer growth trends from the visible reels — the scoring rules
  (`sourcingFilters.growthTrend`) do that already; the reader just reports
  what's on screen.
