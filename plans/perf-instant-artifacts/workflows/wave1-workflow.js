export const meta = {
  name: 'horus-perf-wave1',
  description: 'Wave 0+1 of plans/perf-instant-plan.md: Track A (main git path P01-P05) and Track B (renderer boot + tooling P00, P08-P12), two Opus implementers in parallel',
  phases: [{ title: 'Wave 1', detail: 'two parallel implementer tracks with disjoint file ownership' }],
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

const COMMON = `You are an implementer on the Horus code-review app (Electron 43 + React 19.2 + React Compiler, TypeScript strict, bun). Repo: ${REPO}. Work directly in that worktree (no worktree isolation, no commits, no git stash/checkout/reset). Another implementer is editing OTHER files in the same worktree at the same time, so:
- Edit ONLY files inside your ownership list below (plus new files you create under your owned directories, and new colocated *.test.ts / *.dom.test.tsx for owned modules). If a change outside your ownership seems required, do NOT make it: record it in your progress log under "needs-owner" with the exact edit you wanted, and continue.
- Never run \`git add\`, \`git commit\`, \`git stash\`, \`git checkout\`, \`git restore\`, \`bun run update:mac\`, \`bun run dist:mac\`, \`bun run install:mac\`, and never launch or kill Horus.app / Electron. The reviewer builds and installs after both tracks finish.

FIRST: read ${PLAN} in full (header, targets, root causes, ranked findings, execution order, gates, then your sections). Detailed evidence for each finding is in ${SCRATCH}/reports/*.json (main-startup-and-session-restore.json, folder-open.json, renderer-boot.json, command-palette.json, pr-open.json) — read the entries your sections cite when you need line-level detail. Line numbers in the plan were taken from the current worktree and may drift slightly; locate code by symbol, not by line.

DURABLE PROGRESS LOG: ${SCRATCH}/progress/<track>.md (path given below). At start, if the file exists, read it and RESUME from the first section not marked DONE (you may have been restarted). After finishing each section append a block: \`## <Pxx> <status>\` then bullets: what changed (files), tests added/changed, exact gate commands run and their result (pass/fail counts), deviations from the plan and why, needs-owner items. Write the log entry BEFORE moving to the next section. Keep entries factual and terse.

QUALITY BAR: production code, no placeholders, no TODO stubs, no commented-out code, no console.log debugging left behind. Match the existing code style (look at neighbouring code: formatting, import style, naming, no semicolons if the file has none). Keep functions small and typed; no \`any\`. Every behavioural change gets a bun:test unit test (\`import { describe, expect, test } from 'bun:test'\`) colocated next to the module; DOM tests use the existing \`*.dom.test.tsx\` pattern. Preserve React Compiler compatibility (no mutation of refs during render, no conditional hooks, \`useEffectEvent\` only called from effects). Do not widen scope beyond your sections; do not refactor unrelated code.

PER-SECTION GATES (run after every section, fix before moving on): \`bun run lint\`, \`bun run typecheck\`, \`bun test <the test files you touched or that cover the modules you touched>\`. If a gate fails because of a file you do not own, note it in the log and move on.

FINAL OUTPUT: when all sections are DONE (or you are truly blocked), return the JSON described by the output schema: one entry per section with status, one-paragraph summary, files, tests, gate results, deviations; plus gateSummary (the exact final gate commands and results), blockers, and reviewNotes (anything the reviewer should look at first: risky spots, decisions you made, things you could not verify). No prose outside the JSON.`

const TRACK_A = `${COMMON}

TRACK: A — main-process git path. Progress log: ${SCRATCH}/progress/trackA.md
SECTIONS (in this order): P01, P02, P03, P04, P05.
OWNERSHIP: src/main/repository.ts, src/main/repositorySessions.ts, src/main/repositoryWatcher.ts, src/main/gitCommands.ts, src/main/workspaceListing.ts, src/main/index.ts ONLY inside the functions \`openRepository\` and \`startLiveRefresh\` (and the one-line call-site change P05 describes), their colocated *.test.ts files, and any new module you create under src/main/ for the ignored-listing code (e.g. src/main/ignoredListing.ts + test). Do NOT touch src/renderer/**, src/shared/**, src/preload/**, scripts/**, package.json, electron.vite.config.ts.

Notes specific to this track:
- P01: the reference implementation that was verified byte-identical on four repositories is ${SCRATCH}/reports/tmp/mainstartup/verify3.mjs — read it and port its two-phase algorithm (git --directory listing, then EXCLUDED_DIRECTORY_SET post-filter, then async readdir expansion of survivors with nested-repo boundary + extension filter + cap). Add a test that runs both the old and new algorithm on a synthetic temp git repo (tracked, untracked, ignored dirs incl. node_modules, nested repo, .pyc files) and asserts identical sorted output. Ignored listing must leave the refresh critical path: publish tracked+status first, merge ignored later, with AbortController + hard deadline as the plan says. Keep the \`#visiblePaths\` cache semantics.
- P02: set \`GIT_OPTIONAL_LOCKS=0\` in the env of every git spawn (runCommand and the object reader) and add the \`expectSelfWrite('.git/index')\` window in the watcher as specified; add the watcher test. Do NOT remove \`.git/index\` from \`normalizeChangedPath\`.
- P03: in-flight dedupe keyed on a \`#mutation\` counter; bump it in switchBranch/pullCurrentBranch/checkoutPullRequest/saveWorkingFile; clear on dispose. Test: two concurrent refresh() calls -> one git cycle; a refresh started before a mutation does not satisfy a request made after it.
- P04: \`open()\` races refresh() against a 150 ms timer; return the live snapshot when it wins, else the improved listRootSnapshot skeleton (depth 3, cap 2000) and publish the live one when it lands. Snapshot must carry a discriminator the renderer can read (e.g. \`kind: 'skeleton' | 'live'\` — check src/shared/contracts.ts for the existing shape and if a new field is needed there, log it as needs-owner instead of editing contracts.ts; prefer an already-existing field if one fits).
- P05: add \`refresh(root)\` to the registry and call it from openRepository instead of \`refreshActive()\`.
- The typecheck gate currently fails ONLY on src/renderer/src/splitDiffResize.test.ts (vitest import); Track B fixes that in P00. Treat that single error as pre-existing; any other typecheck error is yours.
- Do NOT run \`bun run build\` (Track B owns builds and runs them concurrently).`

const TRACK_B = `${COMMON}

TRACK: B — renderer boot + tooling. Progress log: ${SCRATCH}/progress/trackB.md
SECTIONS (in this order): P00, P08, P09, P10, P11, P12.
OWNERSHIP: src/renderer/src/splitDiffResize.test.ts (P00 only), src/renderer/src/boot.tsx, src/renderer/src/treeExpansion.ts (and a new module for orderPathsForTree if you split it), src/renderer/src/ReviewComments.tsx, src/renderer/src/GitHubMarkdownContent.tsx, src/renderer/src/MarkdownContent.tsx, src/renderer/src/AppView.tsx ONLY the PerformanceHud mount, src/renderer/src/PerformanceHud.tsx, src/renderer/src/workspaceBoot.ts (only if P08 needs a small change), electron.vite.config.ts, scripts/** (new scripts/perf/**), package.json ONLY the "scripts" block, and colocated tests for those modules. Do NOT touch src/main/**, src/shared/**, src/preload/**, App.tsx (except nothing), CommandPalette*, useRepositorySearch*, RepositoryWorkspace.tsx, styles.css.

Notes specific to this track:
- P00: change the vitest import to bun:test and make \`bun run typecheck\` pass. Do this first and log it, because Track A's gate depends on it.
- P08: remove the awaits in boot.tsx that block createRoot().render() on preloadWorkspaceRoot/preloadWorkspaceViewer; render immediately; fire-and-forget the preloads; if App needs a short fallback gate use the workspaceBoot store as the plan describes and keep the change inside owned files (if App.tsx would need editing, log needs-owner and implement the owned half).
- P09: lazy GitHubMarkdownContent (with a <pre> fallback that shows the raw text) at every call site inside owned files; add Vite \`manualChunks\` for vendor-diffs / vendor-markdown / vendor-shiki / vendor-react per the plan; verify with \`bun run build\` that parse5/rehype/remark no longer appear in the pre-mount closure.
- P10: local folders-first comparator for firstTreePath; move orderPathsForTree out so @pierre/trees + icons leave the boot chunk; lazy Welcome icons only if inside owned files.
- P11: lazy PerformanceHud; first sample only when the popover opens (requestIdleCallback).
- P12: port ${SCRATCH}/bench/{cdp.mjs,startup-probe.mjs,open-folder-probe.mjs,pr-open-probe.mjs} into scripts/perf/ (fix the kebab-case mark keys in medians, add longtask + workspaceRenders capture, keep the 15 s CDP send timeout + readyState guard), add scripts/perf/git-shim/git (a PATH shim that logs every git/gh spawn with args + wall time to a file named by env HORUS_GIT_SHIM_LOG, then execs the real binary) with a README, rewrite scripts/benchmark-startup.mjs to use marks/mainStartup and \`#repository-diff > *\` (never require .multi-file-review), rewrite scripts/check-entry-chunk.mjs to sum the transitive pre-mount closure from out/renderer (entry -> static imports -> ... until the first dynamic import) with MAX_PREMOUNT_BYTES = 1_900_000 and print the top 15 modules by size, add \`crossorigin: ''\` to the CSS preload link in electron.vite.config.ts, and add package.json scripts: perf:startup-probe, perf:open-folder-probe, perf:pr-open-probe (each takes a label arg and appends JSONL to scripts/perf/results/<label>.jsonl; results dir gitignored — if .gitignore is not yours, write results under ${SCRATCH}/results instead and log needs-owner). Probes must accept the app path via env HORUS_APP (default ~/Applications/Horus.app) and must never leave a Horus process running when they exit.
- END-OF-TRACK GATES (you own them): \`bun run verify\` (lint, lint:css, typecheck, bun test, build, check:entry) must pass; then \`npx react-doctor@latest --verbose\` must report 100/100 — if it drops, fix the reported components within your ownership or log needs-owner with the exact report. Record the pre-mount byte total from check:entry before and after your changes in the log and in gateSummary.`

phase('Wave 1')
log('Wave 1: launching Track A (main git path) and Track B (renderer boot + tooling)')
const results = await parallel([
  () => agent(TRACK_A, { label: 'trackA:main-git-path', phase: 'Wave 1', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_B, { label: 'trackB:renderer-boot-tooling', phase: 'Wave 1', model: 'opus', effort: 'max', schema: SCHEMA }),
])
const [trackA, trackB] = results
log(`Wave 1 done: A=${trackA ? trackA.sections.map(s => s.id + ':' + s.status).join(' ') : 'NULL'} | B=${trackB ? trackB.sections.map(s => s.id + ':' + s.status).join(' ') : 'NULL'}`)
return { trackA, trackB }