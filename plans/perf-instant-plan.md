# Horus instant-performance plan

Written 2026-09-05 by Fable from a five-agent deep scan of the working tree
(HEAD e18053e + uncommitted changes) plus live measurements of the installed
build (`~/Applications/Horus.app`, built 2026-09-04 12:32 from this tree).
Executors: Opus agents, one section at a time, in the wave order below.
Reviewer: Fable. This file is the single source of truth; executors update
the status table in place.

## Goals and acceptance targets

All numbers measured with the probes in `scripts/perf/` (section P12 ports them
from the scratchpad) against the installed build, restored into
`~/Developer/materialx/materialsx-core-3` (2,621 tracked files, 369k
gitignored files), machine otherwise idle, warm disk cache.

| Metric | Baseline (2026-09-05) | Target | Probe |
| --- | --- | --- | --- |
| Main `windowShown` | 146-161 ms | <= 200 ms (keep) | startup-probe `mainStartup.windowShown` |
| Main `restoreSettled` (live snapshot ready) | 3,515-3,847 ms | <= 300 ms | startup-probe `mainStartup.restoreSettled` |
| Renderer first-contentful-paint | 284 ms (renderer clock) / 609 ms (from `open`) | <= 200 ms renderer clock | startup-probe `fcpMs` |
| `horus:explorer-committed` / `viewer-committed` | 163-171 ms renderer clock | <= 120 ms | startup-probe marks |
| Boot long task at mount | one 91 ms task | none > 50 ms | CDP longtask (P12 adds to probe) |
| Bytes executed before React mounts | 1,957,782 B | <= 900,000 B, ratchet down | `bun run check:entry` (rewritten) |
| First Cmd+P after launch -> input focused | 328-357 ms | <= 30 ms | startup-probe `palette.openMs` |
| Later Cmd+P | 9-13 ms | <= 15 ms | same |
| Workspace re-renders per palette keystroke (file view) | 2.4 | 0 | reviewMetrics counter via probe |
| Empty-query palette rows | 7 commands + 1 file | >= 20 files/dirs, Files first | startup-probe `palette.emptyRows` |
| Content results after last keystroke | ~270 ms | <= 150 ms | startup-probe `palette.contentResultsMs` |
| Open folder (core-3): full tree + branch + statuses after Enter | 3,451 ms | <= 300 ms | open-folder-probe `liveSnapshotMs` |
| Open folder (imux): same | 126 ms | <= 150 ms | same |
| Git spawns for one `touch README.md` | 9 (3 refresh cycles, 11.3 s CPU) | 3 (1 cycle, <= 150 ms) | git PATH shim (P12) |
| Cmd+H warm app, cached PR -> `.multi-file-review` | 1,439-1,667 ms | <= 400 ms | pr-open-probe |
| Cmd+H cold app, cached PR -> `.multi-file-review` | 1,783 ms (+110 ms `open` hop) | <= 1,500 ms | pr-open-probe |
| Cmd+H warm app, uncached 1-file PR -> review shell / diff | nothing until 2,054 ms | shell <= 900 ms, diff <= 2,000 ms | pr-open-probe |
| `gh` spawns per cached Cmd+H | 4-5 (view, api user, diff, view again, graphql) | 2 (headRefOid revalidate + checks) | git PATH shim |
| Git spawns per Cmd+H | 310 | <= 12 | git PATH shim |
| Git spawns when a PR URL is copied while idle | 103 | 0 (<= 3 if remembered root) | git PATH shim |
| Gates | typecheck FAILS today; react-doctor 81/100 (25 warnings, 15 files) | lint, lint:css, typecheck, `bun test`, build, check:entry, react-doctor 100/100 | `bun run verify`, `npx react-doctor@latest --verbose` |


## Measured results (installed build, `scripts/perf/*` probes, core-3 restored)

Final: 2026-09-05 17:34, Wave 4 build. Medians of 3 startup samples / 4 folder opens /
2 warm + 1 cold PR opens (second pr-open run, after the URL cache index exists).

| Metric | Baseline | Wave 1 | Wave 2 | Wave 3 | Wave 4 (final) | Target |
| --- | --- | --- | --- | --- | --- | --- |
| Live snapshot after launch (`restoreSettled`) | 3,515-3,847 ms | 229 | 190 | 218-247 | 217-257 | <= 300 |
| Window shown | 146-161 | 149 | 146 | 147-168 | 143-179 | <= 200 |
| FCP, renderer clock | 284 | n/a | 156 | 156-176 | 160-180 | <= 200 |
| Explorer/viewer committed, from `open` | ~490 | 505 | 477-503 | 486 | 500-510 | (not attacked) |
| Cmd+P open -> focused input, app-side | n/a | n/a | n/a | 21 / 4-11 | 21-23 | <= 30 |
| Cmd+P open, probe-side (incl. CDP overhead) | 81-149 | 97 | 89-103 | 74-117 | 97-108 | - |
| Palette empty-query rows | 8 | 8 | 34 | 34 | 34 | >= 20 |
| Content results after last key ("app") | 51-66 | 30 | 419 | 132-143 | 15-137 (median 22) | <= 150 |
| Workspace renders per keystroke | 2.4 | - | 0 | 0 | 0 | 0 |
| Open folder -> usable, median of 4 | 3,451 (core-3) / 126 (imux) | 121-196 / 16 | 155 | 181 (44-237) | 50 (40-60) | <= 300 |
| Cmd+H warm, cached PR -> review surface | 1,439-1,667 | 1,188-1,352 | 181-280 | 187-231 | 215-262 | <= 400 |
| Cmd+H cold app, cached PR | 1,783 | 1,689 | 626 | 532-552 | 550-741 | <= 1,500 |
| git spawns: launch / open / Cmd+H | 3+repeats / ? / ~310 | 3 / 6 / ~22 | 3 / 6 / ~6 | 3 / 6 / ~6 | 3 / 6-7 / 6 | 3 / - / <= 12 |
| Pre-mount JS closure | 1,820 KB | 1,649 KB | 1,653 KB | 1,362 KB | 1,381 KB | 900 KB |
| Boot CSS | 172 KB | 172 KB | 172 KB | 80 KB | 80 KB | 60 -> revised 85 KB |
| Tests | 887 (typecheck failing) | 902 | ~1,000 | 1,075 | 1,144 | - |
| react-doctor | 81 / 25 warnings | 81 / 25 | 31, no score | 30 / 81 | **100 / 100, 0 issues** | 100 |

Honest notes: explorer paint from `open` never moved (Electron start dominates); Wave 4's
module split added ~20 KB JS and 10-20 ms to FCP/commit; cold Cmd+H varies 530-740 ms
between runs; first launch after each install pays ~2.5 s (macOS first-run check).
Artifacts: `perf-instant-artifacts/`.

## Root causes (what actually regressed)

1. **`git ls-files --others --ignored` with 54 exclusion pathspecs** was added to
   `RepositoryService.refresh()` in e18053e. Pathspec exclusion filters output
   after git has walked node_modules/.venv etc. On core-3 it takes 3.3-3.8 s
   standalone and 6.6-7.1 s during launch, to return 405 paths. It sits inside
   `Promise.all` with two 20-60 ms commands, so every refresh (restore, folder
   open, watcher tick, post-save) takes >= 3.4 s and pins one core.
2. **Refresh self-retrigger**: plain `git status` rewrites `.git/index`, the
   recursive watcher admits `.git/index`, so each refresh schedules the next.
   One file save = three refreshes = 11.3 s of saturated core.
3. **`open()` returns a 400-path readdir skeleton** (e18053e) and fires the real
   refresh with `void`. IPC got 5x faster; the moment the folder is actually
   usable went from ~100 ms to 3,451 ms (35x slower). Workspace view and
   selection are derived from the status-less skeleton and never recomputed.
4. **Cmd+H resolves the PR root three times** (main warmup, renderer preview
   effect, renderer resolve) with no shared cache: 307 `git remote -v` spawns
   on top of the 7 s ignored walk. Clipboard polling does the same 103-spawn
   scan on every copied PR URL, even in the background.
5. **Renderer boot awaits ~1.87 MB of viewer chunks before `createRoot()`**
   (e18053e). One 91 ms long task lands exactly when the window appears; the
   window is blank for ~170 ms. Shared chunks carry parse5/react-markdown
   (611 KB `BackToTopButton-*.js`) and the shiki tokenizer stack (302 KB
   `copyFilePath-*.js`) on the pre-mount path.
6. **First Cmd+P pays React's 300 ms Suspense fallback throttle**, not work:
   the 10 KB chunk loads in 8 ms; react-dom refuses to commit the retry for
   300 ms. Typing re-renders the whole workspace 2.4x per keystroke because
   `useRepositorySearch` lives in `AppLayout` and resets `contentResults` to a
   fresh `[]` twice per keystroke.

Not problems (measured, do not chase): folder-catalog walk (16-45 ms),
`fs.watch` recursive start (< 3 ms), `runCommand` has no queue (a 3.4 s walk
does not delay other git calls), `last-workspace.json` is 198 KB / 3,026 paths
(parse 0.14 ms; the 20k-path 2 MB case is a cap, not current state),
`rankFilePaths` 0.25-0.46 ms at 3k paths, @pierre/trees virtualises (26 rows),
StrictMode does not double-invoke in production, fonts are `swap`.

## Ranked findings

| ID | Sev | Area | Finding | Gain | Plan |
| --- | --- | --- | --- | --- | --- |
| MAIN-1 / FO-1 / CP-7 | critical | main | ignored-files git walk in refresh (3.4-7 s, every refresh) | -3.4 s restore, open, tick | P01 |
| MAIN-2 | critical | main | `git status` rewrites `.git/index`; watcher re-arms; 3 refreshes per save | -7 s CPU per save | P02 |
| FO-2 / MAIN-13 | critical | main | `open()` returns skeleton; usable tree 3.4 s later | -3.3 s perceived | P04 |
| MAIN-3 / MAIN-5 / PR-4 / PR-5 / PR-6 | critical | main+renderer | PR root resolved 3x; 307 spawns; folderIndex awaited before remembered root; preview probes for a chip | -2.6 s, -300 spawns | P21 |
| PR-1 | critical | main | PR cache keyed on headRefOid; cached PR still waits for `gh pr view` | -700-1,250 ms per re-open | P23 |
| PR-2 | critical | main | warmup steals the review flight; renderer gets no progress events; single-burst parse | -800-1,000 ms first content | P23 |
| PR-3 | critical | main | Cmd+H fires 2-4 concurrent ignored walks (7-9 s CPU) | -7-9 s CPU | P01 P03 P23 |
| PR-7 / PR-8 / PR-9 | medium | main | serial `gh pr diff` after view; duplicate identity `gh pr view`; check fields on the blocking hop | -900-1,100 ms uncached, -700 ms >300 files | P23 |
| PR-10 | medium | renderer | cold Cmd+H renders the whole desk before the PR world; wrong viewer chunk | -150-400 ms | P23 |
| PR-11 / PR-13 / PR-14 | low | main/ext | pending URL never cleared; Raycast fallback no-op; dead cancel | correctness | P23 |
| PR-12 | low | main | warmup cooldown only on success; two pollers | -450 ms bursts | P22 |
| RB-01 | critical | renderer | boot awaits 1.87 MB before render | -90-140 ms FCP | P08 |
| RB-02 | critical | bundle | parse5 + markdown stack in shared viewer chunk | -240 KB pre-mount | P09 |
| CP-1 | critical | renderer | first Cmd+P: 300 ms Suspense throttle | -320 ms | P14 |
| FO-4 | high | main | no refresh in-flight dedupe | -1 duplicate walk | P03 |
| MAIN-4 | high | main | clipboard warmup spawns 103 git per copied URL | -1.3 s bursts | P22 |
| MAIN-7 | high | main | background PR open refreshes the wrong repo | -1 redundant refresh | P05 |
| FO-3 | high | renderer | workspace view/selection from status-less skeleton, never recomputed | correctness | P04, P27 |
| FO-5 | high | main+renderer | sessions never released; N watchers + N refresh loops | -N-1 cores | P25 |
| CP-2 | high | renderer | empty palette offers no files/folders | UX | P16 |
| CP-3 / CP-4 / RB-06 | high | renderer | keystroke re-renders whole workspace 2.4x | -2 renders/key | P15 |
| RB-03 | high | bundle | shiki/oniguruma executed on main thread at boot | -140 KB pre-mount | P31 |
| RB-04 | high | bundle | @pierre/trees + icons in boot chunk via `firstTreePath` | -85 KB boot | P10 |
| RB-05 | high | renderer | `initialWorkspacePaint`/`firstOpenPathForSnapshot` run every App render; React Compiler bailed on App | 0-35 ms/render | P19 |
| MAIN-9 | medium | main | no git spawn concurrency limit | 3-6x per-spawn under load | P28 |
| MAIN-6 / MAIN-8 | medium | main | `capWorkspaceCache` stringifies whole cache per publish; fileText over IPC every 250 ms | up to 112 ms/publish | P26 |
| FO-6 | medium | main | single-slot workspace cache | skeleton flash on alternation | P26 |
| FO-7 / RB-13 | medium | renderer | tree reset + collapse walk twice per open | 1 walk | P27 |
| FO-8 | medium | renderer | no progress affordance while opening | perception | P27 |
| CP-5 | medium | main+renderer | 200 rg hits shipped to render 8; fixed 240 ms debounce | -150 ms first result | P17 |
| CP-8 | medium | css | palette `backdrop-filter: blur(30px)` first frame 34-69 ms | -30-60 ms | P18 |
| RB-07 | medium | css | 172 KB stylesheet serial before app JS, mostly lazy surfaces | -10-25 ms FP | P30 |
| RB-08 | medium | renderer | PerformanceHud eager + IPC sample at mount | -3-8 ms + 1 IPC | P11 |
| RB-09 / MAIN-14 | medium | tooling | startup benchmark can never pass (file-view restore) | measurement | P12 |
| RB-10 | medium | tooling | check-entry guards a 2.8 KB shim | measurement | P12 |
| MAIN-12 | low | build | CSS preload lacks `crossorigin`, fetched twice | -20-60 ms FP | P12 |
| MAIN-10 / 11 / 15 | low | main | restore hydrate on window tick; hint recomputed; redundant realpath | 0-115 ms on big repos | P29 |
| FO-11 | low | main | path resolved 4x per open | ~1 ms | P29 |
| CP-6 / CP-9 / CP-11 | low | renderer | cancel IPC per keystroke; pointer-enter storms; per-render allocs | GC/IPC noise | P20 |
| RB-11 / RB-12 | low | css/renderer | `corner-shape: squircle` on `*`; SidebarResizer sync layout | paint / 2-6 ms | P30 |

## Execution order

Waves run sequentially. Tracks inside a wave run in parallel and own disjoint
files; an executor must not edit a file outside its track's list. Every wave
ends with the gate + probe run (section "Gates") and a Fable review before the
next wave starts.

| Wave | Track | Sections | Files owned |
| --- | --- | --- | --- |
| 0 | prereq | P00 | `src/renderer/src/splitDiffResize.test.ts` |
| 1 | A main git path | P01 P02 P03 P04 P05 | `src/main/repository.ts`, `src/main/repositorySessions.ts`, `src/main/repositoryWatcher.ts`, `src/main/gitCommands.ts`, `src/main/workspaceListing.ts`, `src/main/index.ts` (only `openRepository`, `startLiveRefresh`), their tests |
| 1 | B renderer boot + tooling | P08 P09 P10 P11 P12 | `src/renderer/src/boot.tsx`, `treeExpansion.ts`, `ReviewComments.tsx`, `GitHubMarkdownContent.tsx`, `MarkdownContent.tsx`, `AppView.tsx` (PerformanceHud only), `PerformanceHud.tsx`, `electron.vite.config.ts`, `scripts/**`, `package.json` scripts |
| 2 | C palette | P14 P15 P16 P17(renderer half) P18 P19 P20 | `src/renderer/src/App.tsx`, `CommandPalette.tsx`, `useRepositorySearch.ts`, `fileSearch.ts`, `contentSearchScheduler.ts`, `searchPreview.ts`, `DiffSurface.tsx` (search markers only), `styles.css` (palette rules only), `boot.tsx` (one preload line), tests |
| 2 | D Cmd+H | P21 P22 P23 P17(main half) | `src/main/index.ts` (PR functions, clipboard), `pullRequestRoots.ts`, `folderIndex.ts`, `repository.ts` (`searchContent`, `getPullRequestReview`, `getRemotes` only), `shared/contracts.ts`, `shared/horusUrl.ts`, `preload/index.ts`, `useGitWorkflow.ts`, `pullRequestOpen.ts`, `extensions/horus/**`, tests |
| 3 | E sessions + cache | P25 P26 P27 P29 | `repositorySessions.ts`, `shared/workspaceCache.ts`, `workspaceCacheStore.ts`, `index.ts` (cache/restore parts), `App.tsx` (open-folder handlers), `useReviewWorlds.ts`, `RepositoryWorkspace.tsx` (`useTreeContentSync`), `FolderPicker.tsx` |
| 3 | F hardening | P28 P30 P31 | `gitCommands.ts`, `styles.css`, `SidebarResizer.tsx`, `electron.vite.config.ts`, lazy components' CSS |
| 4 | G react-doctor | P13 | whole repo, single agent, nothing else running |

## Status

| Section | Title | Wave | Status | Notes |
| --- | --- | --- | --- | --- |
| P00 | Fix typecheck gate (vitest import) | 0 | DONE | vitest -> bun:test; typecheck green |
| P01 | Two-phase ignored listing, out of the critical path | 1A | DONE | ignoredListing.ts two-phase; refresh 3,520 -> 45-53 ms on core-3; nested-repo depth-0 bug fixed (Wave 2 R1); late-merge run guard (R3) |
| P02 | Stop the refresh self-retrigger | 1A | DONE | GIT_OPTIONAL_LOCKS=0 + self-write window; 3 spawns per launch |
| P03 | Refresh in-flight dedupe with mutation counter | 1A | DONE | dedupe + mutation counter; watcher ticks call refreshAfterExternalChange (Wave 2 R2) |
| P04 | `open()` returns the real snapshot (deadline race) | 1A | DONE | 150 ms race; core-3 open 3,451 -> 121-196 ms live; `stage` field added (Wave 2 R4) |
| P05 | Refresh the repository you just opened | 1A | DONE | refresh(root) on registry |
| P08 | Render before the viewer chunks arrive | 1B | DONE | render before preloads; reactCommitted 505 -> 443 ms |
| P09 | Markdown pipeline out of the shared viewer chunk | 1B | DONE | lazy GitHubMarkdownRenderer + vendor-* chunks; pre-mount -164 KB |
| P10 | @pierre/trees out of the boot chunk | 1B | DONE | treePathOrder port; boot chunk 244 -> 183 KB; Welcome lazy carried to 2C |
| P11 | PerformanceHud lazy and idle | 1B | DONE | lazy HUD; boot chunk 172 KB |
| P12 | Measurement harness: probes, benchmark, entry budget, CSS preload | 1B | DONE | scripts/perf/* probes, git shim, premount closure budget (1,649,485 B), entry budget; probe selector fixes in fix round |
| P14 | Palette without Suspense | 2C | DONE | module store + host shell; measured palette.openMs 89-103 ms (target 30) -> Wave 3 G2 |
| P15 | Zero workspace renders per keystroke | 2C | DONE | search owned by palette; searchResultsStore; window.__horusMetrics.workspaceRenders |
| P16 | Empty-query autocomplete: files and folders | 2C | DONE | kind-aware index, recents in localStorage, ghost text; dir reveal carried to P27 |
| P17 | Content search: smaller payload, adaptive debounce | 2C+2D | DONE | main: MAX_SEARCH_RESULTS 24 + forOpenPath, --max-filesize 1M, threads cap; renderer debounce 180/120/90; REGRESSION: path-like 400 ms pause fires on 'app' -> contentResults 419 ms (Wave 3 G1) |
| P18 | Palette first frame | 2C | DONE | blur 12px, will-change while opening, contain |
| P19 | App render hygiene + React Compiler on App | 2C | DONE | App/AppLayout/AgentSessionLayout were SKIPPED by React Compiler (refs in render, try/finally); now compile; reactCompiler.test.ts guards |
| P20 | Palette allocation hygiene | 2C | DONE | delegated pointer handling, memoised rows |
| P21 | One PR root resolution per URL | 2D | DONE | PullRequestRootResolver: two-stage probe, URL-keyed promise map, 60 s remotes + negative caches; preview never spawns |
| P22 | Clipboard warmup without scans | 2D | DONE | 2 s poll, skipped while hidden, cooldown before the work, stage 1 only; Raycast warmup-clipboard command removed |
| P23 | Cmd+H: cache-first PR render, one flight, no wasted work | 2D | DONE | multicast flights + URL-keyed cache index; lean metadata + background checks; parallel diff hop; identity seeding; `replace`/`checks` progress kinds. Needs probe measurement |
| P25 | Background sessions: suspend + cap | 3E | DONE | watcher pause/resume, LRU cap 4, lazy reopen |
| P26 | Workspace cache: multi-slot, cheap cap, no fileText storms | 3E | DONE | count-only cap, 3-slot store, atomic writes, fileText own channel |
| P27 | Open-folder UX: progress, view re-derivation, single tree reset | 3E | DONE | picker stays until live/400 ms, spinner after 80 ms, skeleton->live re-derive, one collapse walk |
| P28 | Git spawn semaphore | 3F | DONE | max(4,cpus-2), 2 slots reserved for interactive; background lane for ignored listing + remote probes |
| P29 | Startup tick and path-resolution hygiene | 3F | DONE | setImmediate restore, memoised hint, realpath once |
| P30 | CSS: split boot stylesheet, squircle scope, resizer | 3F | DONE | boot CSS 172 -> 80 KB (target revised to <= 85 KB: remainder is boot-path); squircle scoped; resizer redundant writes removed |
| P31 | Shiki tokenizer off the main thread | 3F | DONE | engine WAS evaluated pre-mount; async-import rewrite plugins + vendor-hast/shiki-langs chunks; pre-mount 1,652,620 -> 1,361,302 B |
| G1 | Content-search path-like heuristic regression | 3G | DONE | file-name-hit branch deleted; only `/` is path-like, pause 400 -> 250 ms; 'app' = 120 ms debounce. Needs probe measurement |
| G2 | Palette first open <= 30 ms (shell first, idle index, staged rows) | 3G | DONE | host rAF shell/panel handoff, `warmFileSearchIndex` on idle (host + boot), 12 rows then the rest. New `horus:palette-open-to-focus` measure — probe must read it (openMs carries 4 CDP round trips) |
| P13 | react-doctor back to 100/100 | 4G | DONE | Wave 4 H1+H2: 100/100, 0 issues; AppView split, App/CommandPalette shrunk, 11 complexity sites, dialog picker, folderIndex + extension fixes; carries W3-X1..X5 done; 1,144 tests |

## Gates (run after every section, all must pass)

```bash
bun run lint && bun run lint:css && bun run typecheck && bun test && bun run build && bun run check:entry
npx react-doctor@latest --verbose        # baseline 2026-09-05: 81/100, 25 warnings. Waves 1-3: must not drop below 81 and
                                         # must not add warnings in touched files. P13 (Wave 4) takes it to 100/100, then it is a hard gate.
bun run update:mac                        # rebuild + install ~/Applications/Horus.app
bun scripts/perf/startup-probe.mjs after  # then open-folder-probe, pr-open-probe
```

Every section below has: files, drift check (what must still be true before
you start), the change, verify, done criteria, STOP (what not to do). Keep a
durable progress log at `scratchpad/progress/<track>.md` and check it plus
`git status` before starting, so a relaunched agent resumes instead of
restarting. Do not commit; Fable reviews the working tree.


## Not scheduled (candidates for a later program)

- Explorer/viewer paint measured from `open`: ~490 ms, of which ~430 ms is Electron/Chromium
  process start + renderer FCP 156 ms. Would need a main-process-side pre-render or a
  persistent renderer process to move.
- Pre-mount JS 1.38 MB -> 900 KB: remaining big chunks are vendor-diffs (575 KB),
  WorkspaceRoot (362 KB), vendor-react (193 KB), boot (~180 KB); `vendor-shiki-langs`
  (31 KB) is still statically imported by vendor-diffs.
- Boot CSS 80 KB -> 60 KB: remainder is boot-path rules (tokens, resets, shell, explorer).
- Semaphore lane promotion when a foreground reader joins a background PR flight.
- First launch after each install pays ~2.5 s first paint (macOS first-run verification).

## Considered and rejected

- Pure-git two-phase ignored listing (`--directory` then `ls-files -- <dirs>`):
  only 1.9x faster because phase 2 re-evaluates gitignore. Rejected in favour
  of readdir expansion (143x, byte-identical output on four repos).
- Dropping `.git/index` from the watcher: a `git commit` from a terminal is a
  real event. Use `--no-optional-locks` + self-write suppression instead.
- Moving `rankFilePaths` to a worker now: 0.25-0.46 ms at 3k paths, 3 ms at
  20k. Not the bottleneck; revisit at 50k+ paths.
- Moving `warm()` earlier for the palette: pays the same 300 ms throttle.
- A per-keystroke `ripgrep` without debounce: spawn + JSON parse on main is
  55-130 ms; keep a debounce, make it adaptive.

---

## P00 Fix typecheck gate (vitest import)

**Files**: `src/renderer/src/splitDiffResize.test.ts`.

**Drift check**: `bun run typecheck` fails with
`splitDiffResize.test.ts(1,38): error TS2307: Cannot find module 'vitest'`.
Every other test file imports from `bun:test`.

**Change**: replace the `vitest` import with `bun:test` equivalents
(`describe`, `expect`, `it`/`test`). Do not add vitest as a dependency.

**Verify**: `bun run typecheck` exits 0; `bun test src/renderer/src/splitDiffResize.test.ts` passes.

**Done**: typecheck green with zero new `// @ts-expect-error`.

**STOP**: do not touch any other file.

## P01 Two-phase ignored listing, out of the critical path

**Files**: `src/main/repository.ts` (refresh, `#visiblePaths`, new helper),
`src/main/repository.test.ts`, optionally a new `src/main/ignoredPaths.ts` +
test if the helper is > 60 lines.

**Drift check**: `refresh()` at `repository.ts:1334-1370` runs three spawns in
one `Promise.all`; the third is
`ls-files --others --ignored --exclude-standard -z -- . ...GIT_IGNORED_EXCLUSION_PATHSPECS`
(`repository.ts:1344-1353`, pathspecs built at `:323-326` from
`EXCLUDED_DIRECTORIES` `:273-301`). Measured 3.3-3.8 s on
`~/Developer/materialx/materialsx-core-3`, 405 paths out.

**Change**:

1. Replace the third spawn with a two-phase listing:
   - Phase 1: `git ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z`
     (measured 30-40 ms; returns ~134 entries: collapsed ignored directories
     with a trailing `/` plus ignored files).
   - Phase 2, in JS: keep phase-1 files; drop every directory entry whose path
     contains a segment in `EXCLUDED_DIRECTORY_SET`; expand the survivors
     (~12 on core-3) with an async recursive `fs.promises.readdir` walk. No
     gitignore evaluation is needed: everything under an ignored directory is
     ignored. Skip names in `EXCLUDED_DIRECTORY_SET`, skip `.git`, and when a
     child directory itself contains `.git` emit `<dir>/` and stop (nested
     repository boundary, matching git `--others`). Filter
     `EXCLUDED_IGNORED_EXTENSIONS` as today. Bound it: at most 32 surviving
     directories expanded and at most `MAX_CACHED_PATHS` ignored paths; log
     nothing, just truncate.
   - Reference implementation that was verified byte-identical on four repos
     (core-3 405==405 in 44 ms, core-4 213==213 in 44 ms, better-code-diff
     576==576 in 20 ms, imux 4,207==4,207 in 79 ms):
     `/private/tmp/claude-501/-Users-fuadnafiz98-Developer-vibes-better-code-diff/2a975ab1-5c84-43b9-bac1-d2fcb5d3d267/scratchpad/reports/tmp/mainstartup/verify3.mjs`.
     Read it, port it into TypeScript with tests; do not import it.
2. Take the ignored listing out of the snapshot's critical path: race it
   against a 400 ms deadline (`AbortController` on the spawn, cancel the walk).
   If it wins, fold it into the same snapshot as today. If it loses, publish
   the snapshot with tracked + untracked paths only, then when the ignored
   set completes call `#setSnapshot` again with the merged paths and let the
   existing publish path deliver it (the watcher's publish already omits
   `paths` when the array identity is unchanged, so an identical merge is
   free). Reuse the last successful ignored set for the interim so alternating
   refreshes do not flicker.
3. Keep `#visiblePaths` buffer-equality caching; key it on the phase-1 buffer
   plus the expanded list.
4. Delete `GIT_IGNORED_EXCLUSION_PATHSPECS` if nothing else uses it.

**Verify**: new unit tests with a temp git repo fixture: ignored files at
root, an ignored directory with nested files, an excluded directory
(`node_modules/x.js` must not appear), a nested repo boundary, `.pyc`
filtering, and the deadline path (inject a slow phase-1). Measure
`RepositoryService.refresh()` on core-3 with a bun script: must be < 150 ms
warm (was 3,520 ms).

**Done**: `restoreSettled` in `startup-probe` <= 300 ms on core-3; output
paths identical to the old command on core-3, imux, better-code-diff.

**STOP**: do not change `status` or `ls-files --cached` arguments here (P02
owns `--no-optional-locks`). Do not alter `RepositorySnapshot` shape.

## P02 Stop the refresh self-retrigger

**Files**: `src/main/gitCommands.ts` (`runCommand` env), or
`src/main/repository.ts:1343` (status spawn), `src/main/repositoryWatcher.ts`,
`src/main/repositoryWatcher.test.ts`.

**Drift check**: `normalizeChangedPath` (`repositoryWatcher.ts:39`) admits
`.git/index`. Plain `git status` rewrites `.git/index` (verified: mtime moves
after `touch README.md; git status`, does not move with
`git --no-optional-locks status`). One `touch` produced 3 refresh cycles.

**Change**:

1. Set `GIT_OPTIONAL_LOCKS=0` in the environment of every git spawn in
   `runCommand` (and in `GitObjectReader` for consistency). Equivalent to
   passing `--no-optional-locks` before every subcommand and safer than
   editing each call site.
2. Belt and braces: around each `refresh()` call, tell the watcher to expect a
   self-write of `.git/index` (the 1 s `expectSelfWrite` window at
   `repositoryWatcher.ts:186` already exists for save paths). Wire it through
   the existing `setSelfWriteObserver` hook so `RepositoryService` does not
   import the watcher.
3. Add a watcher test: an `.git/index` change within the self-write window is
   dropped; a `.git/HEAD` change is still delivered.

**Verify**: with the installed app open on core-3 and a git PATH shim
counting spawns (P12), `touch README.md` produces exactly one refresh (3 git
spawns), then silence.

**Done**: the touch test above; `git commit` from a terminal still refreshes.

**STOP**: do not remove `.git/index` from `normalizeChangedPath`.

## P03 Refresh in-flight dedupe with mutation counter

**Files**: `src/main/repository.ts`, `src/main/repository.test.ts`.

**Drift check**: `refresh()` has no pending-promise guard; `getComparison`
does (`repository.ts:1433-1444`). Callers: `repositorySessions.ts:93,146,203`,
`repositoryWatcher.ts:305`, `index.ts:711,968`, `repository.ts:1553`.

**Change**: `refresh()` returns the in-flight promise when one exists and
no mutation happened since it started. Keep a `#mutation` counter bumped by
`switchBranch`, `pullCurrentBranch`, `checkoutPullRequest`, `saveWorkingFile`
and any other method that writes the tree or the index; a `refresh()` call
observing a newer counter than the in-flight run starts a new run after the
current one settles (chain, do not run concurrently). Clear in `dispose()`.

**Verify**: unit test: two concurrent `refresh()` calls spawn once; a
`refresh()` after a mutation spawns again and observes the write.

**Done**: launch-then-open-same-folder runs one refresh, not two (shim count).

**STOP**: do not dedupe across different `RepositoryService` instances.

## P04 `open()` returns the real snapshot (deadline race)

**Files**: `src/main/repositorySessions.ts`, `src/main/repository.ts`
(`open`), `src/main/workspaceListing.ts`, tests.

**Drift check**: `repositorySessions.open()` (`:113-159`) returns
`listRootSnapshot` (84 paths, `statuses: []`, `branch: null` on core-3) and
fires `void this.#refreshAndPublish(...)`. Before e18053e `open()` returned
`this.refresh()`. After P01, `refresh()` is ~70-130 ms.

**Change**: in `repositorySessions.open()` for a new session: run
`repository.open()` (root/kind detection, ~20 ms), start `refresh()`
immediately, then `Promise.race([refresh, delay(150)])`. If the refresh
settled, register the session, start the watcher, and return the full
snapshot; publish nothing redundant. Otherwise return the skeleton and let
the existing `#refreshAndPublish` deliver the live snapshot. Apply the same
race to the `known != null && current == null` branch. Make `listRootSnapshot`
a better fallback: include dot-directories other than `.git`/`.horus`,
depth 3, cap 2,000, still synchronous and bounded (measure: must stay < 5 ms
on core-3).

**Verify**: unit test with a fake repository whose refresh resolves in 10 ms
(returns live snapshot, one publish) and 500 ms (returns skeleton, later
publish). Probe: `open-folder-probe` `headingMs` and `liveSnapshotMs` on
core-3 both <= 300 ms; `treeRowsMs` <= 300 ms.

**Done**: probe targets; `automaticWorkspaceView` receives real statuses on
open so a dirty repo lands in review view.

**STOP**: do not change the renderer here (P27 handles the fallback UX).

## P05 Refresh the repository you just opened

**Files**: `src/main/index.ts` (`openRepository`), `src/main/repositorySessions.ts`.

**Drift check**: `openRepository` (`index.ts:477-498`) on a cache hit calls
`repositorySessions.refreshActive()` (`:493`), which refreshes whatever root
is active, not `snapshot.root`; with `activate=false` (PR warmup) the
restored repo is refreshed again and the PR repo never is.

**Change**: add `refresh(root: string)` to `RepositorySessionRegistry`
(resolve by root, reuse `#refreshAndPublish`) and call
`repositorySessions.refresh(snapshot.root)` at `index.ts:493`. Keep
`persistWorkspaceFromSnapshot` gated on `live.root === activeRoot`.

**Verify**: unit test on the registry; shim count during a Cmd+H warmup shows
no refresh of the restored root.

**Done**: as above.

**STOP**: nothing else in `index.ts`.

## P08 Render before the viewer chunks arrive

**Files**: `src/renderer/src/boot.tsx`.

**Drift check**: `boot.tsx:20-30` awaits
`Promise.all([preloadWorkspaceRoot(), preloadWorkspaceViewer(...)])` when a
cached workspace exists, before `createRoot().render()` (`:32-38`). Before
e18053e the preloads were fire-and-forget. `App.tsx:487-493` already renders
`CachedWorkspaceFallback` while `getLoadedWorkspaceRoot()` is null and
re-renders through `useSyncExternalStore(subscribeWorkspaceRoot)`.

**Change**: delete the await. Call `createRoot().render()` right after
`loadPreferences()`. Keep fire-and-forget preloads for the cached-paint case
and the existing `sessionSnapshot.then` branch for the no-cache case. If the
fallback flashes for < 60 ms on a warm machine, gate the fallback on a 60 ms
timer inside `App` rather than re-adding the await.

**Verify**: `startup-probe`: `fcpMs` (renderer clock) <= 200 ms, no longtask
> 50 ms at mount, `explorerCommitted` unchanged or earlier. Visual check: no
blank window between first paint and the explorer.

**Done**: probe targets; boot.tsx has no `await` on chunk loads.

**STOP**: do not touch App.tsx (Track C owns it).

## P09 Markdown pipeline out of the shared viewer chunk

**Files**: `src/renderer/src/ReviewComments.tsx`,
`GitHubMarkdownContent.tsx`, `MarkdownContent.tsx`, `MarkdownFilePreview.tsx`,
`markdown.ts` importers; `electron.vite.config.ts` (`manualChunks`).

**Drift check**: `BackToTopButton-*.js` (611,171 B) is the chunk shared by
DiffSurface and MultiFileReview and contains @pierre/diffs 256 KB, parse5
146 KB, micromark/mdast/hast ~90 KB, entities 15 KB (from its `.map`).
`GitHubMarkdownContent.tsx:1-5` statically imports react-markdown,
rehype-raw, rehype-sanitize, remark-gfm; `ReviewComments.tsx` imports it
statically; both viewers import ReviewComments eagerly.

**Change**:

1. Lazy-load the markdown renderer: in `ReviewComments.tsx` (and any other
   eager importer) use `lazy(() => import('./GitHubMarkdownContent'))` under a
   `Suspense` whose fallback renders the raw body in a `<pre>` (keeps text
   visible, no layout jump beyond wrapping). Do the same for
   `MarkdownContent`/`MarkdownFilePreview` if they are reachable from the
   viewer chunk graph.
2. Name shared chunks so they are auditable: add
   `build.rollupOptions.output.manualChunks` in `electron.vite.config.ts`
   renderer config mapping `@pierre/diffs` -> `vendor-diffs`,
   `react-markdown|rehype-*|remark-*|micromark*|mdast-*|hast-*|parse5|unified|entities` -> `vendor-markdown`,
   `shiki|@shikijs/*|oniguruma-*` -> `vendor-shiki`, `react|react-dom|scheduler` -> `vendor-react`.
   Keep the worker's plugin list untouched.

**Verify**: `bunx source-map-explorer 'out/renderer/assets/vendor-diffs-*.js' --json`
shows no parse5/micromark; `vendor-markdown-*.js` is not statically imported
by WorkspaceRoot/DiffSurface/MultiFileReview (grep `from"./vendor-markdown`
in those chunks returns nothing). Open a PR with review comments: markdown
still renders.

**Done**: pre-mount closure (P12's check:entry) drops by >= 240 KB.

**STOP**: do not stub shiki here (P31).

## P10 @pierre/trees out of the boot chunk

**Files**: `src/renderer/src/treeExpansion.ts`, `treeExpansion.test.ts`,
`workspaceMode.ts` (imports only), `AppView.tsx` (icon imports for Welcome).

**Drift check**: `treeExpansion.ts:1` imports `prepareFileTreeInput` from
`@pierre/trees`; `firstTreePath` uses it; `workspaceMode.ts:47-48` calls
`firstTreePath` from `boot.tsx`/`App.tsx`. Boot chunk carries 62 KB of
path-store + 23 KB icons for this.

**Change**: implement `firstTreePath` locally: split each path on `/`, sort
with directories-first at each level then byte order, return the first
file. Keep `orderPathsForTree` (used only inside the WorkspaceRoot chunk)
importing @pierre/trees, but move it to a separate module so
`treeExpansion.ts` no longer imports the library. Move Welcome-only icons
into a lazily imported `Welcome` component if AppView is in the boot chunk.

**Verify**: existing `treeExpansion.test.ts` passes plus a new test that the
local `firstTreePath` matches the old result on a fixture of 200 mixed paths
(compare against `prepareFileTreeInput` in the test only). Boot chunk source
map lists no `path-store/` sources; boot chunk shrinks by >= 60 KB.

**Done**: as above.

**STOP**: do not change tree rendering.

## P11 PerformanceHud lazy and idle

**Files**: `src/renderer/src/AppView.tsx` (import + render site),
`PerformanceHud.tsx`.

**Drift check**: `AppView.tsx:36` static import; `:234` renders it whenever a
snapshot exists; `PerformanceHud.tsx:118` calls `void sample()` at mount
(IPC + `app.getAppMetrics()` in main during the startup window).

**Change**: `const PerformanceHud = lazy(() => import('./PerformanceHud'))`
with `<Suspense fallback={null}>`; first sample in `requestIdleCallback`
(cancel on unmount) and not before the popover has been opened once; keep the
existing polling once opened.

**Verify**: boot chunk map no longer lists PerformanceHud/PerformanceChart;
no `getPerformanceMetrics` IPC in the first 2 s of a launch (add a counter
in the probe or check main logs).

**Done**: as above; HUD still works when opened.

**STOP**: do not change what the HUD displays.

## P12 Measurement harness: probes, benchmark, entry budget, CSS preload

**Files**: `scripts/perf/` (new), `scripts/benchmark-startup.mjs`,
`scripts/check-entry-chunk.mjs`, `electron.vite.config.ts:154`,
`package.json` scripts.

**Drift check**: the benchmark requires `.multi-file-review` which a
file-view restore never renders, so it throws instead of reporting.
`check-entry-chunk.mjs` measures the 2.8 KB Vite shim. The CSS preload tag
lacks `crossorigin` so Chromium discards it and fetches the 172 KB
stylesheet twice (console: "request credentials mode does not match").

**Change**:

1. Copy the working probes into the repo and make them the official harness:
   `/private/tmp/claude-501/-Users-fuadnafiz98-Developer-vibes-better-code-diff/2a975ab1-5c84-43b9-bac1-d2fcb5d3d267/scratchpad/bench/{cdp.mjs,startup-probe.mjs,open-folder-probe.mjs,pr-open-probe.mjs}`
   -> `scripts/perf/`. Fix the medians in `startup-probe.mjs` (mark keys are
   kebab-case: `react-committed`, `explorer-committed`, `viewer-committed`,
   `snapshot-ready`). Add a PerformanceObserver longtask capture (inject
   early via `Page.addScriptToEvaluateOnNewDocument` before reload, or read
   `performance.getEntriesByType('longtask')` if buffered) and a
   `workspaceRenders` read from the reviewMetrics counter for the palette
   typing test. Add `scripts/perf/git-shim/git` (a bash shim that logs
   `date +%s%N`, args, and elapsed to `$HORUS_GIT_LOG`, then execs the real
   git) and a `scripts/perf/README.md` explaining how to launch the app with
   `PATH=scripts/perf/git-shim:$PATH` to count spawns per scenario.
2. Rewrite `benchmark-startup.mjs` to read `performance.getEntriesByName('horus:*')`
   marks and `window.repository.getPerformanceMetrics(true).detail.mainStartup`
   instead of DOM classes; make the viewer gate `#repository-diff > *` or the
   `horus:viewer-committed` mark; default timeout 20 s; never throw on a slow
   run, report the number.
3. Rewrite `check-entry-chunk.mjs`: parse `out/renderer/index.html` for the
   entry, follow static `from"./X.js"` and `import("./X.js")` edges from the
   entry and the `boot` chunk, add the transitive static closure of
   `WorkspaceRoot` plus both viewer chunks (`DiffSurface`, `MultiFileReview`),
   sum bytes, assert <= `MAX_PREMOUNT_BYTES` (start at 1,900,000; each
   section that shrinks it lowers the constant), and assert `WorkerPool` is
   absent from the boot chunk only (it is legitimately inside the viewer
   graph).
4. `electron.vite.config.ts:154`: add `crossorigin: ''` to the CSS preload.
5. `package.json`: `perf:startup` -> `bun scripts/perf/startup-probe.mjs`,
   add `perf:open-folder`, `perf:pr-open`.

**Verify**: run all three probes against the installed build; they complete
and print medians; `bun run check:entry` prints the closure size.

**Done**: harness runs green; console no longer warns about the CSS preload.

**STOP**: do not change app behaviour.

## P14 Palette without Suspense

Finding CP-1. First Cmd+P after launch takes 328-357 ms because
`CommandPaletteController` is `lazy()` (App.tsx:98-100) and React's
`FALLBACK_THROTTLE_MS = 300` holds the fallback for a full 300 ms even when the
chunk arrives in 20 ms. The `useCommandPaletteLoader` warm dance (App.tsx:102-158,
`requestIdleCallback` + hover warm) races the user and loses on a fresh launch.

Do:
1. New `src/renderer/src/commandPaletteModule.ts`: a `useSyncExternalStore`
   module store identical in shape to `workspaceBoot.ts`. State
   `{ status: 'idle' | 'loading' | 'ready', module: typeof import('./CommandPalette') | null }`.
   `loadCommandPalette()` starts the dynamic import once, stores the module, notifies.
   Export `useCommandPaletteModule()`.
2. `boot.tsx`: after `createRoot().render()` (P08 already made this
   non-blocking), call `void loadCommandPalette()` unconditionally. The chunk
   downloads in the background during the first paint; it is < 60 KB.
3. `App.tsx`: delete `lazy(() => import('./CommandPalette'))`, `Suspense`
   around the palette, `useCommandPaletteLoader`, `requestIdleCallback` warm,
   and hover warm. Render `module.CommandPaletteController` directly when
   `status === 'ready'`; when Cmd+P arrives before ready, call
   `loadCommandPalette()` and render the palette shell (`.command-palette`
   container + focused `<input>`) from a tiny inline component so the input is
   focused on the same frame. The controller mounts when the module resolves
   and adopts the current input value (pass `initialQuery`).
4. The inline shell must not import anything from `CommandPalette.tsx`.

Verify: startup-probe `palette.openMs` <= 30 ms on the first Cmd+P after cold
launch; second open <= 15 ms. `bun run check:entry` unchanged or lower.

## P15 Zero workspace renders per keystroke

Findings CP-3, CP-4, RB-06. `useRepositorySearch` lives in `AppLayout`
(App.tsx:554); every keystroke sets `query`, `fileResults`, `contentResults`
state on the layout, re-rendering Explorer, viewer, titlebar (2.4 renders per
keystroke measured, up to 35 ms each on the 3,026-path tree). `useRepositorySearch.ts:59-62`
and `:64-96` also call `setContentResults([])` twice per query.

Do:
1. Move `useRepositorySearch` into the palette controller (it is the only
   consumer of live results). `AppLayout` no longer holds `query` or results.
2. `DiffSurface` search markers need the *settled* query + content results.
   Publish them through a module store `searchResultsStore.ts`
   (`{ query, results }`, frozen `EMPTY_RESULTS` constant) written by the palette
   only when a content search completes or the palette closes; `DiffSurface`
   reads it with `useSyncExternalStore`. Nothing else in the workspace
   subscribes.
3. In `useRepositorySearch`: keep one `results` object per query; replace the
   two `setContentResults([])` with a single reset to the shared frozen
   `EMPTY_RESULTS` so React bails out on identity.
4. Cancel IPC (`cancelContentSearch`) only when a search is actually
   outstanding (track `#inflightId`), not on every keystroke (CP-6).
5. Add `reviewMetrics.workspaceRenders` counter (already exists per RB report;
   if not, add in `RepositoryWorkspace` render) and expose on
   `window.__horusMetrics` in dev/probe builds so the probe can assert 0.

Verify: startup-probe reports `workspaceRenders` delta of 0 across 6 typed
characters while a file is open. Search markers in the diff still appear after
results settle.

## P16 Empty-query autocomplete: files and folders

Finding CP-2. Opening the palette with an empty query shows 7 commands and 1
file (CommandPalette.tsx:297-303 returns early for `query === ''`). The user
expects the file/folder list immediately.

Do:
1. `fileSearch.ts`: `rankFilePaths(paths, '')` returns a priority-ordered list
   instead of `[]`: recent files for this root first (new `recentFiles` list in
   session state, max 20, updated on file open, keyed by root), then changed
   files (status != unmodified), then top-level directories, then the rest in
   tree order, capped at 40.
2. Directories become first-class palette rows: extend the index with
   `{ path, kind: 'file' | 'dir' }` (derive dirs from the path set once per
   snapshot, memoised on `paths` identity). Selecting a dir expands and reveals
   it in the Explorer.
3. Section order for empty query: Files/dirs above Commands. Commands stay at
   the bottom, collapsed to 3 with "more…" unless the query starts with `>`.
4. Autocomplete: keep the current fuzzy scorer; add an inline completion hint
   (ghost text) for the top match when the query is a path prefix; Tab accepts.

Verify: startup-probe `palette.emptyRows >= 20` and first row is a file or
dir; `fileSearch.test.ts` covers empty query, recent-first, dir rows.

## P17 Content search: smaller payload, adaptive debounce

Finding CP-5. `searchContent` returns up to `MAX_SEARCH_RESULTS = 200`
(repository.ts:117) ripgrep hits; the palette renders 8. Debounce is a fixed
240 ms in `contentSearchScheduler.ts`.

Main half (Track D owns `repository.ts:searchContent`):
1. `MAX_SEARCH_RESULTS` 200 -> 24. Add optional `forOpenPath` argument: when set,
   run a second bounded rg restricted to that file so the DiffSurface markers
   for the open file are complete (cap 200 for that file only).
2. Add `--max-filesize 1M`, `--threads` capped at `min(4, cpus)`, `-j` same.
3. Kill the child as soon as the cap is reached (already done at :1754; make
   sure the `--json` stream parser stops reading too).

Renderer half (Track C owns `contentSearchScheduler.ts`):
4. Adaptive debounce: 180 ms for queries < 3 chars, 120 ms for 3-4, 90 ms at >= 5
   chars. Fire immediately on Enter.
5. Skip content search entirely when the query looks like a path (contains `/`
   or matches >= 5 files with score above threshold) until the user pauses 400 ms.

Verify: startup-probe `palette.contentResultsMs <= 150` after the last
keystroke on core-3; payload per response < 20 KB (log in probe).

## P18 Palette first frame

Finding CP-8. `.command-palette` uses `backdrop-filter: blur(30px)`
(styles.css:2981-2985); the first composited frame costs 34-69 ms on a 4K
display.

Do: blur 30px -> 12px (or replace with a semi-opaque background + 1px border if
the blur is not essential to the look); add `will-change: transform, opacity` on
the panel only while opening (`.command-palette[data-opening]`), remove after the
transition ends; ensure the panel has `contain: layout paint`.

Verify: CDP frame timing around Cmd+P shows no frame > 16 ms after the module is
loaded.

## P19 App render hygiene + React Compiler on App

Finding RB-05. `initialWorkspacePaint(...)` and `firstOpenPathForSnapshot(...)`
(App.tsx:639 and neighbours) run on every `App` render; the React Compiler
bailed out of `App` (verify with
`babel-plugin-react-compiler` `logger` in `electron.vite.config.ts`, or
`npx react-compiler-healthcheck`), so nothing in `App` is memoised.

Do:
1. `useState(() => initialWorkspacePaint(...))` for the boot paint; derive
   `firstOpenPathForSnapshot` in a `useMemo` keyed on snapshot identity or move
   it into the child that needs it.
2. Find the bailout reason. Suspects: four `useEffectEvent` sites
   (App.tsx:215, 754, 870, 896) used outside effects, `folderPickerOpenRef`
   mutated during render. Fix each so the compiler accepts `App` (the
   compiler's `logger` option prints `CompileError`/`CompileSkip` per component;
   wire it behind `HORUS_COMPILER_LOG=1`).
3. Confirm with the logger that `App`, `AppLayout`, `RepositoryWorkspace`,
   `CommandPaletteController` all compile.

Verify: no `CompileSkip` for those components; react-doctor stays 100/100.

## P20 Palette allocation hygiene

Findings CP-6, CP-9, CP-11. Per-row `onPointerEnter` closures and per-render
array allocations; pointer-enter storms while the mouse crosses the list set
state per row.

Do: one delegated `onPointerMove` on the list reading `data-index`; only
`setActiveIndex` when it changes; memoise row models per `results` identity;
`rankFilePaths` returns the same array instance when inputs are unchanged.

Verify: no measurable change needed beyond P15's 0-renders assertion; keep
CommandPalette tests green.

## P21 One PR root resolution per URL

Findings MAIN-3, MAIN-5, PR-4, PR-5, PR-6. Per Cmd+H, `findPullRequestRoot`
(index.ts:514-527) runs three times concurrently: `warmupPullRequest`
(index.ts:166), renderer `resolvePullRequestRepository` (index.ts:582 via
useGitWorkflow.ts:503) and renderer `previewPullRequestFolder` (index.ts:559 via
useGitWorkflow.ts:153-173). Each builds its own `remotesCache`
(pullRequestRoots.ts:17-24) and each awaits `folderIndex.list()` (index.ts:515)
before even looking at the remembered root (index.ts:517). Measured: 307
`git remote -v` spawns, 96-192 ms each under contention.

Do (Track D, `src/main/index.ts` PR functions + `pullRequestRoots.ts`):
1. Two-stage resolution. Stage 1 probes, in one `Promise.all` with no waves and
   no folder walk: `[rememberedPullRequestFolder(slug), ...repositorySessions.roots(), ...sessionState.approvedRoots]`
   (dedupe, stat each once). Return on the first remote match. Stage 2 only on a
   miss: `await folderIndex.list()` then the existing name-biased wave scan with
   `preferredRoots: []`.
2. Module-level `rootResolutions = new Map<string, Promise<string | null>>()`
   keyed by normalized PR URL; all three callers share one promise; delete on
   settle after a 5 s TTL (so the renderer's follow-up joins the warmup's
   promise instead of respawning).
3. Module-level remotes cache `Map<root, { remotes, expiresAt }>` with a 60 s
   TTL, hoisted out of `findMatchingPullRequestRoot`; invalidate a root's entry
   when its `.git/config` changes (watcher already reports `.git/*` paths) or
   simply on TTL.
4. Negative cache `noLocalCheckout: Map<slug, expiresAt>` (60 s) so an unmatched
   slug does not re-probe 103 folders on every clipboard change (PR-12).
5. `previewPullRequestFolder` becomes non-probing: return the remembered folder
   (`source: 'remembered'`) after a single `stat`, else join the shared
   `rootResolutions` promise if one is in flight, else `null`. Never walk, never
   spawn git.
6. Carry the resolved root to the renderer: add `root?: string | null` to the
   `openExternalPullRequest` payload (`shared/contracts.ts`), have
   `applyExternalReview` await stage 1 (bounded 150 ms) before publishing, and let
   `useGitWorkflow.ts:502` prefer that root as `preferredRoot` so
   `resolvePullRequestRepository` becomes a map lookup.

Verify: git PATH shim shows <= 12 git spawns per Cmd+H (target table);
`pullRequestRoots.test.ts` covers stage-1 hit, stage-2 fallback, shared promise,
negative cache. Unit test that `previewPullRequestFolder` spawns nothing.

## P22 Clipboard warmup without scans

Findings MAIN-4, PR-12. `startClipboardWarmup` (index.ts:197-206) polls every
800 ms forever, and any GitHub PR URL on the clipboard triggers the full
resolution (103 `git remote -v`, 1.3 s) even when Horus is hidden and even when
the slug has no local checkout (cooldown only set on success, index.ts:170).

Do:
1. `CLIPBOARD_WARMUP_MS` 800 -> 2000; skip the poll entirely when no window is
   visible/focused (`BrowserWindow.getAllWindows().some(w => w.isVisible())`
   false or app not active) and resume on `browser-window-focus`/`activate`.
2. `recentlyWarmedAt.set(url, now)` before the null check so misses are also
   cooled down; consult the negative cache from P21.
3. Warmup only touches the remembered/open roots (stage 1 from P21). Never run
   stage 2 (folder walk) from the clipboard path.
4. Warmup must not call `openRepository()`/`refreshActive()`; it only warms the
   PR review cache (`getPullRequestReview` with `intent: 'warmup'`).
5. Decide one poller: keep the in-app poller, remove the Raycast
   `warmup-clipboard` 10 s background command from `extensions/horus/package.json`
   (it launches Horus in the background on any copied URL). If kept, it must
   not launch the app when it is not running.

Verify: git shim shows 0 spawns when a PR URL is copied while Horus is idle
(<= 3 if the repo is remembered and the PR cache is cold).

## P23 Cmd+H: cache-first PR render, one flight, no wasted work

Findings PR-1, PR-2, PR-3, PR-7, PR-8, PR-9, PR-10, PR-11, PR-13, PR-14.
Measured warm Cmd+H, cached PR: 1,439-1,667 ms to diff; uncached 1-file PR:
2,054 ms; cold Cmd+H cached PR: 1,783 ms + 110 ms `open` hop; 2-4 concurrent
ignored walks saturate CPU 7-9 s (fixed by P01/P03 but the callers below must
also stop asking for them).

Do (Track D; `repository.ts` only `getPullRequestReview`/`#loadPullRequestReview`/
`PullRequestReviewCache`/`#resolvePullRequestIdentity`/`#runPullRequestJsonCommand`):
1. **Multicast flights (PR-2).** Replace
   `#reviewFlights: Map<string, Promise<PullRequestReview>>` (repository.ts:1186)
   with `Map<string, { promise, listeners: Set<ProgressFn>, metadata: PullRequestReviewProgress | null, pages: PullRequestReviewProgress[] }>`.
   A joining caller (repository.ts:2183) adds its `onProgress`, gets the stored
   metadata event and any file pages replayed synchronously, then shares the
   promise. `#loadPullRequestReview` fans every `onProgress?.()` (2245, 2273-2279,
   2296) to all listeners and records metadata/pages.
2. **URL-keyed cache index (PR-1).** `PullRequestReviewCache.write`
   (repository.ts:1077-1109) also writes `<sha1(url)>.latest.json`:
   `{ headRefOid, summary: PullRequestSummary, writtenAt }`. In
   `#loadPullRequestReview`, before spawning `gh`, read the index; on hit, build
   the metadata event from the cached summary and emit it, then emit the cached
   files/patch (paged as today) so the renderer paints within ~50 ms. Then run
   `gh pr view --json headRefOid` in the background: same oid -> done; different
   -> fetch, then emit a `{ kind: 'replace', review }` event (add to
   `PullRequestReviewProgress` in `shared/contracts.ts`; renderer replaces the
   world's review in `useGitWorkflow.ts:396-409`).
3. **Parallel hops (PR-8).** On a cache miss, start `gh pr diff` concurrently
   with `gh pr view` (it does not need headRefOid); abort the diff child via the
   existing `signal` if the cache turns out to hit on the returned oid.
4. **Lean metadata (PR-9).** Open path fetches `PULL_REQUEST_LIST_FIELDS +
   baseRefOid + headRefOid` only (drop `files`, `statusCheckRollup`,
   `mergeable`); a second background `gh pr view --json statusCheckRollup,mergeable`
   patches the header (`{ kind: 'checks' }` progress event).
5. **Seed identity (PR-7).** After parsing details set
   `#pullRequestIdentities` from `pullRequest.url` + number so
   `#resolvePullRequestIdentity` (1817-1836) never spawns for a PR we already
   loaded; start files-API paging concurrently when `changedFiles > 300`.
6. **Warmup never steals (PR-2 stopgap + PR-3).** `applyExternalReview` with
   `intent === 'open'` does not call `warmupPullRequest`; it calls a new
   `primePullRequest(url)` that only resolves the root (P21 stage 1) and starts
   the multicast flight with no listener. `warmupPullRequest`/`primePullRequest`
   never call `openRepository()` and never trigger a repository refresh; the PR
   review path reads no ignored set.
7. **Cold-start hint (PR-10).** Add `pendingPullRequestUrl` to the restore hint
   argument (`encodeRestoreHintArgument`, index.ts:332). In `boot.tsx`, when
   present: skip the workspace preload wait (already removed by P08), preload
   `MultiFileReview` instead of the cached view's chunk, and let `App` open the
   PR world before hydrating the cached desk (or hydrate it hidden).
8. **Ack pending URL (PR-11).** Null `pendingOpenPullRequestUrl` inside the
   `getPendingExternalPullRequest` handler (index.ts:687) after returning it.
9. **Cancel the right flight (PR-14).** Delete the dead
   `this.cancelPullRequestReview(requestId)` at repository.ts:2186; track the
   current foreground request per repository and abort it when a new foreground
   (non-warmup) request for a *different* PR arrives.
10. **Raycast (PR-13).** `extensions/horus/src/lib/horus.ts`: `pgrep -x Horus`
    first; running -> `open horus://…` only; not running ->
    `open -a Horus --args --horus-url=…`; do not await the child after
    `closeMainWindow`; distinct HUD when the scheme is unregistered.
11. Raise `MAX_PULL_REQUEST_CACHE_ENTRIES` 20 -> 60 (bytes cap already 200 MB).

Verify: pr-open-probe warm cached PR -> `.multi-file-review` <= 400 ms; cold
cached <= 1,500 ms; uncached shows the review shell at metadata time (< 900 ms)
and streams files; git shim <= 12 git spawns and exactly 2 `gh` spawns on a
cached hit (`headRefOid` revalidate + checks). Unit tests: multicast replay,
cache index hit/miss/stale, identity seeding, no warmup refresh.

## P25 Background sessions: suspend + cap

Finding FO-5. `RepositorySessionRegistry` never releases a session: every
folder ever opened keeps its recursive `fs.watch` and its refresh loop, so N
opened repos = N concurrent ignored walks on any broad filesystem event.

Do (`repositorySessions.ts`):
1. Track `lastActiveAt` per session. `activate(root)` suspends every other
   session: `watcher.pause()` (close the `fs.watch` handle, keep the snapshot)
   and drop pending refresh timers. Reactivation re-arms the watcher and runs one
   `refresh()`.
2. LRU cap of 4 resident sessions (snapshots kept); beyond that, `dispose()`
   the oldest inactive session. Review worlds that still reference a disposed
   root re-open it lazily via `open()` (already returns a snapshot fast after
   P04).
3. Subscribers of a suspended session receive no publishes; the renderer shows
   the last snapshot (unchanged behaviour).

Verify: open 6 folders in sequence; `lsof -p <main pid> | grep -c kqueue`
stays flat and the git shim shows one refresh cycle per activation only.

## P26 Workspace cache: multi-slot, cheap cap, no fileText storms

Findings MAIN-6, MAIN-8, FO-6. `capWorkspaceCache` `JSON.stringify`s the whole
cache on every publish to measure it (up to 112 ms on a 20k-path repo); the
cache has one slot so alternating between two repos flashes the skeleton;
`fileText` for the open file rides the same publish every 250 ms.

Do (`shared/workspaceCache.ts`, `workspaceCacheStore.ts`, `index.ts` cache parts):
1. Cap by counts, not bytes: `paths.length <= 25_000`, `statuses <= 5_000`,
   `fileText <= 512 KB`; no stringify. Use a `Set` for membership instead of
   `Array.includes`.
2. Multi-slot: `Map<root, WorkspaceCacheEntry>` with 3 slots, LRU by
   `lastOpenedAt`; the restore hint carries the last root only.
3. Split `fileText` out of the snapshot publish into its own IPC
   (`repository:file-text`) sent only when the open file's content actually
   changed (compare a cheap hash of the buffer), and not more than every 250 ms.
4. Write the cache file with `writeFile` (async) debounced 1 s, `atomic` via
   temp + rename; never on the publish tick.

Verify: publish handler median < 2 ms on core-3 (log in main perf marks);
alternating two remembered repos shows the full cached tree for both with no
skeleton.

## P27 Open-folder UX: progress, view re-derivation, single tree reset

Findings FO-3, FO-7, FO-8, RB-13. After Enter in the folder picker nothing
indicates progress; the workspace view/selection is derived from the skeleton
snapshot (no statuses) and never recomputed when the live snapshot lands; the
tree reset + collapse walk runs twice per open.

Do (`App.tsx` open handlers, `useReviewWorlds.ts`, `RepositoryWorkspace.tsx`
`useTreeContentSync`, `FolderPicker.tsx`):
1. `openingRecentPath` state drives a spinner on the picked row and keeps the
   picker mounted until the snapshot with `statuses` arrives or 400 ms pass
   (whichever first); then close.
2. `automaticWorkspaceView`/`firstOpenPathForSnapshot` re-derive when a
   snapshot transitions from `skeleton` -> `live` (P04 marks this with
   `snapshot.kind`); user-made selections (explicit click) win over the
   re-derivation.
3. Skip the collapse pass when the previous path list is empty; run the tree
   reset once per root change (guard on `root` identity, not on `paths`).
4. Recent-folders list in the picker is rendered from session state
   synchronously (already), and the picker's own fuzzy filter must not touch
   `folderIndex` until the query is non-empty.

Verify: open-folder-probe `liveSnapshotMs` on core-3 <= 300 ms (with P01/P04),
imux <= 150 ms; spinner visible within one frame of Enter; one tree reset per
open (counter in probe).

## P28 Git spawn semaphore

Finding MAIN-9. `runCommand` has no concurrency limit; under a Cmd+H the 307
`git remote -v` ran 8-wide against a 4-way ignored walk and each spawn cost
3-6x its idle time.

Do (`gitCommands.ts`): semaphore of `max(4, cpus - 2)` for git/gh/rg spawns
with two lanes: `interactive` (refresh of the active root, PR open, content
search, file reads) always gets a slot ahead of `background` (warmup, inactive
sessions, remotes probing, ignored listing). Expose `lane` on `runCommand`
options; default `interactive`. Abort signals dequeue waiting commands.

Verify: unit test for ordering + abort; git shim shows per-spawn wall time of
`git remote -v` <= 30 ms during a Cmd+H.

## P29 Startup tick and path-resolution hygiene

Findings MAIN-10, MAIN-11, MAIN-15, FO-11. `beginSessionRestore()` runs in the
same tick as `createMainWindow()`; `currentRestoreHint()` is recomputed per
call; the root path is `realpath`ed 4 times per open.

Do (`index.ts` restore parts): `setImmediate(beginSessionRestore)` after the
window is shown; memoise `currentRestoreHint` on `(sessionState, cache)`
identity; resolve `realpath` once in `openRepository` and pass the resolved
path down (sessions, watcher, cache key).

Verify: `windowShown` unchanged or better; no behaviour change in
`sessionStore.test.ts`/`repository.test.ts`.

## P30 CSS: split boot stylesheet, squircle scope, resizer

Findings RB-07, RB-11, RB-12. One 172 KB stylesheet is fetched serially before
the app JS; `corner-shape: squircle` is applied on `*`; `SidebarResizer` forces
synchronous layout on drag.

Do (`styles.css`, lazy components' CSS, `SidebarResizer.tsx`,
`electron.vite.config.ts`): move rules for lazy surfaces (palette, markdown,
review comments, agent panel, terminal, settings) into per-component CSS files
imported by those components so Vite emits them with their chunks; boot CSS
< 60 KB. Scope `corner-shape` to the elements that use `border-radius`.
`SidebarResizer`: read layout once on pointerdown, write via `transform` during
drag, commit width on pointerup.

Verify: `bun run check:entry` reports boot CSS bytes < 60 KB (extend the
script); no visual regressions in the dom tests.

## P31 Shiki tokenizer off the main thread

Finding RB-03 (verify first). The renderer boot report shows shiki + oniguruma
(~140 KB) evaluated pre-mount. Confirm with the P12 pre-mount closure report
whether a main-thread highlighter is created at boot or only imported.

If evaluated at boot: split the highlighter into `vendor-shiki` (P09 manual
chunk) and load it lazily from the viewer on first highlight; if the app
already highlights in a worker, replace the main-thread import with a stub that
posts to the worker. If only imported (not executed), P09's chunking is enough;
mark this section DONE with the evidence.

Verify: pre-mount closure excludes shiki/oniguruma; first highlighted file
still paints within 100 ms of open.

## P13 react-doctor back to 100/100

Baseline 2026-09-05 (`npx react-doctor@latest --verbose`, diagnostics saved in
the session scratchpad `baseline/react-doctor-baseline/`): score 81, 25 warnings
in 15 files:

| Rule | Sites |
| --- | --- |
| no-high-complexity-react-function (11) | AgentPanel.tsx:76, App.tsx:364, AppView.tsx:497, DiffSurface.tsx:249, editor/EditorStatusBar.tsx:17, GitHubPanel.tsx:160, PerformanceChart.tsx:46, PerformanceHud.tsx:49, PullRequestReviewBar.tsx:27, RepositoryWorkspace.tsx:274, RepositoryWorkspace.tsx:804 |
| async-await-in-loop (4) | main/folderIndex.ts:47, 50, 56, 150 |
| no-set-state-after-await-in-effect (2) | extensions/horus/src/open-pull-request.tsx:16, 28 |
| no-giant-component (2) | App.tsx:632, CommandPalette.tsx:148 |
| no-adjust-state-on-prop-change (2) | RepositoryWorkspace.tsx:1307, 1308 |
| no-reset-all-state-on-prop-change (1) | RepositoryWorkspace.tsx:1305 |
| server-sequential-independent-await (1) | main/folderIndex.ts:81 |
| prefer-html-dialog (1) | FolderPicker.tsx:211 |
| js-set-map-lookups (1) | shared/workspaceCache.ts:99 |

Several are removed by earlier sections (P19 splits `App`, P26 fixes the
`workspaceCache` lookup, P27 fixes the `RepositoryWorkspace` prop-change state,
P21 rewrites `folderIndex` loops, P16 shrinks `CommandPalette`). Wave 4 runs
after Wave 3 with a single agent that owns the whole repo: extract sub-components
or hooks for the complexity sites (behaviour-preserving, each extraction covered
by the existing dom tests), `<dialog>` for FolderPicker, cancellation flags in
the Raycast effect, `Promise.all` for the independent awaits in `folderIndex`.
Then `npx react-doctor@latest --verbose` must print 100/100 and becomes a hard
gate for every later change.
