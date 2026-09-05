export const meta = {
  name: 'horus-perf-wave3',
  description: 'Wave 3 of plans/perf-instant-plan.md: Track E (sessions/cache/open-folder UX P25 P26 P27 P29 + Wave 2 carries), Track F (hardening P28 P30 P31), Track G (palette regressions from Wave 2 probes), three Opus implementers in parallel',
  phases: [{ title: 'Wave 3', detail: 'three parallel implementer tracks with disjoint file ownership' }],
}

const REPO = '/Users/fuadnafiz98/Developer/vibes/better-code-diff'
const PLAN = `${REPO}/plans/perf-instant-plan.md`
const SCRATCH = '/private/tmp/claude-501/-Users-fuadnafiz98-Developer-vibes-better-code-diff/2a975ab1-5c84-43b9-bac1-d2fcb5d3d267/scratchpad'

const SCHEMA = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['DONE', 'PARTIAL', 'BLOCKED', 'SKIPPED'] },
          summary: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          tests: { type: 'array', items: { type: 'string' } },
          gates: { type: 'string' },
          deviations: { type: 'string' },
        },
        required: ['id', 'status', 'summary', 'files'],
      },
    },
    gateSummary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    reviewNotes: { type: 'string' },
  },
  required: ['track', 'sections', 'gateSummary'],
}

const COMMON = `You are an implementer on the Horus code-review app (Electron 43 + React 19.2 + React Compiler, TypeScript strict, bun). Repo: ${REPO}. Work directly in that worktree (no worktree isolation, no commits, no git stash/checkout/reset/restore). TWO other implementers are editing OTHER files in the same worktree at the same time, so:
- Edit ONLY files inside your ownership list below (plus new files you create for owned modules and their colocated *.test.ts / *.dom.test.tsx). Some files are SHARED with region ownership (listed explicitly): on a shared file use the Edit tool only (exact string replacement of your own region), never Write/rewrite the whole file, and re-read the region right before each edit. If a change outside your ownership seems required, do NOT make it: record it in your progress log under "needs-owner" with the exact edit, and continue.
- Never run \`git add/commit/stash/checkout/restore\`, \`bun run update:mac\`, \`bun run dist:mac\`, \`bun run install:mac\`. Do not launch or kill Horus.app. The reviewer builds, installs and measures after both tracks finish.
- \`bun run typecheck\` may transiently fail on a file the other track is mid-edit on. If the error is in a file you do not own, wait 60 s and retry once before treating it as pre-existing; never "fix" the other track's file.

FIRST: read ${PLAN} in full (targets, root causes, ranked findings, execution order, status, gates, then your sections). Waves 1 and 2 (P00-P05, P08-P12, P14-P23) are DONE; build on that code. Then read ${SCRATCH}/review/wave1-feedback.md — Fable's review notes for Waves 1-2; the "W2-X*" carry items assigned to your track are listed in your brief below. Evidence per finding: ${SCRATCH}/reports/*.json (folder-open.json, main-startup-and-session-restore.json, renderer-boot.json, command-palette.json, pr-open.json), implementer reports ${SCRATCH}/reports/wave1-*.json and wave2-*.json, probe results ${SCRATCH}/results/wave2-*.out. Line numbers in the plan predate Waves 1-2; locate code by symbol.

DURABLE PROGRESS LOG: ${SCRATCH}/progress/<track>.md (path below). At start, if it exists, read it and RESUME from the first section not marked DONE (you may have been restarted). After each section append \`## <id> <status>\` + bullets: files, tests, exact gate commands and results, deviations, needs-owner. Write the entry BEFORE moving on.

QUALITY BAR: production code, no placeholders/TODO stubs/commented-out code/console.log. Match neighbouring style (no semicolons, single quotes, 2-space, named exports). Typed, no \`any\`. Every behavioural change gets a bun:test test colocated with the module; DOM tests follow the existing *.dom.test.tsx pattern. React Compiler compatibility is a hard rule: no ref reads/writes during render, no try/finally in components, no conditional hooks, useEffectEvent only from effects; \`bun test src/renderer/src/reactCompiler.test.ts\` must stay green and if you add a hot component to App.tsx/RepositoryWorkspace.tsx add it to HOT_COMPONENTS there. react-doctor: do not add warnings in files you touch (P13 in Wave 4 handles the 31 known ones).

PER-SECTION GATES: \`bun run lint\`, \`bun run typecheck\`, \`bun test <tests covering the modules you touched>\`. Do NOT run \`bun run build\` unless your brief allows it.

FINAL OUTPUT: when all sections are DONE (or truly blocked), return the JSON described by the output schema: per section status, one-paragraph summary, files, tests, gates, deviations; plus gateSummary, blockers, reviewNotes (risky spots, decisions, things you could not verify). No prose outside the JSON.`

const TRACK_E = `${COMMON}

TRACK: E — sessions, workspace cache, open-folder UX, Wave 2 carries. Progress log: ${SCRATCH}/progress/trackE.md
SECTIONS (in order): W2-X1, W2-X2, W2-X4, P27, W2-X3, W2-X5, P25, P26, P29.
OWNERSHIP: src/main/repositorySessions.ts, src/main/repositoryWatcher.ts, src/main/workspaceCacheStore.ts, src/shared/workspaceCache.ts, src/main/index.ts (SHARED with Track F who edits only \`remotesForRoot\`; you own the cache/restore/hint functions: rememberWorkspaceCache, persistWorkspaceFromSnapshot, flushPendingWorkspaceCache, trackSnapshot, hydrateLastWorkspace, beginSessionRestore, startLiveRefresh, currentRestoreHint, openRepository, the workspace-cache IPC handlers, the whenReady body; Edit-only), src/shared/contracts.ts (RepositorySnapshot/workspace cache/fileText types + IPC channel names), src/preload/index.ts, src/renderer/src/App.tsx, src/renderer/src/AppView.tsx, src/renderer/src/useReviewWorlds.ts, src/renderer/src/useGitWorkflow.ts, src/renderer/src/RepositoryWorkspace.tsx (SHARED with Track F who may add one CSS import line; Edit-only), src/renderer/src/WorkspaceRoot.tsx, src/renderer/src/FolderPicker.tsx, src/renderer/src/DiffSurface.tsx (prop removal only), src/renderer/src/CommandPaletteHost.tsx and CommandPalette.tsx (only the onRevealDirectory plumbing), src/renderer/src/workspaceMode.ts, src/renderer/src/treeExpansion.ts, package.json (devDependencies only), tests for all of these.
- W2-X1: App.tsx external-PR \`open\` callback takes \`(url, root)\` and passes root to \`gitWorkflow.openPullRequestFromLocator(url, root)\` as preferredRoot.
- W2-X2: delete the dead \`contentSearch\` prop threading (RepositoryWorkspaceProps, WorkspaceViewerProps, both DiffSurface call sites, DiffSurfaceProps, the \`contentSearch ?? publishedSearch\` line).
- W2-X4: add \`@babel/core\` to package.json devDependencies at the version already resolved in bun.lock (do not run a network install if the lockfile already has it; \`bun install --frozen-lockfile\` or equivalent to verify).
- P27 (uses the \`stage: 'skeleton' | 'live'\` field Wave 2 added to RepositorySnapshot): spinner on the picked row via openingRecentPath; picker stays mounted until a snapshot with \`stage === 'live'\` arrives or 400 ms; re-derive automaticWorkspaceView/firstOpenPathForSnapshot on skeleton -> live (explicit user selections win); one tree reset per root change; skip the collapse pass when the previous path list is empty. Note Wave 2 measured folder opens at 16-196 ms, so the skeleton is on screen for < 200 ms in the common case; keep the UX minimal and never flash a spinner for an open that settles inside one frame (show it only after ~80 ms).
- W2-X3: RepositoryWorkspace gains \`revealPath(path)\` (expand ancestors + scroll into view, via the tree's existing expansion helpers); App passes it to CommandPaletteHost as \`onRevealDirectory\`; the palette calls it when a directory row is chosen (keep the query-narrowing behaviour as well).
- W2-X5: \`openPatchWorld\` (useReviewWorlds/useGitWorkflow) matches GitHub reviews by \`patchReviewIdentity(review)\` (PR URL) rather than \`patchWorldId\`, so reopening a PR after a force-push \`replace\` focuses the existing tab instead of creating a second one. Test it.
- P25: suspend inactive sessions (close fs.watch, keep snapshot; re-arm + one refresh on activate); LRU cap 4 resident sessions; disposed roots reopen lazily. Test with a fake watcher.
- P26: cap the workspace cache by counts (no JSON.stringify), Set membership; 3-slot LRU keyed by root; split fileText into its own IPC (\`repository:file-text\`) sent only when the open file's content hash changed (<= every 250 ms); async debounced atomic write (temp + rename), never on the publish tick. Keep the restore hint carrying the last root only. Update sessionRestore/workspaceCache tests.
- P29: \`setImmediate(beginSessionRestore)\` after the window is shown; memoise currentRestoreHint on (sessionState, cache) identity; realpath once in openRepository and pass the resolved path down.
- Do NOT run \`bun run build\` (Track F builds at the end).`

const TRACK_F = `${COMMON}

TRACK: F — hardening: git spawn semaphore, CSS split, shiki off the boot path. Progress log: ${SCRATCH}/progress/trackF.md
SECTIONS (in order): P28, P31, P30.
OWNERSHIP: src/main/gitCommands.ts (+test), src/main/repository.ts (SHARED with nobody this wave but Edit-only: you may add a \`lane: 'background'\` option to the git call inside \`#startIgnoredListing\` and to \`searchContent\`'s rg spawn if it goes through runCommand — nothing else), src/main/pullRequestRoots.ts (only to pass lane 'background' for remote probing), src/main/index.ts (SHARED with Track E; you own ONLY \`remotesForRoot\` to pass lane 'background'; Edit-only), src/renderer/src/styles.css (SHARED: Track E may add small rules for P27's spinner; you own the split — coordinate by Edit-only, never rewrite the file), new per-component CSS files under src/renderer/src/, one \`import './X.css'\` line per lazy component file you split styles out of (SHARED files, Edit-only, one line each — includes RepositoryWorkspace.tsx which Track E owns otherwise), src/renderer/src/SidebarResizer.tsx (+test), electron.vite.config.ts, the shiki/highlighter modules in src/renderer/src (find them: grep for shiki / createHighlighter / @shikijs; also the diff worker under src/renderer/src/**/worker*), scripts/check-entry-chunk.mjs (ratchet only), scripts/premountClosure.mjs (only if P31 needs the closure roots adjusted, with a test).
- P28: semaphore in gitCommands.ts of max(4, cpus-2) concurrent git/gh/rg children with two lanes (interactive default, background); interactive always dequeues first; abort signals dequeue waiters. Callers to mark background: ignored listing, remote probing (pullRequestRoots + remotesForRoot), PR warmup if it goes through runCommand. Unit tests: ordering, lane priority, abort dequeue, limit.
- P31: first verify with the pre-mount closure report (\`bun run build && bun run check:entry\`) and the source maps whether shiki/oniguruma are EXECUTED at boot or only imported. Track B's Wave 1 note: vendor-shiki (206 KB) is in the pre-mount closure because vendor-diffs / the viewer chunk import it statically and hast/property-information are shared. Goal: no shiki/oniguruma code parsed before the first highlighted file is requested — lazy highlighter module loaded on first highlight request, worker-based if the app already highlights in a worker (check). Do not regress highlight latency: first highlighted file must paint within 100 ms of open on a warm chunk cache (reason about it; you cannot launch the app). If it turns out shiki is only imported and not executed, and the chunk split is impossible without editing @pierre/diffs internals, mark P31 PARTIAL with the evidence and the exact blocker.
- P30: move rules for lazy surfaces (palette, markdown, review comments, agent panel, terminal, settings, PR review bar) from styles.css into per-component CSS files imported by those components so Vite emits them with their chunks; boot CSS < 60 KB (measure out/renderer/assets/*.css after build). Scope \`corner-shape: squircle\` to elements with border-radius. SidebarResizer: read layout once on pointerdown, transform during drag, commit width on pointerup. \`bun run lint:css\` must pass; dom tests green.
- You MAY run \`bun run build && bun run check:entry\` (you are the only track allowed to build in this wave). At the end, ratchet MAX_PREMOUNT_BYTES in scripts/check-entry-chunk.mjs down to the measured closure + 3% and record before/after closure, boot chunk and boot CSS bytes in the log and gateSummary. Also run \`bun run verify\` once at the very end and report the result.`


const TRACK_G = `${COMMON}

TRACK: G — command palette follow-ups from the Wave 2 probe run. Progress log: ${SCRATCH}/progress/trackG.md
Wave 2 measured on the installed build (${SCRATCH}/results/wave2-startup.out): palette.openMs 89-103 ms (target <= 30), palette.contentResultsMs 414-423 ms for the 3-character query "app" (Wave 1: 30 ms; target <= 150), emptyRows 34 (good), workspaceRenders 0 (good).
SECTIONS (in order): G1, G2.
OWNERSHIP: src/renderer/src/contentSearchScheduler.ts (+test), src/renderer/src/useRepositorySearch.ts (+test), src/renderer/src/fileSearch.ts (+test), src/renderer/src/commandPaletteModule.ts, src/renderer/src/CommandPaletteHost.tsx (+dom test), src/renderer/src/CommandPalette.tsx (SHARED with Track E, who only adds an \`onRevealDirectory\` prop and its call on directory rows; you own mount/index/search logic; Edit-only), src/renderer/src/boot.tsx (SHARED: you may add one line to warm the palette index at idle; Edit-only), src/renderer/src/searchPreview.ts.
- G1 (regression): the P17 "path-like query" rule (\`CONTENT_SEARCH_PATH_PAUSE_MS = 400\` when the query has a \`/\` OR >= 5 file-name prefix hits) delays content results by 400 ms for ordinary short words like "app" that happen to match many file names. Remove the file-name-hit branch entirely; keep only an explicit \`/\` in the query as the path signal, and lower that pause to 250 ms. Content results for "app" must arrive <= 150 ms after the last keystroke (debounce 120 ms at 3 chars + rg ~30 ms). Update the scheduler tests to pin this.
- G2 (target missed): first Cmd+P after launch is still ~90-100 ms from keydown to a focused input. The palette chunk is already resident (boot preloads it), so the cost is the REAL panel's first mount: \`createFileSearchIndex\` over 3,026 paths + directory derivation, \`rankFilePaths('')\` priority list, localStorage recents, and 34 rows with icons — all synchronous inside the keydown's render. Fix all three: (a) CommandPaletteHost always renders the shell (focused input) on the open frame and mounts the real panel on the next frame (\`requestAnimationFrame\` or \`startTransition\` — the shell/panel handoff already exists), so focus lands in <= 1 frame regardless of panel cost; (b) build the search index off the open path: warm it when the snapshot's \`paths\` array changes (a module-level cache keyed by array identity, computed via \`requestIdleCallback\` with a 1 s timeout, also triggered once from boot.tsx after render), so opening only looks it up; (c) render the empty-query list in two steps: first 12 rows synchronously, the rest after a frame, and lazy-load row icons. Add a dom test that measures the number of synchronous renders/work between \`open()\` and the focused input (mock the heavy index builder and assert it is not called during open when a warm index exists). Keep Track C's tests green (CommandPalette.dom, CommandPaletteHost.dom, fileSearch, useRepositorySearch, reactCompiler).
- Do NOT run \`bun run build\` (Track F builds at the end). Gates: lint, typecheck, the tests above.`

phase('Wave 3')
log('Wave 3: launching Track E (sessions/cache/open-folder UX + carries), Track F (hardening) and Track G (palette follow-ups)')
const results = await parallel([
  () => agent(TRACK_E, { label: 'trackE:sessions-cache-ux', phase: 'Wave 3', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_F, { label: 'trackF:hardening', phase: 'Wave 3', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_G, { label: 'trackG:palette-followups', phase: 'Wave 3', model: 'opus', effort: 'max', schema: SCHEMA }),
])
const [trackE, trackF, trackG] = results
const brief = (t) => (t ? t.sections.map((s) => s.id + ':' + s.status).join(' ') : 'NULL')
log(`Wave 3 done: E=${brief(trackE)} | F=${brief(trackF)} | G=${brief(trackG)}`)
return { trackE, trackF, trackG }
