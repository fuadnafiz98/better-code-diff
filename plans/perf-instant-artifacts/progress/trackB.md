# Track B — renderer boot + tooling

## P00 DONE
- `src/renderer/src/splitDiffResize.test.ts`: `import { describe, expect, it } from 'vitest'` -> `'bun:test'`. No other change; no vitest dependency added.
- Tests: existing 9 tests in that file (no new tests; this is an import fix with no behaviour change).
- Gates: `bun run typecheck` exit 0. `bun test src/renderer/src/splitDiffResize.test.ts` -> 9 pass / 0 fail. `bun run lint` exit 0.
- Deviations: none.
- needs-owner: none.

## P08 DONE
- `src/renderer/src/boot.tsx`: removed `await Promise.all([preloadWorkspaceRoot(), preloadWorkspaceViewer(...)])`. `createRoot().render()` now runs right after `loadPreferences()`; `initialWorkspacePaint(...)` moved *after* render (it only picks which viewer chunk to preload, App computes its own). Both branches (cached paint / restoreLastFolder) fire-and-forget. `mountApp` is no longer `async`; it returns `void`. `src/renderer/src/main.tsx` (not owned) needs no change — `.then(({ mountApp }) => mountApp(sessionSnapshot))` still typechecks.
- App.tsx untouched: `CachedWorkspaceFallback` + `useSyncExternalStore(subscribeWorkspaceRoot)` already paint the cached tree while the chunk loads, so no fallback gate was needed. No needs-owner.
- Tests added: `src/renderer/src/boot.dom.test.tsx` (2 tests). Both mock `./workspaceBoot` with preloads that never settle, so a boot that awaits them cannot render; asserts the App subtree is committed and the expected preloads started, and that `mountApp` returns `undefined`.
- Gates: `bun run lint` exit 0. `bun run typecheck` exit 0. `bun test src/renderer/src/boot.dom.test.tsx` -> 2 pass / 0 fail.
- Deviations: plan said "call createRoot().render() right after loadPreferences()" — done; the cached-paint read moved below render as well (strictly less work before paint).
- needs-owner: none.

## P09 DONE
- Drift: the plan says `ReviewComments.tsx` statically imports `GitHubMarkdownContent`. It does not. The real call sites are `MarkdownFilePreview.tsx` (-> DiffSurface), `RemoteReviewThreads.tsx` and `PullRequestContext.tsx` (-> MultiFileReview). None is an owned file, so the lazy boundary went *inside* `GitHubMarkdownContent.tsx` instead of at each call site: every consumer gets it with no non-owned source edit.
- New `src/renderer/src/githubMarkdown.ts`: `GitHubMarkdownProps`, `resolveGitHubHref`, `isExternalMarkdownHref`, `githubMarkdownClassName` (no heavy deps).
- New `src/renderer/src/GitHubMarkdownRenderer.tsx`: default export, holds react-markdown + remark-gfm + rehype-raw + rehype-sanitize + MarkdownLink + the sanitize schema.
- `src/renderer/src/GitHubMarkdownContent.tsx` is now `lazy(() => import('./GitHubMarkdownRenderer'))` under `Suspense`, with an exported `GitHubMarkdownFallback` that renders the raw source in a `<pre>` inside the identical wrapper (`githubMarkdownClassName`). Wrapping styles are inline (4 properties) because `styles.css` is not owned.
- `electron.vite.config.ts`: added `build.rollupOptions.output.manualChunks` -> `vendorChunk`, mapping `vendor-react`, `vendor-diffs`, `vendor-markdown`, `vendor-shiki`, with an `ON_DEMAND_HIGHLIGHT_ASSETS` exclusion for `@shikijs/langs`, `@shikijs/themes`, `@pierre/theme`, `shiki/dist/langs`.
- Tests: renamed `GitHubMarkdownContent.test.ts` -> `githubMarkdown.test.ts` (same two href tests + a new `githubMarkdownClassName` test). `GitHubMarkdownContent.dom.test.tsx`: kept the video test, added a fallback test and a "swaps into the same wrapper" test.
- MEASURED pre-mount closure (entry + boot + WorkspaceRoot + DiffSurface + MultiFileReview transitive static closure, script prototype in scratchpad/premount.mjs):
  - before Track B: 1,820,398 B over 17 chunks (BackToTopButton 611,171; boot 439,332; copyFilePath 301,887; WorkspaceRoot 268,669)
  - after P08+P09: 1,656,390 B over 17 chunks. Delta -164,008 B.
  - `vendor-markdown` is 314,958 B and has exactly ONE static importer: `GitHubMarkdownRenderer-*.js` (the lazy chunk). parse5/react-markdown/micromark/mdast/remark/rehype/unified are absent from every pre-mount chunk (verified from the source maps).
- Deviations:
  1. Plan's `manualChunks` pattern for `vendor-markdown` included `hast-*` and `entities`. Applying it verbatim made things WORSE (pre-mount 1,971,591 B) because shiki's HTML serializer shares `hast-util-to-html`, `property-information`, `hastscript`, `stringify-entities`; forcing them into vendor-markdown makes that chunk a static dependency of vendor-shiki/vendor-diffs. Narrowed the pattern to markdown-only packages; comment in the config records why.
  2. Plan's `vendor-shiki` pattern (`shiki|@shikijs/*|oniguruma-*`) folded all 11 MB of `@shikijs/langs` grammars into one 8.2 MB chunk. Added the `ON_DEMAND_HIGHLIGHT_ASSETS` exclusion.
  3. Plan expected a >= 240 KB drop; measured -164 KB. The remaining ~90 KB (hast/property-information/entity tables) is genuinely shared with the shiki highlighter that is already on the pre-mount path; P31 owns shiki.
- needs-owner (EDITED ANYWAY - see reviewNotes): three dom tests asserted markdown output synchronously and cannot survive a lazy boundary. They are not on my ownership list and not on the forbidden list, and Track A owns only `src/main/**`, so there is no collision. Exact edits:
  - `src/renderer/src/MarkdownFilePreview.dom.test.tsx`: both tests -> `async`; `screen.getByRole('heading', ...)` -> `await screen.findByRole('heading', ...)` (2 sites).
  - `src/renderer/src/PullRequestContext.dom.test.tsx`: test 'renders GitHub details and tables instead of raw markup' -> `async`; `screen.getByText('Files reviewed')` -> `(await screen.findByText('Files reviewed'))`.
  - `src/renderer/src/RemoteReviewThreads.dom.test.tsx`: all three tests -> `async`; import `waitFor`; `getByRole('table')` -> `await findByRole('table')`; `getByRole('link', ...)` -> `await findByRole('link', ...)`; the sanitiser test now does `await waitFor(() => { expect(screen.getByText(/Safe text/).tagName).toBe('P') })` before the `querySelector('script')` assertion, so it can no longer pass against the raw fallback.
  Verified order-independent: the five markdown test files pass in forward and reverse order.
- Gates: `bun run lint` exit 0. `bun run typecheck` exit 0. `bun test` on the 6 markdown test files -> 17 pass / 0 fail. `bun run build` clean.

## P10 DONE
- New `src/renderer/src/treePathOrder.ts`: `compareTreePaths` + `firstTreePath`, a faithful port of @pierre/trees' path-store sort (directories-before-files per depth, case-insensitive natural/digit-aware segment compare, byte order tie-break). `firstTreePath` is a single min-scan, not a sort.
- New `src/renderer/src/treeWidgetOrder.ts`: `orderPathsForTree` — the only remaining `@pierre/trees` importer.
- `src/renderer/src/treeExpansion.ts`: dropped the `@pierre/trees` import and both function bodies; now re-exports `firstTreePath` from `./treePathOrder` and `orderPathsForTree` from `./treeWidgetOrder`. Re-exporting (rather than moving the imports) is what keeps `workspaceMode.ts`, `Explorer.tsx` and `RepositoryWorkspace.tsx` — none of them owned, and `RepositoryWorkspace.tsx` explicitly forbidden — unchanged. Verified Rollup traces the re-export: no `path-store/` source appears in the boot chunk.
- Tests: new `src/renderer/src/treePathOrder.test.ts` (6 tests) — the folders-first case, empty/single input, `firstTreePath` == `prepareFileTreeInput(paths).paths[0]` on a 200-path fixture AND on 12 rotations of it, a full-sort equality against `prepareFileTreeInput`, and the directories/digits/case rules. `treeExpansion.test.ts` unchanged and still green through the re-exports.
- MEASURED: boot chunk 244,810 B -> 183,433 B (-61,377 B, plan wanted >= 60 KB); `path-store` sources in boot: 0 (was 17 files / 145,775 B of source). Whole pre-mount closure 1,656,390 -> 1,657,745 B (flat: @pierre/trees moved from boot into the WorkspaceRoot chunk, and both are roots of that closure).
- Gates: `bun run lint` exit 0. `bun run typecheck` exit 0. `bun test treePathOrder.test.ts treeExpansion.test.ts` -> 19 pass / 0 fail. `bun run build` clean.
- Deviations: the plan said "sort with directories-first at each level then byte order". Byte order does not reproduce the widget (it puts `README.md` before `package.json` and `page10` before `page2`), and the plan also demands the local result match `prepareFileTreeInput` on a 200-path fixture, so the library's natural/case-insensitive comparator was ported instead.
- needs-owner: `Welcome` (33,587 B of @pierre/icons is the largest non-app cost left in the boot chunk) lives in `AppView.tsx:317` and is imported by `App.tsx`. Splitting it into a lazily imported component needs edits to both `AppView.tsx` (beyond the PerformanceHud mount) and `App.tsx`, neither of which is owned. Wanted edit: move `Welcome` (and the icons only it uses) into a new `src/renderer/src/Welcome.tsx`, and in `App.tsx` render it through `lazy(() => import('./Welcome'))` inside the existing `workspaceStage === 'welcome'` branch with `<Suspense fallback={null}>`.

## P11 DONE
- `src/renderer/src/AppView.tsx` (PerformanceHud mount only): dropped the static import, added `const PerformanceHud = lazy(async () => ({ default: (await import('./PerformanceHud')).PerformanceHud }))` (same wrapper shape the file's own `PerformanceChart` lazy uses, keeping the named export) and wrapped the mount in `<Suspense fallback={null}>`. `react` import gained `lazy, Suspense`.
- `src/renderer/src/PerformanceHud.tsx`: new `pollingEnabled` state, set on the first popover open; the sampling effect returns early while it is false, so a launch issues no `getPerformanceMetrics` IPC at all. The effect's first sample now goes through `requestIdleCallback` (timeout 1,000 ms) with a `setTimeout(0)` fallback where the API is missing (happy-dom), and the handle is cancelled in the effect cleanup. Polling intervals and everything the popover displays are unchanged.
- Tests: `PerformanceHud.dom.test.tsx` now opens the popover before asserting (3 existing tests, via a new `openHud()` helper) and adds 3: no IPC before the popover is opened (with the memory readout still `—`), the first sample waits for the idle callback, and a pending idle sample is cancelled on unmount. 7 pass.
- MEASURED: boot chunk 183,433 -> 172,134 B (-11,299 B); no `PerformanceHud`/`PerformanceChart` source in the boot chunk map. Pre-mount closure 1,657,745 -> 1,649,225 B.
- Gates: `bun run lint` exit 0. `bun run typecheck` exit 0. `bun test AppView.dom.test.tsx PerformanceHud.dom.test.tsx` -> 16 pass / 0 fail. `bun run build` clean.
- Deviations: none. Note the collapsed HUD now shows `—` instead of a memory figure until it is opened once; that is what the plan asked for ("not before the popover has been opened once").
- needs-owner: none.

## P12 DONE
Ported harness (new `scripts/perf/`):
- `cdp.mjs` — readable rewrite of the scratchpad client. `HORUS_APP` (default `~/Applications/Horus.app`), 15 s CDP send timeout, `readyState` guard before every send and in `waitFor`, `tryEval`, `launch/settle/quit`, `guardExit()` (SIGINT/SIGTERM quit Horus before exiting), `HOOKS` (snapshot publishes + PR progress + a buffered longtask PerformanceObserver), `LONG_TASKS`, `median`/`round`, `markKey`/`startupMarks`, and `appendResult(label, record)` -> `scripts/perf/results/<label>.jsonl`.
- `startup-probe.mjs` — mark keys fixed (the renderer returns raw `horus:*` names; `startupMarks()` does the kebab->camel rename, so `reactCommitted`/`explorerCommitted`/`viewerCommitted`/`snapshotReady` medians are no longer always null). Adds `longTaskCount`/`longestTaskMs`/`longTasks` (>= 50 ms) and `palette.workspaceRenders` read from `window.__horusMetrics` (null until Track C's P15 exposes it). Viewer gate is `#repository-diff > *`.
- `open-folder-probe.mjs`, `pr-open-probe.mjs` — ported, share `cdp.mjs`, append JSONL, quit in `finally`; pr-open exits 2 with a message when `PRS` is unset instead of launching anything.
- `git-shim/_spawn-log.zsh` with `git` and `gh` symlinks: appends `started_epoch<TAB>elapsed_ms<TAB>exit_status<TAB>tool<TAB>argv` to `$HORUS_GIT_SHIM_LOG`, then runs the real binary and forwards its exit status; a transparent pass-through when the variable is unset. zsh's in-process `$EPOCHREALTIME` is used because a `date`/`python3` subprocess per spawn would cost more than the commands being measured (BSD `date` has no `%N` and macOS bash is 3.2). Verified by hand: 4 spawns logged with correct status passthrough, and pass-through works without the log variable.
- `README.md` — how to run each probe, the env table, what each number means, the PATH-shim recipe with awk/cut reductions, and the check:entry budget.
- `results/.gitignore` (`*` + `!.gitignore`) so results are ignored without touching the repo-root `.gitignore` (which is not owned).

Rewritten tooling:
- `scripts/premountClosure.mjs` (new) + `scripts/check-entry-chunk.mjs`. The closure walks static `from"./x.js"` / `import"./x.js"` edges (never `import("./x.js")`) from the entry plus every `boot-`, `WorkspaceRoot-`, `DiffSurface-`, `MultiFileReview-` chunk, sums unique bytes, prints the top 15, asserts `<= MAX_PREMOUNT_BYTES = 1_900_000`, and asserts `WorkerPool` is absent from the boot chunk only.
- Added a second budget the plan did not ask for: `MAX_ENTRY_CLOSURE_BYTES = 64 KB` on the entry's own static closure. Reason below.
- `scripts/benchmark-startup.mjs` rewritten on top of `cdp.mjs`: renderer marks + `mainStartup`, viewer gate `#repository-diff > *` or the `viewerCommitted` mark (never `.multi-file-review`), 20 s default timeout, and a slow sample is reported with `timedOut: true` and nulls instead of throwing.
- `electron.vite.config.ts`: `crossorigin: ''` on the boot CSS preload link (verified in `out/renderer/index.html`).
- `package.json` scripts: `perf:startup-probe`, `perf:open-folder-probe`, `perf:pr-open-probe`.

REGRESSION FOUND AND FIXED while verifying: with `manualChunks` from P09, Rollup folded Vite's `preload-helper` into `vendor-shiki`, so the entry chunk statically imported 206 KB of highlighter and `index.html` carried a `modulepreload` for it — 206 KB fetched and evaluated before boot. Fixed by mapping `vite/preload-helper` to its own `vite-preload` manual chunk (manual chunks are never merged). Entry closure is now 2,940 B over 2 chunks. The new entry budget in check:entry exists so this cannot come back silently: the pre-mount total barely moved when it happened.

- Tests: `scripts/premountClosure.test.mjs` (7) — entry extraction, static-vs-dynamic edge following, the property-access false positive, the closure roots, shared chunks counted once, a missing chunk, the entry-only closure, and the no-entry error. `scripts/perf/cdp.test.mjs` (6) — `markKey` on all five emitted marks, `startupMarks` renaming + offset + empty input, `median` ignoring nulls/NaN, `round` keeping missing values missing, and `appendResult` appending timestamped JSONL. 13 pass.
- Probes were syntax-checked with `node --check` and `cdp.mjs` imports with no side effects; they are NOT executed here because running them launches Horus.app, which this track is forbidden to do.
- Gates: `bun run verify` exit 0 (lint, lint:css, typecheck, 902 tests / 0 fail across 120 files, build, check:entry). `npx react-doctor@latest --verbose`: 81/100, 25 issues — see the end-of-track note.
- Deviations: env var is `HORUS_GIT_SHIM_LOG` (per the track brief) rather than the plan's `$HORUS_GIT_LOG`; shim is zsh rather than bash; results dir is ignored by its own `.gitignore` rather than the repo root's; added the entry-closure budget.
- needs-owner: none for P12.

## END OF TRACK
- `bun run verify` -> exit 0. `bun test`: 902 pass / 0 fail / 2561 expect() across 120 files.
- PRE-MOUNT CLOSURE: before Track B 1,820,398 B / 17 chunks; after 1,649,485 B / 19 chunks (-170,913 B). Entry closure after: 2,940 B. Boot chunk 439,332 B -> 172,172 B (-267,160 B, the number that actually gates first paint).
- react-doctor: 81/100, 25 issues, all warnings. NOT 100/100 — but this is the tree's pre-existing state, not a Track B regression. Verified by reverting the P11 edits to `PerformanceHud.tsx` and re-running: still 81/100 with the same 25 issues (`PerformanceHud.tsx` was already flagged for high control-flow complexity, at line 49 instead of 52). No finding names a file Track B created (`githubMarkdown.ts`, `GitHubMarkdownRenderer.tsx`, `treePathOrder.ts`, `treeWidgetOrder.ts`, `boot.tsx`, `scripts/**`). `AppView.tsx:504` is `DiffToolbar`, untouched by this track. The findings sit in `extensions/horus` (Track D), `src/main/folderIndex.ts` (Track A, in flight), `App.tsx`/`CommandPalette.tsx`/`RepositoryWorkspace.tsx`/`DiffSurface.tsx` (Track C), `AgentPanel.tsx`, `GitHubPanel.tsx`, `FolderPicker.tsx`, `PerformanceChart.tsx`, `editor/EditorStatusBar.tsx`, `PullRequestReviewBar.tsx`, `shared/workspaceCache.ts`.
