export const meta = {
  name: 'horus-perf-wave2',
  description: 'Wave 2 of plans/perf-instant-plan.md: Track C (palette P14-P20), Track D (Cmd+H P21-P23 + P17 main half), Track R (Wave 1 review fixes + probe fixes), three Opus implementers in parallel',
  phases: [{ title: 'Wave 2', detail: 'three parallel implementer tracks with disjoint file ownership' }],
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
- Edit ONLY files inside your ownership list below (plus new files you create for owned modules and their colocated *.test.ts / *.dom.test.tsx). Some files are SHARED between tracks with region ownership (listed explicitly). On a shared file: use the Edit tool only (exact string replacement of your own region), never Write/rewrite the whole file, and re-read the region right before each edit. If a change outside your ownership seems required, do NOT make it: record it in your progress log under "needs-owner" with the exact edit, and continue.
- Never run \`git add/commit/stash/checkout/restore\`, \`bun run update:mac\`, \`bun run dist:mac\`, \`bun run install:mac\`. Do not launch or kill Horus.app unless your track brief says so. The reviewer builds, installs and measures after all tracks finish.
- \`bun run typecheck\` may transiently fail on a file another track is mid-edit on. If the error is in a file you do not own, wait 60 s and retry once before treating it as pre-existing; never "fix" another track's file.

FIRST: read ${PLAN} in full (targets, root causes, ranked findings, execution order, status, gates, then your sections). Wave 1 (P00-P05, P08-P12) is DONE and its results are in the status table; build on that code, do not re-do it. Detailed evidence per finding: ${SCRATCH}/reports/*.json (command-palette.json, pr-open.json, renderer-boot.json, folder-open.json, main-startup-and-session-restore.json) and the Wave 1 implementer reports ${SCRATCH}/reports/wave1-trackA.json, ${SCRATCH}/reports/wave1-trackB.json. Fable's Wave 1 review notes: ${SCRATCH}/review/wave1-feedback.md. Wave 1 probe results: ${SCRATCH}/results/wave1-*.out. Line numbers in the plan were taken before Wave 1 and have drifted; locate code by symbol.

DURABLE PROGRESS LOG: ${SCRATCH}/progress/<track>.md (path given below). At start, if the file exists, read it and RESUME from the first section not marked DONE (you may have been restarted). After finishing each section append a block: \`## <id> <status>\` then bullets: what changed (files), tests added/changed, exact gate commands and results, deviations from the plan and why, needs-owner items. Write the entry BEFORE moving on. Terse, factual.

QUALITY BAR: production code, no placeholders/TODO stubs/commented-out code/console.log. Match neighbouring code style (no semicolons, single quotes, 2-space, named exports). Typed, no \`any\`. Every behavioural change gets a bun:test unit test (\`import { describe, expect, test } from 'bun:test'\`) colocated next to the module; DOM tests follow the existing \`*.dom.test.tsx\` pattern (happy-dom + @testing-library/react). Preserve React Compiler compatibility (no ref mutation during render, no conditional hooks, \`useEffectEvent\` only called from effects). Do not widen scope beyond your sections; do not refactor unrelated code. react-doctor: do not introduce new warnings in files you touch (baseline is 81/100 with 25 known warnings; P13 in Wave 4 fixes those).

PER-SECTION GATES: \`bun run lint\`, \`bun run typecheck\`, \`bun test <the test files covering the modules you touched>\`. Do NOT run \`bun run build\` unless your brief allows it (concurrent builds clobber out/).

FINAL OUTPUT: when all sections are DONE (or truly blocked), return the JSON described by the output schema: per section status, one-paragraph summary, files, tests, gates, deviations; plus gateSummary (exact final gate commands + results), blockers, reviewNotes (risky spots, decisions, things you could not verify). No prose outside the JSON.`

const TRACK_C = `${COMMON}

TRACK: C — command palette and renderer render hygiene. Progress log: ${SCRATCH}/progress/trackC.md
SECTIONS (in order): P14, P15, P16, P17 (renderer half only: contentSearchScheduler adaptive debounce + path-like skip), P18, P19, P20, then two carried review items: P10-N1 (lazy Welcome) and P09-N1 (fallback class instead of inline styles).
OWNERSHIP: src/renderer/src/App.tsx, src/renderer/src/AppView.tsx (Welcome extraction only), new src/renderer/src/Welcome.tsx, src/renderer/src/CommandPalette.tsx, new src/renderer/src/commandPaletteModule.ts, new src/renderer/src/searchResultsStore.ts, src/renderer/src/useRepositorySearch.ts, src/renderer/src/fileSearch.ts, src/renderer/src/contentSearchScheduler.ts, src/renderer/src/searchPreview.ts, src/renderer/src/DiffSurface.tsx (search-marker consumption only), src/renderer/src/GitHubMarkdownContent.tsx (replace RAW_MARKDOWN_STYLE inline styles with a class), src/renderer/src/RepositoryWorkspace.tsx (ONLY adding a render counter for P15's metric), src/renderer/src/styles.css (SHARED: you own palette rules and one new \`.github-markdown-fallback\` rule; Edit-only), src/renderer/src/boot.tsx (SHARED: you own one \`void loadCommandPalette()\` line after render; Track D adds a separate block for the PR cold-start hint; Edit-only), electron.vite.config.ts (only if a manualChunk entry is needed for the palette chunk), tests for all of the above.
Notes:
- P14: module store pattern identical to workspaceBoot.ts. Delete lazy/Suspense/useCommandPaletteLoader/requestIdleCallback warm/hover warm. Inline shell must not import CommandPalette.tsx. Target: startup-probe \`palette.openMs\` <= 30 ms on the first Cmd+P after cold launch.
- P15: useRepositorySearch moves into the palette controller; settled \`{ query, results }\` published through searchResultsStore (frozen EMPTY constant) for DiffSurface markers; cancel IPC only when a search is outstanding. Expose \`window.__horusMetrics = { workspaceRenders }\` (incremented once per RepositoryWorkspace render) so scripts/perf/startup-probe.mjs can assert 0 renders across typed characters. Add a dom test that types 6 characters into the palette with a file open and asserts the workspace render count did not change.
- P16: empty query returns a priority list (recent files for this root first — keep recents in renderer localStorage keyed by root, max 20, updated on file open, no main-process changes — then changed files, then top-level directories, then tree order; cap 40); directory rows with kind; Files/dirs section above Commands; ghost-text completion + Tab accept.
- P17 renderer half: adaptive debounce 180/120/90 ms by query length, immediate on Enter, skip content search for path-like queries until a 400 ms pause. Track D lowers MAX_SEARCH_RESULTS in main; do not touch src/main.
- P18: blur 30px -> 12px, will-change only while opening, contain: layout paint.
- P19: \`useState(() => initialWorkspacePaint(...))\`; find the React Compiler bailout on App/AppLayout with the babel-plugin-react-compiler \`logger\` option (wire behind env HORUS_COMPILER_LOG=1 in electron.vite.config.ts) and fix the causes; record the before/after compiler output in the log.
- P20: delegated pointer handling, memoised row models, stable array identity from rankFilePaths.
- P10-N1: move Welcome (and the icons only it uses) from AppView.tsx into Welcome.tsx, render via lazy() in App.tsx's welcome branch with Suspense fallback={null}.
- P09-N1: one CSS rule \`.github-markdown-fallback\` in styles.css replacing the inline style object in GitHubMarkdownContent.tsx; keep its dom tests green.
- You MAY run \`bun run build && bun run check:entry\` once at the very end (you are the only track allowed to build); record the pre-mount closure bytes and the boot chunk bytes in the log.`

const TRACK_D = `${COMMON}

TRACK: D — Raycast Cmd+H / horus:// pull-request open. Progress log: ${SCRATCH}/progress/trackD.md
SECTIONS (in order): P21, P22, P23, P17 (main half only).
OWNERSHIP: src/main/index.ts (SHARED with nobody this wave, but edit only the PR/clipboard/restore-hint functions: findPullRequestRoot, remotesForRoot, previewPullRequestFolder, resolvePullRequestRepository handler, warmupPullRequest, applyExternalReview, publishPendingOpenPullRequest, getPendingExternalPullRequest handler, startClipboardWarmup, currentRestoreHint/encodeRestoreHintArgument for the pending PR url; Edit-only), src/main/pullRequestRoots.ts, src/main/folderIndex.ts, src/main/repository.ts (SHARED with Track R; you own ONLY: searchContent + MAX_SEARCH_RESULTS, getPullRequestReview, #loadPullRequestReview, PullRequestReviewCache, #resolvePullRequestIdentity, #runPullRequestJsonCommand, #collectPullRequestPatch*, getRemotes, the #reviewFlights/#reviewAborts fields, cancelPullRequestReview, MAX_PULL_REQUEST_CACHE_ENTRIES, PULL_REQUEST_*_FIELDS; Track R owns refresh()/#refreshSnapshot/#refreshFolder/#startIgnoredListing/#mergeIgnoredPaths; Edit-only), src/shared/contracts.ts (SHARED with Track R, who adds one line \`stage?: 'skeleton' | 'live'\` to RepositorySnapshot; you own PullRequestReviewProgress kinds, the openExternalPullRequest payload, the restore hint type; Edit-only), src/shared/horusUrl.ts, src/preload/index.ts, src/renderer/src/useGitWorkflow.ts, src/renderer/src/pullRequestOpen.ts, src/renderer/src/useReviewWorlds.ts (only handling of new progress kinds 'replace' and 'checks'), src/renderer/src/boot.tsx (SHARED with Track C: you add one small block that, when the restore hint carries pendingPullRequestUrl, preloads MultiFileReview instead of the cached view's chunk; Edit-only), extensions/horus/**, tests for all of the above.
Notes:
- P21: two-stage root resolution (stage 1 = remembered + open session roots + approvedRoots in one Promise.all, no folder walk; stage 2 = folderIndex.list + wave scan only on miss); module-level rootResolutions promise map keyed by normalized URL (5 s TTL); module-level remotes cache with 60 s TTL; negative cache per slug (60 s); previewPullRequestFolder never walks or spawns; carry the resolved root in the openExternalPullRequest payload so useGitWorkflow passes it as preferredRoot. Target: <= 12 git spawns per Cmd+H (Wave 1 measured 66 per 3 opens, of which ~45 were \`git remote -v\` — 9 per candidate root, i.e. 3 resolutions x 3 opens).
- P22: poll 2000 ms, skip while no visible/focused window, cooldown on miss too, stage 1 only, never openRepository/refresh from warmup, remove the Raycast warmup-clipboard background command (or make it never launch the app).
- P23: implement all 11 items in the plan section. Key facts from the Wave 1 probe: warm cached PR 717 -> .multi-file-review at 1,188 ms, metadata at 1,152 ms; the renderer received NO 'files'/'done' progress events at all (warmup stole the flight — PR-2), so multicast flights (item 1) and the URL-keyed cache index (item 2) are the two that move the number. Targets: warm cached <= 400 ms to .multi-file-review; cold cached <= 1,500 ms; uncached shows the shell at metadata time (< 900 ms) and streams files; exactly 2 gh spawns on a cached hit.
- P17 main half: MAX_SEARCH_RESULTS 200 -> 24 with optional forOpenPath second bounded search (cap 200 for that file), --max-filesize 1M, threads cap min(4, cpus); stop reading the --json stream once the cap is hit.
- Contracts you add (Track C and Track R do not touch these): PullRequestReviewProgress gains \`{ kind: 'replace', review }\` and \`{ kind: 'checks', checks }\`; openExternalPullRequest payload gains \`root?: string | null\`; restore hint gains \`pendingPullRequestUrl?: string\`.
- Do NOT run \`bun run build\`.`

const TRACK_R = `${COMMON}

TRACK: R — Wave 1 review fixes and probe fixes. Progress log: ${SCRATCH}/progress/trackR.md
Read ${SCRATCH}/review/wave1-feedback.md first: it lists every item below with the evidence.
SECTIONS (in order): R1, R2, R3, R4, R5, R6, R7.
OWNERSHIP: src/main/ignoredListing.ts (+test), src/main/repositorySessions.ts (+test), src/main/workspaceListing.ts (+test), src/main/repository.ts (SHARED with Track D; you own ONLY refresh(), a new refreshAfterExternalChange(), #startIgnoredListing, #mergeIgnoredPaths, #refreshSnapshot, #refreshFolder and their tests in repository.test.ts; Edit-only), src/shared/contracts.ts (SHARED with Track D; you add exactly one line to RepositorySnapshot: \`stage?: 'skeleton' | 'live'\` with a one-line doc comment; Edit-only), scripts/check-entry-chunk.mjs, scripts/perf/** (+tests), scripts/premountClosure.mjs.
- R1 (P01-R1, must fix): in ignoredListing.ts walkIgnoredDirectory, drop the \`depth > 0\` condition on the nested-repository check so an ignored directory that is itself a git repository is emitted as \`<dir>/\` and not walked (legacy git prints \`vendor/\`; the current code prints \`vendor/lib/x.js\`). Add the case to the legacy-vs-new equivalence test (top-level ignored dir containing its own .git).
- R2 (P03-R1, must fix): add \`refreshAfterExternalChange(): Promise<RepositorySnapshot>\` on RepositoryService (\`this.#mutation += 1; return this.refresh()\`) and wire the watcher callback in repositorySessions.ts #createSession to it, so a watcher tick never joins a refresh that started before the change. Test: refresh pending, call refreshAfterExternalChange(), assert a distinct promise chained behind the first that observes a file written between the calls.
- R3 (P01-R4): guard the late merge on run identity — pass the AbortController (or a run token) through withIgnoredListingDeadline's onLate so #mergeIgnoredPaths ignores a set from a superseded run. Test it.
- R4 (P04-N1 + P04-N2): remove 'vendor' from SKIP_DIRECTORIES in workspaceListing.ts; add the \`stage\` field to RepositorySnapshot in contracts.ts; listRootSnapshot sets \`stage: 'skeleton'\`; #refreshSnapshot and #refreshFolder set \`stage: 'live'\`. Update tests. Do not change any renderer code (P27 in Wave 3 consumes it).
- R5 (P12-N1): scripts/check-entry-chunk.mjs MAX_PREMOUNT_BYTES 1_900_000 -> 1_700_000 (current closure 1,649,485 B). Do not build; Track C runs the build at the end.
- R6 probe fixes in scripts/perf/ (evidence: ${SCRATCH}/results/wave1-startup.out, wave1-open-folder.out, wave1-pr-open.out):
  (a) startup-probe: fcpMs is null in every sample because the poll loop breaks before the 'first-contentful-paint' entry is recorded — after the loop, keep re-reading performance paint entries for up to 1 s until first-contentful-paint exists. Also mark sample 1 after a fresh install as a cold-cache outlier is fine, but report the median and the min.
  (b) open-folder-probe: headingMs/treeRowsMs are null for every folder: \`.sidebar-heading-identity\` exists in both App.tsx:335 and Explorer.tsx:122 and querySelector picks the wrong one — scope to \`#repository-explorer\` and verify against the real DOM. liveSnapshotMs is null when the 150 ms race (P04) wins because open() then publishes nothing on onDidChange — the probe must also observe the IPC result: in HOOKS wrap window.repository.openFolder / openRecentFolder / openPath (whatever the picker calls; read FolderPicker.tsx and App.tsx) so the resolved snapshot is pushed into window.__probe.changes with a \`source: 'ipc'\` marker, and treat a snapshot with branch != null from either source as live.
  (c) pr-open-probe: the four waits (review surface, metadata, first page, done) run serially with 45-60 s timeouts each, so a missing 'files' event turned firstCodeViewMs into 106,205 ms. Rewrite measure() as ONE poll loop with a single 20 s deadline that records the first-seen time of every condition (tab, surface, metadata, first files page, done, first code view) and exits when done+codeView are seen or the deadline passes; nulls for the rest. Progress kinds are 'metadata' | 'files' | 'done' today; Track D adds 'replace' and 'checks' — record every kind seen with its time in an array.
  (d) add a \`--json\` style summary line per probe that prints medians/mins so the reviewer can diff before/after without parsing.
  You MAY launch the installed ~/Applications/Horus.app (the Wave 1 build) to verify (b) and (c) against the real DOM with the probes themselves, and you must quit it afterwards (the probes do). Do not run the probes more than needed — two other tracks are working.
- R7: run \`bun test scripts/ src/main/\` and \`bun run lint\` and \`bun run typecheck\`; all green.
- Do NOT run \`bun run build\`, \`update:mac\`, or edit anything in src/renderer.`

phase('Wave 2')
log('Wave 2: launching Track C (palette), Track D (Cmd+H) and Track R (Wave 1 review fixes + probes)')
const results = await parallel([
  () => agent(TRACK_C, { label: 'trackC:palette', phase: 'Wave 2', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_D, { label: 'trackD:cmd-h', phase: 'Wave 2', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_R, { label: 'trackR:review-fixes', phase: 'Wave 2', model: 'opus', effort: 'max', schema: SCHEMA }),
])
const [trackC, trackD, trackR] = results
const brief = (t) => (t ? t.sections.map((s) => s.id + ':' + s.status).join(' ') : 'NULL')
log(`Wave 2 done: C=${brief(trackC)} | D=${brief(trackD)} | R=${brief(trackR)}`)
return { trackC, trackD, trackR }