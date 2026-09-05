# Wave 1 review feedback (Fable) — collected during the run

## Track A

### P01-R1 (must fix) nested repository at walk depth 0 is expanded
`src/main/ignoredListing.ts` `walkIgnoredDirectory`: the boundary check is
`if (depth > 0 && entries.some(e => e.name === '.git'))`. When git's `--directory`
listing reports an ignored directory that is itself a nested repository (e.g.
`vendor/` with its own `.git`), legacy `git ls-files --others --ignored` prints
`vendor/` and stops; the new walk descends and prints `vendor/lib/x.js`.
Reproduced on a synthetic repo (scratchpad/p01check): legacy `vendor/`, new
`vendor/lib/x.js`. Fix: drop the `depth > 0` condition (the repository root is
never walked, so there is no false positive at depth 0). Add the case to the
equivalence test (ignored dir that is a git repo at top level).

### P01-R2 (resolved, no action) `revision: Date.now()` vs watcher's monotonic `#revision`
`repositorySessions.ts` publishes `{ revision: Date.now() }` from the snapshot
observer (new) and from `#refreshAndPublish` (pre-existing). The watcher
publishes a small monotonic counter. Verify how the renderer uses `revision`; if
it is compared for staleness, mixing the two domains drops later watcher events.
Checked: renderer only uses `revision` as a change token (`setRevision`, item-id
prefix) and `markRevision` is guarded by `changedPaths.includes(selectedPath)`;
an observer publish with `changedPaths: []` triggers no reload. Harmless.

### P01-R3 (note) `MAX_EXPANDED_IGNORED_DIRECTORIES = 32` drops directories silently
First 32 surviving directories in git order are expanded, the rest vanish from
the Explorer with no signal. Acceptable for now; log a one-line
`console.warn` once per root when the cap is hit so we can see it in the field,
or expand in git order but prefer shallow (fewer `/`) directories first.

### P01-R4 (note) stale-late merge race
`withIgnoredListingDeadline` calls `onLate` even when a newer run has replaced
`#ignoredRun`; the walk only checks `signal` on directory entry, so a run whose
walk had already finished can merge a stale set after a newer refresh started.
Guard `#mergeIgnoredPaths` on the run identity (pass the controller in).

### P02 reviewed: OK
`commandEnvironment()` on both spawn paths, self-write announced before and after
the git cycle, watcher test covers armed/unarmed `.git/index` and `.git/HEAD`.
No changes requested.

## Track B

### P08 reviewed: OK
Render before preloads; `mountApp` sync; dom test with never-settling preloads.
No changes requested.

### P09 reviewed: OK with two notes
- Lazy boundary moved inside `GitHubMarkdownContent.tsx` (call sites not owned);
  three non-owned dom tests made async — justified, no collision with Track A.
- P09-N1: fallback `<pre>` wrapper uses inline styles because `styles.css` was
  not owned. Move the 4 properties into `styles.css` under
  `.github-markdown-fallback` in the Wave 3 CSS pass (P30) or the fix round.
- P09-N2: pre-mount closure 1,820,398 -> 1,656,390 B (-164 KB, not the planned
  -240 KB) because hast/property-information/entities are shared with shiki's
  HTML serializer, which is still pre-mount. Confirms P31 must move shiki off the
  boot path before the 900 KB budget is reachable. Keep `vendor-*` naming.

### P03 reviewed: one must-fix
### P03-R1 (must fix) watcher ticks can join a refresh that predates the change
`refresh()` joins the in-flight run whenever `#mutation` is unchanged, and only
internal writes bump `#mutation`. The watcher (`repositorySessions.ts`
`#createSession`: `new RepositoryWatcher(() => repository.refresh(), ...)`) reports
EXTERNAL writes. Sequence: refresh R1 spawns `git status` at T0; an external
edit lands at T1 > T0; the watcher fires at T1+80 ms and calls `refresh()` while
R1 is still running (it now runs 60-500 ms because of the ignored-listing
deadline); the call joins R1, whose `status` already read the tree before T1; no
further run is scheduled; the snapshot stays stale until the next event.
Before P03 every tick ran its own cycle, so this is a new staleness bug.
Fix: add `refreshAfterExternalChange(): Promise<RepositorySnapshot>` on
`RepositoryService` that does `this.#mutation += 1; return this.refresh()` and
wire the watcher callback to it in `#createSession`. The dedupe still collapses
the restore/open/handler storm (those are not external changes). Test: start a
refresh, call `refreshAfterExternalChange()` while it is pending, assert a
distinct promise chained behind the first and that it observes a file written
between the two calls.

### P10 reviewed: OK
Faithful port of the path-store comparator (tested against `prepareFileTreeInput`
on 200 paths + rotations); boot chunk 244,810 -> 183,433 B. Pre-mount closure
flat because @pierre/trees moved into WorkspaceRoot, which is itself pre-mount —
expected, the Explorer needs it to paint.
- P10-N1 (carry to Wave 2 Track C, owns App.tsx/AppView.tsx): lazy `Welcome`
  (`AppView.tsx:317`, 33.6 KB of @pierre/icons in boot). New `Welcome.tsx`,
  `lazy()` in the `workspaceStage === 'welcome'` branch, `Suspense fallback={null}`.

### P04 reviewed: OK with notes
Race logic correct: win -> return live, publish nothing; loss -> listing now,
`#publishRefreshed` later; refresh rejection -> listing + reportError.
- P04-N1 (nit): `workspaceListing.ts` `SKIP_DIRECTORIES` adds `'vendor'`, which is
  not in `EXCLUDED_DIRECTORIES`; the live snapshot lists tracked `vendor/` files
  (Go repos), so the skeleton and live trees disagree for 150 ms. Drop `'vendor'`.
- P04-N2 (carry to fix round, `src/shared/contracts.ts`): add
  `stage?: 'skeleton' | 'live'` to `RepositorySnapshot`; `listRootSnapshot` sets
  `'skeleton'`, `#refreshSnapshot`/`#refreshFolder` set `'live'`. P27 needs it.
- P04-N3 (verify with P05): after a win, `openRepository` must not call
  `repositorySessions.refresh(root)` on the same tick — with P03's dedupe a call
  after the run settled starts a second full cycle. Expect exactly one git cycle
  per Cmd+O (git shim count).

### P11 reviewed: OK
Lazy HUD + idle first sample gated on popover open; boot chunk -11 KB.

### P05 + post-P05 dedupe release fix reviewed: OK
`refresh(root)` on the registry; `openRepository` cache path refreshes the opened
root; release inside the run's then-handlers guarded by `#refreshGeneration`
(queued run keeps `#refreshRun` because the older generation's release no-ops).
P04-N3 resolved: `open()` path does not call `refresh()` again.
P03-R1 still applies (watcher callback must bump the mutation counter).

### Track A final report, review-note checks
- (3) `open()` publishes nothing when the race wins: checked main — the registry's
  publish callback only forwards to renderer webContents; workspace-cache
  persistence runs through `trackSnapshot` (refresh/save IPC), the cached-open
  refresh, and `persistWorkspaceUi` from the renderer. No main-side consumer of
  that publish. OK.
- (2) `#mergeIgnoredPaths` guard `snapshot.paths === trackedPathsCache.paths`:
  correct for hydrate (hydrate does not touch `#trackedPathsCache`) and for a
  newer refresh (it replaces the cache). Combine with P01-R4 (run identity) and
  it is airtight.
- (5) dotfiles in the skeleton listing: correct, matches live.

## Fix round (single Opus agent, whole repo, after Track B lands)
Must fix: P01-R1, P03-R1. Should fix: P01-R4, P04-N1, P04-N2 (contracts `stage`),
P09-N1 (CSS class instead of inline styles). Carry to Wave 2C: P10-N1 (lazy Welcome).
Plus whatever the full gate run + probes + Track B review add.

### P12 reviewed: OK with one ratchet
Probes ported cleanly (shim confirmed to reach Horus via `open -na`: 3 spawns
logged on the old build). `premountClosure.mjs` static-edge walk is sound; the
entry-closure budget caught a real regression (preload-helper folded into
vendor-shiki).
- P12-N1: ratchet `MAX_PREMOUNT_BYTES` 1_900_000 -> 1_700_000 now that the
  closure is 1,649,485 B; keep ratcheting after each wave (target 900,000).

# Wave 2 review feedback (collected during the run)

## Cross-track carry item
- W2-X1 (App.tsx, after Track C finishes): Track D changed
  `onOpenExternalPullRequest(listener: (url, root) => void)`; App.tsx's `open`
  callback (~:702) must accept `(url, root)` and call
  `gitWorkflow.openPullRequestFromLocator(url, root)` so the main-resolved root is
  the `preferredRoot`. Small win (main already dedupes), not correctness.

### P14 reviewed: OK
Host owns visibility; shell (`<dialog>` + focused input, no CommandPalette import)
renders until the module store resolves; query handoff via `initialQuery`; boot
preloads the chunk. Verify with startup-probe `palette.openMs` <= 30 ms.

### P21 reviewed: OK with one note
`PullRequestRootResolver` (quick/full tiers, shared promise, remotes + negative
caches), `previewPullRequestFolder` never probes, `applyExternalReview` publishes
`(url, root)` after a <= 150 ms quick resolution, pending URL handed over once.
- P21-N1 (design, measure before changing): `primePullRequest` only warms when a
  session for the root already exists (`repositorySessions.tryGet`). A copied PR
  URL for a repo that is not open therefore warms nothing; the first Cmd+H for it
  pays the full `gh` round trips. If pr-open-probe cold/warm numbers for a
  non-restored repo miss the target, allow the warmup to `open(root, activate=false)`
  (refresh is now ~50 ms) and rely on P25's session cap.

### P15 reviewed: OK
Search owned by the palette; settled results via `searchResultsStore` (frozen
empty, identity bail-out); cancel only when outstanding; `window.__horusMetrics`
mirrors `reviewMetrics.workspaceRenders`; dom test asserts 0 renders per 6 keys.
- W2-X2 (carry to Wave 3E / P27, owns RepositoryWorkspace.tsx + WorkspaceRoot.tsx):
  delete the now-unused `contentSearch` prop threading (RepositoryWorkspaceProps,
  WorkspaceViewerProps, two DiffSurface call sites), then drop `contentSearch` from
  DiffSurfaceProps and the `contentSearch ?? publishedSearch` line.

### R1-R6 reviewed: OK
R6 ground truth worth keeping: `.project-tree` rows live in a shadow root
(`[data-item-path]`), `window.repository` is frozen (no IPC wrapping from the
page), folder identity = active world tab label, skeleton renders "Detached
HEAD". Wave 1 build re-measured with fixed probes: open imux 16 ms, core-3 196 ms,
better-code-diff 103 ms (live via DOM branch); FCP renderer clock 164-308 ms;
PR 717 warm first code view 1,440 ms, cold 2,696 ms, no files/done events (PR-2).

### P16 reviewed: OK
Kind-aware index cached per snapshot identity; empty query = recents -> changed ->
top-level dirs -> tree order (cap 30 files + 3 commands); recents in localStorage
per root; ghost-text completion + Tab. Directory rows narrow the query instead of
revealing in the Explorer (no reveal API).
- W2-X3 (carry to Wave 3E / P27): `RepositoryWorkspace` gains `revealPath(path)`
  (expand ancestors + scroll); App passes it to `CommandPaletteHost` as
  `onRevealDirectory` so a directory row reveals in the Explorer as the plan says.

### P22 reviewed: OK
### P23 reviewed: OK by reading; verify by probe
`PullRequestReviewFlight` multicast with synchronous replay (metadata -> pages or
replace -> checks -> done), refcounted attach/detach (warmup never claims), cached
open emits metadata+files+done with zero `gh` spawns, revalidate = `headRefOid`
+ checks in background, `replace` on head move. Expect on cached warm Cmd+H:
`.multi-file-review` <= 400 ms, progressKinds [metadata, files, done, checks],
exactly 2 gh spawns.
- P23-N1 (check in probe): the IPC promise for a cached open resolves only after
  revalidation (~700 ms). Renderer paints from events, so fine, but confirm no UI
  element (spinner/tab pill) is gated on the promise.

### P17 (both halves), P18 reviewed: OK (by log)
### P19 reviewed: significant — App and AppLayout were SKIPPED by the React Compiler
Before: `AppLayout` and `AgentSessionLayout` bailed on "refs during render" (refs
inside the `view` object literal), `App` bailed on `try/finally`, CommandPalette on
a ternary logical test. After: all hot components CompileSuccess; regression test
`reactCompiler.test.ts` runs the compiler over the four files. This is the largest
renderer-side win of Wave 2 and explains the 2.4 workspace renders/keystroke.
- W2-X4 (package.json devDependencies): add `@babel/core` explicitly (the new test
  imports it; today only transitive).
- W2-X5 (carry to Wave 3E, useReviewWorlds/useGitWorkflow): after a force-push
  `replace`, the tab keeps its original `worldId`, so `openPatchWorld` identity
  matching no longer finds it and reopening the same PR creates a second tab.
  Make `openPatchWorld` match on `patchReviewIdentity(review)` (PR URL) instead of
  `patchWorldId` for GitHub reviews.
- react-doctor note: Track D saw "Score not shown because lint or maintainability
  analysis could not complete" — warning list identical to baseline (25). Re-run
  after Wave 2 lands to confirm the numeric score.
- Measurement note (Track D): the first open of a PR after Wave 2 takes the slow path
  (no `.latest.json` yet); measure the SECOND open. run-probes.sh now runs pr-open twice.
- P23-N2 (Track D flagged): on a cache-index hit the flight promise stays pending until
  revalidation (~400-600 ms) so the world sits at `loadStatus: 'loading'` with content
  on screen. Check MultiFileReview / PullRequestReviewBar for any 'loading' indicator
  that would flash; if so resolve the promise at `done` and keep the listener alive
  separately for `replace`/`checks`.

## Wave 2 gate results (worktree, 2026-09-05 15:38)
- `bun run verify` exit 0 (lint, lint:css, typecheck, tests, build, check:entry 1,652,713 B / limit 1,700,000).
- react-doctor 0.9.13: 31 warnings vs 25 at baseline. The 6 new ones are all
  `no-multi-component-file` at AppView.tsx:130/187/286/345/371/387 (Titlebar,
  DiffToolbar, etc. in one file). Unclear whether the rule is new in the tool or
  newly triggered; either way P13 (Wave 4) splits AppView.tsx. Numeric score not
  printed: "Results are incomplete: maintainability checks failed" — investigate in P13.

# Wave 3 review feedback (collected during the run)

### P28 reviewed: OK
Semaphore max(4, cpus-2) with 2 slots reserved for interactive; background lane for
the ignored listing and non-open-root remote probes; GitObjectReader bypasses
(long-lived batch child). Reasonable.
- W3-X1 (carry to Wave 4 cleanup, repository.ts PR path): thread `lane` from
  `getPullRequestReview(intent)` through `#loadPullRequestReview` /
  `runGitHubReadCommand` so `intent === 'warmup'` runs its `gh` hops on the
  background lane.

### W2-X1, W2-X2, W2-X4, P27, W2-X3 reviewed (by log): OK
P27: picker stays until `stage === 'live'` or 400 ms; spinner only after 80 ms;
skeleton->live re-derivation disarmed by explicit selection; one collapse walk per
open. Deviation accepted (picker catalog fetch stays a non-blocking effect).

### P31 reviewed: OK, significant
Shiki engine WAS evaluated pre-mount via 4 static edges; two Vite source-rewrite
plugins (anchor-guarded, tested) make the engine import async inside
@pierre/diffs `getSharedHighlighter` and @pierre/theming `normalizeTheme`;
new vendor-diffs-edit / vendor-hast / vendor-shiki-langs chunks. Pre-mount
1,652,620 -> 1,361,302 B (-291 KB). Worker highlight path unchanged.
- W3-X2 (Wave 4 cleanup, scripts/check-entry-chunk.mjs): add a named assertion
  "no vendor-shiki chunk in the pre-mount closure" next to the WorkerPool check.
- Risk to watch on dependency upgrades: the rewrite plugins throw if anchors drift
  (good) — the build fails loudly rather than silently regressing.

### P25 reviewed: OK
Watcher pause/resume (no OS handle while paused), background opens parked, LRU cap
4 (never the active root), evicted roots reopen lazily via async `activate`.

### G1 reviewed: OK
Path-like = `/` only, pause 250 ms; file-name-hit branch removed; effect no longer
re-runs on fileResults identity. Expect contentResultsMs ~150 for "app".

### G2 reviewed: OK
Shell on the open frame, panel next frame (rAF); index warmed at idle from boot and
on snapshot change (identity-keyed); 12 rows first paint; app-side measure
`horus:palette-open-to-focus`. Important measurement fact: the probe's
`palette.openMs` includes CDP dispatch + poll round trips (44-67 ms), so the
app-only number needs the new measure.
- W3-X3 (Wave 4 cleanup, scripts/perf/startup-probe.mjs): read the
  `horus:palette-open-to-focus` performance measure after the palette opens and
  report it as `paletteOpenAppMs` next to `openMs`.

### P26 reviewed: OK with one watch item
Count-only cap (no stringify), Set membership per path array, 3-slot store with
v1 migration, atomic chained writes, fileText on its own channel keyed by content
identity, UI persist keyed by string. `bun test` 1,071 pass.
- Watch: MAX_CACHED_PATHS 20k -> 25k grows the synchronous preload read
  (`sendSync` of the cache) on very large repos; if a 25k-path repo shows a
  pre-mount regression in `mainStartup`/`fcpRendererMs`, drop back to 20k.

### P30 reviewed: PARTIAL accepted, target revised
Boot CSS 172,331 -> 79,773 B (-54%); remainder is tokens/resets/app shell/explorer/
diff container that the cached first paint needs. 60 KB would require moving
boot-path rules — not worth it. Revise target to <= 85 KB and hold. Squircle scoped
off pseudo-elements (opt-outs preserved). Resizer transform-only drag rejected
(grid track = width; would ghost) — correct call; redundant writes removed instead.

## Wave 3 final-report carries (for the Wave 4 cleanup track)
- W3-X4 (repository.ts `open`): accept a pre-resolved root (`open(folderPath, resolved = false)`)
  and have `repositorySessions.open()` pass `true`, removing the last redundant realpath.
- W3-X5 (scripts/perf/startup-probe.mjs): `palette.emptyRows` can race the staged rows
  (12 then 34 a frame later); read it after a short settle (or wait until the count is
  stable across two polls). Also W3-X3 (paletteOpenAppMs from the measure).
- P25 watch: eviction with 5+ folders open during a background PR flight cancels that
  flight (world recovers via lazy activate). Acceptable; keep an eye on it.
- P30 watch: moved rules now load after boot.css; equal-specificity overrides that
  relied on order could flip. Visual check of agent panel, HUD, settings, GitHub panel,
  terminal dock after install.

## Wave 4 start (16:45)
- react-doctor score failure root cause (found by H1): dead-code pass reads `git ls-files`
  and threw ENOENT on the P22-deleted `extensions/horus/src/warmup-clipboard.ts` whose
  deletion was unstaged. Orchestrator staged the deletion (`git rm --cached`, no commit).
  Score prints again: 81/100, 30 warnings, 14 files — same score as the baseline.

## Wave 4 outcome (17:40)
- react-doctor 100/100, 0 issues (independently verified); `bun run verify` green; 1,144 tests.
- Pre-mount closure 1,361,302 -> 1,380,922 B (+19.6 KB ES-module plumbing from ~90 new
  files; limit 1,403,000). Acceptable; ratchet stays.
- Not done, for a future session (from H2's notes): `vendor-shiki-langs` (31 KB lazy
  language table) is still statically imported by vendor-diffs and sits pre-mount; a
  foreground reader joining an in-flight warmup inherits the background lane (needs
  semaphore promotion).
- H1 ground truth: `no-high-complexity-react-function` counts only a component's own
  top-level control flow (floor cyclomatic 14 / cognitive 16); move JSX branch clusters
  into children or pure `xxxModel.ts` helpers.
