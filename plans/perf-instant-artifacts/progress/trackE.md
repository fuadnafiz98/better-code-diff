# Track E progress log

Sections in order: W2-X1, W2-X2, W2-X4, P27, W2-X3, W2-X5, P25, P26, P29.

## start 2026-09-05
- read plans/perf-instant-plan.md (full), review/wave1-feedback.md
- no prior log; starting fresh at W2-X1

## W2-X1 DONE
- files: src/renderer/src/useGitWorkflow.ts (openPullRequestFromLocator second arg
  `resolvedRoot: string | null = null`, wins over the New-tab folder as preferredRoot),
  src/renderer/src/App.tsx (`openExternalPullRequest(url, root)`; `open(url, root)`;
  pending-URL path passes null), src/renderer/src/useGitWorkflow.dom.test.tsx (new test).
- tests: `bun test src/renderer/src/useGitWorkflow.dom.test.tsx` 9 pass
- gates: `bun run lint` ok, `bun run typecheck` ok
- deviations: none

## W2-X2 DONE
- files: src/renderer/src/DiffSurface.tsx (deleted `ContentSearchState` interface, the
  `contentSearch` prop + destructure, `contentSearch ?? publishedSearch` -> `useSearchResults()`,
  dropped now-unused `ContentSearchResult` import), src/renderer/src/RepositoryWorkspace.tsx
  (Edit-only: dropped the import, RepositoryWorkspaceProps + WorkspaceViewerProps fields,
  both destructures, both DiffSurface/WorkspaceViewer call sites).
- tests: no colocated tests for these modules; covered by typecheck + full renderer suite
- gates: `bun run lint` ok, `bun run typecheck` ok
- deviations: none

## W2-X4 DONE
- files: package.json (devDependencies `"@babel/core": "^7.29.7"`), bun.lock (same line in
  the workspace root devDependencies so the lockfile stays in sync; the package resolution
  `@babel/core@7.29.7` was already present).
- gates: `bun install --frozen-lockfile` -> "2 packages installed", lockfile unchanged apart
  from that one line; `bun test src/renderer/src/reactCompiler.test.ts` 4 pass
- deviations: bun.lock is not in the ownership list but the manifest line has to be mirrored
  there or `--frozen-lockfile` fails; no other lockfile change.

## P27 DONE
- new: src/renderer/src/folderOpenSettle.ts (+ .test.ts) — LIVE_SNAPSHOT_DEADLINE_MS 400,
  OPEN_SPINNER_DELAY_MS 80, isLiveSnapshot(), reportAppliedSnapshot(), waitForLiveSnapshot().
- src/renderer/src/App.tsx: applySnapshot reports every applied snapshot's stage;
  new adoptOpenedSnapshot() shared by the three open handlers; openPickedFolder/openRecentFolder
  funnel through openThroughPicker(), which keeps openingRecentPath set (and the picker mounted)
  until a live snapshot for that root lands or 400 ms pass, then closes the picker;
  FolderChromeButton onSelect no longer closes the picker up front; skeletonOpenRootRef arms the
  skeleton -> live re-derivation and selectPath() (the new explicit-selection wrapper replacing
  the raw setSelectedPath prop) disarms it; handleRepositoryChange calls
  gitWorkflow.resyncDeskNavigation(live) once on that transition.
- src/renderer/src/useGitWorkflow.ts: resyncDeskNavigation(snapshot) — focusDesk with
  firstOpenPathForSnapshot + automaticWorkspaceView, guarded on the desk for that root being
  the active world so a PR tab opened meanwhile is not stolen.
- src/renderer/src/FolderPicker.tsx: row spinner delayed by OPEN_SPINNER_DELAY_MS
  (openingSlowly state) so a 16-196 ms open never blinks; `busy`/disabled stays immediate.
- src/renderer/src/treeExpansion.ts (+ test): treeContentSyncMode(applied, root, paths, statuses)
  gains the root and a fourth mode 'adopt' = reset without the collapse walk (first content for
  the tree, or a different root, or an empty previous list).
  src/renderer/src/RepositoryWorkspace.tsx useTreeContentSync takes the root and only runs the
  collapse pass for mode 'reset'. Net: one collapse walk per open instead of two.
- tests: folderOpenSettle.test.ts (5), treeExpansion.test.ts (16, 3 new),
  FolderPicker.dom.test.tsx (5, 1 new), useGitWorkflow.dom.test.tsx (11, 2 new)
- gates: `bun run lint` clean for my files, `bun run typecheck` ok, `bun test src/renderer/src/`
  594 pass / 0 fail
- deviations: plan item 4 (picker must not touch folderIndex until the query is non-empty) NOT
  done: recents already render synchronously from session state and the catalog fetch is a
  non-blocking effect whose result is only read for a non-empty query, so deferring it only adds
  latency to the first keystroke; `preloadFolderCatalog` on hover/focus already warms main. Not
  in the Track E brief either. "One tree reset per root change" is implemented as one *collapse
  walk* per root change: model.resetPaths still runs for the live path list because the skeleton
  and git path lists genuinely differ.

## W2-X3 DONE
- new: src/renderer/src/explorerReveal.ts (+ .test.ts) — module handler registry
  (setExplorerRevealHandler / revealInExplorer); the palette and the explorer are sibling
  subtrees, so a prop cannot reach the tree.
- src/renderer/src/RepositoryWorkspace.tsx: useRepositoryExplorer gains revealPath(path)
  (expand every ancestor, expand the directory itself, scrollTreeToPath 'nearest') and registers
  it with setExplorerRevealHandler for the life of the workspace.
- src/renderer/src/App.tsx: CommandPaletteHost gets onRevealDirectory={revealInExplorer}
  (CommandPaletteHost spreads paletteProps, so it needed no change).
- src/renderer/src/CommandPalette.tsx: optional onRevealDirectory prop, called from
  drillIntoDirectory alongside the existing query narrowing.
- tests: explorerReveal.test.ts (4), CommandPalette.dom.test.tsx (15, 1 new)
- gates: as P27 above
- needs-owner: none
- note: `bun run lint` reported two unused-import warnings in
  src/renderer/src/CommandPaletteHost.dom.test.tsx at 16:00:31 (file mtime 9 s before the run) —
  another track mid-edit, not touched by Track E.

## W2-X5 DONE
- src/renderer/src/useReviewWorlds.ts: `openPatchWorld` looks for an already-open patch world
  with the same `patchReviewIdentity(review)` (the PR URL) but a different worldId, carries its
  navigation entry to the new world and dispatches `open-patch` with `supersedesWorldId`;
  `insertContentWorld` takes that id, replaces the superseded world in place (same tab position)
  and treats it as the focus origin so `activeWorldId` never points at a removed world.
- Chose supersede-and-rename over reusing the stale worldId: the tab keeps its slot, its
  navigation and the focus, while every reducer guard keyed on the world's oids
  (`replace-patch` compares `patchWorldId(action.review) === world.worldId`) keeps matching the
  fresh review. Reusing the old id would have silently dropped the authoritative post-stream
  `replace-patch`.
- tests: useReviewWorlds.test.ts (23, 1 new reducer test), useGitWorkflow.dom.test.tsx (12, 1 new
  end-to-end reopen-after-force-push test)
- gates: `bun run lint` clean, `bun run typecheck` ok, `bun test src/renderer/src/` 597 pass / 0 fail

## P25 DONE
- src/main/repositoryWatcher.ts: `pause()` closes both `fs.watch` handles, clears the pending
  set / debounce timer and bumps the generation while keeping `#snapshot`; `resume()` re-arms
  from the retained snapshot and returns whether it did; `paused` getter; `start()` clears the
  flag; `#schedule`/`#flush` bail while paused; handle closing factored into `#closeHandles()`.
- src/main/repositorySessions.ts: `RepositorySession` gains `lastActiveAt`; `#setActiveRoot`
  pauses every other session's watcher (on top of the existing cache trim), stamps the active
  one, resumes it and — only when it had actually been paused — runs one `#refreshAndPublish`
  to catch it up; new `#evictBeyondCap()` disposes least-recently-active sessions beyond
  MAX_RESIDENT_SESSIONS = 4, never the active root; new `#parkBackgroundSession()` pauses a
  watcher armed for a repository opened with `activate=false` (PR warmup, second-tab restore).
- `activate(root)` is now async and reopens a root the cap disposed instead of throwing, so a
  review world outliving its session recovers lazily (plan: "disposed roots reopen lazily").
  Only production caller is the `activateRepository` IPC handler, which already returns a
  promise, so index.ts needed no edit.
- tests: repositoryWatcher.test.ts (17, 2 new: pause holds no OS handle then re-arms; resume on
  an unpaused watcher is a no-op), repositorySessions.test.ts (17, 3 new: activation pauses the
  background watchers; a background open never leaves one armed; the 4-session cap evicts the
  two oldest and `activate` reopens an evicted root)
- gates: `bun run lint` clean, `bun run typecheck` ok, `bun test src/main/` 355+ pass / 0 fail
- deviations: the plan's "fake watcher" is realised as `spyOn(RepositoryWatcher.prototype, ...)`
  plus real temp repositories — the registry constructs its watchers internally and adding an
  injection seam only for the test was not worth the API.

## P26 DONE
- src/shared/workspaceCache.ts:
  * `capWorkspaceCache` is count-only — MAX_CACHED_PATHS 20k -> 25k, MAX_CACHED_STATUSES 4k -> 5k,
    fileText still 512 KB. `workspaceCacheBytes` / MAX_WORKSPACE_CACHE_BYTES and the
    stringify-and-halve loop are gone (MAIN-6: up to 112 ms per publish).
  * membership is a `Set` cached per path-array identity (`pathSet` WeakMap), used by
    `parseSelectedPath`, `parseStatuses` and `capSnapshot`; `capSnapshot` returns the same
    snapshot when nothing exceeds a cap. Also removes react-doctor's `js-set-map-lookups:99`.
  * new multi-slot store: `WorkspaceCacheStore { version: 2, lastRoot, entries }`,
    MAX_WORKSPACE_CACHE_SLOTS 3, `parseWorkspaceCacheStore` (reads v1 single-workspace files as
    one slot), `workspaceCacheForRoot`, `lastWorkspaceCache`, `rememberWorkspaceCacheEntry`
    (upsert + move-to-front + cap). The restore hint still carries only `store.lastRoot`.
  * `WorkspaceUiState` is now a patch (all fields optional); `parseWorkspaceUi` omits `fileText`
    when the message does not carry it so a UI update never clears the cached text;
    `parseCachedFileText` exported as the file-text channel's payload parser;
    new `cachedFileTextIdentity(comparison)` = path + main's sha1 `cacheKey`.
- src/main/workspaceCacheStore.ts: loads/saves the store; the write goes to
  `last-workspace.json.tmp` and is renamed over the target (atomic), chained so two saves cannot
  interleave, and the temp file is removed if the write fails.
- src/main/index.ts: `workspaceCache` -> `workspaceCacheStore`; new `cachedWorkspaceForRoot()`
  (uses `rootsMatch`) feeds `openRepository` and `hydrateLastWorkspace`;
  `persistWorkspaceFromSnapshot` merges against that root's own entry, not the single slot;
  debounce 400 ms -> 1,000 ms; `getWorkspaceCache` returns `lastWorkspaceCache(store)` so the
  renderer contract (`cachedWorkspace: WorkspaceCache | null`) is unchanged; new
  `repository:file-text` handler.
- src/shared/contracts.ts: `persistFileText(fileText: CachedFileText | null)` on RepositoryApi,
  `persistFileText: 'repository:file-text'` channel, `CachedFileText` re-exported.
  src/preload/index.ts: the bridge method.
- src/renderer/src/App.tsx: the single 250 ms persist became two — a string-keyed UI persist
  (`root\0selectedPath\0view`) and a fileText persist keyed on `cachedFileTextIdentity`, so
  reselecting a file or flipping the view no longer ships the text, and an unchanged file ships
  nothing (useDebouncedPersist bails on `Object.is`).
- tests: shared/workspaceCache.test.ts (20, 8 new: identity, partial UI patch, v1 migration,
  unreadable input, two-repository store, slot cap, move-to-front, JSON round trip);
  main/workspaceCacheStore.test.ts (3, rewritten for the store + atomic write + v1 migration)
- gates: `bun run lint` clean, `bun run typecheck` ok, `bun test` 1,071 pass / 0 fail
- deviations: none. sessionRestore.test.ts needed no change (the hint still carries lastRoot only).

## P29 DONE
- src/main/index.ts:
  * `setImmediate(beginSessionRestore)` in the whenReady body, after `createMainWindow()` (which
    shows the window at its end) — hydrating up to 25k cached paths no longer shares the tick
    that creates the window. `beginSessionRestore` is idempotent (`sessionRestoreStarted`) and
    the `getSessionSnapshot` handler calls it before awaiting `restoreLastSession`, so a
    renderer that asks before the deferred tick starts the restore instead of racing it.
  * `currentRestoreHint()` memoised on the identity of (sessionState, workspaceCacheStore,
    pendingOpenPullRequestUrl); the computation moved to `computeRestoreHint()`. Each miss cost
    an `existsSync` + `realpathSync` on the last root and it is asked for three times per launch.
  * `openRepository` resolves the path once and passes `resolved: true` down to
    `repositorySessions.open`.
- src/main/repositorySessions.ts: `open(folderPath, activate, resolved = false)` skips its own
  `realpath` when the caller has already resolved.
- tests: repositorySessions.test.ts (18, 1 new: an already-resolved path opens the same session
  a symlinked path opened, no duplicate session)
- gates: `bun run lint` clean, `bun run lint:css` clean, `bun run typecheck` ok,
  `bun test` 1,074 pass / 0 fail
- needs-owner (src/main/repository.ts, nobody owns it in Wave 3): `RepositoryService.open`
  (line ~1489) still does `const selectedRoot = await realpath(folderPath)`. Exact edit to
  finish FO-11 (4 resolutions -> 2):
      async open(folderPath: string, resolved = false): Promise<RepositorySnapshot> {
        const selectedRoot = resolved ? folderPath : await realpath(folderPath)
  and in src/main/repositorySessions.ts `open()`:
      const snapshot = await repository.open(selectedRoot, true)
  (the registry has always resolved `selectedRoot` by that point, with or without the new flag).
- not unit-testable: the restore-hint memo and the setImmediate live in index.ts, which has no
  test harness; both are covered by the startup probe (`windowShown`, `restoreSettled`).

## Final gate run (all sections DONE)
- `bun run lint` clean; `bun run lint:css` clean; `bun run typecheck` clean;
  `bun test` 1,075 pass / 0 fail across 133 files.
- `npx react-doctor@latest --verbose`: 30 issues vs the Wave 2 baseline's 31. Performance
  warnings 5 -> 4 (`js-set-map-lookups` at shared/workspaceCache.ts:99 removed by P26). No new
  warnings in any file Track E touched. Score still not printed ("maintainability checks could
  not complete") — unchanged from the Wave 2 baseline, P13's problem.
- Post-review self-check fix: `insertContentWorld`'s new focus clause was
  `state.activeWorldId === supersedesWorldId`, which is true when both are null — a background
  `open-patch` with `activeWorldId: null` would have stolen focus. Guarded on
  `supersedesWorldId != null` and covered by a new reducer test.
- `bun run build` deliberately not run (Track F builds).
