# Track G — command palette follow-ups (Wave 3)

Sections: G1 (content-search path heuristic regression), G2 (palette first open).
Owned: contentSearchScheduler.ts, useRepositorySearch.ts, fileSearch.ts,
commandPaletteModule.ts, CommandPaletteHost.tsx, CommandPalette.tsx (shared with
Track E, Edit-only), boot.tsx (shared, one line, Edit-only), searchPreview.ts (+tests).

## G0 context read DONE
- plan (targets, P14-P20, G1, G2), wave1-feedback.md (Wave 2 section), wave2-startup.out.
- Baseline measured on the installed Wave 2 build: palette.openMs 89/100/103 ms,
  emptyRows 34, contentResultsMs 414/419/423, workspaceRenders 0.
- Probe reads `palette.emptyRows` one CDP round trip after the focused input
  (scripts/perf/startup-probe.mjs measurePalette) — relevant to G2(c).
- happy-dom has no `requestIdleCallback` (verified); `requestAnimationFrame` exists.

## G1 DONE
- `contentSearchScheduler.ts`: `CONTENT_SEARCH_PATH_PAUSE_MS` 400 -> 250;
  deleted `CONTENT_SEARCH_PATH_FILE_MATCHES`; `isPathLikeQuery(query)` is now
  `query.includes('/')` (one argument, no file-name-hit branch).
- `useRepositorySearch.ts`: dropped the `countFileNameMatches` memo; the effect
  computes `isPathLikeQuery(query)` inline, so `fileResults` identity no longer
  re-runs the content-search effect (it used to cancel + reschedule on it).
  Effect deps now `[cancelOutstanding, hasSnapshot, onError, query]`.
- `fileSearch.ts`: removed `countFileNameMatches` (only consumer was the above);
  one fewer per-keystroke scan over the ranked rows.
- Tests: `contentSearchScheduler.test.ts` pins `isPathLikeQuery('app') === false`,
  the medium (120 ms) debounce for 'app' and `CONTENT_SEARCH_PATH_PAUSE_MS === 250`;
  `useRepositorySearch.test.ts` adds a wiring test with six `src/app-*.ts` paths
  (five+ file-name hits, the old rule's trigger) asserting the ripgrep call is made
  inside 250 ms.
- Expected effect on the probe: 'app' = 3 chars typed -> 120 ms debounce + ~30 ms rg
  = ~150 ms `palette.contentResultsMs` (was 414-423).
- Gates: `bun run lint` PASS, `bun run typecheck` PASS,
  `bun test src/renderer/src/contentSearchScheduler.test.ts src/renderer/src/useRepositorySearch.test.ts src/renderer/src/fileSearch.test.ts` 33 pass / 0 fail,
  `bun test src/renderer/src/CommandPalette.dom.test.tsx src/renderer/src/CommandPaletteHost.dom.test.tsx src/renderer/src/reactCompiler.test.ts` 23 pass / 0 fail.
- Deviations: none. needs-owner: none.

## G2 DONE
Restart note: an earlier run of this agent wrote most of G2's code (host rAF handoff,
`warmFileSearchIndex`, `FIRST_PAINT_ROWS`) without logging it. This entry covers the
whole section, verified end to end in this run.

### (a) shell on the open frame, panel on the next — `CommandPaletteHost.tsx`
- `panelReady` state, `false` on every open; `useEffect` on `open` schedules one
  `requestAnimationFrame(() => setPanelReady(true))` and cancels it on close.
- Render: `open && (module == null || !panelReady)` -> `CommandPaletteShell`
  (focused `<input>`, `showModal()`, no CommandPalette import); afterwards the real
  `paletteModule.CommandPalette` with `initialQuery={pendingQuery}`.
- So the keydown task commits the shell and focuses the input whatever the panel
  would have cost; the panel's mount is on the following frame.

### (b) index built off the open path — `fileSearch.ts`, `CommandPaletteHost.tsx`, `boot.tsx`
- `createFileSearchIndex` keeps its one-slot cache keyed on `paths` array identity
  (`cachedIndexInput`), plus `indexBuilds` counter and `isFileSearchIndexWarm(paths)`.
- New `warmFileSearchIndex(paths)`: no-op when already warm, otherwise
  `requestIdleCallback(build, { timeout: 1_000 })` (falls back to `setTimeout(..,0)`
  where rIC is missing, e.g. happy-dom); returns the canceller so it doubles as an
  effect cleanup.
- Host: `useEffect(() => warmFileSearchIndex(snapshot?.paths), [snapshot?.paths])`
  — every snapshot the reader is already looking at is indexed before Cmd+P.
- boot.tsx (shared, Edit-only, one added line + comment): `warmFileSearchIndex(cachedPaint.snapshot?.paths)`
  after `createRoot().render()`. Verified the identity actually matches what the
  palette later sees: `preload/index.ts:55` parses `cachedWorkspace` once via
  `sendSync`, `initialWorkspacePaint` returns `cache.snapshot` by reference, and
  `App.tsx:568` reads it through `useState(() => initialWorkspacePaint(...))`, so
  boot's warm index is the one the host and palette hit.

### (c) staged rows — `CommandPalette.tsx` (shared with Track E, Edit-only)
- `FIRST_PAINT_ROWS = 12`; `rowsSettled` state set by one mount `requestAnimationFrame`.
- `visibleResults = rowsSettled || results.length <= 12 ? results : results.slice(0, 12)`;
  `groups`, `clampedIndex`, `activeAction`, `moveActive`, `trackPointer` and the
  `data-index` attributes all read `visibleResults`, so the keyboard can never land
  on a row that is not on screen.
- Row icons: only the rendered rows instantiate an icon, so the first commit pays
  12 icons instead of 34. Deviation: the `@pierre/icons` module itself is NOT
  dynamically imported — see Deviations.
- Track E's `onRevealDirectory` prop and its directory-row call are untouched and
  still covered by 'selecting a folder also reveals it in the explorer'.

### In-app open measure — `CommandPaletteHost.tsx`
- `PALETTE_OPEN_MEASURE = 'horus:palette-open-to-focus'`: `setVisibility(true)`
  records `performance.now()`, the shell's layout effect (after `focus()`) emits
  `performance.measure(...)`, clearing the previous entry so the buffer holds one.
- Rationale: `palette.openMs` in `scripts/perf/startup-probe.mjs` is
  `focused.at - openedAt` where `openedAt` is taken on the probe host BEFORE four
  awaited `Input.dispatchKeyEvent` round trips, and `focused.at` comes from a
  `waitFor` poll (3 ms sleep + a `Runtime.evaluate` round trip each). The Wave 2
  run recorded `pollRoundTripMaxMs` 44-67 ms, so a large share of the 89-103 ms is
  CDP, not the app. This mark is the app-only half. Matches the existing
  `horus:*` user-timing convention (`startupMetrics.ts:16`).

### Tests
- `CommandPaletteHost.dom.test.tsx`:
  - 'the open frame looks the index up and leaves the panel to the next one' —
    waits for `isFileSearchIndexWarm(snapshot.paths)`, snapshots `fileSearchIndexBuilds()`
    and `window.__horusMetrics.workspaceRenders`, calls `open()`, then asserts the
    input is focused, the index builder did NOT run, no `.command-palette-results button`
    exists on the open frame, and the workspace sibling did not re-render; then
    waits for the panel and re-asserts both counters.
  - 'opening records how long the app took to focus the input' — one
    `horus:palette-open-to-focus` entry with a non-negative duration.
  - `WorkspaceStandIn` hoisted above its first use; `afterEach` clears the measure.
- `CommandPalette.dom.test.tsx`: 'paints one screenful of rows first and the rest a
  frame later' — 30-path snapshot, 12 rows synchronously, `.primary-result` is
  `data-index="0"` (on screen), more than 12 rows after a frame.

### Gates
- `bun run lint` PASS (oxlint src, no output).
- `bun run typecheck` PASS (tsc -b tsconfig.json, no output).
- `bun test src/renderer/src/CommandPaletteHost.dom.test.tsx src/renderer/src/CommandPalette.dom.test.tsx src/renderer/src/fileSearch.test.ts src/renderer/src/useRepositorySearch.test.ts src/renderer/src/contentSearchScheduler.test.ts src/renderer/src/reactCompiler.test.ts src/renderer/src/boot.dom.test.tsx src/renderer/src/searchPreview.test.ts src/renderer/src/paletteCommands.test.ts`
  -> 76 pass / 0 fail, 171 expect() calls.
- `npx react-doctor@latest --verbose` -> 30 warnings (Bugs 6, Performance 4,
  Maintainability 19, Accessibility 1); score still not computed (lint/maintainability
  analysis incomplete — pre-existing, P13 owns it). The only warning in a file I
  touched is the pre-existing `no-giant-component` on `CommandPalette.tsx:172`
  (the plan's P13 table lists it at :148). No new warnings.
- `bun run build` NOT run (Track F builds at the end, per the brief).

### Deviations
- 'lazy-load row icons' implemented as "only visible rows instantiate icons"
  rather than a dynamic `import('@pierre/icons')`. The icon module lives in the
  palette chunk, which boot already preloads and which is resident before Cmd+P;
  a dynamic import would either paint the first 12 rows iconless or reintroduce a
  Suspense boundary on the open path. The 12-row staging removes the same work.
- The dom test asserts "no index build and no rows on the open frame" via the
  `fileSearchIndexBuilds()` counter rather than `mock.module` on `createFileSearchIndex`.
  Bun cannot intercept a same-module import the way the brief's "mock the heavy
  index builder" implies, and the counter is the stronger assertion (it also
  catches a build made through any other caller).

### needs-owner (scripts/perf/startup-probe.mjs — Track B / the reviewer owns scripts/**)
1. Report the app-only open cost next to the CDP one. In `measurePalette`, after
   `palette.openMs = focused.at - openedAt`, add:
       palette.openAppMs = await cdp.tryEval(
         `performance.getEntriesByName('horus:palette-open-to-focus')[0]?.duration ?? null`
       )
       palette.openPollRoundTripMs = focused.maxRoundTripMs
   and add `paletteOpenAppMs: median(samples.map((s) => s.palette?.openAppMs))` to
   the `summary` object plus `paletteOpenAppMs: samples.map((s) => s.palette?.openAppMs)`
   to the `PERF` metrics block. Without this, G2 cannot be judged against the
   <= 30 ms target: the probe's own key dispatch + poll round trips are tens of ms.
2. `palette.emptyRows` is now read one CDP round trip after the focused poll, while
   the panel mounts a frame later and fills to 34 rows a frame after that (~32 ms
   total). At the Wave 2 round-trip costs it still reads 34, but if the round trip
   gets cheap it could read 0 or 12. Make it wait instead of sampling:
       const rows = await cdp.waitFor(
         `(() => { const n = document.querySelectorAll('.command-palette-results button').length; return n > 0 ? n : null })()`,
         500,
         3
       )
       palette.emptyRows = rows.value ?? 0

## Track G final gate run
- `bun run lint` PASS; `bun run typecheck` PASS.
- `bun test src/renderer/src/` -> 598 pass / 0 fail, 1702 expect() calls, 98 files
  (whole renderer suite, so Track C's palette tests and every other renderer test
  are green alongside G1 + G2).
- Plan status table updated in place: G1 DONE, G2 DONE (two rows only, Edit-only).
- Both sections still need a probe run on a freshly installed build to confirm the
  numbers; see the two needs-owner items above before that run.
