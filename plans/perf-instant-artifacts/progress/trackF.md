# Track F progress log (P28, P31, P30)

Started 2026-09-05. Worktree: /Users/fuadnafiz98/Developer/vibes/better-code-diff
Sections in order: P28 (git spawn semaphore), P31 (shiki off boot path), P30 (CSS split + resizer).

## P28 IN PROGRESS

## P28 DONE
Files:
- src/main/gitCommands.ts: new `CommandLane` type, `MAX_CONCURRENT_COMMANDS = max(4, cpus-2)` (8 on this 10-core box),
  `MAX_BACKGROUND_COMMANDS = max(1, limit-2)` (6), `CommandSemaphore` class + module-level `commandSemaphore`.
  `runCommand` gained a 7th positional param `lane: CommandLane = 'interactive'`; it awaits
  `commandSemaphore.acquire(lane, signal)` and releases in a `finally`. The old body is now the private
  `spawnCommand()`. `GitObjectReader` deliberately still bypasses the semaphore (long-lived `cat-file --batch`
  child would hold a slot for its 60 s idle window and could deadlock reads behind it).
- src/main/repository.ts (Edit-only, 3 edits): `#git(args, signal, lane = 'interactive')`; the ignored-listing
  callback passes `'background'`; import adds `type CommandLane`.
- src/main/index.ts (Edit-only, `remotesForRoot` only): the non-open-root `git remote -v` probe passes `'background'`.
- src/main/gitCommands.test.ts: 11 new tests.

Design notes:
- Lane priority alone only orders the *queue*; a background burst that already filled every slot would still make
  the next interactive command wait for a child to exit, so two slots are reserved for the interactive lane
  (`MAX_BACKGROUND_COMMANDS`). This is beyond the literal plan text and is the part that actually bounds
  interactive latency during a 307-probe Cmd+H.
- `searchContent` spawns ripgrep with `spawn()` directly, NOT through `runCommand`, so it is not admitted by the
  semaphore (brief said "if it goes through runCommand" — it does not). It is interactive anyway, and it already
  caps `--threads`.

Tests: `bun test src/main/gitCommands.test.ts` 14 pass. Full `bun test src/main` 351 pass / 0 fail.
Gates: `bun run lint` exit 0; `bun run typecheck` exit 0;
       `bun test src/main/gitCommands.test.ts src/main/repository.test.ts src/main/ignoredListing.test.ts src/main/pullRequestRoots.test.ts` 183 pass.

needs-owner:
- repository.ts PR-review path (owner of `#loadPullRequestReview` / `#runPullRequestJsonCommand` /
  `runGitHubReadCommand`): warmup (`intent: 'warmup'`) still runs its `gh` hops on the interactive lane. Exact edit:
  thread `lane: CommandLane` from `getPullRequestReview(..., intent)` down through `#loadPullRequestReview` and
  `#runPullRequestJsonCommand` into `runGitHubReadCommand(executable, args, cwd, signal, lane)`, which passes it as
  the 7th argument of `runCommand`; `intent === 'warmup'` -> `'background'`. Outside Track F's ownership of
  repository.ts (ignored listing + searchContent only), so not made.

## P31 DONE
Verification first (as the plan asked). Evidence from the build at the start of this section:
- `vendor-shiki` (206,721 B) WAS statically imported by `vendor-diffs`, which the viewer chunks import
  statically, so its module body — @shikijs/vscode-textmate 42.5 KB, oniguruma-to-es + oniguruma-parser + regex*
  ~56 KB, @shikijs/core 18 KB, @shikijs/primitive 13.5 KB, engine-oniguruma 7 KB (minified, attributed via the
  source map) — was fetched, parsed and EVALUATED before the workspace painted. Not merely "imported": an ES
  static import is evaluated whether or not a binding is read.
- The app already highlights in a worker (`DIFF_WORKER_POOL_OPTIONS` -> `@pierre/diffs/worker/worker.js`,
  `WorkerPoolContextProvider` in editor/ViewerProviders.tsx). `FileRenderer.js:132` only builds a main-thread
  highlighter when `workerManager?.isWorkingPool() !== true` (i.e. the workers failed) or an edit session is
  attached. Nothing in src/renderer calls `preloadHighlighter`/`getSharedHighlighter`/`FileStream`.
- The four static edges that held the engine on the boot path, and what each was:
  1. `@pierre/diffs/dist/highlighter/shared_highlighter.js` -> `createHighlighter` + engines from "shiki".
  2. `@pierre/diffs/dist/editor/tokenizer.js` -> `shiki/textmate`; only reachable through `@pierre/diffs/edit`
     (lazy) but `manualChunks` folded the editor into `vendor-diffs`.
  3. `@pierre/theming/dist/modules/createTheme.js` -> `normalizeTheme` from "shiki/core".
  4. `shiki/dist/langs-bundle-full-*.mjs` (`bundledLanguages`, needed synchronously by `resolveLanguage`) was
     left unassigned and Rollup merged it into vendor-shiki, re-creating the edge.

Changes (all in electron.vite.config.ts):
- `lazyHighlighterEnginePlugin()` (renderer only): rewrites shared_highlighter.js so the engine import happens
  inside the already-async `getSharedHighlighter`. Throws with a named message if the anchors drift.
- `lazyThemeNormalizerPlugin()` (renderer only): same for `normalizeTheme` inside `normalizingLoader`'s async
  arrow in @pierre/theming createTheme.js.
- `manualChunks`: new `vendor-diffs-edit` (@pierre/diffs/dist/edit|editor), new `vendor-hast`
  (hast-util-to-html + property-information + entity tables — the HTML serializer shared by markdown, the
  highlighter and FileRenderer.renderPartialHTML), new `vendor-shiki-langs` (langs-bundle-full, named so Rollup
  cannot merge it into the engine), `@shikijs/transformers` left unassigned so it inlines next to its importer.
  A first attempt at `vendor-hast` matching `hast-util-[^/]+` created a circular chunk
  (vendor-hast -> vendor-markdown -> vendor-hast, via hast-util-raw -> parse5) and pushed the closure to
  1,818,996 B; narrowing it to hast-util-to-html + hast-util-whitespace fixed it.

Result: `vendor-shiki` (143,344 B) is imported ONLY dynamically by vendor-diffs and statically by
vendor-diffs-edit, which is itself off the pre-mount path. Pre-mount closure 1,652,620 -> 1,361,302 B
(-291,318 B, -17.6%). The diff worker chunk still bundles textmate + oniguruma-to-es eagerly (207,921 B,
only `shiki/wasm` dynamic, unchanged), so worker highlight latency is untouched.

Latency reasoning (cannot launch the app): every diff/file view highlights in the worker, whose bundle is
unchanged, so the first highlighted file is unaffected. The one path that now pays an extra chunk fetch is
attaching an editor to a file (File.js:299) or a worker-pool failure; both are already async, already behind a
painted (worker-highlighted) file, and read a warm 143 KB file:// chunk.

Files: electron.vite.config.ts, scripts/lazyHighlighter.test.mjs (new).
Tests: `bun test scripts/lazyHighlighter.test.mjs` 7 pass — asserts both vendored modules still contain the
anchor text, that each engine call site is still inside an async function, that the config still declares both
plugins, and that neither plugin is in `worker.plugins`.
Gates: `bun run lint` 0; `bun run typecheck` 0; `bun run build` ok; `bun run check:entry` 1,361,302 B.

needs-owner: none. Note for the reviewer: `scripts/check-entry-chunk.mjs` is "ratchet only" for this track, so
P31 has no named assertion there; the ratcheted byte budget is what catches a re-import of the 143 KB engine.
A one-line `vendor-shiki absent from the closure` assertion next to the existing `WorkerPool absent` check would
name the regression instead of just failing the budget.

## P30 PARTIAL (split + squircle + resizer done; boot CSS 79,773 B, target was < 60,000)

### 1. Boot stylesheet split
styles.css 203,745 -> 98,151 source bytes; built boot CSS 172,331 -> 79,773 B (-53.7%).
New per-component sheets, each imported by exactly one lazy component (one `import './X.css'` line):
  AgentPanel.css 19,267 (built) - AgentPanel.tsx
  PerformanceHud.css 16,949 - PerformanceHud.tsx
  MultiFileReview.css 14,516 - MultiFileReview.tsx
  GitHubPanel.css 13,775 - GitHubPanel.tsx
  SettingsPage.css 10,840 - SettingsPage.tsx
  TerminalDock.css 7,360 (joined the existing xterm sheet) - TerminalDock.tsx
  GitHubMarkdownRenderer.css 3,969 - GitHubMarkdownRenderer.tsx
  ReviewComments.css + PullRequestReviewBar.css + PullRequestContext.css -> BackToTopButton chunk CSS 8,293
  (those three render inside the viewer/workspace chunks)
Method: every top-level rule whose comma-separated selectors ALL have a leading compound belonging to one
surface moved; mixed rules stayed. `@media`/`@container`/`@starting-style` blocks were partitioned the same
way and the moved partition was appended to that surface's file AFTER its base rules, so an override that was
later in styles.css is still later in the surface sheet (this matters: the 3,867 B `prefers-reduced-motion`
block covers six surfaces at once).
Boot-path corrections after an audit of every moved class against the nine boot-chunk components: the pull
request loading indicator, `.review-locator`, `.editor-option-controls`, `.markdown-view-toggle` and
`.github-markdown-fallback` are painted by AppView/PullRequestLoadingIndicator/GitHubMarkdownContent before
their surface's chunk exists, so those rules were returned to styles.css in a commented section at the end.
Deliberately NOT split: the command palette (its shell is rendered from the boot chunk by CommandPaletteHost
before the module resolves — P14/P18 tuned that first frame and 3.6 KB is not worth an unstyled first open),
`.agent-dock*` (AgentDock's Suspense fallback), the folder picker, world strip, app shell, explorer and diff
container (all boot-path).
Why 60 KB was not reached: after the split the sheet is design tokens (4.3 KB), resets, cross-cutting
@media (6.5 KB), app shell/titlebar, palette shell, folder picker, world strip, explorer, diff container and
toolbar - all painted on the boot path. The only movable remainder is ~6.6 KB source of viewer-internal rules
(.diff-scroll, .find-bar, .image-diff, .editor-statusbar, .review-orphan-actions), which would land at ~74 KB,
still short. Reaching 60 KB means moving the explorer/app-shell rules that the cached first paint uses.

### 2. `corner-shape: squircle` scope
`*, *::before, *::after { box-sizing; corner-shape }` split into `*, *::before, *::after { box-sizing }` plus
`* { corner-shape: squircle }`. The nine pseudo-element rules that set a border-radius and relied on the global
declaration now declare it themselves; the three that are in the `corner-shape: round` opt-out list
(.performance-live > span::before, .performance-chart-tooltip dt::before, .file-edit-state::before) were
deliberately left alone - a later squircle declaration would have beaten the opt-out and turned true circles
into rounded squares. CSS has no "elements with a border-radius" selector, so the element half of the universal
selector stays; the pseudo-element halves are gone.

### 3. SidebarResizer
RB-12's "read layout once on pointerdown" was ALREADY implemented and tested (dragRef caches
workspaceWidth; the existing dom test asserts zero getBoundingClientRect calls during pointermove). Verified,
no change needed. The "write via transform during drag" half was NOT implemented: the sidebar width IS the grid
track, so a transform-only drag turns live resizing into a ghost divider that snaps on release - a UX
regression I cannot visually validate. Instead the two real remaining costs were removed:
  - a pointermove that rounds to the same pixel no longer writes `--sidebar-width` at all (a high-rate pointer
    delivers several moves per frame);
  - committing (drag end, keyboard step, double click) no longer measures and writes a second time: every
    commit path writes through `commitWidth` and records the painted width, and the layout effect returns early
    when the DOM already carries it.
`getBoundingClientRect` is now read once per drag, once per keystroke and once on mount.

Files: src/renderer/src/styles.css (Edit-only, exact-substring replacements), 10 new *.css files,
one `import './X.css'` line each in AgentPanel.tsx, PerformanceHud.tsx, SettingsPage.tsx, GitHubPanel.tsx,
TerminalDock.tsx, GitHubMarkdownRenderer.tsx, ReviewComments.tsx, MultiFileReview.tsx,
PullRequestReviewBar.tsx, PullRequestContext.tsx; src/renderer/src/SidebarResizer.tsx,
src/renderer/src/SidebarResizer.dom.test.tsx; scripts/check-entry-chunk.mjs (ratchet).
Tests: `bun test src/renderer/src/SidebarResizer.dom.test.tsx` 3 pass (2 new). Full `bun test` 1075 pass / 0 fail.
Gates: lint 0, lint:css 0, typecheck 0, build ok, check:entry 1,362,221 B (limit ratcheted 1,700,000 -> 1,403,000).

Deviation from the brief: styles.css was edited with a script that applies exact-string replacements against a
freshly read file (~600 blocks); doing it as individual Edit calls was not feasible. Each replacement asserted
`count == 1` on the fresh read, and the file was never rewritten wholesale from a stale copy.

needs-owner: plans/perf-instant-plan.md status table (not in Track F's ownership, and Track E may be editing
the same table). Rows to set:
| P28 | Git spawn semaphore | 3F | DONE | two-lane semaphore, max(4,cpus-2)=8 with 2 slots reserved for interactive; ignored listing + remote probing marked background |
| P30 | CSS: split boot stylesheet, squircle scope, resizer | 3F | PARTIAL | boot CSS 172,331 -> 79,773 B (target < 60,000); 10 per-component sheets; squircle off pseudo-elements; resizer writes deduped |
| P31 | Shiki tokenizer off the main thread | 3F | DONE | engine + theme normaliser made lazy via two build-time rewrites; vendor-shiki (143 KB) dynamic-only; closure 1,652,620 -> 1,362,221 B |

## Final gate run
`bun run verify` exit 0 (lint, lint:css, typecheck, `bun test` 1075 pass / 0 fail / 133 files, build,
check:entry 1,362,221 B against the ratcheted 1,403,000 limit).

Before -> after (same worktree; boot chunk JS also moved because Tracks C/D/E kept editing App.tsx,
useGitWorkflow.ts and useReviewWorlds.ts during this run, so treat that one as noise):
  pre-mount closure   1,652,620 -> 1,362,221 B  (-290,399, -17.6%)
  boot chunk JS         174,907 ->   180,566 B  (+5,659, other tracks' source)
  boot CSS              172,331 ->    79,773 B  (-92,558, -53.7%)
  vendor-shiki          206,721 B statically pre-mount -> 143 KB, dynamic-only (out of the closure)
