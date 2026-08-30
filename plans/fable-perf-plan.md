# Horus — Fable performance & UI plan

Written by Fable 5 on **2026-08-30** (revised 00:50 after the React/Compiler review and Grok's startup refactor) against commit `caa1771` **plus the
uncommitted working tree** (41 modified files, ~2.6k insertions). Every section
below stamps that. **Commit the working tree before executing anything**, then
run each section's drift check.

This is one file on purpose. Each `## Plan NNN` section is a self-contained
handoff for an executor with zero context (Opus, effort max, via Workflow agents
— the operating model for this repo). Fable's job is to review
the diff, not write it. `react-doctor` must stay **100 / 100** after every
section.

## How the audit was done

- Recon: `package.json`, `IDEAS.md`, `README.md`, `plans/README.md`,
  `electron.vite.config.ts`, CI, git log, `bunfig.toml`.
- Seven read-only audit agents (renderer render perf, main/IPC perf,
  memory/diff pipeline, agent+terminal streaming, CSS/UI consistency,
  bundle/startup/deps, UI-bug correctness), each returning `file:line`
  evidence in the `improve` skill's Finding format.
- `npx react-doctor@latest --verbose` → **100 / 100, no issues**;
  `react-doctor design` → no issues. Lint-level React problems are absent; every
  finding here is architectural and came from reading.
- Every excerpt in every plan was re-read by Fable from the working tree. Agent
  claims that did not survive that check are in "Considered and rejected".

## What was NOT audited

`src/main/agentRequest.ts` envelope logic, `codexProtocol.ts`, `@pierre/diffs`
worker-pool/highlighter internals, test bodies (titles only), and no runtime
profiling or heap snapshot was taken — every MB/ms figure is an estimate from
code shape unless a section says "measured". Plan 022 exists to make those
measurements trustworthy first.

## React version review (added 2026-08-30 00:50)

Checked, not assumed:

| Item | State | Consequence for this plan |
|---|---|---|
| `react` / `react-dom` | **19.2.8 installed = npm `latest` 19.2.8**. 19.3 exists only as `canary`/`next`. | Nothing to upgrade. Do not move to canary. |
| 19.x APIs already used | `useEffectEvent` (6 files), `startTransition` (7 sites), `useDeferredValue` (2). | Plans 005/006/007 may use `useEffectEvent` for listeners; no new API adoption needed. |
| `<Activity>` (19.2) | Exported by the installed React; **not used** in `src/` (grep hits were `ActivityIcon`). | Considered for Plan 024 (keep tabs mounted) and **rejected for the CodeView**: `Activity mode="hidden"` keeps the hidden subtree's DOM and state, which multiplies the memory-heavy viewer — the exact thing IDEAS.md forbids ("One mounted CodeView"). It remains a candidate for *light* per-tab state (file-tree expansion, threads UI) inside 024's spike; the spike note must weigh it against the explicit world-state cache. |
| **React Compiler 1.0** (`babel-plugin-react-compiler@1.0.0`, stable since Oct 2025) | **Not installed.** `@vitejs/plugin-react` 5.2.0 is installed (6.1.1 is latest) and supports `babel.plugins`. `react-doctor-baseline.json` reports `hasReactCompiler: false`. | This is the real gap. The compiler auto-memoises component bodies and hook return values, which would remove Plan 002's Sites A (`[]` literals), C (`join('\0')` in render) and D (`useAgentSession` object/`ask`) mechanically, and would keep every future prop identity-stable without review discipline. It does **not** fix Site B (reading `multiFileScrollTopRef.current` in render — the compiler *bails out of that component* and its lint flags it) or Site E (reducer sweep), and it cannot help the main process, CSS, or drag handlers. **Plan 026** adopts it behind a healthcheck. Plan 002 stays: it is S-effort, lands first, and is the fallback if 026 is rejected; Site B is a compiler prerequisite anyway. |
| Hooks lint | `bun run lint` = `oxlint src` **without** `--react-plugin`; no `eslint-plugin-react-hooks`. `rules-of-hooks` / `exhaustive-deps` are not enforced today. | Plan 026 enables oxlint's react plugin (rules-of-hooks, exhaustive-deps) as the compiler's safety net. |
| `@vitejs/plugin-react` | 5.2.0 → 6.1.1 available. | Not required for the compiler; leave the bump to Plan 023's dependency pass unless 026's healthcheck needs it. |
| Suspense `FALLBACK_THROTTLE_MS = 300` (React 19) | Confirmed by `grok-perf-plan.md`; Grok replaced the first-reveal `lazy()`/`Suspense` with a resolved-module store (`workspaceBoot.ts`). | Plan 013 must **not** reintroduce `lazy()` on the first workspace reveal. Palette/Chart/Settings are user-initiated, so `lazy()` + `Suspense fallback={null}` is fine there. |

## Sibling document: `grok-perf-plan.md` (repo root)

A parallel, startup-only investigation (by "Grok", with Codex's packaged
traces) was written the same night and its steps A–D were **implemented at
00:35 on 2026-08-30**, after this audit's reads. The working tree is green
(`bun run typecheck` 0, `bun test` 542/542) and a fresh `out/` build exists
(00:37). Reconciliation:

| Grok step | Landed | Effect on this plan |
|---|---|---|
| A — crash guard: `cancelContentSearch` no-ops without a repository | Yes (`repositorySessions.ts:49`, `index.ts:416`, `useRepositorySearch.ts:121,129` gated on `snapshot`) | Plan 008 Step 4 shrinks to `cancelPullRequestReview` + the `uncaughtException` logger. |
| B — resolved-module boot, no `lazy()` on first reveal | Yes (`workspaceBoot.ts`, `main.tsx` preloads, `App.tsx:364` renders `WorkspaceRoot`, `RepositoryWorkspace.tsx:762-765` `useSyncExternalStore` for `MultiFileReview`) | Plan 002 excerpts re-anchored (App.tsx:378-381, RepositoryWorkspace.tsx:990/1253, MultiFileReview.tsx:761). Plan 024 excerpts re-anchored; its Step 5 now edits `workspaceKey` on `WorkspaceRoot` (App.tsx:364). Grok's constraint — **never key `ViewerProviders` on the world** — is consistent with 024 and is now quoted there. |
| C — `ViewerProviders` off Welcome via `WorkspaceRoot.tsx`; `SettingsPage` lazy | Yes; entry chunk **815 KB → 340 KB**, `WorkerPool` count in entry = 0 | Plan 013 rewritten: only Palette + Chart lazy, `sourcemap: 'hidden'`, and the `Editor` dynamic import remain. `manualChunks` **dropped** (Grok: asar round-trips can hurt; no measurement supports it). |
| D — startup marks in HUD diagnostics | Yes (`startupMetrics.ts`, `mainStartup` in `PerformanceHud.tsx`) | Plan 022 keeps its memory-tool scope; `scripts/benchmark-startup.mjs` now exists and is the startup instrument. |

Grok's "lower leverage — do not do yet" list (split `styles.css`, preload
fonts, defer first HUD sample, static-import workspace, `manualChunks`, Shiki
chunks, Agent SDK, main size) agrees with this document's "Considered and
rejected" except `manualChunks`, which this document now also drops.

**Line numbers** in every plan were re-verified at 00:50 against the
post-Grok working tree. Excerpts remain the source of truth: if a number is
off by a few lines, `grep -n` the excerpt; if the excerpt itself is gone, STOP.

## Vetted findings, ranked by leverage

Impact ÷ effort, discounted by confidence and fix risk. "Plan" is the section
that carries it.

| # | Finding | Category | Impact | Effort | Risk | Conf. | Evidence | Plan |
|---|---|---|---|---|---|---|---|---|
| 1 | Fresh `[]` / ref-in-render / unstable `ask` defeat every `memo()` into the workspace on each App render (incl. every streamed agent frame) | perf | HIGH | S | LOW | HIGH | `App.tsx:378-381`, `RepositoryWorkspace.tsx:1253`, `MultiFileReview.tsx:761`, `useAgentSession.ts:306-356` | 002 |
| 2 | Streamed PR patch concatenated per page → O(n²) copies; main re-ships the joined patch after streaming | perf | HIGH | M | MED | HIGH | `useReviewWorlds.ts:313-314`, `repository.ts:1962-1975`, `useGitWorkflow.ts:328-342` | 003 |
| 3 | Seven visible UI bugs: popover 40 px off, inert toast button, invalid focus ring, dark hex in light theme, 8 px label, frozen skeleton, layout-animating brand | bug | HIGH | S | LOW | HIGH | `styles.css:1273,2044-2070,490,1639`, `dragSelection.ts:6-43`, `GitHubPanel.tsx:289` | 015 |
| 4 | Escape closes 2–3 surfaces; `Alt+Z` fires while typing; tab-A load error lands on tab B; failed Approve hides its message; Ctrl+J eaten in terminal | bug | HIGH | M | MED | HIGH | `App.tsx:142-180`, `keybindings.ts:93-109`, `useGitWorkflow.ts:289,354`, `PullRequestReviewBar.tsx:39-48` | 025 |
| 5 | Closing a tab never calls `dispose()` → stray `git cat-file` child + up to 128 MB caches per closed repo; `ipcMain.on` handlers throw uncaught | perf/bug | HIGH | S | LOW | HIGH | `repositorySessions.ts:106-111`, `repository.ts:1068-1072`, `index.ts:416-423` | 008 |
| 6 | Sidebar/split/gutter drags read layout then write per pointermove; pinch-zoom rebuilds `CodeView` options per wheel tick | perf | HIGH | M | MED | HIGH | `SidebarResizer.tsx:62`, `splitDiffResize.ts:171`, `dragSelection.ts:70-107`, `useCodeZoomGesture.ts:139` | 005 |
| 7 | Three stacked review bars with different heights/gutters/alignment; six-step left-gutter ladder; skeleton ≠ Explorer | UI | HIGH | M | MED | HIGH | `styles.css:659-686,576,695,1017,1024`, `WorkspaceSkeleton.tsx:84-98` | 016 |
| 8 | Watcher re-scans pending set per event; union `Set` rebuilt in loop; folder mode re-ships all paths per tick; sync fs on flush | perf | MED | S | LOW | HIGH | `repositoryWatcher.ts:233,110-115,242-246`, `repository.ts:1144-1172` | 009 |
| 9 | Raw patch + parsed items both retained per tab; Since worlds outside the budget; estimator counts wrong bytes; Since build peaks 3× | perf/mem | HIGH | M | MED | HIGH | `useReviewWorlds.ts:225-241`, `reviewCheckpoints.ts:166-176`, `useComparisonLoader.ts:82-85` | 004 |
| 10 | Memory tooling wrong: benchmark script misses dev binary + grandchildren; DOM-node metric ignores shadow roots | dx | MED (unblocks 003/004/008 verification) | S | LOW | HIGH | `scripts/benchmark-memory.sh:7,18`, `preload/index.ts:117` | 022 |
| 11 | Per-checkbox / per-page synchronous localStorage writes; re-anchor runs once per streamed page; settings sliders persist + IPC + SIGWINCH per step | perf | MED | S | LOW | HIGH | `useReviewSession.ts:47-63`, `App.tsx:646-657`, `TerminalDock.tsx:474-483` | 006 |
| 12 | Agent transcript forced layout per streamed frame; duplicate CLI probes; terminal fit/focus per status change; HUD polls `getAppMetrics` every 3 s forever | perf | MED | S | LOW | HIGH | `AgentPanel.tsx:103-108`, `useAgentSession.ts:196-217`, `TerminalDock.tsx:485-503`, `PerformanceHud.tsx:21-91` | 007 |
| 13 | 25 duplicated selector blocks (14 in agent dock), 5 dead blocks, 7 orphan classNames | UI debt | MED | M | MED | HIGH | `styles.css:1700-2002` pairs | 017 |
| 14 | 150 raw `ms` vs 3 duration tokens; 9 px most-used size has no token; 8 icon-button sizes; 25 raw z-indexes | UI debt | MED | M | LOW | HIGH | `styles.css` (counts in plan) | 018 |
| 15 | 52 hover rules without `:not(:disabled)`; 6 truncations without `min-width:0`; 1 themed scrollbar of 15; baseline-aligned pills | UI | MED | M | MED | HIGH | `styles.css:664,1793,1582,1444,526` | 019 |
| 16 | Entry chunk: **Grok landed the diff-runtime split (815→340 KB, 00:35)**; remaining: Palette/Chart static, `Editor` value import, no sourcemaps | perf (startup) | LOW (was MED) | S | LOW | HIGH | `App.tsx:31-34`, `PerformanceHud.tsx:6`, `useFileEditing.ts:3`, `out/renderer/assets/index-CxFcYpGS.js` | 013 |
| 17 | `getWorkingTreePatch` no abort/dedupe, runs per watcher event; `git remote -v` re-spawned on every write action | perf | MED | M | LOW | HIGH | `repository.ts:1299-1359,1584,1605,2084` | 010 |
| 18 | Six PR IPC channels use `requireActive()` → conversation poll for tab A can read repo B | bug | MED | M | MED | MED | `index.ts:482-491,511-513`, `usePullRequestConversation.ts:85,114` | 011 |
| 19 | Four unbounded localStorage families; drafts cap 12 MB > 5 MB quota; writes silently dropped | bug | MED | M | LOW | HIGH | `viewedFileStorage.ts:45-47`, `reviewThreadStorage.ts:91-93`, `draftStore.ts:15-16` | 021 |
| 20 | Tab switch remounts the whole workspace (re-parse, re-highlight) | perf (arch) | HIGH | L | MED | HIGH | `App.tsx:364`, `RepositoryWorkspace.tsx:798` | 024 |
| 21 | Two `@pierre/theme` majors installed (tree vs code palette); 1.15 MB of unselectable Shiki themes shipped | migration/size | LOW | S | MED | HIGH | `node_modules/@pierre/theme` 1.1.0 vs nested 2.0.0; `out/` theme chunks | 014 |
| 22 | PR disk cache `JSON.parse`/`stringify` of whole patch on main thread | perf | MED | M | MED | HIGH | `repository.ts:943-980` | 012 |
| 23 | Two markdown stacks: GFM renders in PR body, not in review comments | UI | LOW | M | MED | HIGH | `RemoteReviewThreads.tsx:5,23`, `PullRequestContext.tsx:5,56` | 020 |
| 24 | CI no cache, `react-doctor@latest` hard gate; `tsc -p` ×2 despite composite refs; stray transcript at root | dx | LOW | S | LOW | HIGH | `.github/workflows/ci.yml`, `package.json` | 023 |
| 25 | React Compiler 1.0 stable but not adopted; no hooks lint (`oxlint src` without react plugin) — would enforce #1 structurally | migration/perf | HIGH | M | MED | HIGH | `electron.vite.config.ts:100-104`, `package.json`, `react-doctor-baseline.json` `hasReactCompiler:false` | 026 |

## Execution order

Three tracks can run in parallel (different files). Within a track, top to bottom.

**Track P — perf, renderer**: 022 → 002 → 026 (spike, then rollout) → 003 → 004 → 005 → 006 → 007 → 024
**Track M — perf, main process**: 008 → 009 → 010 → 011 → 012
**Track U — UI**: 015 → 025 → 016 → 017 → 018 → 019 → 020
**Anytime**: 013, 014, 021 (after 006), 023

Dependency notes:

- 003 needs nothing but is much easier to *measure* after 002 (memo noise gone).
- 004 requires 003 (`patchPages`, `patchLength` exist).
- 005 requires 002 (zoom measurement).
- 007 requires 002 (`session.ask` stabilised there).
- 012 requires 003 (streamed reply shape).
- 016 requires 015; 017 requires 016; 018 requires 017 (tokens applied to one copy of each rule); 019 requires 018.
- 021 requires 006 (writes are debounced before they are budgeted).
- 024 requires 002, 003, 004 and an approved spike note (Phase A).
- 026 requires 002 (Site B is a compiler bailout); once 026 is DONE, Plan 002's Sites A/C/D are enforced by the compiler and the review rule in 002's maintenance notes relaxes.
- 022 first: without it, 003/004/008 cannot prove their memory claims.

## Status table

| Plan | Title | Track | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|---|
| 002 | Hold the memo boundaries | P | P1 | S | — | TODO |
| 003 | Stream PR patch as pages | P | P1 | M | — | TODO |
| 004 | Bound review memory retention | P | P1 | M | 003 | TODO |
| 005 | Compositor-only drags and zoom | P | P1 | M | 002 | TODO |
| 006 | Debounce persistence and re-anchoring | P | P2 | S | — | TODO |
| 007 | Agent dock render hygiene | P | P2 | S | 002 | TODO |
| 008 | Release repository resources on tab close | M | P1 | S | — | TODO |
| 009 | Watcher and folder-refresh hot path | M | P1 | S | — | TODO |
| 010 | Working-tree patch abort and dedupe | M | P2 | M | — | TODO |
| 011 | Root-scope pull-request channels | M | P2 | M | — | TODO |
| 012 | PR cache sidecar format | M | P3 | M | 003 | TODO |
| 013 | Finish the entry-chunk diet (palette/chart lazy, editor import, sourcemaps) | any | P3 | S | — | TODO — bulk landed by Grok 00:35 (entry 815→340 KB) |
| 014 | Theme dedupe and Shiki trim | any | P3 | S | — | TODO |
| 015 | UI bug batch | U | P1 | S | — | TODO |
| 016 | Unify review bars and gutters | U | P1 | M | 015 | TODO |
| 017 | CSS dedupe and dead rules | U | P2 | M | 016 | TODO |
| 018 | Design token pass | U | P2 | M | 017 | TODO |
| 019 | Interaction state polish | U | P2 | M | 018 | TODO |
| 020 | One markdown renderer for GitHub bodies | U | P3 | M | — | TODO |
| 021 | localStorage budget and feedback | any | P2 | M | 006 | TODO |
| 022 | Perf tooling baseline | P | P1 | S | — | TODO |
| 023 | DX hygiene | any | P3 | S | — | TODO |
| 024 | Keep workspace mounted across tab switch | P | P2 | L | 002, 003, 004 | TODO (spike first) |
| 025 | Keyboard, Escape, focus and scoping bugs | U | P1 | M | — | TODO |
| 026 | Adopt React Compiler 1.0 behind a healthcheck | P | P2 | M | 002 | TODO (spike first) |

Status values: TODO · IN PROGRESS · DONE · BLOCKED (reason) · REJECTED (reason).

## Considered and rejected (do not re-audit)

- **"Renderer re-parses the whole patch when the resolved review arrives"** —
  wrong: `canAppendPatch` (`useReviewLoadState.ts:107-115`) seam-checks the
  streamed prefix and parses only the tail. The double ship (plan 003) costs
  IPC bytes and a transient second copy, not a re-parse.
- **`hash ^ 0` separator in `viewedFileStorage.ts:76` is a no-op** — not quite:
  the following `Math.imul` still advances state, so line boundaries do
  perturb the hash (weakly). Changing it would invalidate every stored
  signature; not worth it.
- **Per-token setState / full markdown re-parse / IPC listener leaks / xterm
  lifecycle / ripgrep per keystroke / toast timers** — all checked, all already
  handled (`agentService.ts:275-315`, `useAgentAnswer.ts:191-211`,
  `markdown.ts:145-186`, `preload/index.ts` unsubscribe closures,
  `TerminalDock.tsx:275-332`, `contentSearchScheduler.ts`, `toast.ts:55-64`).
- **`poolSize: 1` / `totalASTLRUCacheSize: 4`** — deliberate, documented
  memory-for-CPU trade (`diffWorkerConfig.ts`). Measure after 003/004; change
  only with a benchmark.
- **Inline `style={{}}`** — 11 sites, 9 are CSS-variable bridges; correct pattern.
- **Main cold start** — clean: window created after two small sync JSON reads,
  git spawns start before the window (`index.ts:620-633`), SDK/node-pty are
  `import type`.
- **`@pierre/icons`, `react-markdown`, `xterm` bundling** — tree-shaken / lazy already.
- **Shiki grammar trimming (~8 MB, lazy)** — package size only; needs a
  supported-language decision + plaintext fallback. Follow-up, not in this plan.
- **Terminal → pty backpressure** (`terminalService.ts:267-275` flushes at 64 KB
  with no ack) — real but needs a firehose measurement first; MED risk to
  interactive programs. Follow-up.
- **Buffer-based working-tree patch assembly** (`repository.ts:1319-1357`,
  `patchBuilder.ts:145-150`, 3–4× transient) — MED risk against tight byte-exact
  tests; revisit after 010 shows the remaining cost.
- **Font subset trimming** (190 KB non-Latin) — `unicode-range` makes it
  package-size only, and Fira Code renders arbitrary repos. Product decision.
- **Real-clock sleeps in main tests** — flake risk, but the watcher tests
  document why they retry; plan 023 records timings only.
- **Repeated group header in palette ranking** (`paletteCommands.ts:65-72`) —
  consequence of rank-ordering the flat list; fixing it breaks the one-index
  selection model the code defends.
- **Aggregate main-process cache cap** — folded into plan 008 Step 3 (trim
  inactive services) rather than a global budget object; revisit if 008's
  floor is not enough.

---

# Plans

Each section is self-contained. Headings inside a plan are demoted one level so the whole document has a single outline.

---

## Plan 002: Make the `memo()` boundaries into the review workspace actually hold

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/App.tsx src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/MultiFileReview.tsx src/renderer/src/useAgentSession.ts src/renderer/src/useReviewWorlds.ts`
> This plan was written against commit `caa1771` **plus the uncommitted working
> tree of 2026-08-30**. Commit that working tree first. Then compare every
> "Current state" excerpt against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

### Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

> **Update 2026-08-30 00:50** — `RepositoryWorkspace` is now rendered through `WorkspaceRoot` (`src/renderer/src/WorkspaceRoot.tsx`, loaded via `workspaceBoot.ts`); the two `[]` literals are on the `<WorkspaceRoot …>` element at `App.tsx:378-381` and flow unchanged into `memo(RepositoryWorkspace)` (`RepositoryWorkspace.tsx:990`). `MultiFileReview` is now loaded with `useSyncExternalStore` (`RepositoryWorkspace.tsx:762-765`) — its props are unchanged. If Plan 026 (React Compiler) lands first, Sites A, C and D become redundant; Site B and Site E still apply. Line numbers re-verified.

### Why this matters

`RepositoryWorkspace` (35 props), `RepositoryDiffPanel` (43), `MultiFileReview`
(28) and `MultiFileViewer` (41) are all wrapped in `memo()`, and every one of
those boundaries is defeated on every `App` render by a handful of unstable
props. The consequence: every keystroke in the titlebar search field, every
search-result hover, every terminal resize tick, every error-banner mount, and
— worst — **every animation frame of a streaming agent answer** re-runs the
entire workspace render path and hands the `@pierre/diffs` `CodeView` a new
`renderCodeViewHeader` function. The repo already documents this exact failure
mode once (`useRepositorySearch.ts:148-149`) and fixed it there; this plan
fixes the remaining sites. Several other plans (005, 006, 007) get cheaper once
this lands, because the workspace stops re-rendering for unrelated reasons.

### Current state

Files:

- `src/renderer/src/App.tsx` — renders `<RepositoryWorkspace>` inside
  `AgentSessionLayout` (a `memo` component that re-renders once per rAF while
  an agent answer streams, because `useAgentSession` lives inside it, lines
  238 and 270).
- `src/renderer/src/RepositoryWorkspace.tsx` — `memo(RepositoryWorkspace)` at
  line 948; forwards props into `memo(RepositoryDiffPanel)`.
- `src/renderer/src/MultiFileReview.tsx` — `memo(MultiFileReview)` →
  `memo(MultiFileViewer)`; owns the single `<CodeView>` (line 617).
- `src/renderer/src/useAgentSession.ts` — returns a bare object literal and an
  unstable `ask` callback.
- `src/renderer/src/useReviewWorlds.ts` — `dispatch` runs the inactive-payload
  sweep on every action.
- `src/renderer/src/reviewMetrics.ts` — `markRepositoryWorkspaceRender()` counts
  workspace renders; exposed in the Performance HUD as `workspaceRenders`. This
  is your measurement instrument.

#### Site A — fresh `[]` literals (App.tsx:378-381)

```tsx
// src/renderer/src/App.tsx:378-381 — current
sinceRemovedPaths={gitWorkflow.activeWorld?.source === 'since'
  ? gitWorkflow.activeWorld.removedPaths : []}
sinceUncertainPaths={gitWorkflow.activeWorld?.source === 'since'
  ? gitWorkflow.activeWorld.uncertainPaths : []}
```

For every non-Since tab (the normal case) both props are a brand-new array
each render. They flow `RepositoryWorkspace` → `RepositoryDiffPanel`
(`RepositoryWorkspace.tsx:807-808`) → `MultiFileReview` → `MultiFileViewer`
(`MultiFileReview.tsx:959-960`), and they sit in the deps of the
`renderReviewSummary` `useCallback` (`MultiFileReview.tsx:436-437`), so
`CodeView`'s `renderCodeViewHeader` prop also changes identity.

The exemplar the repo already uses for this problem:

```ts
// src/renderer/src/useRepositorySearch.ts:148-150 — existing exemplar
// A bare object literal here defeated `memo(AppLayout)` and `memo(AgentSessionLayout)`
// on every App render, so both boundaries cost a 40-key compare and saved nothing.
return useMemo(() => ({
```

#### Site B — a mutable ref read in render (RepositoryWorkspace.tsx:1253)

```tsx
// src/renderer/src/RepositoryWorkspace.tsx:1253 — current
initialScrollTop={multiFileScrollTopRef.current}
```

The ref is written on every scroll (`RepositoryWorkspace.tsx:957-960`,
`rememberScroll`) without a re-render. `MultiFileReview.tsx:835` copies the
prop into `restoreTargetRef` once at mount and never reads it again. So after
any scroll, the *next* unrelated re-render sees a changed prop and both
`RepositoryDiffPanel` and `MultiFileReview` fail their memo compare — for an
input nobody consumes after mount.

#### Site C — `join('\0')` / `split` round-trip in render (MultiFileReview.tsx:761-762)

```tsx
// src/renderer/src/MultiFileReview.tsx:761-762 — current
const pathsKey = paths.join('\0')
const stablePaths = useMemo(() => pathsKey === '' ? [] : pathsKey.split('\0'), [pathsKey])
```

`paths.join` runs unmemoized on every `MultiFileReview` render. For a folder
review or a large PR (tens of thousands of paths) this allocates a
multi-hundred-KB string per render, then splits it back into an array. `paths`
already arrives memoized from `useReviewPaths`.

#### Site D — unstable `ask` and session object (useAgentSession.ts:306-356)

```ts
// src/renderer/src/useAgentSession.ts:306-324 — current (abridged)
const ask = useCallback((prompt: string) => {
  ...
  answer.ask({ ... })
  ...
}, [accessMode, answer, attachments, effort, model, provider, subject, subjectKey])
...
return {            // src/renderer/src/useAgentSession.ts:329 — bare object literal
  answer, open, provider, model, ...
  ask, toggle, close
}
```

`answer` is the object returned by `useAgentAnswer`, which is `{ ...state,
blocks, ask, ... }` — new identity every render — so `ask` is rebuilt every
render even though only `answer.ask` is used. `AgentDock.tsx:76` passes
`onAsk={session.ask}` into `memo(AgentPanel)` (`AgentPanel.tsx:75`), so that
memo never bails either.

#### Site E — inactive-payload sweep on every dispatch (useReviewWorlds.ts:401)

```ts
// src/renderer/src/useReviewWorlds.ts:400-402 — current
const dispatch = useCallback((action: WorldRegistryAction) => {
  setState((current) => boundInactivePatchPayloads(reduceWorldRegistry(current, action)))
}, [])
```

`boundInactivePatchPayloads` (`useReviewWorlds.ts:231-262`) calls
`reviewPayloadBytes` (`:225-229`), which reduces over `review.files` and
`review.omittedFiles` of every inactive patch world, on **every** action —
including `update-locator` (typing in a New Tab locator) and `focus`, which
cannot grow any payload.

### Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Tests | `bun test` | all pass |
| Focused tests | `bun test src/renderer/src/useReviewWorlds.test.ts src/renderer/src/useAgentSession.dom.test.tsx` | all pass |
| React health gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |
| Whitespace | `git diff --check` | exit 0 |
| Build + install (feel check) | `bun run update:mac` | `Installed Horus 0.1.0 in …/Horus.app` |

### Suggested executor toolkit

- Run `react-doctor` (see `.claude/skills/react-doctor`) before and after; the
  score must remain 100.
- The Performance HUD (titlebar) shows `workspaceRenders` from
  `reviewMetrics.ts`. Use it for the before/after measurement in Step 6.

### Scope

**In scope** (the only files you should modify):

- `src/renderer/src/App.tsx`
- `src/renderer/src/RepositoryWorkspace.tsx`
- `src/renderer/src/MultiFileReview.tsx`
- `src/renderer/src/useAgentSession.ts`
- `src/renderer/src/useReviewWorlds.ts`
- `src/renderer/src/useReviewWorlds.test.ts` (add tests)
- `src/renderer/src/useAgentSession.dom.test.tsx` (add a test)

**Out of scope** (do NOT touch, even though they look related):

- `src/renderer/src/useAgentAnswer.ts` — its return object is also unstable, but
  the streaming path is deliberately designed around per-frame updates; plan 007
  handles the agent dock.
- `src/renderer/src/DiffSurface.tsx`, `useCodeZoomGesture.ts` — plan 005.
- Anything inside `node_modules/@pierre/*`.
- Do not add `React.memo` to new components or change any component's props
  shape; this plan only stabilises identities that already cross existing memo
  boundaries.

### Git workflow

- Branch: `perf/002-hold-memo-boundaries`
- Commit style (from `git log`): short conventional prefix, e.g.
  `fix: stabilise workspace memo props`
- Do NOT push or open a PR unless the operator instructed it.

### Steps

#### Step 1: Record the baseline render count

Run `bun run dev`, open a repository, open the Performance HUD popover, note
`workspaceRenders`. Then type 10 characters into the titlebar search field and
note the new value. Record both numbers (expect roughly +10 or more today).

**Verify**: numbers recorded in your report.

#### Step 2: Hoist the empty-path fallbacks (Site A)

In `src/renderer/src/App.tsx`, add at module scope (near the other module-level
constants, before the first component):

```ts
// Both props are read-only; a shared frozen array keeps memo(RepositoryWorkspace)
// from failing its compare on every render of a non-Since tab.
const NO_PATHS: readonly string[] = Object.freeze([]) as readonly string[]
```

Replace the two `: []` fallbacks at lines 365-368 with `: NO_PATHS`. If the
prop types are `string[]` (mutable), widen the corresponding prop types in
`RepositoryWorkspaceProps`, `RepositoryDiffPanelProps` and the
`MultiFileReview`/`MultiFileViewer` props to `readonly string[]` rather than
casting. Follow the readonly usage down until `bun run typecheck` is clean.

**Verify**: `bun run typecheck` → exit 0; `grep -n "removedPaths : \[\]\|uncertainPaths : \[\]" src/renderer/src/App.tsx` → no matches.

#### Step 3: Stop reading the scroll ref in render (Site B)

In `src/renderer/src/RepositoryWorkspace.tsx` around line 1210, change the prop
so its identity does not change on scroll. Preferred shape: pass a stable
getter created once —

```ts
const getInitialMultiFileScrollTop = useCallback(() => multiFileScrollTopRef.current, [])
...
getInitialScrollTop={getInitialMultiFileScrollTop}
```

— and in `src/renderer/src/MultiFileReview.tsx` (prop currently named
`initialScrollTop`, consumed at line 833 into `restoreTargetRef`), rename the
prop to `getInitialScrollTop: () => number` and call it once where the old value
was copied. Update the `RepositoryDiffPanel` pass-through and prop types.

**Verify**: `bun run typecheck` → exit 0; `grep -n "initialScrollTop={" src/renderer/src/RepositoryWorkspace.tsx` → no matches (the getter prop replaces it).

#### Step 4: Remove the join/split round-trip (Site C)

In `src/renderer/src/MultiFileReview.tsx:761-762`, delete `pathsKey` and make
`stablePaths` the `paths` prop directly (it is already memoized upstream by
`useReviewPaths`). If anything else in the file reads `pathsKey`, replace it with
`paths` (identity) — search the file first: `grep -n pathsKey
src/renderer/src/MultiFileReview.tsx`. If a consumer genuinely needs a string key
(e.g. a storage key), compute it inside a `useMemo(() => paths.join('\0'),
[paths])` so it runs only when `paths` identity changes, not on every render.

**Verify**: `grep -n "paths.join('\\\\0')" src/renderer/src/MultiFileReview.tsx` returns either nothing or only a line inside a `useMemo`; `bun test src/renderer/src/MultiFileReview.test.ts` → pass.

#### Step 5: Stabilise `useAgentSession` (Site D)

In `src/renderer/src/useAgentSession.ts`:

1. Change the `ask` dependency list to depend on `answer.ask` instead of
   `answer`: destructure `const askAnswer = answer.ask` above the callback and
   use `askAnswer(...)` inside; deps become
   `[accessMode, askAnswer, attachments, effort, model, provider, subject, subjectKey]`.
2. Wrap the returned object (lines 329-356) in `useMemo(() => ({ ... }), [every
   field listed])`, following the exemplar at `useRepositorySearch.ts:150`.

**Verify**: `bun test src/renderer/src/useAgentSession.dom.test.tsx` → pass; `bun run lint` → exit 0 (oxlint will flag a missing dep if you forget one).

#### Step 6: Skip the payload sweep for actions that cannot grow a payload (Site E)

In `src/renderer/src/useReviewWorlds.ts`, add a small predicate next to
`boundInactivePatchPayloads`:

```ts
// Only these actions can add bytes to an inactive patch world or change which
// world is active; every other dispatch leaves the budget exactly where it was.
const PAYLOAD_AFFECTING_ACTIONS: ReadonlySet<WorldRegistryAction['type']> = new Set([
  'open-patch', 'append-patch-page', 'replace-patch', 'open-since', 'focus', 'close'
])
```

(`focus` and `close` stay in because they change `activeWorldId`, which changes
which worlds count as inactive.) Then in `dispatch`:

```ts
setState((current) => {
  const next = reduceWorldRegistry(current, action)
  return PAYLOAD_AFFECTING_ACTIONS.has(action.type) ? boundInactivePatchPayloads(next) : next
})
```

Confirm the action-type union at `useReviewWorlds.ts:73-97` — if an action type
that can add `review` bytes is missing from the set above, add it.

**Verify**: `bun test src/renderer/src/useReviewWorlds.test.ts` → pass.

#### Step 7: Re-measure

Repeat Step 1. Typing 10 characters into the titlebar search field must now
change `workspaceRenders` by **0**. Also: start an agent answer and watch
`workspaceRenders` while it streams — it must not climb with the stream.

**Verify**: both observations recorded in your report.

### Test plan

- `src/renderer/src/useReviewWorlds.test.ts` — add:
  - `dispatching 'update-locator' returns the same state object when nothing
    else changed` (asserts the sweep is skipped: reduce with `update-locator`
    then check `boundInactivePatchPayloads` was not needed by comparing
    identities of every world in `state.worlds` before/after).
  - Model after the existing `'inactive GitHub patch payloads are released when
    they exceed the memory budget'` test at line 170.
- `src/renderer/src/useAgentSession.dom.test.tsx` — add: render the hook via
  `renderHook`, capture `result.current.ask`, trigger an unrelated re-render
  (`rerender()`), assert `result.current.ask` is the same function reference.
- Verification: `bun test` → all pass, including the new tests.

### Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run lint` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0; the two new tests exist and pass
- [ ] `npx -y react-doctor@latest --verbose` prints `Score: 100 / 100`
- [ ] `grep -n "removedPaths : \[\]\|uncertainPaths : \[\]" src/renderer/src/App.tsx` → no output
- [ ] `grep -n "initialScrollTop={multiFileScrollTopRef.current}" src/renderer/src/RepositoryWorkspace.tsx` → no output
- [ ] Typing 10 characters into the titlebar search field changes `workspaceRenders` in the Performance HUD by 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] status table in this file updated

### STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift).
- Widening to `readonly string[]` in Step 2 cascades into more than ~6 type
  sites — report the list instead of casting.
- `MultiFileReview.tsx` has a consumer of `pathsKey` you cannot classify as
  "identity key" vs "storage key".
- After Step 6, `workspaceRenders` still climbs while typing in search. That
  means another unstable prop exists; list the candidates (compare each of the
  35 `RepositoryWorkspace` props across two renders with a temporary `console.log`
  in dev — remove it before committing) and stop.
- `react-doctor` score drops below 100.

### Maintenance notes

- Any new prop added to `RepositoryWorkspace`, `RepositoryDiffPanel`,
  `MultiFileReview` or `MultiFileViewer` must be identity-stable across renders
  (module constant, `useMemo`, `useCallback`, or a ref getter). Reviewers should
  ask "what is this prop's identity on an unrelated re-render?" for every new one.
- `PAYLOAD_AFFECTING_ACTIONS` must be extended if a new action type can put
  `review` bytes into a world. Plan 004 changes the byte estimator; that is
  compatible with this gate.
- Deferred: `useAgentAnswer`'s return object (plan 007), the `codeViewOptions`
  rebuild on zoom (plan 005).

---

## Plan 003: Stream a PR patch as pages — no quadratic concatenation, no double shipping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/useReviewWorlds.ts src/renderer/src/useReviewLoadState.ts src/renderer/src/useGitWorkflow.ts src/main/repository.ts src/main/index.ts src/shared/contracts.ts`
> This plan was written against commit `caa1771` **plus the uncommitted working
> tree of 2026-08-30**. Commit that working tree first. Compare every "Current
> state" excerpt against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

### Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (002 recommended first so re-render noise does not hide the win)
- **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Opening a large pull request is the slowest everyday action in Horus. The main
process already streams the patch page by page, and `useReviewLoadState`
already parses only the new tail. But the reducer that *stores* those pages
concatenates strings — `patch: \`${world.review.patch}${page}\`` — so a 13 MB
patch delivered in ~130 pages copies roughly 850 MB of string data through the
renderer heap during load, and every `startsWith`/`slice` on the growing
cons-string forces V8 to flatten it again. Then, when the stream finishes, main
re-joins the whole patch and returns it as the IPC reply, so the same bytes
cross the boundary twice and the renderer briefly holds both copies. Fixing the
storage shape (pages, not a string) and the double ship makes PR open time and
peak memory scale linearly with patch size.

### Current state

Files:

- `src/renderer/src/useReviewWorlds.ts` — world registry reducer; `PatchWorld`
  (lines 36-48) holds `review: RepositoryReview` whose `patch` is one string.
- `src/renderer/src/useReviewLoadState.ts` — incremental patch parser
  (`canAppendPatch`, `patchSeam`, `externalReview` memo).
- `src/renderer/src/useGitWorkflow.ts` — `loadPullRequestReview`; adopts the
  resolved review after streaming.
- `src/main/repository.ts` — `getPullRequestReview` / `#collectPullRequestPatch`
  emit pages and return the joined review.
- `src/main/index.ts` — IPC handler that both forwards progress and resolves the
  review (lines 491-507).
- `src/shared/contracts.ts` — `PullRequestReview` (line 209; `patch: string` at
  220, `expectedFileCount` at 224) and `PullRequestReviewProgress` (232-245).

#### The quadratic concat (renderer)

```ts
// src/renderer/src/useReviewWorlds.ts:306-319 — current
if (action.type === 'append-patch-page') {
  return updatePatchWorld(state, action.worldId, action.generation, (world) => {
    if (world.review.kind !== 'github' || world.review.selector !== action.progress.selector) return world
    return {
      ...world,
      review: {
        ...world.review,
        files: [...world.review.files, ...action.progress.files],
        patch: `${world.review.patch}${action.progress.patch}`,
        omittedFiles: [...world.review.omittedFiles, ...action.progress.omittedFiles]
      }
    }
  })
}
```

#### The incremental parser it feeds (renderer)

```ts
// src/renderer/src/useReviewLoadState.ts:95-116 — current
const PATCH_SEAM_SAMPLE = 4_096

function patchSeam(patch: string): string {
  return patch.length <= PATCH_SEAM_SAMPLE ? patch : patch.slice(patch.length - PATCH_SEAM_SAMPLE)
}

export function canAppendPatch(
  parsed: Pick<ParsedPatchCache, 'key' | 'length' | 'tail'>,
  key: string,
  patch: string
): boolean {
  return parsed.key === key
    && patch.length >= parsed.length
    && patch.startsWith(parsed.tail, parsed.length - parsed.tail.length)
}
```

```ts
// src/renderer/src/useReviewLoadState.ts:180-207 — current (abridged)
const parsedPatchRef = useRef<ParsedPatchCache>({ key: '', length: 0, tail: '', items: [] })
const externalReview = useMemo<ExternalReviewItems | null>(() => {
  if (repositoryReview == null) return null
  const key = ...
  const parsed = parsedPatchRef.current
  const appended = canAppendPatch(parsed, key, repositoryReview.patch)
  const pending = appended ? repositoryReview.patch.slice(parsed.length) : repositoryReview.patch
  const pendingItems = pending === '' ? [] : createPatchReviewItems<ReviewAnnotationMetadata>(pending, key)
  const items = appended ? mergeReviewItems(parsed.items, pendingItems) : pendingItems
  return { cache: { key, length: repositoryReview.patch.length, tail: patchSeam(repositoryReview.patch), items },
           items: orderReviewItems(items, stablePaths) }
}, [repositoryReview, stablePaths])
```

The seam check exists because "a page re-emitted with different bytes would
have been sliced mid-hunk" (comment at lines 101-106). Keep that guarantee.

#### The double ship (main + renderer)

```ts
// src/main/repository.ts:1962-1975 — current
const review: PullRequestReview = {
  ...base,
  files: collectedFiles,
  patch: patchParts.join(''),
  omittedFiles: collectedOmitted
}
if (!signal.aborted) await this.#pullRequestCache?.write(pullRequest.url, headRefOid, review)
return review
```

```ts
// src/main/repository.ts:1931-1942 — the cached path already avoids this, and says so
// No files event: the whole patch is already in hand, so emitting it here
// and returning it from the same call would clone up to the entire review
// over IPC twice in one tick. The renderer adopts the resolved review.
```

```ts
// src/main/repository.ts:1993-2000 — fast path (≤300 files, `gh pr diff`) emits ONE page
const patch = diffResult.stdout.toString('utf8')
emit({ patch, files: filesFromPatch(patch), omittedFiles: [] })
```

```ts
// src/renderer/src/useGitWorkflow.ts:328-342 — renderer adopts the resolved copy
if (streamed) {
  // The resolved review is authoritative: progress events and the reply to
  // this call are separate IPC messages, so a late page can land after the
  // listener is gone. Its patch shares the streamed prefix, so adopting it
  // only costs parsing whatever tail was missed. ...
  if (worldId != null) {
    reviewWorlds.replacePatchReview(worldId, generation, { ...review, expectedFileCount: review.files.length })
    reviewWorlds.setPatchLoadStatus(worldId, generation, 'ready')
  }
  return
}
```

That comment records a real constraint: the resolved reply is how the renderer
learns the final file count and recovers any page it missed. The fix must keep
that reconciliation while not shipping the bytes it already has.

#### Existing tests to model after

- `src/renderer/src/useReviewWorlds.test.ts:70-97` — `'a patch page only
  updates its matching world generation'` builds a `PatchWorld` with
  `createPatchWorld(snapshot(), review, generation, status)` and dispatches
  `append-patch-page`.
- `src/renderer/src/useReviewLoadState.test.ts` imports `canAppendPatch`.

### Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `bun run lint` | exit 0 |
| Typecheck (both projects) | `bun run typecheck` | exit 0 |
| Tests | `bun test` | all pass |
| Focused | `bun test src/renderer/src/useReviewWorlds.test.ts src/renderer/src/useReviewLoadState.test.ts src/main/repository.test.ts` | all pass |
| React gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |
| Build + install | `bun run update:mac` | `Installed Horus 0.1.0 in …` |

### Scope

**In scope**:

- `src/shared/contracts.ts` — add optional `pages?: readonly string[]` /
  `patchLength` on the renderer-side world review shape ONLY if you choose the
  contract route in Step 2; otherwise untouched.
- `src/renderer/src/useReviewWorlds.ts`, `useReviewWorlds.test.ts`
- `src/renderer/src/useReviewLoadState.ts`, `useReviewLoadState.test.ts`
- `src/renderer/src/useGitWorkflow.ts`
- `src/main/repository.ts`, `src/main/repository.test.ts`
- `src/main/index.ts` (only the `getPullRequestReview` handler)

**Out of scope**:

- `src/renderer/src/reviewCheckpoints.ts` (`filterReviewPatch`) — plan 004.
- The PR disk cache format (`PullRequestReviewCache`) — plan 012. This plan must
  keep writing the same on-disk shape (`patch: string`), so join once in main
  for the cache write only.
- `MultiFileReview.tsx`, `@pierre/diffs` internals.
- Local branch/commit comparisons (`kind: 'local'`) — they arrive as one
  document; leave them as a single page.

### Git workflow

- Branch: `perf/003-stream-pr-patch-as-pages`
- Commits: one per step, e.g. `perf: store streamed patch pages instead of concatenating`
- Do NOT push or open a PR unless instructed.

### Steps

#### Step 1: Characterise the seam behaviour before changing it

Add tests to `src/renderer/src/useReviewLoadState.test.ts` that pin the current
`canAppendPatch` semantics (same key + longer patch + matching tail → true; a
mutated tail → false; a different key → false). These stay valid after the
refactor because Step 3 keeps the function for the single-string local review.

**Verify**: `bun test src/renderer/src/useReviewLoadState.test.ts` → pass.

#### Step 2: Store pages on the world

In `src/renderer/src/useReviewWorlds.ts`:

1. Add to `PatchWorld` (lines 36-48): `patchPages: readonly string[]` and
   `patchLength: number`. Keep `review.patch` in the type (the shared contract
   still has it) but treat it as *derived*: for a streaming GitHub world it stays
   `''` until Step 4 decides otherwise.
2. `append-patch-page` pushes `action.progress.patch` onto `patchPages`
   (`[...world.patchPages, page]` — arrays of ~130 short references, not string
   copies), adds `page.length` to `patchLength`, and no longer touches
   `review.patch`.
3. `open-patch` / `replace-patch` / `open-since` initialise `patchPages` from
   whatever they receive: a review with a non-empty `patch` string becomes
   `patchPages: [review.patch]`.
4. `boundInactivePatchPayloads` (lines 231-262) releases `patchPages: []` and
   `patchLength: 0` alongside the existing `patch: ''`.
5. Update `reviewPayloadBytes` (225-229) to use `patchLength` instead of
   `review.patch.length`.

Expose a memoised helper for consumers that genuinely need the whole string:
`export function joinPatchPages(world: PatchWorld): string` (used by plan 004's
`createSinceReview`; do not call it on the hot path).

**Verify**: `bun run typecheck` → exit 0; `bun test src/renderer/src/useReviewWorlds.test.ts` → pass (update the two `append-patch-page` tests at lines 70-97 to assert on `patchPages.length` and `patchLength`).

#### Step 3: Parse pages, not a re-sliced string

In `src/renderer/src/useReviewLoadState.ts`:

1. Change the external-review input so a GitHub patch world supplies
   `patchPages` (a `readonly string[]`) and `patchKey`. Keep the single-string
   path for `kind: 'local'` reviews and for anything that still passes `patch`.
2. Replace `ParsedPatchCache` for the paged path with
   `{ key, pageCount, items }`. The append condition becomes: same `key` and
   `pages.length >= parsed.pageCount` and **`pages[i] === parsed.pageRefs[i]`
   by identity for `i < parsed.pageCount`** (store the page references you
   parsed; identity equality is O(pages) and gives the same "a re-emitted page
   with different bytes cannot be silently sliced" guarantee the seam check
   gave — a re-emitted page is a new string, so identity fails and you fall back
   to a full reparse exactly as today).
3. Parse only `pages.slice(parsed.pageCount)` — each page is a self-contained
   sequence of whole `diff --git` sections (main emits per-file pages from the
   files API, and the fast path emits one whole document), so a page never
   starts mid-hunk. Merge with `mergeReviewItems` as today.
4. Keep `canAppendPatch` exported and unchanged for the string path so the
   Step 1 tests still pass.

**Verify**: `bun test src/renderer/src/useReviewLoadState.test.ts` → pass, including new tests: `'appends only new pages'`, `'a replaced page forces a full reparse'`.

#### Step 4: Stop shipping the joined patch twice (main)

In `src/main/repository.ts` `getPullRequestReview` / `#loadPullRequestReview`:

1. Add a terminal progress event to `PullRequestReviewProgress` in
   `src/shared/contracts.ts`: `{ kind: 'done'; selector: string; fileCount: number }`.
2. After `#collectPullRequestPatch` completes (line ~1961) and `onProgress` was
   supplied and at least one `files` page was emitted, emit `{ kind: 'done',
   fileCount: collectedFiles.length }`, write the cache (join once, cache only),
   and **resolve with `{ ...review, patch: '', files: [], omittedFiles: [] }`
   plus `expectedFileCount: collectedFiles.length`** — the renderer already has
   the pages. When `onProgress` was *not* supplied or no page was emitted
   (cached path, or an error before the first page), resolve with the full
   review exactly as today.
3. Chunk the fast path (lines 1993-2000): split `patch` on `\ndiff --git `
   boundaries into groups of ~25 files and emit each group as its own `files`
   page so a 200-file PR paints progressively like the paged path. Use the same
   splitting helper `filesFromPatch` relies on; do not write a new patch parser.

In `src/main/index.ts:506-522` no change is needed if the handler forwards
every progress kind verbatim — confirm it does not filter on `kind`.

In `src/renderer/src/useGitWorkflow.ts:328-342`: on the streamed path, when the
resolved review has `patch === ''` and `files.length === 0`, do **not** call
`replacePatchReview`; instead dispatch `setPatchExpectedFileCount(worldId,
generation, review.expectedFileCount)` (add this small action to
`useReviewWorlds`) and then `setPatchLoadStatus(..., 'ready')`. Handle the
`done` progress kind in the progress listener by recording `fileCount` the same
way, so a `done` that arrives before the reply is not lost. Keep the existing
behaviour when the resolved review *does* carry a patch (cached path).

**Verify**: `bun test src/main/repository.test.ts` → pass (add: `'the streamed reply omits bytes the pages already delivered'`, `'the fast path emits multiple pages for a 60-file diff'`); `bun run typecheck` → exit 0.

#### Step 5: Feel check

`bun run update:mac`, open a PR with 300+ files (uncached — pick a fresh PR).
The file count in the review header must climb progressively, the final count
must equal what GitHub reports (or the omitted-files notice must explain the
gap), and the Performance HUD's renderer heap must not spike to ~2× the
steady-state value at stream end.

**Verify**: observations recorded in your report.

### Test plan

- `useReviewWorlds.test.ts`: `append-patch-page` grows `patchPages` by one and
  `patchLength` by `page.length`; `boundInactivePatchPayloads` clears pages;
  `reviewPayloadBytes` uses `patchLength`.
- `useReviewLoadState.test.ts`: page append; replaced-page reparse; seam tests
  from Step 1 unchanged.
- `repository.test.ts`: streamed reply shape; fast-path chunking; cached path
  still returns the full review.
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint`, `bun run typecheck`, `bun test` all exit 0
- [ ] `npx -y react-doctor@latest --verbose` → `Score: 100 / 100`
- [ ] `grep -n 'patch: `\${world.review.patch}' src/renderer/src/useReviewWorlds.ts` → no output
- [ ] `grep -n "kind: 'done'" src/shared/contracts.ts` → one match
- [ ] Opening an uncached 300+-file PR shows a progressively increasing file count
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] status table in this file updated

### STOP conditions

- Drift: any excerpt above no longer matches.
- You find a consumer of `world.review.patch` for a GitHub world other than
  `useReviewLoadState`, `reviewCheckpoints.createSinceReview`, and
  `reviewPayloadBytes`. List it and stop (it needs `joinPatchPages` or a
  redesign, and the plan author should decide which).
- Main's files-API page emission turns out to split a single file across two
  pages (check `patchBuilder.ts` before Step 3; if a page can end mid-file,
  the identity-based append is unsafe — stop).
- `useReviewLoadState` items ever contain a duplicated file id after Step 3
  (the `mergeReviewItems` idempotency test should catch it).
- Typecheck errors in `src/main` about `PullRequestReviewProgress` narrowing
  exceed what the `done` variant obviously requires.

### Maintenance notes

- `patchPages` is the source of truth for GitHub patch worlds; `review.patch`
  is empty for them. Anyone adding a feature that needs the whole text must go
  through `joinPatchPages` and should ask whether it can work per page instead.
- Plan 004 replaces `review.patch` retention entirely; plan 012 changes the disk
  cache to store the patch as a separate file — both are compatible with pages.
- Reviewer focus: the identity-based append guard in Step 3 and the "no
  `replacePatchReview` when the reply is bytes-empty" branch in Step 4.

---

## Plan 004: Make the review memory budget bound what is actually retained

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/useReviewWorlds.ts src/renderer/src/useReviewLoadState.ts src/renderer/src/reviewCheckpoints.ts src/renderer/src/useComparisonLoader.ts src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/useGitWorkflow.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts before
> proceeding; mismatch = STOP.

### Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 003 (pages + `patchLength` must exist)
- **Category**: perf (memory)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

The stated product pain is "high memory when viewing many diffs". The DOM is
not the leak: `MultiFileReview` mounts one `CodeView` (`MultiFileReview.tsx:618`)
which virtualises with a 200 px overscroll and releases off-screen items. The
retained cost is JavaScript state: for every open tab, the raw patch text
**and** the parsed items live side by side for the tab's lifetime, "Since" tabs
carry their own filtered patch that no budget ever counts, the budget's byte
estimate counts the wrong thing, and building a Since view materialises three
copies of the patch at once. After this plan the 64 MB budget bounds real bytes,
Since tabs are evictable, and the raw patch is dropped once it has been parsed.

### Current state

#### A. The budget skips Since worlds (useReviewWorlds.ts)

```ts
// src/renderer/src/useReviewWorlds.ts:50-64 — SinceWorld has a full review but no loadStatus
export interface SinceWorld {
  source: 'since'
  worldId: string
  ...
  removedPaths: string[]
  uncertainPaths: string[]
  review: Extract<RepositoryReview, { kind: 'github' }>
}
```

```ts
// src/renderer/src/useReviewWorlds.ts:238-241 — the sweep only considers `patch` worlds
if (world?.source !== 'patch' || world.worldId === state.activeWorldId
  || world.review.kind !== 'github' || world.loadStatus === 'loading'
  || world.loadStatus === 'released') continue
```

#### B. The estimator counts the wrong bytes (useReviewWorlds.ts:225-229)

```ts
function reviewPayloadBytes(review: RepositoryReview): number {
  return review.patch.length * 2
    + review.files.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
    + review.omittedFiles.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
}
```

`patch.length * 2` over-counts an ASCII patch (V8 stores one-byte strings at
one byte per char), and the parsed `CodeViewItem[]` graph — the larger
allocation, ~1.5× the text — is not counted at all. (Plan 003 already switches
this to `patchLength`; this plan changes *what* is counted.)

#### C. Raw patch text retained after parsing

`useReviewLoadState.ts:180-207` parses `repositoryReview.patch` into items and
keeps them in `parsedPatchRef` + `loadState.items`. `@pierre/diffs` copies every
line off the source string (`node_modules/@pierre/diffs/dist/utils/detachString.js`),
so the parsed items do not alias the patch — the raw text is pure duplicate once
parsing has finished. After plan 003 the raw text lives in `world.patchPages`.

#### D. Since view materialises 3× (reviewCheckpoints.ts:166-176)

```ts
export function filterReviewPatch(patch: string, paths: ReadonlySet<string>): string {
  if (patch === '' || paths.size === 0) return ''
  const starts = patchSectionStarts(patch)
  const sections: string[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const section = patch.slice(starts[index], starts[index + 1] ?? patch.length)
    const path = patchSectionPath(section)
    if (path != null && paths.has(path)) sections.push(section)
  }
  return sections.join('')
}
```

Every section — matching or not — is sliced into `sections`' sibling
allocations before the join. For a 13 MB patch that is original + all slices +
joined result, synchronously on the main thread.

#### E. Four live references to the single-file comparison

- `src/renderer/src/useComparisonLoader.ts:82-85` — in `multi` view the effect
  returns early without clearing `comparison` state (line 45). The comment
  explains why: clearing made the return trip flash empty.
- `src/renderer/src/RepositoryWorkspace.tsx:858-862` — `retainedRef.current`
  keeps the last comparison "so returning to a file does not flash", never
  cleared.
- `src/renderer/src/comparisonCache.ts` — the LRU (this one is *meant* to hold it).
- `DiffSurface.tsx` `staleComparison` — freed on unmount; leave it.

Each `FileComparison` holds `oldFile.contents` + `newFile.contents` (up to
2 MB per side). Two of the references above outlive the switch into multi-file
review, where the file is not on screen.

#### Existing test exemplars

- `useReviewWorlds.test.ts:170-182` — `'inactive GitHub patch payloads are
  released when they exceed the memory budget'` calls
  `boundInactivePatchPayloads(state, 100)` with two 100-char patches.
- `reviewCheckpoints.test.ts` — imports `filterReviewPatch` and
  `createSinceReview`; `review(files, patch)` builder at lines 15-25.
- `comparisonCache.test.ts` — plain `describe/test` unit style.

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | all exit 0 |
| Focused | `bun test src/renderer/src/useReviewWorlds.test.ts src/renderer/src/reviewCheckpoints.test.ts src/renderer/src/useReviewLoadState.test.ts` | pass |
| React gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |
| Memory snapshot | `bun run perf:snapshot` (after plan 022 fixes the script) | CSV with all Horus processes |

### Scope

**In scope**: `useReviewWorlds.ts` (+ test), `useReviewLoadState.ts` (+ test),
`reviewCheckpoints.ts` (+ test), `useComparisonLoader.ts`,
`RepositoryWorkspace.tsx` (only the `useRetainedComparison`-style hook at
~812-824), `useGitWorkflow.ts` (only where a Since world is opened/refocused).

**Out of scope**: `diffWorkerConfig.ts` (`poolSize: 1`, `totalASTLRUCacheSize:
4` are deliberate, documented trade-offs — measure, don't change); `@pierre/diffs`;
`comparisonCache.ts` (its LRU is the intended holder); the disk cache (plan 012);
localStorage growth (plan 021).

### Git workflow

- Branch: `perf/004-bound-review-memory`
- One commit per step, `perf:` prefix. No push.

### Steps

#### Step 1: Count what is retained

In `useReviewWorlds.ts`, change `reviewPayloadBytes` to:

```ts
// One byte per char for the patch text (V8 one-byte strings), plus the parsed
// item graph, which detaches every line into its own string (~24 B overhead
// per line on top of the text) — that graph is the larger allocation.
const PARSED_LINE_OVERHEAD_BYTES = 24
function reviewPayloadBytes(world: PatchWorld | SinceWorld): number {
  const text = world.patchLength
  const lines = world.patchLineCount            // see below
  return text + lines * PARSED_LINE_OVERHEAD_BYTES
    + world.review.files.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
    + world.review.omittedFiles.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
}
```

Add `patchLineCount: number` to both world types, computed in the reducer as
each page arrives (count `\n` in the page; a single pass, O(page)). Keep
`MAX_INACTIVE_PATCH_BYTES = 64 MB` for now — retune in Step 6.

**Verify**: `bun test src/renderer/src/useReviewWorlds.test.ts` → pass (update the budget test at line 170 to build worlds with `patchLength`/`patchLineCount`).

#### Step 2: Give Since worlds a `loadStatus` and put them under the budget

1. Add `loadStatus: 'ready' | 'released'` and `patchPages`, `patchLength`,
   `patchLineCount` to `SinceWorld` (mirror `PatchWorld`).
2. In `boundInactivePatchPayloads`, treat `source === 'since'` worlds exactly
   like `patch` worlds: inactive + `ready` → eligible; release = clear pages,
   `review.files`, `review.omittedFiles`, set `'released'`.
3. In `useGitWorkflow.ts`, where the active world changes to a Since world whose
   `loadStatus === 'released'`, recompute it from its parent patch world via the
   existing `createSinceReview(parentReview, checkpoint)` path (the same call
   that built it originally — find it with `grep -n createSinceReview
   src/renderer/src/useGitWorkflow.ts`). If the parent is itself released,
   reload the parent first (that path already exists for released patch worlds —
   grep `'released'` in `useGitWorkflow.ts`).

**Verify**: new test `'inactive Since worlds are released under the same budget'` passes; `bun run typecheck` → exit 0.

#### Step 3: Drop the raw pages once parsed

In `useReviewWorlds.ts`, add action `{ type: 'retire-patch-text'; worldId;
generation }` that sets `patchPages: []` but **keeps `patchLength` and
`patchLineCount`** (the budget still needs them). Dispatch it from
`useGitWorkflow.ts` immediately after `setPatchLoadStatus(worldId, generation,
'ready')` on the streamed path.

In `useReviewLoadState.ts`, the paged parser from plan 003 must tolerate pages
going to `[]` *after* it has parsed them: when `pages.length === 0` and
`parsed.pageCount > 0` for the same key, return the cached items unchanged
(do not treat it as a reset). Add a test for that.

A Since view built later needs the parent's text — so `createSinceReview` must
get its input from the parent world's **parsed items**, not the retired text.
That is Step 4.

**Verify**: `bun test src/renderer/src/useReviewLoadState.test.ts` → pass including `'retired pages keep the parsed items'`.

#### Step 4: Build the Since patch without materialising non-matching sections

Rewrite `filterReviewPatch` in `reviewCheckpoints.ts` to a single pass over
offsets that only slices **matching** sections and appends them to one growing
array (matching sections only), then joins once:

```ts
export function filterReviewPatch(patch: string, paths: ReadonlySet<string>): string {
  if (patch === '' || paths.size === 0) return ''
  const starts = patchSectionStarts(patch)
  const kept: string[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = starts[index + 1] ?? patch.length
    const headerEnd = patch.indexOf('\n', start)
    const header = patch.slice(start, headerEnd === -1 ? end : headerEnd)   // header only, not the section
    const path = parseDiffGitHeaderPaths(header)?.path ?? null
    if (path != null && paths.has(path)) kept.push(patch.slice(start, end))
  }
  return kept.join('')
}
```

Then add an overload/sibling `filterReviewPatchPages(pages: readonly string[],
paths)` that applies the same logic per page and returns `string[]` (pages),
so `createSinceReview` can take the parent world's `patchPages` when they are
still present, and — when they were retired in Step 3 — a fallback that
re-requests the parent review through the cached path (`getPullRequestReview`
hits the disk cache and returns in one reply). Wire the fallback in
`useGitWorkflow.ts` where Since worlds are opened.

**Verify**: `bun test src/renderer/src/reviewCheckpoints.test.ts` → pass; add a test that a 3-section patch with one matching path returns exactly that section (byte-identical to today's output — capture today's output in the test *before* changing the function).

#### Step 5: Release the off-screen single-file comparison

- `useComparisonLoader.ts:82-85`: keep the early return, but when
  `workspaceView === 'multi'` **and** `selectedPath !== lastPathRef.current`
  (a different file was selected while in multi view), `setComparison(null)`.
  The "return trip flashes empty" case is the *same* path, which stays cached.
- `RepositoryWorkspace.tsx:858-862`: clear `retainedRef.current` in the same
  effect when `workspaceView` is `'multi'` and the retained path no longer
  equals `selectedPath`.

**Verify**: `bun test src/renderer/src/useGitWorkflow.dom.test.tsx` → pass; manual: open a file, switch to multi-file review, switch back to the same file → no empty flash; select a different file in multi view then switch to file view → loads normally.

#### Step 6: Measure and retune the budget

With plan 022's fixed `perf:snapshot`, open three large PR tabs and one Since
tab, switch between them, and record renderer RSS. Then set
`MAX_INACTIVE_PATCH_BYTES` so that the *renderer* private memory with three
inactive tabs stays under the value you measured for one active tab plus ~64 MB.
Record before/after numbers in your report and in a comment above the constant.

**Verify**: numbers recorded.

### Test plan

- `useReviewWorlds.test.ts`: estimator uses `patchLength + lines*24`; Since
  worlds evicted; `retire-patch-text` keeps `patchLength`.
- `useReviewLoadState.test.ts`: retired pages keep items.
- `reviewCheckpoints.test.ts`: byte-identical filtering; page variant.
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `npx -y react-doctor@latest --verbose` → `Score: 100 / 100`
- [ ] `grep -n "source !== 'patch'" src/renderer/src/useReviewWorlds.ts` → no output inside `boundInactivePatchPayloads`
- [ ] `grep -n "patch.length \* 2" src/renderer/src/useReviewWorlds.ts` → no output
- [ ] Measured renderer RSS with 3 inactive large PR tabs recorded in the plan's report and ≤ (1 active tab + 64 MB)
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- Plan 003 is not DONE (no `patchPages` on `PatchWorld`).
- `createSinceReview` has a caller that passes something other than a parent
  patch world's review (grep first; if so, report).
- Step 5 produces an empty-viewer flash on the same-file return trip — revert
  Step 5 and report; the memory win there is small.
- `useGitWorkflow.ts` has no existing "reload a released world on focus" path
  (grep `'released'`); building one is out of this plan's scope — stop.

### Maintenance notes

- Any new world kind that carries review bytes must set `patchLength` /
  `patchLineCount` and be included in the sweep.
- `PARSED_LINE_OVERHEAD_BYTES` is an estimate; if `@pierre/diffs` changes its
  item shape, re-measure with a heap snapshot.
- Deferred: `poolSize`/AST LRU tuning (measure only, per `diffWorkerConfig.ts`
  comments); localStorage growth (plan 021).

---

## Plan 005: Make sidebar resize, split-divider drag, gutter drag-select and pinch-zoom frame-stable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/SidebarResizer.tsx src/renderer/src/splitDiffResize.ts src/renderer/src/dragSelection.ts src/renderer/src/useCodeZoomGesture.ts src/renderer/src/codeZoom.ts src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/MultiFileReview.tsx src/renderer/src/DiffSurface.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 002 (so the zoom fix can be measured without memo noise)
- **Category**: perf (rendering)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Four pointer-driven interactions do a synchronous layout read followed by a
layout write on **every pointermove**, which forces the browser to lay out the
heaviest subtree in the app (the diff viewer) once per event — 60–120 times a
second during a drag. The product rule is that everyday actions are instant and
that motion is compositor-only; these are the four places the repo violates it.
Pinch-zoom is the worst: it goes through React state and rebuilds the
`CodeView` options object per wheel tick.

### Current state

#### A. Sidebar resizer — read then write on the same element (SidebarResizer.tsx:58-67)

```ts
const resizeFromPointer = useCallback((resizer: HTMLDivElement, pointerX: number) => {
  const workspace = getWorkspace(resizer)
  const drag = dragRef.current
  if (workspace == null || drag == null) return
  const bounds = workspace.getBoundingClientRect()          // layout READ …
  const raw = drag.width + (pointerX - drag.pointerX)
  const maximum = clampSidebarWidth(MAX_SIDEBAR_WIDTH, bounds.width)
  liveWidthRef.current = clampSidebarWidth(raw, bounds.width)
  applyWidth(workspace, Math.round(withResistance(raw, MIN_SIDEBAR_WIDTH, maximum, bounds.width)))  // … then WRITE --sidebar-width on the same element
}, [])
```

`dragRef` (line 53) already stores `{ pointerX, width }` at pointer-down. The
keyboard path (line 125) reads bounds too, but at keyboard frequency — leave it.

#### B. Split divider — read, write CSS vars, dispatch, re-query (splitDiffResize.ts)

```ts
// splitDiffResize.ts:106-115
function applySplitPercentage(surface: HTMLElement, value: number, resistanceWidth?: number): number {
  ...
  surface.style.setProperty('--horus-split-before', `${displayed}fr`)
  surface.style.setProperty('--horus-split-after', `${100 - displayed}fr`)
  surface.style.setProperty('--horus-split-before-width', `${displayed}cqi`)
  surface.dispatchEvent(new CustomEvent<number>('horus:split-resize', { detail: percentage }))
  return percentage
}
// splitDiffResize.ts:170-179
const updateFromPointer = (event: PointerEvent): void => {
  const bounds = node.getBoundingClientRect()                // READ per move
  ...
  applySplitPercentage(surface, dragOrigin.percentage + delta, bounds.width)   // WRITE per move
}
// splitDiffResize.ts:246-250 — the event listener re-queries the shadow root
const onSplitResize = (event: Event): void => {
  const nextPercentage = (event as CustomEvent<number>).detail
  const handle = createHandle(root, nextPercentage)
  handle?.setAttribute('aria-valuenow', String(Math.round(nextPercentage)))
}
```

`--horus-split-before` drives `grid-template-columns` of the diff, so each write
relayouts the whole visible diff; the next move's `getBoundingClientRect` then
forces that layout synchronously.

#### C. Gutter drag guide — full DOM scan + N rect reads per move (dragSelection.ts)

```ts
// dragSelection.ts:69-86
function findClosestGutterLine(side: HTMLElement, pointerY: number): DragLine | null {
  const lines = [...side.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')]
  ...
  for (const element of lines) {
    ...
    const bounds = element.getBoundingClientRect()          // N reads per move
    ...
// dragSelection.ts:88-107
function renderDragGuide(side: HTMLElement, startIndex: number, endIndex: number): void {
  ...
  for (const element of side.querySelectorAll<HTMLElement>('[data-line-index]')) {   // second full query
    ...
    element.setAttribute('data-drag-range', boundary)       // N attribute writes → invalidates layout for the next move
// dragSelection.ts:166-176
const onPointerMove = (event: Event): void => {
  ...
  const current = findClosestGutterLine(drag.side, pointerEvent.clientY)
  ...
  renderDragGuide(drag.side, drag.start.index, current.index)
}
```

The drag is the entry point to leaving a review comment.

#### D. Pinch-zoom through React state (useCodeZoomGesture.ts → MultiFileReview.tsx)

```ts
// useCodeZoomGesture.ts:138-139 — per wheel event
currentFontSizeRef.current = nextFontSize
setZoom({ baseFontSize: baseFontSizeRef.current, fontSize: nextFontSize })
// codeZoom.ts:20 — rounds to 2 decimals, so nearly every tick is a new value
return Math.round(Math.min(MAX_CODE_ZOOM_FONT_SIZE, Math.max(MIN_CODE_ZOOM_FONT_SIZE, nextFontSize)) * 100) / 100
```

```ts
// RepositoryWorkspace.tsx:1059
const viewerPreferences = useViewerPreferences(preferences, codeZoom)
// MultiFileReview.tsx:521-527 — new style object per preferences change
const codeStyle = useMemo(() => ({
  '--diffs-font-family': ..., '--diffs-font-size': `${preferences.codeFontSize}px`,
  '--diffs-line-height': `${preferences.codeLineHeight}px`, ...
}) as CSSProperties, [preferences])
// MultiFileReview.tsx:528-559 — new CodeView options object per preferences change
const codeViewOptions = useMemo<CodeViewReactOptions<ReviewAnnotationMetadata>>(() => ({
  ...
  itemMetrics: { lineHeight: preferences.codeLineHeight }, unsafeCSS: CODE_VIEW_CSS,
  ...
}), [diffStyle, onBeginComment, onSelectLines, preferences, repositoryReview])
```

Every wheel tick → `RepositoryWorkspace` → `RepositoryDiffPanel` →
`MultiFileReview` → `MultiFileViewer` re-render, and `CodeView` receives a new
`options` object (rebuilding `loadDiffFiles` and re-measuring at the new
`itemMetrics.lineHeight`). `DiffSurface.tsx:265-271` and `:413-438` do the same
for single-file view. Note: `itemMetrics.lineHeight` feeds the viewer's
virtualisation math, so the *committed* value must still reach `CodeView` — just
not per tick.

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | exit 0 |
| Focused | `bun test src/renderer/src/splitDiffResize.test.ts src/renderer/src/codeZoom.test.ts src/renderer/src/sidebarWidth.test.ts` | pass |
| React gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |
| Build + install | `bun run update:mac` | `Installed Horus 0.1.0 in …` |

### Suggested executor toolkit

- Chrome DevTools Performance panel in the dev build (`bun run dev`, then
  View → Toggle Developer Tools): record a 2-second drag before and after.
  Look for "Forced reflow" warnings (purple) — the target is zero per move.
- Rendering → "Layout Shift Regions" / "Paint flashing" to confirm the diff
  body is not repainting during the sidebar drag.

### Scope

**In scope**: `SidebarResizer.tsx`, `splitDiffResize.ts` (+ test),
`dragSelection.ts`, `useCodeZoomGesture.ts`, `codeZoom.ts` (+ test),
`RepositoryWorkspace.tsx` (only `useViewerPreferences` / zoom wiring),
`MultiFileReview.tsx` and `DiffSurface.tsx` (only `codeStyle` /
`codeViewOptions` deps).

**Out of scope**: `collapsedSeparator.ts` (reads `--horus-split-before-width`
via CSS — no JS change needed); `@pierre/diffs`; keyboard resize paths; any
change to the resistance/clamp math in `sidebarWidth.ts` or
`clampSplitPercentage`.

### Git workflow

- Branch: `perf/005-compositor-only-drags`
- One commit per step, `perf:` prefix. No push.

### Steps

#### Step 1: Sidebar — cache bounds at pointer-down

In `SidebarResizer.tsx`, extend `dragRef` to `{ pointerX, width, workspaceWidth }`
and capture `workspace.getBoundingClientRect().width` once where the drag starts
(the `pointerdown` handler that sets `dragRef.current`). In `resizeFromPointer`
use `drag.workspaceWidth` instead of calling `getBoundingClientRect`. Leave the
keyboard handler (line ~125) untouched.

**Verify**: `grep -n "getBoundingClientRect" src/renderer/src/SidebarResizer.tsx` → exactly one match, inside the `onKeyDown` handler (or a pointer-down capture), none inside `resizeFromPointer`.

#### Step 2: Split divider — one write per frame, no re-query

In `splitDiffResize.ts`:

1. Capture `node.getBoundingClientRect()` once in `onPointerDown` into
   `dragOrigin` (extend it to `{ clientX, percentage, left, width }`); use those in
   `updateFromPointer`.
2. Coalesce writes: keep a module-level `pendingFrame: number | null` and a
   `pendingValue`; `updateFromPointer` stores the value and schedules one
   `requestAnimationFrame` that calls `applySplitPercentage` once. Cancel the
   pending frame in `finishPointer`, after applying the final value synchronously.
3. In `onSplitResize`, cache the handle element on the binding object at
   creation instead of calling `createHandle(root, …)` (which does
   `root.querySelector`) on every event.

Update `splitDiffResize.test.ts` if it drives pointer events synchronously —
flush the rAF with the happy-dom `requestAnimationFrame` (see
`src/renderer/test/setup.ts`) or expose a `flushSplitResize()` test hook.

**Verify**: `bun test src/renderer/src/splitDiffResize.test.ts` → pass; `grep -c "getBoundingClientRect" src/renderer/src/splitDiffResize.ts` → 1.

#### Step 3: Gutter drag — measure once, write only the boundary changes

In `dragSelection.ts`:

1. At `pointerdown` (where `drag` is created, ~line 155-165), build a geometry
   cache for `drag.side`: one `querySelectorAll('[data-gutter] [data-column-number]')`,
   then an array of `{ index, lineNumber, top, bottom, element }` from a single
   pass of `getBoundingClientRect()`. Store it on `drag`.
2. `findClosestGutterLine(drag, pointerY)` becomes a binary search over the
   cached `top`s (they are sorted by DOM order) — zero DOM reads per move.
3. `renderDragGuide` keeps the previous `[first, last]` on `drag` and only
   touches elements whose membership or boundary role changed (at most two
   lines gain/lose `data-drag-range` per move, plus the `first`/`last` role
   swap). Use the cached `element` references; do not re-query.
4. Invalidate the cache when `syncDragGuideLifecycle` sees the `update` phase
   from `onPostRender` (the viewer re-rendered lines) and on `scroll` of the
   scroll container (line positions moved): set a `stale` flag that rebuilds
   the cache on the next move.

**Verify**: manual — drag-select 40 lines in a wrapped split diff with DevTools Performance recording; the flame chart must show no `Recalculate Style`/`Layout` per `pointermove`. `bun test` → pass.

#### Step 4: Pinch-zoom — live CSS variable, committed state on settle

1. In `useCodeZoomGesture.ts`, on each wheel tick write the live value straight
   to the surface: `surface.style.setProperty('--diffs-font-size',
   \`${nextFontSize}px\`)` and the derived line height (use the same ratio
   `useViewerPreferences` uses — read that function in
   `RepositoryWorkspace.tsx` first). Keep `currentFontSizeRef` as today.
2. Replace the per-tick `setZoom(...)` with a settle timer: clear/restart a
   `window.setTimeout(commit, 120)` on every tick; `commit` calls `setZoom` once
   with the final value and removes the inline overrides (so the committed
   `codeStyle` takes over with no visual jump — the values are identical).
3. Leave `codeStyle`/`codeViewOptions` memo deps as they are: after this change
   they rebuild once per gesture, not once per tick.
4. Apply the identical pattern to `DiffSurface.tsx` if it hosts its own
   `useCodeZoomGesture` instance (grep).

**Verify**: `bun test src/renderer/src/codeZoom.test.ts` → pass; manual — pinch on a large PR: text scales smoothly; the Performance HUD `workspaceRenders` increases by ≤ 2 per gesture (not per tick).

#### Step 5: Feel check

`bun run update:mac`. For each of the four interactions confirm: no visible
hitching on a 3000-line file, and the final committed state matches the last
pointer position (no snap-back).

### Test plan

- `splitDiffResize.test.ts`: one write per frame (two moves before a flush →
  one `--horus-split-before` set); final value applied on pointer-up.
- `codeZoom.test.ts`: unchanged math; add a test for the settle-commit helper if
  you extract it (`commitAfterSettle(fn, ms)`).
- Gutter drag: `dragSelection.ts` has no test file today; add
  `dragSelection.test.ts` covering the binary search over a fake geometry cache
  (pure function — no DOM needed).
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `npx -y react-doctor@latest --verbose` → `Score: 100 / 100`
- [ ] `grep -c getBoundingClientRect src/renderer/src/splitDiffResize.ts` → `1`
- [ ] `grep -n getBoundingClientRect src/renderer/src/SidebarResizer.tsx` → not inside `resizeFromPointer`
- [ ] `grep -n "setZoom(" src/renderer/src/useCodeZoomGesture.ts` → only inside the settle-commit callback
- [ ] DevTools recording of a 2 s sidebar drag shows zero "Forced reflow" warnings
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- `useViewerPreferences` derives something from zoom other than font size and
  line height (e.g. gutter width) that cannot be expressed as a CSS variable —
  report before continuing Step 4.
- `CodeView` visibly mis-virtualises (blank rows, wrong scroll extent) while the
  live CSS variable differs from `itemMetrics.lineHeight` during a gesture. If
  the 120 ms settle is not enough to hide it, stop and report; do not push line
  height per tick into React state.
- The `onPostRender` `update` phase does not fire for line re-renders inside a
  drag (Step 3 invalidation) — the geometry cache would go stale; report.

### Maintenance notes

- Rule for reviewers: a `pointermove` handler may **read** layout only from a
  cache captured at `pointerdown`, and may **write** at most once per frame.
- Any new CSS variable driven from JS during a gesture should be committed to
  React state once on settle, never per event.
- Deferred: keyboard resize paths (low frequency); `collapsedSeparator.ts`
  reads only CSS variables and needs no change.

---

## Plan 006: Debounce localStorage persistence and gate thread re-anchoring to load completion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/useReviewSession.ts src/renderer/src/App.tsx src/renderer/src/SettingsPage.tsx src/renderer/src/TerminalDock.tsx src/renderer/src/useFileEditing.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Three effects write to `localStorage` synchronously on every state change:
review threads (up to 512 KB of JSON), viewed files (up to 256 KB), and the
full preferences blob (plus an IPC round-trip and an xterm refit). Marking a
file "viewed" — an action a reviewer repeats hundreds of times — therefore
stringifies and writes ~150 KB on a 2000-file review, mid-scroll-follow.
Separately, the thread re-anchor effect runs once per streamed page (its
dependency is the items array, which changes per page), so loading a large PR
with saved comments runs the anchor search N times instead of once, each
followed by a full write. The repo already has the right pattern —
`useFileEditing.ts` debounces draft writes — this plan applies it to the other
three writers.

### Current state

```ts
// src/renderer/src/useReviewSession.ts:47-63 — current
useEffect(() => {
  saveStoredReviewThreads(threadStorageKey, threadsByPath)
}, [threadStorageKey, threadsByPath])

useEffect(() => {
  if (!reanchorSource.enabled) return
  setThreadsByPath((current) => reanchorReviewThreads(
    reanchorSource.items,
    current,
    !reanchorSource.loading
  ))
}, [reanchorSource.enabled, reanchorSource.items, reanchorSource.loading])

useEffect(() => {
  saveStoredViewedFiles(viewedStorageKey, viewedFiles)
}, [viewedFiles, viewedStorageKey])
```

`saveStoredViewedFiles` (`viewedFileStorage.ts:38-50`) and
`saveStoredReviewThreads` (`reviewThreadStorage.ts:84-96`) each do
`JSON.stringify` + `localStorage.setItem` synchronously.

```ts
// src/renderer/src/App.tsx:646-657 — current: runs on EVERY preferences change
useEffect(() => {
  const root = document.documentElement
  root.style.setProperty('--font-ui', INTERFACE_FONTS[preferences.interfaceFont].fontFamily)
  root.style.setProperty('--font-mono', CODE_FONTS[preferences.codeFont].fontFamily)
  savePreferences(preferences)
  void window.repository?.setStartupPreferences({
    themeType: getEditorThemeType(preferences.editorTheme),
    restoreLastFolder: preferences.restoreLastFolder
  })
}, [preferences])
```

```ts
// src/renderer/src/SettingsPage.tsx:64-68 — every slider step calls onChange synchronously
const update = <Key extends keyof AppPreferences>(key: Key, value: AppPreferences[Key]): void => {
  const nextPreferences = { ...preferences, [key]: value }
  if (key !== 'editorTheme') {
    onChange(nextPreferences)
    return
  }
```

Three `RangeControl` sliders (code font size, code line height, terminal
scrollback — `SettingsPage.tsx:180-198`) fire `update()` per step; scrollback
spans 1 000–50 000 in steps of 1 000. `TerminalDock.tsx:474-483` reacts to each
preferences change by writing xterm options and calling `fit()`, which sends
`SIGWINCH` to the shell.

The exemplar to copy:

```ts
// src/renderer/src/useFileEditing.ts:213-223 — existing debounce pattern
draftsRef.current = next
setDrafts(next)
if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
persistTimerRef.current = window.setTimeout(() => {
  persistTimerRef.current = null
  writeDrafts(root, next, browserDraftStorage())
}, DRAFT_PERSIST_DEBOUNCE_MS)
```

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | exit 0 |
| Focused | `bun test src/renderer/src/reviewThreadStorage.test.ts src/renderer/src/viewedFileStorage.test.ts src/renderer/src/preferences.test.ts` | pass |
| React gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |

### Scope

**In scope**: `useReviewSession.ts`, `App.tsx` (only the preferences effect),
`TerminalDock.tsx` (only the preferences → xterm effect at ~474-483), a new
`src/renderer/src/useDebouncedPersist.ts` (+ test).

**Out of scope**: `SettingsPage.tsx` controls (live preview must stay
immediate — do not debounce `onChange` itself); `useFileEditing.ts` (already
correct); storage caps and pruning (plan 021); the storage modules' internals.

### Git workflow

- Branch: `perf/006-debounce-persistence`; `perf:` commits; no push.

### Steps

#### Step 1: Extract a reusable debounced-persist hook

Create `src/renderer/src/useDebouncedPersist.ts`:

```ts
import { useEffect, useRef } from 'react'

// Persist `value` at most once per `delayMs`, and always flush the latest value
// on unmount and on pagehide so the last change before a close is not lost.
export function useDebouncedPersist<T>(value: T, persist: (value: T) => void, delayMs: number): void {
  const latest = useRef(value)
  const persistRef = useRef(persist)
  const timer = useRef<number | null>(null)
  latest.current = value
  persistRef.current = persist
  useEffect(() => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { timer.current = null; persistRef.current(latest.current) }, delayMs)
    return () => { /* the next value's effect re-arms; unmount handled below */ }
  }, [value, delayMs])
  useEffect(() => {
    const flush = (): void => {
      if (timer.current == null) return
      window.clearTimeout(timer.current); timer.current = null
      persistRef.current(latest.current)
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [])
}
```

Add `useDebouncedPersist.test.ts` (model after `comparisonCache.test.ts`
style; use `bun:test` fake timers or a real 20 ms delay).

**Verify**: `bun test src/renderer/src/useDebouncedPersist.test.ts` → pass.

#### Step 2: Debounce threads and viewed-file writes

In `useReviewSession.ts`, replace the two save effects with
`useDebouncedPersist(threadsByPath, (t) => saveStoredReviewThreads(threadStorageKey, t), 400)`
and the same for viewed files. Because the key can change (tab switch), include
it in the persisted closure by passing `{ key, value }` as the value, or reset
via the `flush()` on unmount (the workspace remounts per world today, so unmount
flush covers it — confirm with `App.tsx:364` keying).

**Verify**: `bun test` → pass; manual: toggle "viewed" on 5 files rapidly, reload the app → all 5 still viewed.

#### Step 3: Gate re-anchoring on load completion

Change the re-anchor effect so it runs when `reanchorSource.loading` flips from
`true` to `false` (final pass, `committed = true`) and, at most, once more when
`items` change while **not** loading (a working-tree edit). Implement with a
`wasLoadingRef`: skip the effect body while `reanchorSource.loading === true`
except for a single provisional pass on the first items (so comments show
during a stream). Keep the `reanchorReviewThreads(items, current, committed)`
call signature.

**Verify**: `bun test src/renderer/src/reviewThreadAnchors.test.ts src/renderer/src/useReviewThreads*.test.*` → pass; manual: open a PR with saved comments → they appear during the stream and are correctly anchored after it.

#### Step 4: Debounce the preferences persistence and IPC, keep the CSS immediate

In `App.tsx:646-657`, keep the two `setProperty` calls in a plain effect (fonts
must update live), and move `savePreferences` + `setStartupPreferences` into
`useDebouncedPersist(preferences, persistPreferences, 150)`.

In `TerminalDock.tsx:474-483`, debounce the xterm option writes + `fit()` the
same way (150 ms) so a slider drag ends in one `SIGWINCH`.

**Verify**: manual — drag the terminal-scrollback slider end to end with a `tail -f` running in the dock: the shell receives one resize at the end, not dozens; quit and relaunch → the last slider value persisted.

### Test plan

- `useDebouncedPersist.test.ts`: coalesces N rapid values into one call with
  the last value; flushes on unmount; flushes on `pagehide`.
- Existing storage tests unchanged.
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `npx -y react-doctor@latest --verbose` → `Score: 100 / 100`
- [ ] `grep -n "saveStoredViewedFiles\|saveStoredReviewThreads" src/renderer/src/useReviewSession.ts` → only inside `useDebouncedPersist` callbacks
- [ ] `grep -n "savePreferences(preferences)" src/renderer/src/App.tsx` → no output (moved into the debounced callback)
- [ ] Rapid toggling of 5 viewed files survives an app reload
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- `pagehide` does not fire in the Electron renderer on window close (test it in
  dev with a `console.log`); if not, flush on `beforeunload` instead and note it.
- The first-render provisional re-anchor pass (Step 3) leaves comments
  unanchored until stream end for a *cached* PR (single reply, no stream) —
  the effect must still run once when `loading` starts `false`.

### Maintenance notes

- New synchronous `localStorage.setItem` calls in effects are a review smell;
  route them through `useDebouncedPersist`.
- Plan 021 adds a storage budget/pruning layer; it composes with this hook.

---

## Plan 007: Agent dock, terminal dock and Performance HUD render hygiene

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/AgentPanel.tsx src/renderer/src/useAgentSession.ts src/renderer/src/TerminalDock.tsx src/renderer/src/PerformanceHud.tsx src/renderer/src/performanceHistory.ts src/renderer/src/RemoteReviewThreads.tsx src/renderer/src/PullRequestContext.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 002 (stabilises `session.ask`)
- **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

The agent streaming path is already well engineered (main coalesces text at
16 ms, the renderer batches per animation frame, markdown parses incrementally,
settled blocks keep identity). What remains are leaks around its edges: a forced
synchronous layout of the whole transcript on every streamed frame, per-frame
array copies, a terminal effect that re-runs fit-and-focus on every status
change and steals focus when the shell exits, duplicate CLI status probes per
sign-in, and a Performance HUD that polls `app.getAppMetrics()` every 3 s for
the whole session with three state writes per sample. Each is small; together
they are the difference between "streams smoothly" and "streams smoothly while
the diff still scrolls".

### Current state

#### A. Per-frame forced layout (AgentPanel.tsx:103-108)

```ts
useEffect(() => {
  const transcript = transcriptRef.current
  if (transcript == null || !streaming) return
  const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight   // READ ×3
  if (distanceFromBottom < 120) transcript.scrollTop = transcript.scrollHeight                          // WRITE
}, [activity, blocks, streaming, usage])
```

`blocks` changes every animation frame while streaming; the transcript holds up
to 20 archived turns (`useAgentAnswer.ts:245` keeps `.slice(-20)`), each a full
markdown tree, so the read forces layout of all of it, per frame.

#### B. Per-render allocations (AgentPanel.tsx:87-92)

`[...activity].reverse().find(...)` (up to 80 items, `MAX_ACTIVITY_ITEMS` in
`useAgentAnswer.ts:84`) and `models.find(...)` run in the render body on every
streamed frame.

#### C. Copied timer without cleanup (AgentPanel.tsx:441-446)

`window.setTimeout(() => setCopied(false), 1_600)` created in a click handler;
the component unmounts on reset / re-key inside that window.

#### D. Duplicate status probes (useAgentSession.ts:196-217)

`probeStatuses` is a `useCallback` with `[authenticatingProvider]` in its deps;
`refreshStatuses` therefore changes identity on every sign-in transition, and
the effect `[open, refreshStatuses]` re-runs `probeStatuses(null)` — probing
**both** providers (two CLI spawns) at the start and end of every sign-in,
against the intent documented at lines 221-222.

#### E. Terminal open effect re-runs per status (TerminalDock.tsx:485-503)

Deps `[open, startTerminal, status]`; body schedules two nested rAFs ending in
`fitRef.current?.()` and `terminalRef.current?.focus()`. `status` moves
`'starting' → 'running'` on open and `→ 'exited'` on process exit
(`updateStatus` at 384/402/444), so fit-and-focus runs 2–3× per open and pulls
focus back to the terminal when the shell exits. The `status` dep is
load-bearing for the "don't respawn on failed" guard documented at 487-489.

#### F. Performance HUD polling (PerformanceHud.tsx:21-22, 66-86)

```ts
const SAMPLE_INTERVAL_OPEN_MS = 2_000
const SAMPLE_INTERVAL_COLLAPSED_MS = 3_000
...
setMetrics(nextMetrics)
setSamplingStatus('live')
setHistory([...recordMemorySample({...})])      // fresh 500-element array copy per sample
...
if (!disposed) setReviewMetrics(getReviewMetrics())   // every sample, even when unchanged
```

`src/main/index.ts:529` — `app.getAppMetrics()` is a synchronous main-process
call walking every child process, ~20×/min for the whole session.
`performanceHistory.ts:158-176` memoises chart paths on the array identity,
which never matches.

#### G. `Date.now()` in render (RemoteReviewThreads.tsx:42, PullRequestContext.tsx:53)

"3 minutes ago" labels only refresh on unrelated re-renders. The ticker pattern
already exists at `GitHubPanel.tsx:219-223`.

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | exit 0 |
| Focused | `bun test src/renderer/src/useAgentSession.dom.test.tsx src/renderer/src/useAgentAnswer.test.ts src/renderer/src/PerformanceHud.dom.test.tsx src/renderer/src/performanceHistory.test.ts` | pass |
| React gate | `npx -y react-doctor@latest --verbose` | `Score: 100 / 100` |

### Scope

**In scope**: `AgentPanel.tsx`, `useAgentSession.ts` (+ dom test),
`TerminalDock.tsx` (only the effect at 485-503), `PerformanceHud.tsx`,
`performanceHistory.ts` (+ test), `RemoteReviewThreads.tsx`,
`PullRequestContext.tsx`.

**Out of scope**: `useAgentAnswer.ts` reducer/batching (already correct);
`src/main/agentService.ts` coalescer; `markdown.ts`; xterm lifecycle
(`TerminalDock.tsx:275-332`, already correct); terminal backpressure (see
plan README "considered" — separate future plan).

### Git workflow

- Branch: `perf/007-agent-dock-hygiene`; `perf:`/`fix:` commits; no push.

### Steps

#### Step 1: Track "pinned to bottom" from a passive scroll listener

In `AgentPanel.tsx`, add `const pinnedRef = useRef(true)` and one effect that
attaches a `{ passive: true }` `scroll` listener to `transcriptRef.current`
updating `pinnedRef.current = scrollHeight - scrollTop - clientHeight < 120`
(reads happen in the scroll event, off the commit path). Change the streaming
effect to: `if (streaming && pinnedRef.current) transcript.scrollTop =
transcript.scrollHeight` — a write only.

**Verify**: manual — stream an answer, scroll up mid-stream: view stays where you scrolled; scroll back to the bottom: it re-pins.

#### Step 2: Memoise the per-render scans and clean the timer

Replace the reverse-copy with a backwards `for` loop inside
`useMemo(() => ..., [activity])`; wrap `selectedModel` in `useMemo` on
`[models, model]`. Store the copied-timer id in a ref and clear it in a
`useEffect` cleanup.

**Verify**: `grep -n "\[\.\.\.activity\]" src/renderer/src/AgentPanel.tsx` → no output.

#### Step 3: Stable `probeStatuses`

Read `authenticatingProvider` through a ref inside `probeStatuses` so its
dependency array is `[]`; `refreshStatuses` then stays stable and the effect at
212-217 no longer re-fires on sign-in transitions.

**Verify**: add to `useAgentSession.dom.test.tsx`: starting a login triggers exactly one probe of the provider being signed into (mock `window.repository` status calls and count them).

#### Step 4: Split the terminal effect

Two effects: `[open, startTerminal, status]` decides whether to spawn (keeps the
failed-guard); `[open]` alone runs the fit-and-focus rAF chain once per open.

**Verify**: manual — open the dock, run `exit`: focus does not jump back to the terminal; reopen: fit + focus happen once.

#### Step 5: Calm the Performance HUD

- `SAMPLE_INTERVAL_COLLAPSED_MS` → `15_000`; keep 2 s while the popover is open.
- `recordMemorySample` returns the same array reference when it appended nothing
  new; otherwise `setHistory` uses a version counter (`setHistoryVersion(v =>
  v + 1)`) and the chart memo keys on the version — no 500-element copies.
- Skip `setReviewMetrics` when all four fields equal the previous value.

**Verify**: `bun test src/renderer/src/performanceHistory.test.ts src/renderer/src/PerformanceHud.dom.test.tsx` → pass; manual: with the popover closed, `workspaceRenders` does not tick every 3 s.

#### Step 6: One clock for comment ages

Lift a `now` value from a 30 s interval (copy the `GitHubPanel.tsx:219-223`
pattern) into `RemoteReviewThreads` and `PullRequestContext` props; remove the
render-phase `Date.now()` calls.

**Verify**: `grep -n "Date.now()" src/renderer/src/RemoteReviewThreads.tsx src/renderer/src/PullRequestContext.tsx` → no output.

### Test plan

- `useAgentSession.dom.test.tsx`: single probe per sign-in.
- `performanceHistory.test.ts`: identity stable when nothing appended.
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `npx -y react-doctor@latest --verbose` → `Score: 100 / 100`
- [ ] `grep -n "scrollHeight - transcript.scrollTop" src/renderer/src/AgentPanel.tsx` → only inside the scroll listener
- [ ] `grep -n "SAMPLE_INTERVAL_COLLAPSED_MS = 15_000" src/renderer/src/PerformanceHud.tsx` → one match
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- The terminal's "don't respawn on failed" guard cannot be kept with the
  two-effect split — report the exact status transitions that break it.
- Making `recordMemorySample` identity-stable requires changing its persisted
  format (it also writes localStorage) — report first.

### Maintenance notes

- Effects keyed on `blocks` during streaming must be write-only against the DOM.
- New HUD metrics should be added to the equality check in Step 5.

---

## Plan 008: Release repository resources when a tab closes, and make fire-and-forget IPC handlers total

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/main/repositorySessions.ts src/main/repository.ts src/main/index.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf (memory) + bug
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

> **Update 2026-08-30 00:50** — Grok already made `cancelContentSearch` total (`repositorySessions.ts:49` `cancelActiveContentSearch`, `index.ts:416`). Step 4 now covers only `cancelPullRequestReview` (`index.ts:420-423`) and the `uncaughtException` logger. `#stopSession` is at `repositorySessions.ts:106-111`, `release()` at 103, `stopAll()` at 116; `dispose()` is still never called.

### Why this matters

Closing a repository tab does not release the repository. `RepositoryService.dispose()`
— the only thing that kills the `git cat-file --batch` child — has no caller
outside `open()`. Each service also owns up to 64 MB of HEAD blobs and 64 MB of
working-file contents, per repository, with no aggregate cap across tabs. Open
and close a handful of large repos and the main process carries hundreds of MB
and several stray git processes it believes it released. Separately, two
`ipcMain.on` handlers call `requireActive()`/`require(root)`, which **throw**
when the root was released — and a throw from an `ipcMain.on` listener is an
uncaught main-process exception, not a rejected promise.

### Current state

```ts
// src/main/repositorySessions.ts:106-120 — dispose() is never called
stopAll(): void {
  for (const session of this.#sessions.values()) this.#stopSession(session)
  this.#sessions.clear()
  this.#activeRoot = null
}

#stopSession({ repository, watcher }: RepositorySession): void {
  watcher.stop()
  repository.cancelContentSearch()
  repository.cancelPullRequestReview()
  repository.setSelfWriteObserver(null)
}
```

```ts
// src/main/repository.ts:1068-1072 — what dispose() does today
dispose(): void {
  this.#cancelActiveSearch()
  this.#objectReader?.dispose()
  this.#objectReader = null
}
```

`open()` (lines 1076-1092) additionally clears `#githubViewerLogin`,
`#githubSlug`, `#pullRequestIdentities`, `#clearHeadFileCache()`,
`#trackedPathsCache`, `#pendingComparisons` — `dispose()` does none of that.

```ts
// src/main/repository.ts:94-97 — per-service caps, no aggregate
const MAX_HEAD_CACHE_ENTRIES = 512
const MAX_HEAD_CACHE_BYTES = 64 * 1024 * 1024
const MAX_WORKING_CACHE_ENTRIES = 256
const MAX_WORKING_CACHE_BYTES = 64 * 1024 * 1024
```

```ts
// src/main/index.ts:416 and 405-408 — ipcMain.on handlers that can throw
ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => repositorySessions.requireActive().cancelContentSearch())
...
ipcMain.on(IPC_CHANNELS.cancelPullRequestReview, (_event, root: unknown, requestId: unknown) => {
  if (typeof requestId !== 'string' || requestId === '') return
  repositorySessions.require(requireRepositoryRoot(root)).cancelPullRequestReview(requestId)
})
```

```ts
// src/main/repositorySessions.ts:44-52
requireActive(): RepositoryService {
  if (this.#activeRoot == null) throw new Error('Open a repository before using this action.')
  return this.require(this.#activeRoot)
}
require(root: string): RepositoryService {
  const session = this.#sessions.get(root)
  if (session == null) throw new Error('The repository tab is no longer open.')
  return session.repository
}
```

`release(root)` (lines 96-102) nulls `#activeRoot` when the released root was
active. The renderer fires `cancelContentSearch` on every query change
(`useRepositorySearch.ts:121,129`) and `cancelPullRequestReview` for sibling
requests whose root may already be released (`useGitWorkflow.ts:625-633`).
`grep -rn uncaughtException src package.json` → no handler.

Test exemplar: `src/main/repositorySessions.test.ts` (uses `mkdtemp` roots,
`registry.stopAll()` in `afterEach`).

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | exit 0 |
| Focused | `bun test src/main/repositorySessions.test.ts src/main/repository.test.ts` | pass |
| Process check | `pgrep -fl "git cat-file --batch"` after closing a tab and waiting 2 s | no output for the closed root |

### Scope

**In scope**: `repositorySessions.ts` (+ test), `repository.ts` (`dispose()`
and a new `trimCaches()`), `index.ts` (the two `ipcMain.on` bodies + an
`uncaughtException` logger).

**Out of scope**: watcher internals (plan 009); the PR disk cache; changing the
per-service cap constants; `terminalService`/`agentService` lifecycles.

### Git workflow

- Branch: `fix/008-release-repository-on-close`; `fix:` commits; no push.

### Steps

#### Step 1: Make `dispose()` complete

In `repository.ts`, extend `dispose()` to also do what `open()` does for a
replaced repository: `#clearHeadFileCache()`, `#workingFileCache.clear()` (and
reset its byte counter), `#pendingComparisons.clear()`,
`#pullRequestIdentities.clear()`, `#trackedPathsCache = null`, `#githubSlug =
undefined`, `#githubViewerLogin = null`. Read lines 1076-1092 and mirror every
reset there. Then have `open()` call `this.dispose()` first instead of repeating
the list.

**Verify**: `bun test src/main/repository.test.ts` → pass.

#### Step 2: Call it from the registry

In `repositorySessions.ts` `#stopSession`, add `repository.dispose()` as the last
line. Add a test: open two roots, `release(first)`, assert the released service
has no object reader (expose a `hasObjectReader()`/`disposed` getter or spy on
`dispose`).

**Verify**: `bun test src/main/repositorySessions.test.ts` → pass; manual: open a repo tab, browse a few files (spawns `cat-file`), close the tab, `pgrep -fl "git cat-file --batch"` → gone within 2 s.

#### Step 3: Trim inactive repositories' caches

Add `trimCaches(floorBytes: number)` to `RepositoryService` that evicts LRU
entries from both file caches down to `floorBytes` each. In
`RepositorySessionRegistry.activate(root)`, after switching `#activeRoot`, call
`trimCaches(8 * 1024 * 1024)` on every *other* session. (The per-service caps
stay; this bounds the aggregate to ~active + 16 MB × inactive.)

**Verify**: new registry test — activate B after populating A's cache → A's byte counter ≤ floor.

#### Step 4: Make the two `ipcMain.on` handlers total

Add `tryGet(root: string | null): RepositoryService | null` to the registry (no
throw), and rewrite:

```ts
ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => {
  repositorySessions.tryGet(repositorySessions.activeRoot)?.cancelContentSearch()
})
ipcMain.on(IPC_CHANNELS.cancelPullRequestReview, (_event, root: unknown, requestId: unknown) => {
  if (typeof requestId !== 'string' || requestId === '' || typeof root !== 'string') return
  repositorySessions.tryGet(root)?.cancelPullRequestReview(requestId)
})
```

Also add, once, near the top of `index.ts` after `app` is imported:

```ts
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main:', error)
})
```

(Log only — do not swallow into silence without a trace.)

**Verify**: manual — open a repo, type in the search box, close the tab via ⌘W while results are pending, keep typing → no crash dialog, no `Error: Open a repository before using this action.` in the main log.

### Test plan

- `repositorySessions.test.ts`: release disposes; activate trims others.
- `repository.test.ts`: `dispose()` clears caches (assert cache byte getters are 0).
- `bun test` → all pass.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `grep -n "repository.dispose()" src/main/repositorySessions.ts` → one match inside `#stopSession`
- [ ] `grep -n "ipcMain.on(" src/main/index.ts` → none of the listed handlers call `requireActive()` or `require(`
- [ ] `grep -n uncaughtException src/main/index.ts` → one match
- [ ] Closing a tab kills its `git cat-file --batch` child within 2 s
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- `dispose()` is called from a path where the service is reused afterwards
  (grep callers after Step 1); if so, `open()` must fully re-initialise —
  verify with the existing `open()` tests before proceeding.
- The file caches have no LRU ordering to trim by (check the cache Map insert
  order/`touch` logic before Step 3); if they are FIFO, trim FIFO and note it.

### Maintenance notes

- Every new `ipcMain.on` handler must be total (no throwing lookups). Prefer
  `ipcMain.handle` when the renderer can await a rejection.
- Any new per-repository cache must be cleared in `dispose()` and trimmed in
  `trimCaches()`.

---

## Plan 009: Remove the quadratic work from the filesystem watcher and folder refresh

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in the status table at the top of this file — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/main/repositoryWatcher.ts src/main/repository.ts src/main/sessionStore.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of
> 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Every file save in the editor, every `git checkout`, every formatter run goes
through the watcher. Four spots on that path are quadratic or blocking: the
pending-path set is re-scanned on every accepted event (O(n²) across a burst),
a union `Set` of all paths is rebuilt inside the changed-path loop, non-git
folders rebuild and re-ship the entire path list on every tick (the code's own
comment measures that at ~120 ms at 100k paths — the fix was applied to git
repos only), and five `existsSync` calls run per flush. All four are small,
mechanical fixes with existing unit tests around them.

### Current state

#### A. Re-scan of the pending set per event (repositoryWatcher.ts:229-235)

```ts
#schedule(generation: number, delay?: number): void {
  if (this.#suspended) return
  if (this.#timer != null) clearTimeout(this.#timer)
  const metadataOnly = [...this.#pendingPaths].every((path) => path.startsWith('.git/'))
  this.#timer = setTimeout(() => { ... }, delay ?? (metadataOnly && this.#pendingPaths.size > 0 ? METADATA_DEBOUNCE_MS : CHANGE_DEBOUNCE_MS))
}
```

Called from `accept` for every event (`repositoryWatcher.ts:161-165`). A 5k-event
burst → ~12.5M string comparisons before the debounce fires.

#### B. Union set inside the loop (repositoryWatcher.ts:102-116)

```ts
for (const path of filesystemPaths) {
  if (path === '*') {
    const paths = previous.kind === 'git'
      ? new Set([...previousStatuses.keys(), ...nextStatuses.keys()])
      : new Set([...previousPaths, ...nextPaths])
    for (const visiblePath of paths) changedPaths.add(visiblePath)
  } else if (!path.startsWith('.git/') && (previousPaths.has(path) || nextPaths.has(path))) {
    changedPaths.add(path)
  } else if (!path.startsWith('.git/')) {
    const directoryPrefix = `${path.replace(/\/$/, '')}/`
    for (const visiblePath of new Set([...previousPaths, ...nextPaths])) {   // rebuilt per unknown path
      if (visiblePath.startsWith(directoryPrefix)) changedPaths.add(visiblePath)
    }
  }
}
```

`collectChangedPaths` has direct tests (`repositoryWatcher.test.ts:28-51`).

#### C. Folder mode rebuilds and re-ships paths every tick (repository.ts:1125-1172)

```ts
// The identity-preserving cache exists — for git only:
#visiblePaths(trackedBuffer: Buffer, untrackedPaths: readonly string[]): string[] {
  const cached = this.#trackedPathsCache
  if (cached != null && cached.buffer.equals(trackedBuffer) && ...) return cached.paths
  ...
}
async #refreshFolder(root: string): Promise<RepositorySnapshot> {
  const pathsResult = await runCommand(RIPGREP_EXECUTABLE, ['--files', ...], root, [1])
  const paths = prepareVisiblePaths(pathsResult.stdout)        // new array every tick
  ...
}
```

`repositoryWatcher.ts:302-316` decides whether to ship `paths` by reference
equality (`this.#publishedPaths !== snapshot.paths`), so folder mode always
takes the "send the whole snapshot" branch; `contracts.ts:25-31` documents that
omitting `paths` is the point of that branch.

#### D. Sync fs on the flush path

```ts
// repositoryWatcher.ts:242-246
#operationInProgress(): boolean {
  const gitDirectory = ...
  return OPERATION_MARKERS.some((marker) => existsSync(resolve(gitDirectory, marker)))   // 5 blocking stats per flush
}
// sessionStore.ts:51-57
export function saveSessionState(directory: string, state: SessionState): void {
  try { writeFileSync(join(directory, FILE_NAME), JSON.stringify(state, null, 2), 'utf8') } ...
}
```

`saveSessionState` is called from IPC handlers after start-up
(`index.ts:564`, `:590`); the "needed before the first window" justification
covers the *load* side only.

### Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint / typecheck / tests | `bun run lint && bun run typecheck && bun test` | exit 0 |
| Focused | `bun test src/main/repositoryWatcher.test.ts src/main/repository.test.ts src/main/sessionStore.test.ts` | pass |

### Scope

**In scope**: `repositoryWatcher.ts` (+ test), `repository.ts` (only
`#refreshFolder` and a folder-mode paths cache), `sessionStore.ts` (+ test),
`index.ts` (only if `saveSessionState` becomes async — await/`void` its callers).

**Out of scope**: debounce constants, `normalizeChangedPath`, the watcher's
recursive `watch` scope (already filtered), `loadSessionState`/`loadWindowState`
(deliberately sync at boot).

### Git workflow

- Branch: `perf/009-watcher-hot-path`; `perf:` commits; no push.

### Steps

#### Step 1: Counter instead of re-scan

Add `#pendingContentCount = 0` to the watcher. In `accept`, if the path is new
to `#pendingPaths` and does not start with `.git/`, increment. Reset to 0
wherever `#pendingPaths` is cleared (flush, `stop`). `metadataOnly` becomes
`this.#pendingContentCount === 0`.

**Verify**: `bun test src/main/repositoryWatcher.test.ts` → pass (the `RepositoryWatcher` describe at line 164 covers metadata vs content debounce).

#### Step 2: Hoist the union

In `collectChangedPaths`, compute `const union = new Set([...previousPaths,
...nextPaths])` once before the loop (and the statuses union once, lazily on
first `'*'`). Better: collect all directory prefixes first, then do one pass
over `union` testing each path against the prefix list. Keep output identical.

**Verify**: `bun test src/main/repositoryWatcher.test.ts` → pass; add a test with two directory-prefix paths and assert the same result set as before the change (write the expectation from the *old* implementation first).

#### Step 3: Identity-preserving paths for folder mode

In `repository.ts`, add `#folderPathsCache: { buffer: Buffer; paths: string[] } | null`.
In `#refreshFolder`, if `cache.buffer.equals(pathsResult.stdout)` return
`cache.paths`; otherwise compute and store. This mirrors `#visiblePaths`.
`#setSnapshot` (line ~2343) then sees `paths === snapshot.paths` and keeps
`#pathSet`; the watcher's `pathsChanged` becomes false and ships the small
event.

**Verify**: `bun test src/main/repository.test.ts` → pass; add a test: two consecutive folder refreshes with identical ripgrep output return the same `paths` array reference.

#### Step 4: Async fs on the flush path

- `#operationInProgress` → `async`, using `Promise.all(OPERATION_MARKERS.map(m
  => access(...).then(() => true, () => false)))`; `#flush` already `await`s
  around it — add the `await`.
- `saveSessionState` → async with `writeFile`; serialise concurrent writes
  through a module-level promise chain so two rapid saves cannot interleave.
  Update the two callers in `index.ts` to `void saveSessionState(...)`.

**Verify**: `bun test src/main/sessionStore.test.ts src/main/repositoryWatcher.test.ts` → pass; `grep -n "existsSync\|writeFileSync" src/main/repositoryWatcher.ts src/main/sessionStore.ts` → only `loadSessionState`'s `readFileSync` remains.

### Test plan

- Watcher: metadata-only debounce still selected when only `.git/` paths are
  pending; content path flips it; directory-prefix expansion identical.
- Repository: folder-mode paths identity stable across identical scans.
- Session store: async save writes the same JSON; sequential saves apply in order.

### Done criteria

- [ ] `bun run lint && bun run typecheck && bun test` exit 0
- [ ] `grep -n "\[\.\.\.this.#pendingPaths\]" src/main/repositoryWatcher.ts` → no output
- [ ] `grep -c "new Set(\[\.\.\.previousPaths, \.\.\.nextPaths\])" src/main/repositoryWatcher.ts` → `0` (hoisted union has a different shape) or `1` outside any loop
- [ ] `grep -n "existsSync" src/main/repositoryWatcher.ts` → no output
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift in any excerpt.
- `#flush` is not already async or the `#operationInProgress` result is used
  synchronously somewhere else — report.
- The ripgrep stdout for a folder is not byte-stable across identical scans on
  this machine (e.g. ordering varies); Step 3 would then never hit — report and
  fall back to comparing a sorted digest.

### Maintenance notes

- Any new per-event work in `accept`/`#schedule` must be O(1).
- Any new snapshot field that is an array should be identity-preserved across
  refreshes when unchanged, so the watcher can omit it from the change event.

---

## Plan 010: Cancel superseded working-tree patch builds and stop re-spawning `git remote -v`

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/main/repository.ts src/main/index.ts src/main/gitCommands.ts src/renderer/src/useReviewLoadState.ts src/preload/index.ts src/shared/contracts.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW · **Depends on**: none · **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Working-tree review reloads its patch on every watcher event that touches a visible path. `getWorkingTreePatch` spawns `git diff --numstat` plus `git diff` per path chunk (concurrency 4) with no `AbortSignal` and no in-flight dedupe, so a format-on-save across several files produces overlapping builds that all run to completion; the renderer discards the stale answers, but the spawns and string assembly are pure waste on the same main process that has to answer the next request. Separately, three write actions and the PR-URL resolver each re-spawn `git remote -v` although a cached slug resolver exists 200 lines away — 20–60 ms per spawn added to the critical path of every review submit.

### Current state

```ts
// src/main/repository.ts:1174-1185 — the dedupe pattern that getComparison already has
getComparison(path: string): Promise<FileComparison> {
  const pending = this.#pendingComparisons.get(path)
  if (pending != null) return pending
  const comparison = this.#loadComparison(path).finally(() => { this.#pendingComparisons.delete(path) })
  this.#pendingComparisons.set(path, comparison)
  return comparison
}
```

```ts
// src/main/repository.ts:1299-1312, 1336-1359 — getWorkingTreePatch: no signal, no dedupe
async getWorkingTreePatch(pathsValue: unknown): Promise<WorkingTreePatch> {
  ...
  const patchChunks = await mapWithConcurrency(chunks, MAX_PATCH_COMMAND_CONCURRENCY, async (chunk) => (
    await this.#git(['diff', '--no-color', '--find-renames', '--unified=3', head, '--', ...chunk])
  ).stdout.toString('utf8'))
  ...
  const limited = limitPatchFileSize(patchParts.join('\n'), MAX_DIFF_FILE_BYTES)
  return { patch: limited.patch, omittedFiles: [...omittedFiles, ...limited.omittedFiles] }
}
```

`src/main/index.ts:410-412` passes nothing to cancel with. `useReviewLoadState.ts:349` invokes it from the repository-change effect; `:333` has a `cancelled` flag that drops stale answers. `#loadPullRequestReview` shows the signal-threading pattern (it takes `signal` and forwards it to `runCommand`, which already accepts one).

```ts
// src/main/repository.ts:1619-1631 — cached slug exists
async #getGitHubSlug(): Promise<string | null> {
  if (this.#githubSlug !== undefined) return this.#githubSlug
  const remotes = parseRemotes(await this.#git(['remote', '-v']))
  ...
}
// but 1584 (mergePullRequest), 1605 (markPullRequestReady), 2084 (submitPullRequestReview):
const remotes = parseRemotes(await this.#git(['remote', '-v']))
// and index.ts:311-323 findPullRequestRoot: one spawn per candidate root + existsSync per candidate
```

### Commands

`bun run lint && bun run typecheck && bun test`; focused `bun test src/main/repository.test.ts`.

### Scope

**In**: `repository.ts`, `repository.test.ts`, `index.ts` (handlers `getWorkingTreePatch`, `findPullRequestRoot`), `preload/index.ts` + `contracts.ts` only if you add a `requestId` parameter. **Out**: `patchBuilder.ts` internals (buffer rewrite is a separate, MED-risk item — see README "considered"), `useReviewLoadState` beyond passing an id.

### Steps

1. **In-flight dedupe keyed on the sorted path list.** Add `#pendingWorkingTreePatches = new Map<string, Promise<WorkingTreePatch>>()`; key = `paths.slice().sort().join('\0')`; same `finally`-delete shape as `getComparison`. Verify: test — two concurrent calls with the same paths spawn `git diff` once (spy on `#git` via the existing test seam in `repository.test.ts`).
2. **Abort the superseded build.** Add `#workingTreePatchAbort: AbortController | null`; on each new *different-key* request, `abort()` the previous controller and create a new one; thread `signal` into every `this.#git(...)`/`runCommand` call inside `getWorkingTreePatch` and `#createNewFilePatch`. A rejected-by-abort promise must reject with a recognisable error the renderer already ignores (it drops stale answers via `cancelled`; confirm it does not surface the rejection as a toast — if it does, catch `AbortError` in the IPC handler and return `null`, and make `useReviewLoadState` treat `null` as "superseded"). Verify: test — second call with different paths aborts the first (`signal.aborted === true`).
3. **Cache remotes per repository.** Add `#remotes: GitRemote[] | undefined`, filled once via `#getRemotes()`, cleared in `open()`/`dispose()`. Use it in `#getGitHubSlug`, `mergePullRequest`, `markPullRequestReady`, `submitPullRequestReview`. The security check (`pullRequestTargetsRemotes`) still runs against the cached list. Verify: `grep -n "'remote', '-v'" src/main/repository.ts` → exactly one match (inside `#getRemotes`).
4. **`findPullRequestRoot`**: replace `existsSync` with `await stat(root).catch(() => null)`, and use each registered session's `#getRemotes()` when the root is open (fall back to a spawn only for approved-but-unopened roots). Verify: `grep -n existsSync src/main/index.ts` → no match in `findPullRequestRoot`.

### Done criteria

- [ ] lint/typecheck/test exit 0
- [ ] `grep -c "'remote', '-v'" src/main/repository.ts` → `1`
- [ ] Two overlapping `getWorkingTreePatch` calls with identical paths spawn one `git diff` set (test)
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift. · `runCommand` does not accept a `signal` (check `gitCommands.ts` first). · The renderer surfaces an abort as an error toast and the `null`-return fallback in Step 2 would require changing `WorkingTreePatch`'s contract beyond an optional nullable — report.

### Maintenance notes

- New multi-spawn read paths should follow the `#pending*` + `AbortController` shape.
- The remotes cache assumes remotes cannot change while a tab is open (the same assumption `#getGitHubSlug` already makes and documents).

---

## Plan 011: Route every pull-request IPC call to its tab's repository, not the active one

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/main/index.ts src/preload/index.ts src/shared/contracts.ts src/renderer/src/usePullRequestConversation.ts src/renderer/src/useGitWorkflow.ts src/renderer/src/RemoteReviewThreads.tsx src/renderer/src/GitHubPanel.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: MED · **Depends on**: none · **Category**: bug
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

IDEAS.md's core rule: "Agent requests carry an explicit registered repository root … main does not infer their repository from whichever tab is active." The PR review load already honours that (`getPullRequestReview`/`cancelPullRequestReview` take `root`). The conversation, thread-reply, resolve, merge, mark-ready and submit channels do not — they call `requireActive()`. `resolvePullRequestRepository` deliberately opens a PR's checkout with `activate = false` (`index.ts:330, 329`), so a PR tab's root is by design **not** the active root. With two repository tabs open, the 30 s conversation poll for repo A's PR #42 runs `gh` in repo B and shows B's PR #42 threads — silently. `submitPullRequestReview` is partly protected by `pullRequestTargetsRemotes` (turns the mismatch into an error rather than a wrong write); the read paths have no guard.

### Current state

```ts
// src/main/index.ts:482-491 — requireActive()
ipcMain.handle(IPC_CHANNELS.getPullRequestConversation, (_event, selector: number | string) =>
  repositorySessions.requireActive().getPullRequestConversation(selector))
ipcMain.handle(IPC_CHANNELS.replyToPullRequestThread, (_event, threadId: unknown, body: unknown) =>
  repositorySessions.requireActive().replyToPullRequestThread(threadId, body))
ipcMain.handle(IPC_CHANNELS.setPullRequestThreadResolved, (_event, threadId: unknown, resolved: unknown) =>
  repositorySessions.requireActive().setPullRequestThreadResolved(threadId, resolved))
ipcMain.handle(IPC_CHANNELS.mergePullRequest, (_event, selector: number | string, strategy: unknown) =>
  repositorySessions.requireActive().mergePullRequest(selector, strategy))
ipcMain.handle(IPC_CHANNELS.markPullRequestReady, (_event, selector: number | string) =>
  repositorySessions.requireActive().markPullRequestReady(selector))
// index.ts:526-528
ipcMain.handle(IPC_CHANNELS.submitPullRequestReview, (_event, selector, commitId, reviewEvent, body, comments) =>
  repositorySessions.requireActive().submitPullRequestReview(selector, commitId, reviewEvent, body, comments))
```

```ts
// src/main/index.ts:506-508 — the already-correct shape to copy
ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (event, root: unknown, selector: number | string, requestId: unknown) => {
  const repositoryRoot = requireRepositoryRoot(root)
  ...
  return repositorySessions.require(repositoryRoot).getPullRequestReview(selector, ..., requestId)
```

`usePullRequestConversation.ts:85, 114` polls every 30 s with `review.selector`, which for a number-opened PR is a bare number string (`repository.ts:641-656`). `PatchWorld.root` (`useReviewWorlds.ts:40`) already carries the correct root on the renderer side.

### Commands

`bun run lint && bun run typecheck && bun test`; focused `bun test src/renderer/src/usePullRequestConversation*.test.* src/main/repository.test.ts`.

### Scope

**In**: `contracts.ts` (channel signatures), `preload/index.ts`, `index.ts` (the six handlers), `usePullRequestConversation.ts`, `useGitWorkflow.ts` (submit/merge/ready call sites), `RemoteReviewThreads.tsx`/`ReviewComments.tsx` if they call reply/resolve directly, `GitHubPanel.tsx` (merge/ready buttons). **Out**: `getGitIntegration`, `getPullRequestInbox`, `getClosedPullRequests`, `searchContent`, folder open — genuinely active-tab actions; `repository.ts` method bodies.

### Steps

1. **Contract**: add `root: string` as the first parameter of the six channels in `contracts.ts` (`RepositoryApi` interface) and `preload/index.ts` (pass-through). Verify: `bun run typecheck` fails at every renderer call site — that is your worklist.
2. **Main**: change each handler to `repositorySessions.require(requireRepositoryRoot(root))`, mirroring `getPullRequestReview`. Verify: `grep -n "requireActive()" src/main/index.ts` → none of the six PR channels remain.
3. **Renderer**: at each call site pass the world's root — `reviewWorlds.activeWorld.root` for user actions on the active PR tab, and the world captured at effect start for the conversation poll (store `root` next to `selector` in `usePullRequestConversation`'s options so a tab switch mid-poll cannot repoint it). Verify: `bun run typecheck` → exit 0.
4. **Guard test**: in `repository.test.ts` or a new `index`-level test if a seam exists, assert that calling `getPullRequestConversation` with a released root rejects with `'The repository tab is no longer open.'` rather than reading another repository. Verify: test passes.

### Done criteria

- [ ] lint/typecheck/test exit 0
- [ ] `grep -n "requireActive" src/main/index.ts` shows none of: `getPullRequestConversation`, `replyToPullRequestThread`, `setPullRequestThreadResolved`, `mergePullRequest`, `markPullRequestReady`, `submitPullRequestReview`
- [ ] Manual: two repo tabs open, PR tab from repo A active while repo B is the last *activated* working tree → conversation shows A's threads
- [ ] `git status` clean outside scope; status table in this file updated

### STOP conditions

- Drift. · A call site has no world/root in reach (e.g. a component that only knows the selector) — report the component rather than threading a new context.

### Maintenance notes

- Rule: any IPC channel whose subject is a PR, comparison, or file takes `root`; `requireActive()` is only for actions that are about "the folder the user is looking at right now".

---

## Plan 012: Store the cached PR patch as a raw file so reopening a PR never `JSON.parse`s tens of MB on the main thread

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/main/repository.ts src/main/repository.test.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P3 · **Effort**: M · **Risk**: MED · **Depends on**: Plan 003 (streamed reply shape) · **Category**: perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

The PR disk cache exists to make reopening a reviewed PR instant. Today `read()` does `JSON.parse(await readFile(..., 'utf8'))` on an entry whose `patch` field can be tens of MB (budget 200 MB / 20 entries), and `write()` does the matching `JSON.stringify`. Both are synchronous and un-yielding: 100–300 ms of blocked main process on exactly the fast path the cache was built for, during which every other IPC handler and watcher flush queues.

### Current state

```ts
// src/main/repository.ts:104-108
const PULL_REQUEST_CACHE_VERSION = 2
const MAX_PULL_REQUEST_CACHE_ENTRIES = 20
const MAX_PULL_REQUEST_CACHE_BYTES = 200 * 1024 * 1024
// src/main/repository.ts:943-959 — read
const entry = JSON.parse(await readFile(this.#entryPath(url, headRefOid), 'utf8')) as CachedPullRequestReview
if (entry.version !== PULL_REQUEST_CACHE_VERSION || entry.headRefOid !== headRefOid || typeof entry.patch !== 'string' || ...) return null
// src/main/repository.ts:961-980 — write
const entry: CachedPullRequestReview = { version: PULL_REQUEST_CACHE_VERSION, headRefOid, files: review.files, patch: review.patch, omittedFiles: review.omittedFiles }
...
await writeFile(temporaryPath, JSON.stringify(entry), 'utf8')
await rename(temporaryPath, entryPath)
await this.sweep()
```

`#entryPath` returns `${createCacheKey(url, headRefOid)}.json`. `sweep()` enforces the entry/byte budget by file size (read it before changing the layout — it must count both files of an entry).

### Commands

`bun run lint && bun run typecheck && bun test`; focused `bun test src/main/repository.test.ts`.

### Scope

**In**: `repository.ts` (`PullRequestReviewCache` class only), `repository.test.ts`. **Out**: the review streaming path (plan 003), renderer.

### Steps

1. **Bump `PULL_REQUEST_CACHE_VERSION` to 3.** Old `.json` entries fail the version check and are treated as misses; `sweep()` will age them out. Verify: existing cache tests still pass with a fresh temp directory.
2. **Split the entry**: metadata sidecar `<key>.json` = `{ version, headRefOid, files, omittedFiles, patchBytes }` (small; keep `JSON.parse`), patch `<key>.patch` written with `writeFile(temp, review.patch, 'utf8')` + `rename`. Write the patch first, sidecar last, so a sidecar's presence implies a complete patch. Verify: test — write then read returns an equal review.
3. **Read**: parse the sidecar, then `readFile(patchPath, 'utf8')` (no parse). Validate `patch.length === sidecar.patchBytes`-equivalent (store the UTF-16 length, compare after read) to detect a torn write; on mismatch return `null`. Verify: test — corrupt/truncated patch file → `null`.
4. **`sweep()`**: count both files per key toward the byte budget; delete both when evicting; delete orphan `.patch` files with no sidecar. Verify: test — budget eviction removes the pair.
5. **(With plan 003 landed)** when the cached path serves a review, main can now stream the patch to the renderer in pages by splitting the raw string on `\ndiff --git ` — same chunker as the fast path — instead of a single 20 MB structured clone. Optional; do it only if plan 003's chunker is reusable without duplication.

### Done criteria

- [ ] lint/typecheck/test exit 0
- [ ] `grep -n "PULL_REQUEST_CACHE_VERSION = 3" src/main/repository.ts` → one match
- [ ] `grep -n "JSON.parse" src/main/repository.ts` inside `PullRequestReviewCache.read` parses only the sidecar
- [ ] Manual: reopen a cached 3000-file PR — Performance HUD main-process CPU shows no multi-hundred-ms stall
- [ ] status table in this file updated

### STOP conditions

- Drift. · `sweep()` relies on a single file per key in a way that cannot be extended (e.g. keyed by full filename) — report the shape before rewriting it.

### Maintenance notes

- Any new field on the review goes in the sidecar, never the `.patch` file.

---

## Plan 013: Finish the entry-chunk diet — lazy palette and chart, dynamic editor import, hidden sourcemaps

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/App.tsx src/renderer/src/PerformanceHud.tsx src/renderer/src/useFileEditing.ts src/renderer/src/editor/ViewerProviders.tsx electron.vite.config.ts package.json`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30 00:50** (after Grok's startup refactor landed). Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P3 (was P2 — the big win already landed) · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: perf (startup)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30 00:50

### Why this matters

Grok's `WorkspaceRoot` refactor (see "Sibling document" above) already took the
`@pierre/diffs` runtime out of the Welcome path: the renderer entry chunk went
from 814,673 B to **340 KB** (`out/renderer/assets/index-CxFcYpGS.js`, build of
00:37) and `grep -c WorkerPool` on it is `0`; `SettingsPage-*.js` is its own
chunk. What remains is small and mechanical: the command palette and the
performance chart are still static imports in the entry, `useFileEditing.ts`
still value-imports the `Editor` class (now inside the `WorkspaceRoot` chunk —
fine for Welcome, but it is only needed once the user presses Edit), and the
build emits no sourcemaps, so renderer crash frames in
`renderer-terminations.json` (`src/main/index.ts:77`) are minified.

Do **not** reintroduce `lazy()`/`Suspense` on the first workspace or viewer
reveal — React 19's `FALLBACK_THROTTLE_MS = 300` is why Grok replaced it with
the resolved-module store in `workspaceBoot.ts`. Palette and chart are
user-initiated, so `lazy()` with a `null` fallback is fine there.

### Current state

```ts
// src/renderer/src/App.tsx:31-34 — palette still static in the entry
import {
  CommandPaletteController,
  type CommandPaletteHandle
} from './CommandPalette'
// src/renderer/src/App.tsx:80-86 — the lazy pattern already in use (Grok added SettingsPage)
const TerminalDock = lazy(() => import('./TerminalDock'))
const RepositoryPanel = lazy(async () => ({ default: (await import('./GitHubPanel')).RepositoryPanel }))
const SettingsPage = lazy(async () => ({ default: (await import('./SettingsPage')).SettingsPage }))
```

```ts
// src/renderer/src/PerformanceHud.tsx:6, 153 — chart imported statically, rendered only when the popover is open
import { PerformanceChart } from './PerformanceChart'
...
{popoverOpen ? <PerformanceChart history={history} /> : null}
```

```ts
// src/renderer/src/useFileEditing.ts:3, 21-22 — value import of the editor class
import { Editor, type EditorOptions } from '@pierre/diffs/edit'
export function createDiffEditor<LAnnotation>(options: EditorOptions<LAnnotation>): Editor<LAnnotation> { return new Editor(options) }
// src/renderer/src/editor/ViewerProviders.tsx:4 — already type-only
import type { Editor, EditorOptions } from '@pierre/diffs/edit'
```

```ts
// electron.vite.config.ts:100-108 — no sourcemap
renderer: {
  root: resolve('src/renderer'),
  plugins: [react(), contentSecurityPolicyPlugin(), dropShikiWasmPlugin()],
  build: { minify: 'esbuild', cssMinify: 'esbuild' },
  worker: { format: 'es', plugins: () => [dropShikiWasmPlugin()] }
}
```

`ls out/renderer/assets/*.map | wc -l` → `0`.

### Commands

| Purpose | Command | Expected |
|---|---|---|
| Build (writes only to ignored `out/`) | `bun run build` | exit 0 |
| Entry size | `ls -l out/renderer/assets/index-*.js` | largest ≤ 340 KB (no regression) |
| Chunks | `ls out/renderer/assets \| grep -E "CommandPalette\|PerformanceChart"` | two chunks after Step 1 |
| Maps | `ls out/renderer/assets/*.map \| wc -l` | > 0 after Step 3 |
| Gate | `bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` | exit 0, `Score: 100 / 100` |

### Scope

**In**: `App.tsx` (palette import only), `PerformanceHud.tsx` (chart import only), `useFileEditing.ts`, `editor/ViewerProviders.tsx` (if `createDiffEditor` becomes async), `electron.vite.config.ts`, `package.json` (`build.files`). **Out**: `workspaceBoot.ts`, `WorkspaceRoot.tsx`, `main.tsx` (Grok's boot path — do not touch), `manualChunks` (rejected), CSP/shiki plugins.

### Steps

1. **Lazy palette and chart**: `const CommandPaletteController = lazy(async () => ({ default: (await import('./CommandPalette')).CommandPaletteController }))` behind `<Suspense fallback={null}>`; keep the eager `keybindings` import (`App.tsx:35`) so ⌘K still registers; the ref handle may be `null` until the chunk lands — on first ⌘K, call `preload` (`import('./CommandPalette')`) on `keydown` of the Meta key or on app idle, and only `open()` once the ref exists. Same for `PerformanceChart` inside the popover. Verify: two new chunks; ⌘K on a cold start opens the palette within one frame after its chunk (acceptable: it is user-initiated).
2. **Dynamic `Editor`**: `createDiffEditor` becomes `async` and does `const { Editor } = await import('@pierre/diffs/edit')`; update its single caller in `ViewerProviders.tsx` to await before attaching (edit sessions start on the Edit button). Verify: `grep -n "from '@pierre/diffs/edit'" src/renderer/src/useFileEditing.ts` → only `import type`.
3. **Hidden sourcemaps**: renderer `build.sourcemap: 'hidden'`; add `"!out/renderer/assets/*.map"` to `package.json` `build.files`. Verify: maps exist in `out/`; `bun run build` exit 0.
4. **Regression guard**: record the entry size and `WorkerPool` count in the plan report; add a one-line check to `scripts/benchmark-startup.mjs`'s README comment or a tiny `scripts/check-entry-chunk.sh` that fails if the entry exceeds 400 KB or contains `WorkerPool` — wire it into `verify`. Verify: `bun run verify` exit 0.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor 100
- [ ] Entry chunk ≤ 340 KB, `WorkerPool` count 0, `CommandPalette-*` and `PerformanceChart-*` chunks exist
- [ ] `useFileEditing.ts` has no value import from `@pierre/diffs/edit`
- [ ] `.map` files emitted and excluded from packaging
- [ ] status table in this file updated

### STOP conditions

- Drift. · Lazy palette breaks ⌘K on first press even with the preload — report; do not add a spinner. · `createDiffEditor` has more than one caller (grep first).

### Maintenance notes

- New surfaces default to `lazy()` **unless** they are on the first reveal path (Welcome → workspace → viewer), which goes through `workspaceBoot.ts`.
- `scripts/check-entry-chunk.sh` is the guard; raise its limit only with a measured reason.

---

## Plan 014: One `@pierre/theme`, and ship only the 8 Shiki themes the UI can select

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- package.json bun.lock electron.vite.config.ts src/renderer/src/Explorer.tsx src/renderer/src/preferences.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P3 · **Effort**: S (themes) · **Risk**: MED (major bump) · **Depends on**: none · **Category**: migration + perf (package size)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Two copies of `@pierre/theme` are installed: `1.1.0` at the root (pinned in `package.json`) and `2.0.0` nested under `@pierre/diffs` (which requires `2.0.0`, `node_modules/@pierre/diffs/package.json:72`). The file tree colours come from 1.1.0 (`Explorer.tsx:5,18`) and the code colours from 2.0.0 — a silent palette-drift hazard, visible in the build as two `pierre-light-*.js` chunks of identical size (30,552 B) and different hashes. Separately, Shiki theme chunks total ~1.65 MB across 57 files while `preferences.ts:66-75` exposes exactly 8 themes — ~1.15 MB of unreachable theme data in every download. (Grammar chunks are ~8 MB but lazy; trimming languages needs a product decision on the supported list and is deferred.) These are package-size wins, not cold-start wins — say so in the commit.

### Current state

```ts
// src/renderer/src/Explorer.tsx:1-22
import { themeToTreeStyles } from '@pierre/trees'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
...
const DARK_TREE_STYLES = themeToTreeStyles(pierreDarkTheme)
let lightTreeStyles: Promise<TreeThemeStyles> | null = null
function loadLightTreeStyles(): Promise<TreeThemeStyles> {
  lightTreeStyles ??= import('@pierre/theme/pierre-light').then((module) => themeToTreeStyles(module.default))
  return lightTreeStyles
}
```

```ts
// src/renderer/src/preferences.ts:66-75
export const EDITOR_THEMES: Record<EditorTheme, string> = {
  'pierre-dark': 'Pierre Dark', 'pierre-dark-soft': 'Pierre Dark Soft', 'github-dark': 'GitHub Dark', 'vitesse-dark': 'Vitesse Dark',
  'pierre-light': 'Pierre Light', 'github-light': 'GitHub Light', 'vitesse-light': 'Vitesse Light', 'light-plus': 'Light Plus'
}
```

```ts
// electron.vite.config.ts:47-73 — the existing resolveId-stub pattern to copy
function dropShikiWasmPlugin(): Plugin {
  const stubId = '\0horus:shiki-wasm-stub'
  return { name: 'horus:drop-shiki-wasm', enforce: 'pre',
    resolveId(source) { return source === 'shiki/wasm' ? stubId : null },
    load(id) { if (id !== stubId) return null; return "throw new Error('…')\n" } }
}
```

`@pierre/diffs` resolves themes through `shiki`'s bundled registry (`node_modules/@pierre/diffs/dist/highlighter/shared_highlighter.js:8` imports `createHighlighter` from `"shiki"`); shiki's theme map lives at `node_modules/shiki/dist/themes.mjs` (exported as `shiki/themes`). Build evidence: `ls out/renderer/assets | grep -c "^pierre-"` → 11 chunks; two `pierre-light-*.js`.

### Commands

| Purpose | Command | Expected |
|---|---|---|
| Install (writes lockfile — allowed for this plan) | `bun install` | exit 0 |
| Dedupe check | `find node_modules -path "*@pierre/theme/package.json" \| xargs grep '"version"'` | one version |
| Build | `bun run build` | exit 0 |
| Theme chunk count | `ls out/renderer/assets \| grep -cE "^(catppuccin\|gruvbox\|everforest\|material-theme\|ayu\|dracula\|nord\|one-\|night-owl\|snazzy\|solarized\|min-\|monokai\|slack)"` | `0` after Step 3 |
| Gate | `bun run lint && bun run typecheck && bun test` | exit 0 |

### Scope

**In**: `package.json`, `bun.lock`, `Explorer.tsx` (only if 2.0.0 renamed exports), `electron.vite.config.ts`. **Out**: language/grammar trimming (needs a supported-language decision — record as a follow-up), `@pierre/diffs` version, fonts.

### Steps

1. **Bump `@pierre/theme` to `2.0.0`** in `devDependencies`; `bun install`. Note `bunfig.toml` has `minimumReleaseAge = 604800` — 2.0.0 is already installed transitively, so it passes. Verify: the dedupe check prints one version; `bun run typecheck` passes (fix `Explorer.tsx` imports if 2.0.0 renamed `pierre-dark`/`pierre-light` entry points — check `node_modules/@pierre/theme/package.json` `exports`).
2. **Visual check**: run dev, compare the file tree colours in dark and light against the code view — they must now come from the same palette version. Verify: `bun run build`; `ls out/renderer/assets | grep "^pierre-light"` → one chunk.
3. **Theme allowlist plugin**: add `trimShikiThemesPlugin()` next to `dropShikiWasmPlugin` with `enforce: 'pre'`. In `load(id)`, when `id` resolves to shiki's `dist/themes.mjs` (match on `/shiki/dist/themes.mjs` or the `\0`-prefixed resolved id — log `id` once to find the exact string), return a rewritten module that keeps only entries whose key is in `EDITOR_THEMES` (import the key list by reading `src/renderer/src/preferences.ts`? No — hard-code the 8 ids in the config with a comment pointing at `EDITOR_THEMES`, and add a unit test in `src/renderer/src/preferences.test.ts` that asserts `Object.keys(EDITOR_THEMES)` equals that list, so drift fails CI). The rewritten module must preserve the export shape (`bundledThemesInfo`, `bundledThemes`) — read `themes.mjs` first and generate the filtered source by regex on its `import()` entries. Verify: `bun run build`; theme chunk count command → `0`; the app still switches between all 8 themes in dev.
4. **Record the language follow-up** in the "Considered and rejected" list at the top of this file: ~8 MB of grammar chunks are lazy and cost package size only; trimming needs a supported-language list and a plaintext fallback.

### Done criteria

- [ ] lint/typecheck/test exit 0; `bun run build` exit 0
- [ ] One `@pierre/theme` version in `node_modules`; one `pierre-light-*.js` chunk
- [ ] Zero unreachable theme chunks in `out/renderer/assets`
- [ ] All 8 themes still selectable and rendering in dev
- [ ] status table in this file updated

### STOP conditions

- Drift. · `@pierre/theme` 2.0.0 changes the token object shape consumed by `themeToTreeStyles` (tree renders unstyled) — report; do not patch `node_modules`. · shiki's `themes.mjs` is not the module `@pierre/diffs` resolves themes through (worker chunk still ships them) — report the actual import path.

### Maintenance notes

- Adding a theme = add it to `EDITOR_THEMES` **and** the allowlist in the config; the preferences test enforces the pairing.

---

## Plan 015: Fix the seven visible UI bugs (popover offset, inert toast, dead focus ring, light-theme selection colours, 8px label, frozen skeleton, layout-animating brand)

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/styles.css src/renderer/src/dragSelection.ts src/renderer/src/WorkspaceSkeleton.tsx src/renderer/index.html src/renderer/src/GitHubPanel.tsx src/renderer/src/App.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: bug (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Seven concrete, reproducible defects — each one line to a handful of lines — that a user meets on ordinary paths: the search popover opens 40 px above the field it belongs to and covers the tab strip; the only actionable toast in the app cannot be clicked; its focus ring is an invalid declaration; line selection paints GitHub-dark blue on a light theme; a label renders at ~8 px; the loading skeleton freezes under reduced motion; and the brand animates a layout property during the fullscreen transition. These are the "UI bugs" the user reports, isolated from the broader consistency work in plans 016–019 so they can land in an hour.

### Current state

```css
/* styles.css:1273 — popover anchored to a pre-WorldStrip constant */
.search-popover { position: fixed; z-index: 50; top: 42px; left: 50%; ... max-height: min(620px, calc(100vh - 70px)); ... }
/* styles.css:65-67 — the real chrome height */
--tabbar-height: 44px; --toolbar-height: 48px; --titlebar-height: calc(var(--tabbar-height) + var(--toolbar-height));
/* styles.css:351 */ .performance-popover { top: calc(100% + 7px); max-height: calc(100vh - 66px); ... }
```
`App.tsx:288` renders `<WorldStrip>` before `App.tsx:297` `<Titlebar>`, so the search field's bottom edge is ~92 px, not 42.

```css
/* styles.css:2044-2070 — toast host is click-through and nothing re-enables it */
#horus-toast-host { ... pointer-events: none; }
.horus-toast > button { flex: none; border: 0; padding: 2px 0; background: transparent; color: var(--accent); font: inherit; cursor: pointer; }
.horus-toast > button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
/* styles.css:95-96 — --focus-ring is a LENGTH, so the shorthand above is invalid and dropped */
--focus-ring: 2px; --focus-offset: 2px;
/* styles.css:204-206 — the correct global rule (lower specificity, so it loses) */
:where(button, input, select, summary, textarea, [tabindex]):focus-visible { outline: var(--focus-ring) solid var(--focus); outline-offset: var(--focus-offset); }
```
`toast.ts:80-89` builds a real `<button>`; `useFileEditing.ts:406-409` ships the "N unsaved drafts restored → Open" toast.

```ts
// dragSelection.ts:3-46 (DRAG_SELECTION_CSS, injected into every diff shadow root via viewerCss.ts:82)
[data-selected-line], [data-drag-range] { background: rgba(64, 139, 230, 0.16) !important; }
[data-gutter] [data-drag-range]::after { ... border-radius: 2px; background: #58a6ff; ... }
[data-utility-button] { position: relative; border-radius: 7px; corner-shape: squircle; background: #58a6ff; color: #07111f; }
```
Tokens: `--accent: #78a9ff` (dark, styles.css:17) / `#276bd6` (light, :124); `--accent-contrast: #101113` / `#ffffff`; `--corner-compact: 7px`. `viewerCss.ts:47-48` documents that custom properties cross the shadow boundary. `index.html:6`: `<meta name="theme-color" content="#0c0d0f" />` never updated; `styles.css:184` hand-patches `html:has(.app-shell[data-theme-type="light"]) { color-scheme: light; background: #f7f8fa; }`.

```tsx
// GitHubPanel.tsx:289 — className with no rule anywhere; UA `small` = ~8px beside 10px siblings (.git-sync-bar font: 10px, styles.css:1411)
<small className="git-sync-freshness">
```

```css
/* styles.css:1639 — global reduced-motion rule (!important) beats the skeleton's non-important fallback */
*, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; ... }
/* styles.css:1686-1688 — the workaround already applied to .spin / .terminal-status / .diff-loading-bar */
.spin, .agent-work-log-status.running { animation: status-pulse 1.4s ease-in-out infinite !important; animation-duration: 1.4s !important; animation-iteration-count: infinite !important; ... }
```
```ts
// WorkspaceSkeleton.tsx:50-53 — the fallback that never wins
@media (prefers-reduced-motion: reduce) {
  .workspace-skeleton-bar::after { animation: workspace-skeleton-fade 1600ms ease-in-out infinite; transform: none; }
```

```css
/* styles.css:490 — the only layout-property transition in the file */
.world-strip-brand { height: 37px; min-width: 142px; display: flex; align-items: center; gap: 8px; padding-left: calc(var(--titlebar-leading-safe-area) - 10px); ... transition: padding-left var(--duration-slow) var(--ease-out); }
/* styles.css:187 */ html[data-fullscreen="true"] { --titlebar-leading-safe-area: 10px; }
```

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` (100); `bun run update:mac` for the feel check.

### Scope

**In**: `styles.css` (the cited rules only), `dragSelection.ts` (CSS block only), `WorkspaceSkeleton.tsx` (reduced-motion block only), `index.html`, `App.tsx` (only a `theme-color` meta update alongside the existing theme effect at 618-629), `GitHubPanel.tsx` (no change if you add a CSS rule instead). **Out**: bar unification, tokens, dedupe (plans 016–018); toast behaviour in `toast.ts`.

### Steps

1. **Popovers derive from chrome height**: `.search-popover { top: calc(var(--titlebar-height) - 4px); max-height: calc(100vh - var(--titlebar-height) - 24px); }`; `.performance-popover { max-height: calc(100vh - var(--titlebar-height) - 24px); }`. Add a one-line comment: "derived — went stale once when the tab strip was added". Verify: dev — open search; the popover's top edge sits just under the search field and the tab strip is fully visible.
2. **Toast button clickable + real focus ring**: add `.horus-toast:has(> button) { pointer-events: auto; }`; change the focus rule to `outline: var(--focus-ring) solid var(--focus); outline-offset: var(--focus-offset);`. Verify: `grep -n "solid var(--focus-ring)" src/renderer/src/styles.css` → no output; dev — trigger the restored-drafts toast (edit a file, quit, relaunch) and click **Open** → it acts.
3. **Selection colours from tokens**: in `DRAG_SELECTION_CSS`, `background: color-mix(in srgb, var(--accent) 16%, transparent) !important;`, both `#58a6ff` → `var(--accent)`, `#07111f` → `var(--accent-contrast)`, `border-radius: 7px` → `var(--corner-compact)`. Verify: `grep -nE "#58a6ff|#07111f|rgba\(64, 139, 230" src/renderer/src/dragSelection.ts` → no output; dev in Pierre Light — select lines: the band is light-theme blue, button text is white.
4. **`theme-color` follows the theme**: in the `App.tsx` preferences effect, `document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getEditorThemeType(...) === 'light' ? '#f7f8fa' : '#0c0d0f')` — read both literals from `getComputedStyle(document.documentElement).getPropertyValue('--canvas')` instead if you prefer one source of truth. Verify: switch themes; `document.querySelector('meta[name=theme-color]').content` changes.
5. **`.git-sync-freshness` sized**: add `.git-sync-freshness { font-size: inherit; }` next to `.git-sync-bar` (styles.css:1411). Verify: the "updated 2m ago" label matches its siblings' 10px.
6. **Skeleton pulses under reduced motion**: in `WorkspaceSkeleton.tsx`'s reduced-motion block add `animation-duration: 1600ms !important; animation-iteration-count: infinite !important;` (same pattern as styles.css:1686). Verify: DevTools → Rendering → emulate `prefers-reduced-motion: reduce`; open a folder → skeleton bars pulse.
7. **Brand travel on the compositor**: give `.world-strip-brand` a fixed `padding-left: 0` and a leading spacer: `.world-strip-brand::before { content: ""; width: calc(var(--titlebar-leading-safe-area) - 10px); flex: none; }` — no transition (fullscreen is a window-state change; macOS animates the chrome itself). If a transition is wanted, animate `translateX` on the brand's children instead. Verify: `grep -n "transition: padding-left" src/renderer/src/styles.css` → no output; toggle fullscreen — no jitter in the tab row.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor 100; `git diff --check` exit 0
- [ ] `grep -n "top: 42px" src/renderer/src/styles.css` → no output
- [ ] `grep -n "solid var(--focus-ring)" src/renderer/src/styles.css` → no output
- [ ] `grep -nE "#58a6ff|#07111f" src/renderer/src/dragSelection.ts` → no output
- [ ] `grep -n "transition: padding-left" src/renderer/src/styles.css` → no output
- [ ] Feel check items 1–7 above confirmed in the installed app
- [ ] status table in this file updated

### STOP conditions

- Drift. · `color-mix` inside the shadow root does not resolve `var(--accent)` (band renders transparent) — report; `viewerCss.ts:47-48` says variables cross, so this would be new information. · The toast host's `:has()` is unsupported in the shipped Electron (it is supported in 43; if not, add `pointer-events: auto` on `.horus-toast` and `none` on `.horus-toast > span`).

### Maintenance notes

- Fixed offsets in overlay CSS must be `calc()`s from `--titlebar-height`.
- Shadow-root CSS must use tokens; a hex literal in `*Css.ts` is a review blocker.

---

## Plan 016: One review-bar recipe, one left gutter, and a skeleton that matches what replaces it

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/styles.css src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/PullRequestReviewBar.tsx src/renderer/src/ReviewCheckpointBar.tsx src/renderer/src/WorkspaceSkeleton.tsx src/renderer/src/Explorer.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED · **Depends on**: Plan 015 (bug batch first, so this diff is pure consistency) · **Category**: tech-debt (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

On every GitHub PR review, up to three bars render as consecutive siblings in the diff column (`RepositoryWorkspace.tsx:298-328`): the checkpoint bar, the review bar (or its read-only variant). They are 32 px vs 34 px tall, padded 10 vs 12 px, set in 10 px vs 11 px, aligned left vs right, with buttons that differ in border colour, corner radius and press feedback. Below and above them, the left text edge steps 14 → 10 → 12 → 14 → 16 → 10 px down the column, and the sidebar starts at 12 while its search box starts at 8. Nothing shares an edge. This is the single most visible source of the "messy / not aligned" report. The loading skeleton adds a text change ("Files" → "Explorer") and four controls popping in on swap.

### Current state

```css
/* styles.css:659-665 */
.pr-review-bar.compact { min-height: 34px; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 10px; }
.pr-review-bar.compact span { color: var(--faint); font-size: var(--text-2xs); }
.pr-review-bar button { min-height: var(--control-height-sm); display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-strong); border-radius: var(--corner-control); padding: 0 8px; background: transparent; color: var(--text-secondary); font-size: var(--text-2xs); cursor: pointer; }
.pr-review-bar button:hover { background: var(--control-fill-hover); color: var(--text); }
/* styles.css:672-678 */
.review-checkpoint-bar { min-height: 32px; flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px; border-bottom: 1px solid var(--border); background: var(--panel-subtle); color: var(--muted); font-size: var(--text-2xs); }
.review-checkpoint-bar button { min-height: var(--control-height-sm); display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--corner-compact); padding: 0 7px; background: transparent; color: var(--text-secondary); font-size: var(--text-2xs); cursor: pointer; transition: none; }
.review-checkpoint-bar button:hover:not(:disabled) { border-color: var(--border-strong); background: var(--control-fill-hover); color: var(--text); }
/* styles.css:680-686 */
.pr-review-readonly { min-height: 34px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--panel-subtle); color: var(--muted); font-size: var(--text-xs); }
.pr-review-readonly button { min-height: var(--control-height-sm); border: 1px solid var(--border-strong); border-radius: var(--corner-compact); padding: 0 8px; background: var(--control-fill); color: var(--text-secondary); font-size: var(--text-2xs); font-weight: var(--weight-strong); cursor: pointer; }
```

Gutter ladder (left padding, top to bottom of the diff column): `.diff-toolbar` `0 10px 0 14px` (:576) → `.review-checkpoint-bar` `0 10px` (:672) → `.pr-review-bar.compact` `0 10px` / `.pr-review-readonly` `0 12px` → `.editor-breadcrumbs` `0 14px` (:1017) → `.diff-scroll` `16px` (:695) → `.editor-statusbar` `0 10px` (:1024). Sidebar: `.sidebar-heading` `0 8px 0 12px` (:566); tree search `padding: 7px 8px 6px` (`RepositoryWorkspace.tsx:126`, in `TREE_STYLES`). Cards inside the scroller: `.review-summary { margin: 8px 16px 2px }` (:842), `.pr-context { margin: 12px 16px 4px }` (:878), `.review-card { margin: 7px 12px 9px }` (:918).

Skeleton: `WorkspaceSkeleton.tsx:84` `<div className="sidebar-heading"><strong>Files</strong></div>` vs `Explorer.tsx:85-105` `<strong>Explorer</strong>` + `.sidebar-heading-actions` (count + 3 icon buttons); `WorkspaceSkeleton.tsx:93-98` toolbar has only `.diff-toolbar-context` while the real toolbar also has `.diff-controls` reserved at `min-inline-size: 336px` (:586); `.workspace-skeleton-code { padding: 14px 18px }` (:38) vs `.diff-scroll` `16px`.

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose && npx -y react-doctor@latest design --verbose` → 100 / no issues; `bun run update:mac`.

### Scope

**In**: `styles.css` (bar rules, gutter paddings, card margins, sidebar heading), `RepositoryWorkspace.tsx` (`TREE_STYLES` search padding only; bar JSX may gain a shared class), `PullRequestReviewBar.tsx`, `ReviewCheckpointBar.tsx` (className additions only), `WorkspaceSkeleton.tsx`. **Out**: bar behaviour/state machine (`PullRequestReviewBar.tsx:45-58`), tokens for durations/type/icons (plan 018), the `.file-preview-mode .diff-toolbar` variant's *purpose* (keep it; align its padding).

### Steps

1. **Tokens for this plan only**: add to `:root` — `--bar-height: 34px; --gutter: 14px; --gutter-sidebar: 12px;`. Verify: `grep -n "^\s*--bar-height\|^\s*--gutter" src/renderer/src/styles.css` → three matches.
2. **`.review-bar` base + `.bar-button` recipe**: one block — `min-height: var(--bar-height); display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 var(--gutter); border-bottom: 1px solid var(--border); background: var(--panel-subtle); color: var(--muted); font-size: var(--text-2xs);` and `.bar-button { min-height: var(--control-height-sm); display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--corner-compact); padding: 0 8px; background: transparent; color: var(--text-secondary); font-size: var(--text-2xs); cursor: pointer; } .bar-button:hover:not(:disabled) { border-color: var(--border-strong); background: var(--control-fill-hover); color: var(--text); } .bar-button:disabled { opacity: var(--disabled-opacity); cursor: default; }`. Keep `.primary`/`.danger` modifiers from `.pr-review-bar button.primary/.danger` as `.bar-button.primary/.danger`. Add `className="review-bar …"` to the three bar roots and `bar-button` to their buttons; delete the per-bar height/padding/font/button rules (keep only what is genuinely unique — e.g. `.pr-review-readonly[role="alert"]` colours, `.pr-review-bar.expanded` textarea). Text alignment: left (`space-between`) for all three — the compact review bar's `flex-end` goes. Verify: dev, open a PR — the checkpoint bar and review bar share height, left edge, label size, and button look; `grep -n "min-height: 32px\|min-height: 34px" src/renderer/src/styles.css` → no matches in bar rules.
3. **Gutter**: set left/right inline padding to `var(--gutter)` on `.diff-toolbar` (keep right at 10px if the icon buttons need the tighter edge — then use `0 10px 0 var(--gutter)`), `.editor-breadcrumbs`, `.editor-statusbar`, and `.diff-scroll { padding: 16px var(--gutter) }`; set `.sidebar-heading { padding: 0 8px 0 var(--gutter-sidebar) }` and the tree search container in `TREE_STYLES` to `padding: 7px var(--gutter-sidebar) 6px` (custom properties cross the shadow root — the file already relies on that). Cards: `.review-summary`, `.pr-context`, `.review-card` → `margin-inline: 0` (the scroller's gutter now provides the edge); keep their block margins. Verify: screenshot the diff column with a PR open; a vertical guide at x = gutter touches the toolbar title, bar labels, breadcrumbs, first code column, statusbar text, and card borders.
4. **Skeleton parity**: `WorkspaceSkeleton.tsx` heading → `<strong>Explorer</strong>` plus a `.sidebar-heading-actions` containing one `.sidebar-file-count` placeholder (fixed width 28px bar) and three 30 × 30 placeholder squares; toolbar → add `<div className="diff-controls" style={{ minInlineSize: 336 }} />` spacer; `.workspace-skeleton-code { padding: 16px var(--gutter) }`. Verify: DevTools → throttle CPU 6×, open a folder: the heading text does not change and no control pops in when the real Explorer mounts.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor full + design clean; `git diff --check` exit 0
- [ ] `grep -c "\.review-bar\b" src/renderer/src/styles.css` ≥ 1 and the three bars carry the class (`grep -n 'className="review-bar' src/renderer/src/*.tsx` → 3 sites)
- [ ] `grep -nE "padding: 0 (10|12)px" src/renderer/src/styles.css` shows none of `.diff-toolbar|.review-checkpoint-bar|.pr-review|.editor-breadcrumbs|.editor-statusbar`
- [ ] Skeleton heading text equals Explorer heading text (`grep -n "<strong>" src/renderer/src/WorkspaceSkeleton.tsx src/renderer/src/Explorer.tsx` → same word)
- [ ] status table in this file updated

### STOP conditions

- Drift. · `PullRequestReviewBar.dom.test.tsx` / `ReviewCheckpointBar.dom.test.tsx` fail on role/name queries after class changes — they should not (classes only); if they do, stop. · The tree search container is not styled from `TREE_STYLES` (grep first).

### Maintenance notes

- New chrome rows use `.review-bar` + `.bar-button`; a new `min-height: NNpx` on a bar is a review blocker.
- Every horizontal padding in the diff column derives from `--gutter`.

---

## Plan 017: Merge the 25 duplicated selector blocks, delete dead CSS and orphan classNames, and add a guard so it cannot recur

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/styles.css src/renderer/src/ReviewSummary.tsx src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/MultiFileReview.tsx src/renderer/src/SettingsPage.tsx src/renderer/src/AgentPanel.tsx src/renderer/src/WorkspaceSkeleton.tsx package.json`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: MED · **Depends on**: Plan 016 · **Category**: tech-debt (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

`styles.css` (2111 lines, 370 class selectors) has 25 selectors declared in two separate blocks where the later silently overrides the earlier — 14 of them in the agent dock (`.agent-dock-header` 40 px at :1715 → 42 px at :1873; `.agent-dock-empty` centred at :1726 → start-aligned at :1917; `.agent-activity` gap 4 → 0; `.world-load-signal` :524 → :525 makes the first rule unreachable). Nobody editing a rule can tell whether it is the one that applies, so half of all dock tweaks edit the losing copy — a mechanism that *produces* drift. Five class blocks have no consumer (the AgentPanel→AgentDock migration residue), one pill state is unreachable by construction, and seven classNames in JSX have no rule. Do this **before** the token pass (plan 018) so tokens are applied to one copy of each rule.

### Current state

Duplicate pairs (first → second block, styles.css line numbers): `.agent-dock` :1700/:1872 · `.agent-dock-header` :1715/:1873 · `.agent-dock-transcript` :1723/:1883 · `.agent-question` :1725/:1887 · `.agent-dock-empty` :1726/:1917 · `.agent-activity` :1734/:1937 · `.agent-activity-item pre` :1747/:1941 · `.agent-activity-chevron` :1745/:1942 · `.agent-composer` :1762/:2002 · `.pr-inbox` / `.pr-inbox-heading` :836-837/:1454-1455 · `.multi-file-progress` :796/:817 · `.settings-header` :1078/:1091 · `.world-load-signal` :524/:525 · `.segmented-control button` :317/:332 · `.file-edit-save` :635/:644 · `.world-new` :498/:549. (Reproduce the full list: `grep -oE '^\.[a-zA-Z0-9_-]+( [^{,]+)? \{' src/renderer/src/styles.css | sort | uniq -d`.)

Dead blocks: `.agent-panel-form` (:1853-1860), `.agent-toolbar-button` (:1861-1868), `.agent-streaming` + `@keyframes agent-pulse` (:1842-1846), `.agent-panel-prompts` (:1848-1851), `.open-button-secondary` (:303-304); `.pr-row-title .pr-state.state-open` (:1448) unreachable — `GitHubPanel.tsx:102` renders the pill only when `state !== 'open'`.

Orphan classNames (JSX, no rule): `copy-icon-swap` (`ReviewSummary.tsx:66`), `diff-mode` (`RepositoryWorkspace.tsx:777`, `WorkspaceSkeleton.tsx:92`), `review-file-metadata` (`MultiFileReview.tsx:482`), `settings-heading` (`SettingsPage.tsx:121`), `archived` on `.agent-turn` (`AgentPanel.tsx:345`); `git-sync-freshness` is handled by plan 015.

No stylelint in `package.json`; lint is `oxlint src` (JS/TS only).

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` (100); new: `bunx stylelint "src/renderer/src/styles.css"` after Step 4.

### Scope

**In**: `styles.css`, the six JSX files above (className removal or a real rule), `package.json` (`lint:css` script + `stylelint` devDependency), a new `.stylelintrc.json`. **Out**: any visual change beyond "the winning value survives" — this is a no-op refactor for the rendered UI; tokens (plan 018).

### Steps

1. **Snapshot the winners**: for each duplicated selector, compute the effective declaration set (later block wins per property) and write it down in your report. Verify: list complete for every selector printed by the `uniq -d` command.
2. **Merge**: move each winner set into the *first* block, delete the second. For `.world-load-signal`, keep the intended visible state (the :525 rule) and delete :524's background. Verify: `grep -oE '^\.[a-zA-Z0-9_-]+( [^{,]+)? \{' src/renderer/src/styles.css | sort | uniq -d` → no output; dev — agent dock, PR inbox, settings header, world strip look identical to before (compare screenshots).
3. **Delete dead CSS; resolve orphans**: remove the five dead blocks and `:1448`. For orphans: `archived` → add `.agent-turn.archived { opacity: 0.85; }` (a real de-emphasis, or remove the class — pick one, note it); `diff-mode`, `review-file-metadata`, `settings-heading`, `copy-icon-swap` → remove the className unless a hook is needed for a test (`grep` the `*.test.*` files first). Verify: for each of the 370 selectors, `grep -rq` its class in `src/**/*.tsx|ts|html` — write a 10-line script in the scratchpad that prints any selector with zero JSX hits; expect none except state/attribute selectors.
4. **Guard**: add `stylelint` (+ `stylelint-config-standard`) as devDependencies with `.stylelintrc.json` enabling at least `no-duplicate-selectors` and `declaration-block-no-duplicate-properties`; `"lint:css": "stylelint \"src/renderer/src/**/*.css\""`; add it to `verify` and to `.github/workflows/ci.yml` after `bun run lint`. Note `bunfig.toml` `minimumReleaseAge` may delay a very fresh stylelint release — pin a version ≥ 7 days old. Verify: `bun run lint:css` → exit 0; introduce a temporary duplicate selector → exit 1; remove it.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor 100; `bun run lint:css` exit 0
- [ ] `uniq -d` duplicate-selector command → no output
- [ ] `grep -n "agent-panel-form\|agent-toolbar-button\|agent-streaming\|agent-panel-prompts\|open-button-secondary" src/renderer/src/styles.css` → no output
- [ ] Orphan-className script → no output
- [ ] status table in this file updated

### STOP conditions

- Drift. · A duplicated pair's blocks are separated by a media query or a `:has()`-scoped parent that makes both reachable — it is not a duplicate; leave it and note it. · Merging changes a rendered value you cannot explain (screenshot diff) — stop.

### Maintenance notes

- `lint:css` in CI is the guard; do not disable `no-duplicate-selectors` to get a PR through.

---

## Plan 018: Route durations, type sizes, icon sizes, icon buttons and z-index through tokens

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/styles.css src/renderer/src/viewerCss.ts src/renderer/src/collapsedSeparator.ts src/renderer/src/splitDiffResize.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW · **Depends on**: Plan 017 · **Category**: tech-debt (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

The token set in `:root` (styles.css:1-100) is lean and mostly honoured — radii (135 `var()` uses), weights (95), easing (114) are healthy. Three families are routinely bypassed and two do not exist: **durations** — 3 tokens (:87-89), 12 `var()` uses vs **150 raw `ms` literals across 14 values** (80/100/110/120/125/130/140/150/160/180/200/220/300/320), so two panels opening from the same click land 40–60 ms apart and chevrons rotate at four different speeds; **type** — the most-used size in the file is **9 px (19×) and it has no token**, nor do 17/20/24 px, and 32 `font:` shorthands silently reset weight/variant so `tabular-nums` is restated 14×; **icon size** — 11 distinct svg sizes, no token; **icon-only buttons** — 8 sizes and 6 radii for one concept (30/30/30/30/24/24/24/24×28/28-circle/16); **z-index** — 25 raw values 0–110 with no ladder. This is the "everything slightly off" layer under the visible bugs.

### Current state

Duration examples: panel enter 180 ms (`.git-panel` :1391, `.agent-dock` :1708, `.settings-page` :1064) vs popover 160 (:351) / 130 (`.search-popover` :1273) / 120 (`.find-bar` :774) vs card 140 (`.review-card` :918) / 150 (`.back-to-top` :790) vs toast 180 (:2065); chevrons 220 (:1935, :1985) / 160 (:1942, :1957) / 140 (`[data-collapse-chevron]` :723). Tokens: `--duration-fast: 100ms; --duration-base: 160ms; --duration-slow: 220ms;` with a comment (:90-92) explaining the easing choice for "the 220-320ms the drawers and chevrons run at".

Type: `--text-2xs: 10px … --text-lg: 14px` (:74-78); 9 px via `font: 9px var(--font-mono)` at `.comparison-label` :687, `.review-summary-line code` :858, `.branch-list small` :1495, `.terminal-context` :1574, `.performance-group dd` :450, `.agent-usage-grid dd` :1963, `.pr-inbox-heading > span` :1456, and `font-size: 9px` at `.selection-actions kbd` :1823; 17 px :373, :1592; 20 px :382; 24 px :1092; literal `14px` at :1020, :1101, :1405.

Icon buttons: `.icon-button` 30×30 `--corner-control` (:293); `.sidebar-heading-actions button` `var(--control-height)` (:570); `.terminal-actions button` (:1576); `.git-panel-header button` (:1407); `.agent-dock-header-actions button` 24×24 `--corner-compact` (:1719); `.commit-row > button` 24 + border (:1475); `.find-bar button` 24 / `calc(var(--corner-control) - 3px)` (:782); `.world-close` 24×28 (:526); `button[data-review-collapse-button]` 28×28 `border-radius: 50%` (:706-713); `.agent-attachment button` 16 (:1794). Existing size tokens: `--control-height-sm: 24px; --control-height: 30px; --control-height-lg: 36px` (:71-73).

z-index raw values present: 0,1,2,4,5,8,18,18,20,21,24,50,60,60,70,70,90,90,90,100,110.

### Commands

`bun run lint && bun run lint:css && bun run typecheck && bun test && npx -y react-doctor@latest --verbose && npx -y react-doctor@latest design --verbose`.

### Scope

**In**: `styles.css`; shadow CSS modules `viewerCss.ts`, `collapsedSeparator.ts`, `splitDiffResize.ts` (their ~20 px literals — only where a token clearly applies). **Out**: colours (already tokenised), radii/weights/easing (healthy), spacing scale (33 distinct paddings — too broad; plan 016 fixed the gutters that matter; leave the rest), any behaviour.

### Steps

1. **Durations**: add `--duration-instant: 80ms; --duration-panel: 180ms;` and snap the 14 values onto {80, 100, 160, 180, 220}: 110/120/125/130/140/150 → `--duration-fast` or `--duration-base` (≤130 → fast, ≥140 → base), 200 → base, 300/320 → slow. All chevrons → `--duration-fast`. Then replace every raw `ms` literal in `styles.css` with the token. Verify: `grep -cE "[0-9]+ms" src/renderer/src/styles.css` → only inside `@keyframes` timing or `animation:` shorthand where a token cannot be used (list them); `grep -c "var(--duration-" src/renderer/src/styles.css` ≥ 150.
2. **Type**: add `--text-3xs: 9px; --text-xl: 17px; --text-2xl: 20px; --text-3xl: 24px;`. Replace every `font: <size> <family>` shorthand with `font-family` + `font-size` pairs (so weight/variant stop being reset), then delete the now-redundant `font-variant-numeric: tabular-nums` restatements only where the parent already sets it, and delete `.settings-preview b { font-weight: 400 }` (:1218) if it was only undoing a shorthand reset. Verify: `grep -nE "font: [0-9]+px" src/renderer/src/styles.css` → no output; `grep -nE "font-size: (9|14|17|20|24)px" src/renderer/src/styles.css` → no output.
3. **Icons + icon buttons**: add `--icon-sm: 12px; --icon-md: 14px; --icon-lg: 16px;` and a single recipe `.icon-button { width: var(--control-height); height: var(--control-height); display: grid; place-items: center; border: 0; border-radius: var(--corner-control); padding: 0; background: transparent; color: var(--muted); cursor: pointer; } .icon-button.sm { width: var(--control-height-sm); height: var(--control-height-sm); border-radius: var(--corner-compact); } .icon-button:hover:not(:disabled) { background: var(--control-fill-hover); color: var(--text); }`. Apply `icon-button` / `icon-button sm` to the ten sites listed above (JSX className additions are allowed for this step — list the files touched) and delete their bespoke size/radius rules. Snap svg sizes 9/10/11 → `--icon-sm`? No: 11 px is the dominant small glyph (21 uses) — set `--icon-sm: 11px`, `--icon-md: 13px` (12 uses), `--icon-lg: 16px`, and map 12→sm-or-md by context, 14/15→md, 17/20/22 stay literal (3 sites; note them). Verify: `grep -cE "width: (9|10|11|12|13|14|15|16)px; height" src/renderer/src/styles.css` → 0.
4. **z-index ladder**: `--z-raised: 1; --z-sticky: 10; --z-chrome: 20; --z-popover: 50; --z-overlay: 70; --z-modal: 90; --z-toast: 110;` with a comment naming what lives at each level; map the 25 raw values (0–8 → raised/sticky, 18–24 → chrome, 50 → popover, 60–70 → overlay, 90–100 → modal, 110 → toast). Verify: `grep -nE "z-index: [0-9]+" src/renderer/src/styles.css` → no output; dev — open search popover over the tab strip, a toast over the confirm dialog, the agent dock over the terminal: stacking unchanged.
5. **Shadow CSS**: in `collapsedSeparator.ts` / `splitDiffResize.ts` replace radius/duration literals with the tokens (they cross the shadow boundary — `viewerCss.ts:47-48`); leave geometry (widths of the divider) alone. Verify: `grep -nE "[0-9]+ms|border-radius: [0-9]+px" src/renderer/src/collapsedSeparator.ts src/renderer/src/splitDiffResize.ts src/renderer/src/viewerCss.ts` → no output.

### Done criteria

- [ ] lint/lint:css/typecheck/test exit 0; react-doctor full + design clean
- [ ] Grep criteria from Steps 1–5 all satisfied
- [ ] `:root` has `--duration-instant`, `--duration-panel`, `--text-3xs`, `--icon-sm`, `--z-toast`
- [ ] Side-by-side screenshots (before/after) of: PR review with bars, agent dock, settings, world strip — no unintended visual change other than harmonised motion timing
- [ ] status table in this file updated

### STOP conditions

- Drift. · Plan 017 not DONE (duplicates would get tokens twice). · A duration snap changes a *choreographed* sequence (e.g. an exit that must finish before a remount — `SettingsPage.tsx` `SETTINGS_EXIT_MS`) — check JS constants that mirror CSS durations (`grep -rn "_MS = " src/renderer/src/*.tsx`) and keep them equal.

### Maintenance notes

- New CSS may not contain a raw `ms`, `font:` shorthand, `z-index: <number>`, or icon `width/height` literal; `lint:css` can enforce some of this with `declaration-property-value-disallowed-list`.

---

## Plan 019: Disabled controls stop reacting to hover, truncation works everywhere, one scrollbar, optically centred badges and tabs

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/styles.css src/renderer/src/ReviewCheckpointBar.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: MED · **Depends on**: Plan 018 · **Category**: tech-debt (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Four state/alignment families where the repo has the right pattern in some places and the wrong one in others. (a) 74 `:hover` rules, 52 without `:not(:disabled)` — a disabled **Approve** lightens under the cursor (`.pr-review-bar button:hover` :664 vs `:disabled` :665) while `.review-checkpoint-bar button:hover:not(:disabled)` (:678) two pixels away does it right. (b) 42 ellipsis incantations, six of which cannot fire because the flex child lacks `min-width: 0` — long paths push the remove button out of the attachment chip. (c) The terminal has a themed scrollbar (:1582-1585); the other 14 scroll containers show the platform one, and `scrollbar-gutter` flips `stable` ↔ `auto` between diff and editor so the code column shifts by a scrollbar width. (d) PR-row pills sag (`align-items: baseline` with a bordered box, :1444-1447), the tab close button sits 0.5 px high (`top: 4px` in a 37 px tab, :526), and the world strip's five children have four different heights under `align-items: end` (:482).

### Current state

Hover without guard (examples; full list via `grep -nE ":hover \{|:hover," src/renderer/src/styles.css | grep -v "not(:disabled)"`): `.pr-review-bar button:hover` :664 (`:disabled` at :665), `.review-card button:hover` :924 (:927), `.pr-row-actions button:hover` :1462 (:1464), `.icon-button:hover` :294 (:297), `.git-panel-header button:hover` :1408 (:1409), `.confirm-dialog-actions button:hover` :1372. Correct exemplars: :678, :783, :1414, :1501.

Missing `min-width: 0`: `.agent-attachment code` :1793 (inside `inline-flex` `.agent-attachment` :1792; remove button is `flex: none` :1794), `.theme-card-label strong` :1130, `.performance-popover-header small` :359, `.performance-chart-reading span` :383, `.performance-group dt` :449, `.agent-usage-grid dt` :1962; `.remote-list > article > svg` :1509 lacks `flex: none` (siblings :871, :1366, :1923, :1997 have it).

Scrollbars: terminal only (:1582-1585: `scrollbar-color`, `scrollbar-width: thin`, 10 px `::-webkit-scrollbar` with `--corner-compact` thumb). Raw: `.diff-scroll` :695, `.multi-file-code-view` :789, `.agent-dock-transcript` :1723, `.review-summary ol` :854, `.search-results-list` :1277, `.command-palette-results` :1325, `.git-panel-content` :1427, `.settings-scroll` :1096, `.performance-popover-body` :364, `.since-notice ul` :876, `.editor-shortcuts-sheet dl` :1039, `.agent-activity-item pre` :1747, `.welcome` :1225, `.since-empty-state` :869. `scrollbar-gutter: stable` on `.diff-scroll`, `.multi-file-code-view`, `.agent-dock-transcript`; `auto` on `.editor-scroll` :1021.

Alignment: `.pr-row-title { display: flex; align-items: baseline; gap: 7px; }` :1444; `strong … line-height: 1.35` :1446; `em` pill `padding: 1px 5px` no `line-height` :1447. `.world-close { width: 24px; height: 28px; … top: 4px }` :526 inside `.world-tab { height: 37px }` :493; `.world-tab > button[role="tab"] { height: 36px; … border-radius: 11px 11px 0 0; padding: 0 31px 0 12px }` :502-511 inside a 37 px `align-items: stretch` parent with `border-radius: 12px 12px 0 0`. World strip children: brand 37 (:490), tabs 37 (:493), overflow 37 (:532) with 34 summary (:533), new-tab 34 + `margin-bottom: 2px` (:549), shortcuts 36 (:551), parent `align-items: end` (:482). Icon nudges `margin-top: 1px` :871, :1366, :1923, :1997; `2px` :1509.

`ReviewCheckpointBar.tsx:38` — a disabled button relies on `title` for its explanation, so `pointer-events: none` on disabled buttons is **not** an option.

### Commands

`bun run lint && bun run lint:css && bun run typecheck && bun test && npx -y react-doctor@latest --verbose && npx -y react-doctor@latest design --verbose`.

### Scope

**In**: `styles.css`. **Out**: JSX (no markup changes; if a fix needs one, note it and skip), `TREE_STYLES`, viewer shadow CSS, `pointer-events` on disabled controls (tooltips depend on hover).

### Steps

1. **Hover guard**: append `:not(:disabled)` to every `button…:hover` selector that lacks it (only selectors whose subject is a `button` or has a `:disabled` sibling rule — links and rows are not disable-able). Verify: `grep -nE "button[^{,]*:hover( |\{|,)" src/renderer/src/styles.css | grep -vc "not(:disabled)"` → `0`; dev — hover a disabled Approve: no change.
2. **Truncation**: add `min-width: 0` to the six rules; `flex: none` to `.remote-list > article > svg`. Add a utility `.truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` and — CSS only — leave adoption for later (no JSX in scope). Verify: dev — attach a 120-char path to the agent: the chip ellipsises and the × stays inside.
3. **Scrollbars**: promote the terminal's `::-webkit-scrollbar` block + `scrollbar-color`/`scrollbar-width` to a selector list covering all 15 containers (or a `.scroll-surface` class applied via existing selectors — CSS only, so use the selector list). Set `scrollbar-gutter: stable` on `.editor-scroll` too. Keep `scrollbar-width: thin` off `.diff-scroll`/`.multi-file-code-view` if the thumb becomes hard to grab — test it. Verify: switch between diff and editor view on the same file: the code column's x-position does not change.
4. **Optical alignment**: `.pr-row-title { align-items: center }` and give `.pr-row-title em { line-height: 14px }` (pill height = 14 + 2 + 2 = 18 px, centred against the 13 px × 1.35 ≈ 17.5 px title line); `--tab-height: 37px` and derive `.world-close { top: calc((var(--tab-height) - 28px) / 2) }` (= 4.5 px); make the strip's children one height — `.world-overflow summary, .world-new, .world-shortcuts { height: var(--tab-height) }`, drop `margin-bottom: 2px` on `.world-new`; use `--corner-surface`/`--corner-card` for the tab's 12/11 px concentric pair (12 = `--corner-card` + 1; nearest token pair is `--corner-surface: 13px` outer / `--corner-card: 11px` inner — pick the pair, note it). Replace the five `margin-top: 1px/2px` icon nudges with one `.icon-leading { margin-block-start: 0.1em }`? That needs JSX — instead keep them but express as `margin-block-start: 1px` consistently (the 2 px at :1509 becomes 1 px after `flex: none` fixes its squash). Verify: screenshot the PR list and tab strip at 2× zoom — pill vertically centred on the title; close button centred in the tab; strip children share a top edge.

### Done criteria

- [ ] lint/lint:css/typecheck/test exit 0; react-doctor full + design clean
- [ ] Hover-guard grep → 0
- [ ] `grep -c "::-webkit-scrollbar" src/renderer/src/styles.css` → 1 block (selector list) or ≤ 3
- [ ] `grep -n "scrollbar-gutter: auto" src/renderer/src/styles.css` → no output
- [ ] `grep -n "align-items: baseline" src/renderer/src/styles.css` → not on `.pr-row-title`
- [ ] status table in this file updated

### STOP conditions

- Drift. · A hover rule's subject is not a `button` and has no `:disabled` counterpart (leave it). · Themed scrollbars on the code viewers make the thumb < 8 px wide (unusable) — keep the platform scrollbar there and note it. · The pill centring needs a markup change — note and skip.

### Maintenance notes

- Every `button:hover` gets `:not(:disabled)`; `lint:css` `selector-disallowed-list` can enforce `/button[^:]*:hover(?!:not)/`.
- Truncating text inside flex must have `min-width: 0` on the *same* element.

---

## Plan 020: Render every GitHub-authored body through the same sanitised markdown pipeline

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/RemoteReviewThreads.tsx src/renderer/src/PullRequestContext.tsx src/renderer/src/GitHubMarkdownContent.tsx src/renderer/src/MarkdownContent.tsx src/renderer/src/markdown.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P3 · **Effort**: M · **Risk**: MED · **Depends on**: none · **Category**: tech-debt (UI consistency)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Two markdown implementations render GitHub content five pixels apart. The PR description and submitted review bodies go through `react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-sanitize` (`GitHubMarkdownContent.tsx:2-5`, used by `PullRequestContext.tsx:5,23,56`); review-thread comments go through the hand-written streaming parser `parseMarkdown` (`RemoteReviewThreads.tsx:5,23`), which by design supports only headings, paragraphs, flat lists, quotes and fenced code (`markdown.ts:7-12`, confirmed by IDEAS.md). So a table, task list or autolink renders in the PR description and not in the comment below it. The hand parser is the *right* tool for the streaming agent answer (its incremental settled-boundary parse is the point); it is the wrong tool for finished GitHub HTML. Keep both, but give all GitHub-authored bodies the sanitised renderer.

### Current state

```tsx
// src/renderer/src/RemoteReviewThreads.tsx:5, 23 (abridged)
import { parseMarkdown } from './markdown'
...
const blocks = parseMarkdown(comment.body)   // hand parser → text nodes only
// src/renderer/src/PullRequestContext.tsx:5, 23, 56
import { GitHubMarkdownContent } from './GitHubMarkdownContent'
...
<GitHubMarkdownContent source={pullRequest.body} />
// src/renderer/src/GitHubMarkdownContent.tsx:2-5
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
```

`MultiFileReview.tsx:75` imports `PullRequestContext` statically, so the unified pipeline already lives in the (lazy) `MultiFileReview` chunk — moving thread rendering onto it adds no bundle weight. `rehype-raw` + `rehype-sanitize` is the security boundary for GitHub-authored HTML; the hand parser emits text nodes only, so **neither direction may lose sanitisation**.

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` (100); focused `bun test src/renderer/src/markdown.test.ts src/renderer/src/PullRequestContext.dom.test.tsx`.

### Scope

**In**: `RemoteReviewThreads.tsx`, `GitHubMarkdownContent.tsx` (props for a compact variant), `styles.css` (comment-body typography), a new `RemoteReviewThreads.dom.test.tsx`. **Out**: `markdown.ts` / `MarkdownContent.tsx` (agent streaming path — do not touch), `ReviewComments.tsx` local drafts (author-typed, plain text is fine), the `rehype-sanitize` schema (keep the default; tightening/loosening is a security review).

### Steps

1. **Compact variant**: add a `variant?: 'document' | 'comment'` prop to `GitHubMarkdownContent` that sets a wrapper class (`.gh-markdown.comment`) — CSS only; same pipeline, same sanitiser. Verify: `bun test src/renderer/src/PullRequestContext.dom.test.tsx` → pass.
2. **Switch threads**: in `RemoteReviewThreads.tsx` replace `parseMarkdown(comment.body)` + block rendering with `<GitHubMarkdownContent source={comment.body} variant="comment" />`. Remove the now-unused `parseMarkdown` import. Verify: `grep -n "parseMarkdown" src/renderer/src/RemoteReviewThreads.tsx` → no output.
3. **Typography**: in `styles.css`, style `.gh-markdown.comment` to match the previous comment body (font-size `--text-xs`, line-height 1.5, tight paragraph margins, `code` in `--font-mono`) so the change is additive (tables/task lists/links appear) not a restyle. Verify: side-by-side screenshot of a thread with plain paragraphs before/after — identical metrics.
4. **Test**: `RemoteReviewThreads.dom.test.tsx` — a comment body containing `| a | b |` table syntax renders a `<table>`; a body containing `<script>alert(1)</script>` renders no `<script>` element (sanitiser active); a body with a bare URL renders an `<a>`. Model after `PullRequestReviewBar.dom.test.tsx`.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor 100
- [ ] `grep -rn "parseMarkdown" src/renderer/src --include=*.tsx` → only `MarkdownContent.tsx` (agent path)
- [ ] New dom test passes including the `<script>` negative case
- [ ] status table in this file updated

### STOP conditions

- Drift. · `GitHubMarkdownContent` renders links that open in-app rather than via the shell `openExternal` bridge — check how `PullRequestContext` handles anchors first; if links are unhandled, that is a pre-existing gap to report, not to solve here.

### Maintenance notes

- Rule: GitHub-authored → `GitHubMarkdownContent`; agent-streamed → `MarkdownContent`; user-typed plain drafts → text.

---

## Plan 021: Put per-review localStorage under a budget with LRU pruning, and tell the user when a write is dropped

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/viewedFileStorage.ts src/renderer/src/reviewThreadStorage.ts src/renderer/src/reviewCheckpoints.ts src/renderer/src/editor/draftStore.ts src/renderer/src/useReviewSession.ts src/renderer/src/toast.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW · **Depends on**: Plan 006 (debounced writes) · **Category**: bug + perf (memory)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Four key families grow without bound and are never swept: viewed files (`better-code-diff:viewed-files:<root>:<review>`, cap 256 KB each), review threads (512 KB each), checkpoints (2 MB each), and drafts (`horus:drafts:v1:<root>`, whose own caps allow 24 × 512 000 B ≈ 12.2 MB — already above Chromium's ~5 MB per-origin quota). The only `removeItem` calls are the empty-value cases. Once quota is hit, every `setItem` throws into a silent `catch` (`viewedFileStorage.ts:47`, `reviewThreadStorage.ts:93`, `draftStore.ts:106`), and the over-cap early `return`s are equally silent — so **viewed state, comments and drafts silently stop persisting**, which the user discovers as "my comments vanished on reload". `saveReviewCheckpoint` already returns a boolean (`reviewCheckpoints.ts:112-121`); the other savers should too.

### Current state

```ts
// src/renderer/src/viewedFileStorage.ts:5-6, 38-50
const STORAGE_PREFIX = 'better-code-diff:viewed-files:'
const MAX_SERIALIZED_BYTES = 256 * 1024
export function saveStoredViewedFiles(key: string, signatures: Readonly<ViewedFileSignatures>): void {
  try {
    if (Object.keys(signatures).length === 0) { localStorage.removeItem(key); return }
    const serialized = JSON.stringify(signatures)
    if (serialized.length > MAX_SERIALIZED_BYTES) return          // silent
    localStorage.setItem(key, serialized)
  } catch { /* Persistence is best effort */ }                       // silent
}
// src/renderer/src/reviewThreadStorage.ts:84-96 — identical shape, 512 KB cap
// src/renderer/src/editor/draftStore.ts:15-16
const MAX_PERSISTED_DRAFT_BYTES = 512_000
const MAX_PERSISTED_DRAFTS = 24
// src/renderer/src/reviewCheckpoints.ts:112-121 — the exemplar: returns boolean
export function saveReviewCheckpoint(root: string, checkpoint: ReviewCheckpoint): boolean { ... return false }
```

Note `serialized.length` is UTF-16 code units, not bytes — the constants' names overstate them by up to 2×. `toast.ts` exposes a toast API (used by `useFileEditing.ts:406-409` with an action button).

### Commands

`bun run lint && bun run typecheck && bun test`; focused `bun test src/renderer/src/viewedFileStorage.test.ts src/renderer/src/reviewThreadStorage.test.ts src/renderer/src/reviewCheckpoints.test.ts src/renderer/src/editor/draftStore.test.ts`.

### Scope

**In**: the four storage modules (+ tests), a new `src/renderer/src/storageBudget.ts` (+ test), `useReviewSession.ts` (surface the boolean), `useFileEditing.ts` (surface the boolean for drafts), `toast.ts` only if a new toast kind is needed. **Out**: preferences/recent-folders (tiny), the key naming schemes (keep prefixes so existing data stays readable).

### Steps

1. **Manifest**: `storageBudget.ts` keeps `horus:storage-index:v1` = `{ [key]: { bytes, touchedAt } }`. `touch(key, bytes)` on every successful write; `forget(key)` on remove; `enforce(totalBudget = 3 * 1024 * 1024)` evicts least-recently-touched keys (and the entries themselves) until under budget — never evicting the key being written. Pure functions over an injected `Storage` so tests use a Map. Verify: `storageBudget.test.ts` — eviction order, self-preservation, corrupt manifest → rebuilt from a prefix scan.
2. **Return booleans**: change `saveStoredViewedFiles` and `saveStoredReviewThreads` to return `boolean` (false on over-cap or throw) — same signature as `saveReviewCheckpoint`; call `enforce()` before `setItem` and retry once after eviction on `QuotaExceededError`. Rename the caps to `MAX_SERIALIZED_UTF16_UNITS` or measure bytes with `new Blob([serialized]).size` — pick one, apply to all four modules. Verify: existing tests pass; new tests: over-cap → `false`; quota throw → eviction → retry succeeds.
3. **Drafts total cap**: in `draftStore.ts`, add `MAX_PERSISTED_DRAFTS_TOTAL_BYTES = 2 * 1024 * 1024` enforced in `serializeDrafts` (drop the oldest drafts first; they stay in memory for the session, as the existing comment promises). Verify: test — 10 × 400 KB drafts persist ≤ 2 MB.
4. **Feedback**: in `useReviewSession.ts` and `useFileEditing.ts`, when a saver returns `false`, show one toast per session per kind: "Review comments could not be saved locally (storage full)". Rate-limit with a module-level `Set` of shown kinds. Verify: dev — fill storage via DevTools (`localStorage.setItem('x', 'a'.repeat(4_000_000))`), add a comment → toast appears once.

### Done criteria

- [ ] lint/typecheck/test exit 0
- [ ] `grep -n "): void" src/renderer/src/viewedFileStorage.ts src/renderer/src/reviewThreadStorage.ts` shows no saver returning `void`
- [ ] `grep -n "storage-index" src/renderer/src/storageBudget.ts` → one match
- [ ] Storage-full toast reproduces once
- [ ] status table in this file updated

### STOP conditions

- Drift. · `toast.ts` cannot be called from a hook without a DOM host mounted (check how `useFileEditing` does it) — follow that path exactly.

### Maintenance notes

- Any new `localStorage` key family must register with `storageBudget` and return a boolean from its saver.

---

## Plan 022: Make the memory tooling trustworthy before optimising against it

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- scripts/benchmark-memory.sh src/preload/index.ts react-doctor-baseline.json`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1 (prerequisite for verifying 003/004/008) · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: dx
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Plans 003, 004 and 008 claim memory wins. The two instruments that would verify them are both wrong today: `scripts/benchmark-memory.sh` finds the app by `pgrep -x 'Horus'` (the dev binary is `Electron`, so it exits "Horus is not running" against `bun run dev`) and matches only direct children (`$1 == root || $2 == root`), missing reparented utility processes; and the Performance HUD's "DOM nodes" diagnostic uses `getElementsByTagName('*')`, which does not descend into shadow roots — every diff file renders inside one, so the metric reads flat exactly when the viewer is heaviest. A tracked `react-doctor-baseline.json` (12.7 KB, `version 0.9.12`, an absolute home-directory path) is referenced by nothing.

### Current state

```bash
## scripts/benchmark-memory.sh:7, 18
root_pid="$(pgrep -x 'Horus' | head -n 1 || true)"
...
$1 == root || $2 == root {
```

```ts
// src/preload/index.ts:115-118
metrics.detail = {
  ...mainMetrics.detail,
  rendererHeapUsedMegabytes: heap.usedHeapSize / 1_024,
  rendererHeapTotalMegabytes: heap.totalHeapSize / 1_024,
  rendererDomNodes: rendererDocument?.getElementsByTagName('*').length ?? 0
}
```

`git ls-files react-doctor-baseline.json` → tracked; `grep -rn react-doctor-baseline .github package.json src` → no references.

### Commands

`bash scripts/benchmark-memory.sh smoke` with the dev app running → CSV rows for every Horus/Electron process; `bun run lint && bun run typecheck && bun test`.

### Scope

**In**: `scripts/benchmark-memory.sh`, `src/preload/index.ts` (the one metric), `react-doctor-baseline.json` (delete), `.gitignore`. **Out**: the HUD UI, main-process metrics.

### Steps

1. **Script**: accept `HORUS_PROCESS_NAME` (default regex `^(Horus|Electron)$`) and use `pgrep -x -f`-compatible matching; walk descendants transitively (build a `ppid → pids` map from `ps -axo pid=,ppid=` and BFS from the root) instead of one level. Print a header line naming the root pid and process name. Verify: with `bun run dev` running, the script lists ≥ 4 processes (main, GPU, renderer, utility/network) and their RSS.
2. **DOM count that sees shadow roots**: replace the `getElementsByTagName` count with a bounded recursive walk — `countNodes(root: Node): number` that iterates `root.querySelectorAll('*')`, adds each element's `shadowRoot` subtree recursively, and stops at 500 000 to keep the sample cheap; call it only when the HUD popover is open (`detailed === true` path), since the walk itself costs. Verify: open a large PR, open the HUD → DOM nodes climb into the thousands while scrolling; close the PR → drops.
3. **Baseline file**: `git rm react-doctor-baseline.json`; add `react-doctor-baseline.json` to `.gitignore` under "Build output and caches". If the team wants a baseline gate later, generate it in CI, not from a laptop path. Verify: `git ls-files react-doctor-baseline.json` → empty.
4. **Record a baseline**: with the fixed script, open (a) one working tree, (b) one 300-file PR, (c) three PR tabs; save the three CSVs under `plans/perf-baselines/2026-08-30-*.csv` (small, committed) so later plans have a before number. Verify: three files exist.

### Done criteria

- [ ] `bash scripts/benchmark-memory.sh smoke` works against the dev build and lists grandchildren
- [ ] `grep -n "getElementsByTagName('\*')" src/preload/index.ts` → no output
- [ ] `git ls-files react-doctor-baseline.json` → empty
- [ ] `plans/perf-baselines/` has three CSVs
- [ ] status table in this file updated

### STOP conditions

- Drift. · `ps` on this macOS lacks the `-o ppid=` form (it does not — but if the script errors, report the exact message).

### Maintenance notes

- Every memory-related plan's Done criteria should cite a `perf-baselines/` before/after pair.

---

## Plan 023: CI cache, pinned React Doctor, `tsc -b`, and repo-root cleanup

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- .github/workflows/ci.yml package.json tsconfig.json tsconfig.node.json tsconfig.web.json .gitignore`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: dx
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

CI re-downloads every dependency including the ~100 MB Electron binary on every run (no cache step), and gates on `npx -y react-doctor@latest --blocking warning` — an unpinned tool where a new warning-level rule turns `main` red with zero repo changes. Local `bun run typecheck` runs two full `tsc -p` passes although both projects are `composite` with `references` wired in `tsconfig.json`; `.tsbuild/web/` is empty, so the web half never produces incremental state. An 11 KB agent-session transcript sits tracked at the repo root next to `README.md`.

### Current state

```yaml
## .github/workflows/ci.yml (steps)
- uses: oven-sh/setup-bun@v2   # no actions/cache
- run: bun install --frozen-lockfile
- run: bun run lint
- run: bun run typecheck
- run: bun test
- run: bun run build
- run: npx -y react-doctor@latest --verbose --blocking warning
```

```json
// package.json
"typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
// tsconfig.json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
// tsconfig.node.json:3,12 / tsconfig.web.json:3,14 — "composite": true, outDir ".tsbuild/node" / ".tsbuild/web"
```

`git ls-files | grep this-session` → `2026-08-25-221140-this-session-is-being-continued-from-a-previous-c.txt`. `.gitignore` already ignores `.tsbuild/`.

Real-clock sleeps in tests (`repositoryWatcher.test.ts:127-160,221`; `terminalService.test.ts:119,161,176`; `agentService.test.ts:45`; `codexAppServer.test.ts:42`) are a flake risk on `ubuntu-latest`, but the watcher tests document why they retry (FSEvents can drop early writes) — **investigate, don't rewrite** in this plan.

### Commands

`bun run typecheck` (twice; second run should be visibly faster); `bun test`; push a branch to see CI (only if the operator permits).

### Scope

**In**: `.github/workflows/ci.yml`, `package.json` scripts, the stray `.txt`, `.gitignore`. **Out**: test bodies (record timing only), tsconfig `include` lists.

### Steps

1. **Cache**: add `actions/cache@v4` keyed on `hashFiles('bun.lock')` for `~/.bun/install/cache` and `~/.cache/electron` (Electron's download cache dir on Linux). Verify: second CI run shows the cache hit in the log (or, locally, `bun install --frozen-lockfile` twice — second is seconds).
2. **Pin React Doctor**: replace `react-doctor@latest` with the exact version currently reported by `npx -y react-doctor@latest --version` (record it), and add a monthly `schedule:` job (or a Renovate rule) that runs `@latest` non-blocking so bumps are deliberate. Keep `--blocking warning` on the pinned run. Verify: `grep -n "react-doctor@" .github/workflows/ci.yml` → pinned version.
3. **`tsc -b`**: `"typecheck": "tsc -b tsconfig.json"`. Both projects emit into `.tsbuild/` (ignored). Verify: `bun run typecheck` → exit 0; `ls .tsbuild/web` → a `.tsbuildinfo` now exists; a second run completes noticeably faster (record both timings with `time`).
4. **Cleanup**: `git rm 2026-08-25-221140-this-session-is-being-continued-from-a-previous-c.txt` (read it first — if it contains anything environment-specific worth keeping, move it under `docs/` instead); add `*-this-session-is-being-continued-*.txt` to `.gitignore`. Verify: `git ls-files | grep -c this-session` → 0.
5. **Test timing record**: run `bun test --reporter=junit` or time the suite; list tests over 1 s in the report. No code change.

### Done criteria

- [ ] CI workflow has a cache step and a pinned `react-doctor@<version>`
- [ ] `bun run typecheck` uses `tsc -b`; `.tsbuild/web/*.tsbuildinfo` exists after one run
- [ ] Stray transcript removed and pattern ignored
- [ ] status table in this file updated

### STOP conditions

- Drift. · `tsc -b` reports project-reference errors (e.g. `src/shared` included in both projects conflicts under `composite`) — report the exact error; do not restructure tsconfigs.

### Maintenance notes

- Bump the React Doctor pin deliberately when the scheduled run is green.

---

## Plan 024: Keep the review workspace mounted across tab switches (design + implementation)

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/App.tsx src/renderer/src/RepositoryWorkspace.tsx src/renderer/src/MultiFileReview.tsx src/renderer/src/useReviewWorlds.ts src/renderer/src/useReviewLoadState.ts src/renderer/src/useReviewSession.ts`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: L · **Risk**: MED · **Depends on**: Plan 002, 003, 004 · **Category**: perf (architecture)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

> **Update 2026-08-30 00:50** — The world key now lives on `<WorkspaceRoot workspaceKey={`${root}:${worldId ?? 'desk'}`}>` (`App.tsx:364`), which forwards it to `RepositoryWorkspace key=` (`WorkspaceRoot.tsx:16`). `grok-perf-plan.md` states the constraint this plan must keep: **never key `ViewerProviders` on the world** (the worker pool and editor undo stack live there). Step 5 therefore changes `workspaceKey` to `view.snapshot.root` only and leaves `WorkspaceRoot`'s wrapper order intact. `MultiFileReview` is rendered via `useSyncExternalStore` at `RepositoryWorkspace.tsx:796-798` with `key={`${reviewIdentity}:${reviewSessionRevision}`}`. `<Activity>` (React 19.2) was considered for hidden tabs and rejected for the CodeView (multiplies viewer DOM/state, against IDEAS.md); the spike may evaluate it for light per-tab state only.

### Why this matters

IDEAS.md: "Everyday actions stay instant. No tab-switch animation, no motion on `]`." Today ⌘⇧] destroys and rebuilds the workspace: `App.tsx:364` keys `RepositoryWorkspace` on `${root}:${worldId}`, and `RepositoryWorkspace.tsx:798` keys `MultiFileReview` on `${reviewIdentity}:${reviewSessionRevision}`. Every switch tears down the `@pierre/trees` model, `useReviewLoadState` (re-parses the whole patch), `useReviewSession`/`useReviewThreads`, the collapsed/viewed sets and the `CodeView` DOM, and re-highlights every visible file through the worker pool. `ViewerProviders` was deliberately lifted *above* the key to keep the pool alive (`App.tsx:406-409`) — the cost was recognised, not eliminated. This is the largest remaining perf item and it is architectural, so it is scoped as a design spike followed by a gated implementation.

### Current state

```tsx
// src/renderer/src/App.tsx:364-367
<Suspense fallback={<WorkspaceSkeleton />}>
  <ViewerProviders theme={view.preferences.editorTheme}>
    <RepositoryWorkspace key={`${view.snapshot.root}:${gitWorkflow.activeWorld?.worldId ?? 'desk'}`}
// src/renderer/src/App.tsx:406-409
// Keyed on the repository only. Opening a pull request review keys the
// workspace below, not this: remounting here would tear down the agent
// transcript (useAgentAnswer cancels the in-flight request on unmount) and,
// with ViewerProviders inside, the worker pool and every cached edit session.
// src/renderer/src/RepositoryWorkspace.tsx:796-798
{workspaceView === 'multi' ? (
  <MultiFileReview
    key={`${reviewIdentity}:${reviewSessionRevision}`}
```

Per-world state that currently lives *inside* the keyed subtree: `useReviewLoadState` (`parsedPatchRef`, `loadState.items`), `useReviewSession` (threads, viewed — already persisted to localStorage per key), collapsed item ids, scroll position (`multiFileScrollTopRef`, also mirrored into the world via `rememberReviewScroll`), tree expansion, `pendingSelection`, draft comment. `useReviewWorlds` already stores navigation (`WorldNavigation`, `useReviewWorlds.ts:12`) and the review payload per world, and `IDEAS.md` states the rule: "Inactive tab state lives outside the viewer."

`MultiFileReview` mounts a single `CodeView` whose `items` prop drives it; `CodeView` virtualises and can accept a new items array without remounting.

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` (100); `bun run update:mac`.

### Scope

**In (spike)**: a design note `Plan 024`; **In (implementation)**: `App.tsx`, `RepositoryWorkspace.tsx`, `MultiFileReview.tsx`, `useReviewWorlds.ts`, `useReviewLoadState.ts`, `useReviewSession.ts`, their tests. **Out**: `ViewerProviders`, agent/terminal docks (already keyed on root only), the file tree's internal model beyond passing it a new input.

### Steps

#### Phase A — spike (time-box: half a day; produces a note, no product code)

1. **Inventory**: list every `useState`/`useRef` inside `RepositoryWorkspace` and `MultiFileReview` and classify it: (a) derivable from world + persisted storage (threads, viewed, checkpoint), (b) must be cached per world (parsed items, collapsed set, scroll, tree expansion, selection), (c) transient (drag state, hover). Write the table into the spike note.
2. **Measure**: with three PR tabs open, time ⌘⇧] using `performance.mark` around the world focus dispatch and the next `onPostRender` from `CodeView` (add temporary marks; remove before commit). Record p50/p95 over 20 switches. This is the number the implementation must beat.
3. **Design**: propose a `WorldViewCache` (a `Map<worldId, { items, collapsed, scrollTop, expansion, selection }>`) owned by `useReviewWorlds` (or a sibling hook above the key), bounded by the same budget machinery as plan 004 (a released world drops its cache). Decide whether `MultiFileReview` receives `items` for the active world (preferred: `CodeView` stays mounted and gets a new `items` array) or stays keyed on `reviewIdentity` only when the *root* changes. Note risks: scroll restoration timing with virtualisation, `useLayoutEffect` ordering for `restoreTargetRef`, thread re-anchor on a cache hit.

**Verify (Phase A)**: `Plan 024` exists with the inventory table, the p50/p95 numbers, and the chosen design; STOP here and get the operator's sign-off before Phase B.

#### Phase B — implementation (after sign-off)

4. Move class-(b) state into the cache keyed by `worldId`; on focus, hydrate from the cache or, on a miss, from the world's `patchPages` via the existing parser. Verify: `useReviewWorlds.test.ts` covers cache set/get/evict.
5. Change `App.tsx:364` key to `view.snapshot.root` only; change `RepositoryWorkspace.tsx:798` key to `reviewSessionRevision` only (the revision exists to force a remount on explicit reload — keep that semantic). Verify: switching tabs no longer logs `markRepositoryWorkspaceRender` from a fresh mount (count stays continuous, no reset of internal refs).
6. Restore scroll from the cache in the same `useLayoutEffect` that handles `restoreTargetRef` today; restore selection/collapsed state before the first paint. Verify: manual — three tabs, scroll each to a different file, cycle: each tab returns to its exact scroll position and collapsed state with no flash of the top of the document.
7. Re-measure Step 2. Target: p95 ≤ 50 ms for a cache hit.

### Done criteria

- [ ] Phase A note exists and was approved
- [ ] lint/typecheck/test exit 0; react-doctor 100
- [ ] `grep -n "worldId ?? 'desk'" src/renderer/src/App.tsx` → no output in the workspace key
- [ ] Tab-switch p95 (cache hit) ≤ 50 ms, recorded in the note with before/after
- [ ] Scroll/collapsed/selection restore verified for three tabs
- [ ] status table in this file updated

### STOP conditions

- Drift. · Plans 002/003/004 not DONE. · Phase A finds a class-(b) item that cannot be externalised without changing `@pierre/diffs` (e.g. `CodeView` internal scroll state not exposed) — report; do not fork the library. · Phase B: threads re-anchor visibly wrong on a cache hit — stop, keep the `reviewIdentity` key, report.

### Maintenance notes

- After this lands, "per-world state" has exactly one home: `useReviewWorlds`' registry/cache. New per-tab state goes there, not into the workspace component.

---

## Plan 025: Escape closes one thing, shortcuts respect typing, focus is restored, and tab-A errors stay in tab A

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- src/renderer/src/App.tsx src/renderer/src/keybindings.ts src/renderer/src/useTerminalVisibility.ts src/renderer/src/FindBar.tsx src/renderer/src/CommandPalette.tsx src/renderer/src/WorldStrip.tsx src/renderer/src/PullRequestReviewBar.tsx src/renderer/src/useGitWorkflow.ts src/renderer/src/ReviewComments.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED · **Depends on**: none · **Category**: bug (UI)
- **Planned at**: commit `caa1771` + working tree, 2026-08-30

### Why this matters

Nine keyboard/focus/scoping defects, each with a concrete repro: one Escape dismisses two or three surfaces (comment draft **and** git panel **and** search); `Alt+Z` toggles word wrap while typing Ω in a comment; the tab-overflow menu stays open after choosing a tab; a PR load failure in a background tab shows its error banner over the foreground tab and closes the panel the user just opened; a failed Approve hides its error message in a branch that is not rendered; ⌘F → Escape drops focus to `<body>`; the palette's active row can scroll out of view; Ctrl+J inside the terminal closes the dock instead of sending a linefeed; background tabs are unreachable by keyboard while their close buttons are not. Zero tests reference `Escape`.

### Current state

```ts
// src/renderer/src/App.tsx:142-159 — Escape branches BEFORE the defaultPrevented guard
if (event.key === 'Escape' && commandPaletteRef.current?.close()) { event.preventDefault(); return }
if (event.key === 'Escape' && settingsOpen) return
if (event.key === 'Escape' && gitWorkflow.panelOpen) { event.preventDefault(); gitWorkflow.setPanelOpen(false); return }
if (event.key === 'Escape' && search.isOpen) { event.preventDefault(); search.dismiss(); return }
if (event.defaultPrevented || event.repeat) return
...
// App.tsx:177-180 — no typing-element check
const command = commandFromEvent(event, keybindings)
if (command == null) return
event.preventDefault()
runCommand(command)
```

```ts
// src/renderer/src/keybindings.ts:58-62, 93-100, 106-109
export function isTypingElement(element: Element | null): boolean { ... }      // exists; used only by reviewCommandFromEvent
export function commandFromEvent(event: KeyboardEvent, keybindings: KeybindingMap): AppCommand | null { ... }  // never calls it
export function isTerminalToggleShortcut(event, keybindings): boolean {
  const binding = keybindingFromEvent(event)
  return binding === 'Meta+KeyJ' || binding === 'Control+KeyJ' || binding === keybindings.toggleTerminal
}
// src/renderer/src/useTerminalVisibility.ts:108-121 — capture-phase window listener + stopPropagation
if (target?.closest('.keybinding-recorder .recording') != null) return
if (!isTerminalToggleShortcut(event, keybindings)) return
event.preventDefault(); event.stopPropagation(); toggle()
...
window.addEventListener('keydown', handleShortcut, true)
```

```tsx
// src/renderer/src/WorldStrip.tsx:119-141 — bare <details>, never closed
<details className="world-overflow"> ... <button ... onClick={() => void onFocus(world.worldId)}>
```

```ts
// src/renderer/src/useGitWorkflow.ts:289, 310-311, 354 — originWorldId stored, never compared
reviewRequestsRef.current.set(requestId, { root: repositorySnapshot.root, originWorldId })
...
setSubmissionMessage(null); setPanelOpen(false)
...
if (reviewRequestsRef.current.has(requestId)) onError(getErrorMessage(error))
```

```tsx
// src/renderer/src/PullRequestReviewBar.tsx:39-48 — message only in the !expanded branch
const submit = async (event) => { if (!await onSubmit(event, body)) return; setBody(''); setExpanded(false) }
if (!expanded) { return (<div className="pr-review-bar compact"><span ...>{message ?? ...}</span> ...
```

```ts
// src/renderer/src/FindBar.tsx:25-29 — no focus restore (contrast CommandPalette.tsx:316-330 focusReturnRef)
const close = (): void => { setOpen(false); setResult(null); void window.repository?.stopFindInPage() }
```

`CommandPalette.tsx:251` `setActiveIndex` never scrolls the row into view; `:205` clamps for display only. `WorldStrip.tsx:156` `role="tablist"`, `:76` `tabIndex={active ? 0 : -1}`, no `onKeyDown`. `ReviewComments.tsx:129, 214` — Escape → `onCancel()` without `preventDefault`. Test exemplar: `PullRequestReviewBar.dom.test.tsx` (render + `fireEvent`).

### Commands

`bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` (100).

### Scope

**In**: the nine files in the drift check + new/extended dom tests. **Out**: `SettingsPage` Escape handling (already correct via `<dialog cancel>`), `useConfirm.ts`, terminal internals beyond the shortcut guard, palette ranking.

### Steps

1. **Escape precedence**: in `App.tsx`, move `if (event.defaultPrevented || event.repeat) return` to the top of the handler; add `if (event.key === 'Escape' && document.querySelector('dialog[open]') != null) return` (a modal owns Escape). In `ReviewComments.tsx:129, 214` and `FindBar.tsx:50-53`, call `event.preventDefault()` when they handle Escape. Verify: new `App.dom.test.tsx` (or extend `AppView.dom.test.tsx`) — with a comment draft open and the git panel open, one Escape closes only the draft.
2. **Typing guard**: in `keybindings.ts`, `commandFromEvent(event, keybindings, activeElement = deepActiveElement(document))` skips non-`Meta` bindings when `isTypingElement(activeElement)`; keep Meta combos (⌘O, ⌘,) working while typing. Verify: `keybindings.test.ts` — `Alt+KeyZ` with a textarea active → `null`; `Meta+KeyO` → still the command.
3. **Overflow menu closes**: control `open` on the `<details>`; close + clear `query` in the button `onClick`, on `Escape` inside the menu, and on outside `pointerdown` (document listener while open, removed on close). Verify: `WorldStrip.dom.test.tsx` — click a menu item → `details.open === false`.
4. **World-scope side effects**: in `useGitWorkflow.ts`, before `onError(...)`, `setPanelOpen(false)`, `setSubmissionMessage(null)`, compare `originWorldId` with `reviewWorlds.activeWorld?.worldId` (read via a ref to avoid stale closure); when they differ, store the error on the world (`setPatchLoadStatus(..., 'error')` already exists — add an `errorMessage` field) and skip the global banner/panel changes. Show the per-world error in the world's own view (`RepositoryWorkspace` already renders `.multi-file-error`). Verify: `useGitWorkflow.dom.test.tsx` — a rejected load for world A while B is active does not call `onError`.
5. **Review bar message**: render `message` in the expanded `<section>` too, with `role="alert"`. Verify: `PullRequestReviewBar.dom.test.tsx` — `onSubmit` resolves `false` with `message="Nope"` → text visible.
6. **Focus restore + palette scroll**: `FindBar` — save `document.activeElement` on open, restore on close (copy `CommandPalette.tsx:316-330`); `CommandPalette` — after `setActiveIndex`, `rowRefs[index]?.scrollIntoView({ block: 'nearest' })`, and clamp `activeIndex` in an effect when `results.length` shrinks. Verify: `CommandPalette.dom.test.tsx` — ArrowDown past 30 results keeps `activeIndex < results.length`.
7. **Terminal shortcut**: in `useTerminalVisibility.ts`, `if (target?.closest('.terminal-dock') != null && binding === 'Control+KeyJ') return` (linefeed belongs to the shell); feed the two reserved bindings into `findKeybindingConflicts` so rebinding to ⌘J warns. Verify: `keybindings.test.ts` — `findKeybindingConflicts({ toggleWordWrap: 'Meta+KeyJ' })` reports a conflict.
8. **Tablist keyboard**: `onKeyDown` on the tablist — ArrowLeft/Right move focus and activate (roving tabindex), Home/End; set `tabIndex={-1}` on inactive tabs' close buttons. Verify: `WorldStrip.dom.test.tsx` — ArrowRight from the active tab calls `onFocus` with the next world.

### Done criteria

- [ ] lint/typecheck/test exit 0; react-doctor 100
- [ ] `grep -n "if (event.defaultPrevented || event.repeat) return" src/renderer/src/App.tsx` → precedes every `Escape` branch
- [ ] `grep -n "isTypingElement" src/renderer/src/keybindings.ts` → used inside `commandFromEvent`
- [ ] New/extended tests: Escape precedence, typing guard, overflow close, world-scoped error, expanded message, palette clamp, conflict detection, tablist arrows — all pass
- [ ] status table in this file updated

### STOP conditions

- Drift. · Moving the `defaultPrevented` guard breaks the settings-exit choreography documented at `App.tsx:146-148` — report. · `RepositoryWorkspace` has no existing per-world error surface (grep `multi-file-error` / `loadStatus === 'error'`) — report before inventing one.

### Maintenance notes

- Every global `keydown` handler: check `defaultPrevented` first, then typing context, then act; leaf handlers `preventDefault` what they consume.
- Any async side effect that touches global UI state must compare its origin world with the active world.

---

## Plan 026: Adopt React Compiler 1.0 behind a healthcheck, with hooks lint as the safety net

> **Drift check (run first)**: `git diff --stat caa1771..HEAD -- electron.vite.config.ts package.json bun.lock src/renderer/src/RepositoryWorkspace.tsx`
> Written against commit `caa1771` **plus the uncommitted working tree of 2026-08-30 00:50**. Commit that working tree first; compare excerpts; mismatch = STOP.

### Status

- **Priority**: P2 · **Effort**: M (spike S, rollout M) · **Risk**: MED · **Depends on**: Plan 002 (Site B — the ref read in render — must be gone first; the compiler skips components that read refs during render) · **Category**: migration + perf
- **Planned at**: commit `caa1771` + working tree, 2026-08-30 00:50

### Why this matters

React 19.2.8 is current, but the codebase does not use **React Compiler 1.0**
(stable since October 2025, `babel-plugin-react-compiler@1.0.0`;
`react-doctor-baseline.json` records `hasReactCompiler: false`). Every memo
finding in this document — fresh `[]` props, an unstable hook return object, a
`join('\0')` in render, per-frame allocations in `AgentPanel` — is the class of
bug the compiler removes mechanically and permanently, without asking reviewers
to eyeball prop identities on 35–43-prop components. Adopting it turns Plan 002
from a one-off fix into a guarantee. It cannot help the main process, CSS, drag
handlers, or reducers, and it **bails out** of components that violate the
Rules of React (e.g. reading `ref.current` during render — Plan 002 Site B), so
those must be fixed first and the healthcheck must pass before the flag is
flipped. The repo also runs no hooks lint today (`bun run lint` = `oxlint src`
without `--react-plugin`), so `rules-of-hooks` / `exhaustive-deps` go in as the
compiler's safety net.

### Current state

```ts
// electron.vite.config.ts:100-104 — react() with no babel options
renderer: {
  root: resolve('src/renderer'),
  plugins: [react(), contentSecurityPolicyPlugin(), dropShikiWasmPlugin()],
```

```json
// package.json (devDependencies) — relevant pins
"@vitejs/plugin-react": "5.2.0",   // supports babel.plugins; 6.1.1 is latest
"react": "19.2.8", "react-dom": "19.2.8",
"oxlint": "1.78.0",
// scripts
"lint": "oxlint src",
```

`npm view babel-plugin-react-compiler version` → `1.0.0`. Known compiler-bailout
site in the working tree: `src/renderer/src/RepositoryWorkspace.tsx:1253`
(`initialScrollTop={multiFileScrollTopRef.current}` — fixed by Plan 002 Site B).
Other `Ref.current` reads found by grep are inside handlers/effects (allowed).
`bunfig.toml` sets `minimumReleaseAge = 604800`; `babel-plugin-react-compiler@1.0.0`
is months old, so it installs.

### Commands

| Purpose | Command | Expected |
|---|---|---|
| Healthcheck (read-only) | `npx -y react-compiler-healthcheck@latest --src src/renderer` | prints compiled/failed component counts and the failing files |
| Hooks lint | `bunx oxlint src --react-plugin` | exit 0 after Step 2 |
| Install (allowed for this plan) | `bun install` | exit 0 |
| Build | `bun run build` | exit 0 |
| Gate | `bun run lint && bun run typecheck && bun test && npx -y react-doctor@latest --verbose` | exit 0, `Score: 100 / 100` (react-doctor reports `hasReactCompiler: true`) |

### Scope

**In**: `electron.vite.config.ts`, `package.json` (`lint` script, devDependency), `bun.lock`, `.oxlintrc.json` (new), and **only** the components the healthcheck names as failing (fix the rule violation; do not add `"use no memo"` unless the STOP conditions say so). **Out**: `src/main`, any behavioural change, removing existing `useMemo`/`useCallback` (the compiler tolerates them; deleting them is a later cleanup).

### Steps

1. **Spike (S)**: run the healthcheck; record the counts and every failing file/reason in the plan report. If more than ~10 components fail for reasons other than Plan 002 Site B, STOP and report (the rollout cost is higher than estimated). Verify: numbers recorded.
2. **Hooks lint first**: add `.oxlintrc.json` enabling the `react` plugin with `react-hooks/rules-of-hooks: error` and `react-hooks/exhaustive-deps: warn`; change `lint` to `oxlint src` (config picked up) — confirm with `bunx oxlint src --react-plugin --deny-warnings` in CI only after the warnings are triaged. Fix genuine violations; suppress none without a comment. Verify: `bun run lint` exit 0.
3. **Enable the compiler**: `bun add -d babel-plugin-react-compiler@1.0.0`; in `electron.vite.config.ts` renderer plugins: `react({ babel: { plugins: [['babel-plugin-react-compiler', { target: '19' }]] } })`. Keep the worker build untouched (no React there). Verify: `bun run build` exit 0; `grep -c "_c(" out/renderer/assets/*.js | sort -t: -k2 -n | tail -3` shows compiler cache slots in the app chunks (the `_c` helper is the compiler's memo cache).
4. **Verify behaviour**: `bun test` (542+), `react-doctor` 100 with `hasReactCompiler: true`; manual: open a PR, stream an agent answer, drag the sidebar, pinch-zoom, switch tabs — no visual regressions, and the Performance HUD `workspaceRenders` count during an agent stream stays flat (this is the compiler doing Plan 002's job structurally).
5. **Measure**: with `scripts/benchmark-startup.mjs`, confirm cold-start median did not regress by more than 5 % (compiled output is slightly larger). Record before/after.

### Done criteria

- [ ] Healthcheck report recorded; zero bailouts in `RepositoryWorkspace`, `MultiFileReview`, `MultiFileViewer`, `AgentPanel`, `App`
- [ ] `.oxlintrc.json` exists; `bun run lint` exit 0 with the react plugin active
- [ ] `babel-plugin-react-compiler` in devDependencies and wired in `electron.vite.config.ts`
- [ ] `bun run build` exit 0; tests pass; react-doctor 100 and `hasReactCompiler: true`
- [ ] Startup median within 5 % of the pre-compiler baseline
- [ ] status table in this file updated

### STOP conditions

- Drift. · Plan 002 not DONE. · Healthcheck fails on `@pierre/diffs/react` wrapper components in a way that requires editing `node_modules` — report. · Any test that depends on render counts or reference identity changes meaning under the compiler — report the test, do not weaken it. · A component needs `"use no memo"` to keep working: allowed for at most two components, each with a comment naming the rule it violates and a follow-up in "Considered and rejected".

### Maintenance notes

- With the compiler on, the review rule from Plan 002 relaxes to: "do not read refs during render; do not mutate props/state; let the compiler memoise." Hand-written `useMemo`/`useCallback` can be removed opportunistically.
- Bump `babel-plugin-react-compiler` with React minors; re-run the healthcheck on each bump.
