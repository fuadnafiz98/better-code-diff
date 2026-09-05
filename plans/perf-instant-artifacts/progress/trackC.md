# Track C — command palette and renderer render hygiene

Sections in order: P14, P15, P16, P17 (renderer half), P18, P19, P20, P10-N1, P09-N1.

## Baseline read (start of run)
- No prior trackC.md: fresh start, nothing to resume.
- Wave 1 landed: boot.tsx renders before preloads; workspaceBoot.ts is the module-store
  pattern to copy; GitHubMarkdownContent.tsx has a lazy renderer + inline-styled fallback
  (P09-N1); AppView.tsx still owns Welcome (P10-N1).
- Palette today: App.tsx `lazy(CommandPaletteController)` + Suspense + useCommandPaletteLoader
  (idle warm + Meta-key warm); useRepositorySearch lives in AppLayout.

## NOTE from reviewer (2026-09-05 14:31): previous Track C run died on a rate limit after creating
src/renderer/src/commandPaletteModule.ts and src/renderer/src/CommandPaletteHost.tsx (P14 in progress; App.tsx not yet changed). Verify those two files, finish P14, then continue.

## Resume 2026-09-05 (run 2)
- Verified the two files the dead run left: `commandPaletteModule.ts` (module store, complete)
  and `CommandPaletteHost.tsx` (shell + host, references `CommandPaletteControllerProps` which
  CommandPalette.tsx does not export yet). App.tsx/boot.tsx untouched. P14 resumes from there.
- Survey: `reviewMetrics.ts` already has `markRepositoryWorkspaceRender`/`workspaceRenders`;
  `RepositoryWorkspace.tsx:1298` calls it in an effect. `window.__horusMetrics` not exposed yet.
- `contentSearch` reaches DiffSurface through RepositoryWorkspace (props at :217 :641 :847 :946
  :1290 :1527). Track C may not edit those, so DiffSurface will read searchResultsStore and keep
  the prop as an override. needs-owner recorded under P15.

## P14 DONE
- `src/renderer/src/CommandPalette.tsx`: `CommandPaletteController` (lazy + ref-driven open state)
  deleted; the file now exports a plain `CommandPalette` panel that is open while mounted, plus
  `CommandPaletteProps` with a new `initialQuery`. A `useEffectEvent` mount effect replays the
  shell's query through `onQueryChange` so the search the reader started actually runs.
- `src/renderer/src/commandPaletteModule.ts` (from the dead run, kept): useSyncExternalStore module
  store, `loadCommandPalette()` / `useCommandPaletteModule()`.
- `src/renderer/src/CommandPaletteHost.tsx`: owns visibility + `CommandPaletteHandle`; renders
  `CommandPaletteShell` (dialog + focused input, imports nothing from CommandPalette.tsx) until the
  module store resolves, then the real panel with `initialQuery`. React 19 `ref` prop, not
  `forwardRef`. `setVisibility` is a `useCallback` reading `onError`/`onQueryChange` through refs so
  `useImperativeHandle` has no exhaustive-deps warning.
- `src/renderer/src/App.tsx`: `lazy(CommandPalette)`, `Suspense`, `preloadCommandPalette`,
  `useCommandPaletteLoader`, the `requestIdleCallback` warm effect and the `event.key === 'Meta'`
  hover/keydown warm are all gone. New `useCommandPaletteControls()` returns `{ref, close, open,
  toggle}`. `AppLayoutProps.commandPaletteMounted`/`setCommandPaletteHandle` removed;
  `WorkspaceLayoutProps` now omits `commandPaletteRef`, so the palette ref no longer flows into the
  workspace subtree.
- `src/renderer/src/boot.tsx` (shared, Edit-only for the second hunk): `void loadCommandPalette()`
  right after `createRoot().render()`.
- Tests: `CommandPalette.dom.test.tsx` rewritten around a `PaletteHarness` that unmounts on close
  (8 tests, incl. a new "adopts the query the shell collected"); new
  `CommandPaletteHost.dom.test.tsx` (shell-first open with focus + query handoff; toggle/close).
- Gates: `bun run lint` clean; `bun run typecheck` clean (one transient failure in src/main/index.ts
  from Track D, green after a 45 s wait); `bun test CommandPalette.dom CommandPaletteHost.dom
  boot.dom App.dom useRepositorySearch` -> 14 pass / 0 fail.
- Deviations: the plan said "render module.CommandPaletteController"; keeping a second ref-driven
  controller inside the chunk would have duplicated the host's job, so the chunk exports the panel
  and the host owns open/closed. Same observable behaviour, one owner.
- needs-owner: none.

## P15 DONE
- New `src/renderer/src/searchResultsStore.ts`: `{query, results}` module store with a frozen
  `EMPTY_SEARCH_RESULTS`, `publishSearchResults` (identity bail-out), `clearSearchResults`,
  `useSearchResults()`.
- New `src/renderer/src/workspaceRenderMetric.ts`: `markWorkspaceRender()` bumps the existing
  `reviewMetrics` counter and mirrors it onto `window.__horusMetrics.workspaceRenders`
  (`declare global`), which is exactly what scripts/perf/startup-probe.mjs already reads.
- `useRepositorySearch.ts`: now called from the palette. One shared frozen instance for every
  content reset (`NO_CONTENT_RESULTS`) and for empty file results; `cancelContentSearch()` only
  fires when a request is actually outstanding (`outstandingRequestRef`); settled results are
  published to the store; unmount (= palette close) bumps the request id, cancels and clears.
- `CommandPalette.tsx`: owns `useRepositorySearch`. Props `fileResults`/`contentResults`/
  `searchingContent`/`onQueryChange`/`gitRepositoryOpen`/`projectOpen` replaced by `snapshot`,
  `repositoryReview`, `onError`; git/project state is derived from the snapshot.
- `App.tsx`: `useRepositorySearch` and the `workspaceContentSearch` memo deleted from `AppLayout`;
  `WorkspaceLayoutProps` no longer carries `workspaceContentSearch`; `AgentSessionLayout` stops
  passing `contentSearch` to `WorkspaceRoot`.
- `DiffSurface.tsx`: `DiffContents` reads `useSearchResults()`; the `contentSearch` prop stays as an
  explicit override (`contentSearch ?? publishedSearch`).
- `RepositoryWorkspace.tsx` (1 line + 1 import): `useEffect(markRepositoryWorkspaceRender)` ->
  `useEffect(markWorkspaceRender)`.
- Tests: new `searchResultsStore.test.ts` (4); `useRepositorySearch.test.ts` extended to 4 (no
  cancel without an outstanding search, publish-on-settle + clear-on-unmount, shared empty
  instance); `CommandPaletteHost.dom.test.tsx` gains "typing in the palette does not re-render the
  workspace" — 6 characters typed with a memo'd workspace stand-in calling `markWorkspaceRender`,
  asserts `window.__horusMetrics.workspaceRenders` is unchanged.
- Gates: `bun run lint` clean; `bun run typecheck` clean; `bun test CommandPalette.dom
  CommandPaletteHost.dom useRepositorySearch searchResultsStore` -> 16 pass / 0 fail.
- needs-owner: `WorkspaceRoot.tsx` / `RepositoryWorkspace.tsx` (:217 :641 :847 :946 :1290 :1527)
  still thread a `contentSearch` prop that nothing supplies any more. Whoever owns
  RepositoryWorkspace next (Track E, P27) should delete the prop from
  `RepositoryWorkspaceProps`/`WorkspaceViewerProps`/the two DiffSurface call sites and then from
  `DiffSurfaceProps` + the `contentSearch ?? publishedSearch` line in DiffSurface.tsx.

## P16 DONE
- `fileSearch.ts` rewritten around `IndexedPath { path, normalizedPath, kind }` and
  `RankedPath { path, kind }`. `createFileSearchIndex` now derives every ancestor directory once
  per snapshot and single-slot-caches on the input array identity (the palette rebuilds its index
  on every open now that the hook lives inside it). `rankFilePaths(index, query, options)` takes
  `{ limit, priorityPaths, recentPaths }`; an empty query goes to `priorityFilePaths`, a single pass
  that buckets recents (in recency order) -> changed/review paths -> top-level directories -> tree
  order, capped at `limit`. Directories carry `DIRECTORY_SCORE_PENALTY = 1` when scored so a folder
  only outranks a file when no file matched nearly as well.
- New `recentFiles.ts`: localStorage per root (`better-code-diff:recent-files:v1:<root>`, max 20)
  plus `useRecentFiles(root, selectedPath)`, which keeps the root next to the list in state so a
  root switch can never persist one project's history under another's key. No main-process change.
- `App.tsx`: the in-memory `recentFiles` state, `RECENT_FILE_LIMIT` and its two effects are replaced
  by `useRecentFiles(snapshot?.root ?? null, selectedPath)`.
- `CommandPalette.tsx`: `recentFileActions`/`searchFileActions` collapse into one kind-aware
  `fileActions`; a directory row uses `IconFolder` and narrows the query to `<path>/` instead of
  opening a file. Empty query renders Files first (30 rows) then 3 commands and a "More commands…"
  row that switches the query to `>`. `pathCompletion()` (exported, unit-tested) drives ghost text
  under the caret; Tab accepts it.
- `styles.css` (shared, Edit-only): `.command-palette-input` wrapper + `.command-palette-ghost`.
- Tests: `fileSearch.test.ts` rewritten (13, incl. dir derivation, index identity, the empty-query
  ordering, cap, stale recents); new `recentFiles.test.ts` (4) and `recentFiles.dom.test.tsx` (3,
  incl. the root-switch case); 4 new palette dom tests (empty-query sections, More commands, folder
  drill-in, ghost text + Tab); `useRepositorySearch.test.ts` gains the empty-query case.
- Gates: `bun run lint` clean, `bun run lint:css` clean, `bun run typecheck` clean,
  `bun test` over the 10 owned/affected files -> 60 pass / 0 fail.
- Deviations: the plan says a directory row "expands and reveals it in the Explorer". The Explorer's
  expansion state lives inside `RepositoryWorkspace`/@pierre/trees, which Track C may not edit and
  which exposes no reveal API, so a folder row narrows the palette query to that folder instead.
  Recorded as needs-owner.
- needs-owner: Explorer reveal for palette directory rows — `RepositoryWorkspace.tsx` would need to
  accept a `revealPath` (expand ancestors + scroll) and App would pass it to `CommandPaletteHost`
  as `onRevealDirectory`. Natural fit for P27 (Track E), which already touches tree expansion.
- Note for the reviewer: running many dom test files in one `bun test` process made the earlier
  "shell renders first" host assertion flaky — with `./CommandPalette` already in bun's module
  registry, `import()` resolves inside the same `act()` and the real palette mounts immediately.
  The shell is now covered by rendering `CommandPaletteShell` directly, and the host test asserts
  the timing-independent property (an input is focused the moment `open()` returns, and whatever
  was typed survives into the palette).

## P17 (renderer half) DONE
- `contentSearchScheduler.ts`: `CONTENT_SEARCH_STABLE_QUERY_MS = 240` replaced by
  `SHORT 180 / MEDIUM 120 / LONG 90` (long from 5 characters up); paste (growth > 1) still fires at
  once. New `CONTENT_SEARCH_PATH_PAUSE_MS = 400` and `isPathLikeQuery(query, fileNameMatches)`
  (a `/` in the query, or >= `CONTENT_SEARCH_PATH_FILE_MATCHES` (5) file-name prefix hits);
  `contentSearchDelay(previous, next, pathLike)` returns 400 for those, paste included.
- `fileSearch.ts`: new `countFileNameMatches(matches, query)` — the file-name-prefix hit count the
  scheduler needs, computed over the <= 32 ranked results rather than leaking scores into RankedPath.
- `useRepositorySearch.ts`: `pathLikeQuery` memo feeds the delay; the pending dispatch is kept in
  `pendingSearchRef` and exposed as `flushContentSearch()`, cleared on query change and unmount.
- `CommandPalette.tsx`: `runActive()` calls `flushContentSearch()` when there is nothing to open
  (no rows, or the active row is disabled) so Enter resolves a deferred search instead of doing
  nothing. Enter never steals an open.
- Tests: `contentSearchScheduler.test.ts` rewritten (9: bucket boundaries, coalescing at 60 ms/char,
  paste, short/cleared, path pause, `isPathLikeQuery`); `useRepositorySearch.test.ts` gains
  "holds a path-like query back … and Enter runs it now".
- Gates: lint, lint:css, typecheck clean; `bun test` over the 6 scheduler/search/palette files ->
  49 pass / 0 fail.
- Deviations: (1) the plan says "fire immediately on Enter" unqualified; flushing on every Enter
  would spawn a ripgrep that the closing palette immediately cancels, so the flush is limited to the
  case where Enter would otherwise do nothing. (2) ">= 5 files with score above threshold" is
  implemented as ">= 5 file-name prefix hits" — RankedPath carries no score and a raw match count
  would make almost every 3-letter query path-like.
- Note for the reviewer: at ~90 ms/character the 90 ms bucket starts one ripgrep per keystroke
  (each one cancelling the last). That is the trade the plan asks for; it depends on Track D's main
  half (MAX_SEARCH_RESULTS 24, capped threads, kill on cap) to stay cheap. At 60 ms/character it
  still coalesces to one search.
- needs-owner: none.

## P18 DONE
- `styles.css` (shared, Edit-only, palette rules): the translucent-surface rule now reads
  `blur(var(--surface-blur, 30px))`, and `.command-palette-layer` sets `--surface-blur: 12px`, so
  the palette drops 30px -> 12px while `.pr-loading-indicator` (not Track C's) is untouched. Done
  through an inherited custom property because splitting the shared selector list tripped
  stylelint `no-duplicate-selectors`.
- `.command-palette` gains `contain: layout paint` (it already clips with `overflow: hidden`, so
  paint containment changes nothing visually and its own box-shadow is unaffected).
- `.command-palette[data-opening] { will-change: transform, opacity; }`; `CommandPalette` sets
  `data-opening` on mount and clears it after `PALETTE_OPENING_MS = 80` (matches
  `--duration-instant`, the scrim fade), so no layer is pinned for the life of the palette.
- Test: "drops the opening hint once the panel has settled" in `CommandPalette.dom.test.tsx`.
- Gates: lint, lint:css, typecheck clean; `bun test CommandPalette.dom CommandPaletteHost.dom
  viewerCss` -> 19 pass / 0 fail.
- Not verified here: the CDP frame timing around Cmd+P. That needs an installed build, which only
  the reviewer produces.
- needs-owner: none.

## P19 DONE
Compiler output BEFORE (git HEAD's App.tsx, run through babel-plugin-react-compiler 1.0.0 with the
`logger` option):
  ok AgentSessionLayout? no — CompileError fn@356 :: Cannot access refs during render
  CompileError fn@557 (AppLayout) :: Cannot access refs during render
  CompileError fn@604 (App) @760 @802 @820 :: (BuildHIR::lowerStatement) Handle TryStatement with a
    finalizer ('finally') clause
  CommandPalette.tsx: CompileError :: Unexpected terminal kind `ternary` for logical test block
AFTER (working tree): every one of `App`, `AppLayout`, `AgentSessionLayout`,
`CachedWorkspaceFallback`, `CommandPalette`, `SearchPreview`, `CommandPaletteHost`,
`CommandPaletteShell`, `RepositoryWorkspace` reports CompileSuccess.

Causes found and fixed (each isolated by bisecting a scratch copy against the logger):
1. Refs read into an object literal during render. `view` carried `commandPaletteRef` and
   `terminalDockRef`, and `AppLayout` read `view.terminalDockRef` — the compiler's ref validation
   rejects both, and the whole component is skipped. Both refs now travel as their own JSX props
   (`<AppLayout {...view} commandPaletteRef=… terminalDockRef=… />`); `view` is typed
   `Omit<AppLayoutProps, 'commandPaletteRef' | 'terminalDockRef'>` and `WorkspaceLayoutProps` omits
   both, so no ref reaches the workspace subtree at all.
2. `try { … } finally { … }` in `openFolder`, `openPickedFolder`, `openRecentFolder`: the compiler
   cannot lower a finalizer. No `return` sits inside those `try` blocks, so the cleanup moved to
   after the `try/catch` — same behaviour, no finalizer.
3. `initialWorkspacePaint(window.repository?.cachedWorkspace ?? null)` and the
   `firstOpenPathForSnapshot(...)` fallback ran on every render. Now
   `const [cachedPaint] = useState(() => initialWorkspacePaint(...))` and
   `useState(() => cachedPaint.selectedPath ?? …)`. This also turned out to matter to the compiler:
   with the eager read still in the body it reported `PreserveManualMemo` on 13 `useCallback`s
   ("inferred dependency `setError`, source dependencies []"), and those errors are gone now — no
   manual memoisation had to be deleted.
4. `CommandPalette.tsx`: `[a, b].filter(Boolean).join(' ') || undefined` for the row class is a
   logical test over a ternary chain, which the compiler cannot lower. Replaced by
   `paletteRowClassName(active, preview)`.
- `electron.vite.config.ts`: `reactCompilerOptions()` adds the plugin's `logger` behind
  `HORUS_COMPILER_LOG=1`, printing one line per non-success event.
- New `src/renderer/src/reactCompiler.test.ts`: runs the compiler over App.tsx, CommandPalette.tsx,
  CommandPaletteHost.tsx and RepositoryWorkspace.tsx and fails with the reported reasons if any of
  the hot components is skipped. This is the regression guard — a build prints nothing about a
  skipped component, so nothing else would catch it.
- Gates: lint, lint:css, typecheck clean; `bun test reactCompiler CommandPalette.dom
  CommandPaletteHost.dom App.dom boot.dom recentFiles.dom` -> 29 pass / 0 fail.
- Deviations: no dom test for the boot-paint change. Rendering `App` in bun tests needs a stub for
  ~12 IPC methods plus useGitWorkflow/useAgentSession, and there is no existing App render test to
  build on; `useState(() => …)` moves *when* pure work runs, not what it returns, and
  `reactCompiler.test.ts` covers the part that can silently regress.
- needs-owner: `package.json` — add `@babel/core` to devDependencies. `reactCompiler.test.ts`
  imports it and it currently resolves only as a transitive dependency of `@vitejs/plugin-react`.
- Note: `RepositoryWorkspace.tsx` has one *other* component (fn@985) that still bails on
  "Cannot access refs during render". Out of Track C's ownership; left for P13/Track E.

## P20 DONE
- `CommandPalette.tsx`: the per-row `onPointerEnter` closure and the per-row `ref` callback are
  gone. Rows carry `data-index`; one `onPointerMove` on `.command-palette-results` resolves the row
  with `closest('[data-index]')` and only calls `setActiveIndex` when the index actually changes.
  The keyboard scroll-into-view now finds the active row through `resultsRef.querySelector`, so
  `rowRefs` (an array rebuilt every render) is deleted.
- Row models: `groups` is a `useMemo` on `results` identity that carries each section's starting
  row index, so the render loop no longer mutates a `let rowIndex` across nested `.map` callbacks.
  Written as a `for` loop — reassigning the accumulator inside `.map` is "Cannot reassign variable
  after render completes" to the React Compiler, caught by `reactCompiler.test.ts`.
- `fileSearch.ts`: `rankFilePaths` keeps a single-slot cache of its arguments and result, and when a
  recomputation is element-wise equal to the previous one it hands the previous array back, so the
  palette's row memo bails out instead of rebuilding 30 row models. Ranking moved into
  `computeRanking`.
- Tests: 3 identity cases in `fileSearch.test.ts`; "one delegated pointer handler makes the row
  under the cursor active" in `CommandPalette.dom.test.tsx` (fired on a child element, to prove the
  handler is on the list and not the row).
- Gates: lint, lint:css, typecheck clean; `bun test` over the 8 palette/search/compiler files ->
  69 pass / 0 fail.
- needs-owner: none.

## P10-N1 DONE (lazy Welcome)
- New `src/renderer/src/Welcome.tsx`: `Welcome`, its `WelcomeProps`, the module-level
  `welcomeEntranceShown` flag, and `ShortcutHint`/`ShortcutHintProps` (used only by Welcome) moved
  out of `AppView.tsx` verbatim. `IconBraces` is the one icon only Welcome used, so it moved with
  it; `IconRefresh`/`IconFolder`/`IconX` stay in AppView, which still uses them.
- `AppView.tsx`: those blocks and the now-unused `useEffect` import removed. Nothing else changed.
- `App.tsx`: `const Welcome = lazy(async () => ({ default: (await import('./Welcome')).Welcome }))`
  and the `workspaceStage === 'welcome'` branch wrapped in `<Suspense fallback={null}>`.
- New `Welcome.dom.test.tsx` (3): recent-folder open, remove-without-open, empty state.
- Gates: lint, lint:css, typecheck clean; `bun test Welcome.dom AppView.dom` -> 12 pass / 0 fail.

## P09-N1 DONE (fallback class instead of inline styles)
- `styles.css` (shared, Edit-only, one new rule next to `.gh-markdown.comment`):
  `.github-markdown-fallback { margin: 0; font-family: inherit; font-size: inherit;
  white-space: pre-wrap; word-break: break-word; }`.
- `GitHubMarkdownContent.tsx`: `RAW_MARKDOWN_STYLE` deleted, `<pre className="github-markdown-fallback">`.
- `GitHubMarkdownContent.dom.test.tsx`: the existing fallback test now also asserts the class is
  applied and that the element carries no inline `style` attribute.
- Gates: lint, lint:css, typecheck clean; `bun test GitHubMarkdownContent.dom` -> 3 pass / 0 fail.

## Final build + entry budget (the one build Track C is allowed)
`bun run build` exit 0, `bun run check:entry` exit 0.
- Pre-mount closure: 1,652,713 B across 20 chunks (limit 1,700,000). Wave 1 left it at 1,649,485 B,
  so +3,228 B.
- Boot chunk: `boot-mooE_MZK.js` 174,866 B. Wave 1 left it at 172,134 B, so +2,732 B.
- Entry closure 2,935 B (limit 65,536); WorkerPool still absent from the boot chunk.
Where the boot chunk's +2.7 KB went, and why it is the right trade:
- OUT: `Welcome.tsx` is now its own 5,233 B chunk and no longer in the boot map.
  `CommandPalette.tsx` is its own 20,458 B chunk carrying `useRepositorySearch`, `fileSearch`,
  `contentSearchScheduler` and `searchPreview`; none of them is in the boot map any more.
  `searchResultsStore.ts` landed in the DiffSurface-shared chunk, not boot.
- IN: `CommandPaletteHost.tsx` (the shell has to be resident to paint on the Cmd+P frame),
  `commandPaletteModule.ts`, `recentFiles.ts`, `workspaceRenderMetric.ts`, and — the largest part —
  the React Compiler's memoisation for `App`, `AppLayout`, `AgentSessionLayout` and
  `CachedWorkspaceFallback`, which were all skipped before P19 and emitted no cache code at all.
- Note on P10-N1's premise: the boot chunk still carries 28 `@pierre/icons` sources. They come from
  `AppView`'s Titlebar/DiffToolbar and from `FolderPicker`, not from Welcome — `IconBraces` was the
  only icon Welcome had to itself. Moving Welcome out buys the component and its FolderPicker
  entry point, not the 33.6 KB the Wave 1 note estimated.
- `Welcome-*.js` and `CommandPalette-*.js` are still counted inside the "pre-mount closure" number
  because `scripts/perf/premountClosure.mjs` follows dynamic `import()` edges out of the boot chunk.
  Neither is parsed before mount; the closure number overstates both by ~25 KB.

## Track C complete
All nine sections DONE. Full renderer suite: `bun test src/renderer` -> 574 pass / 0 fail across
96 files. `bun test src/shared` -> 73 pass / 0 fail. lint, lint:css, typecheck all clean.
Not measured here (needs the installed build, reviewer's step): startup-probe `palette.openMs`,
`palette.emptyRows`, `palette.contentResultsMs`, `palette.workspaceRenders`, and the CDP frame
timing around Cmd+P.
