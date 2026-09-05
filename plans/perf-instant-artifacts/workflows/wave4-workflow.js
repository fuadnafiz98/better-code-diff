export const meta = {
  name: 'horus-perf-wave4',
  description: 'Wave 4 of plans/perf-instant-plan.md: P13 react-doctor back to 100/100 (Track H1 renderer, Track H2 main/shared/extensions/scripts + carry-over cleanup), two Opus implementers in parallel',
  phases: [{ title: 'Wave 4', detail: 'react-doctor to 100 + cleanup carries, disjoint ownership' }],
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

const COMMON = `You are an implementer on the Horus code-review app (Electron 43 + React 19.2 + React Compiler, TypeScript strict, bun). Repo: ${REPO}. Work directly in that worktree (no worktree isolation, no commits, no git stash/checkout/reset/restore). ONE other implementer is editing OTHER files in the same worktree at the same time:
- Edit ONLY files inside your ownership list below (plus new files you create for owned modules and their colocated tests). Never Write/rewrite a file the other track may touch; Edit-only on shared files. If a change outside your ownership seems required, record it in your progress log under "needs-owner" with the exact edit, and continue.
- Never run \`git add/commit/stash/checkout/restore\`, \`bun run update:mac\`, \`bun run dist:mac\`, \`bun run install:mac\`. Do not launch or kill Horus.app.
- \`bun run typecheck\` may transiently fail on the other track's file; wait 60 s and retry once before treating it as pre-existing.

FIRST: read ${PLAN} (status table, gates, section P13) and ${SCRATCH}/review/wave1-feedback.md (Fable's review notes for Waves 1-3, including the "W3-X*" carry items). react-doctor baseline for this wave: ${SCRATCH}/reports/react-doctor-wave2.txt (31 warnings; the current tree has 30 — P26 removed js-set-map-lookups) and the tool prints "Score not shown because lint or maintainability analysis could not complete / Results are incomplete: maintainability checks failed" — the numeric score is unavailable until that is fixed. Run \`npx react-doctor@latest --verbose\` yourself at the start to get the live list and the diagnostics directory it writes (it prints the path).

BEHAVIOUR-PRESERVING REFACTORS ONLY. Every extraction must keep the existing dom/unit tests green without weakening assertions; add tests where a new module gets its own logic. Keep React Compiler compatibility (\`bun test src/renderer/src/reactCompiler.test.ts\` stays green; if you split a component out of App.tsx / RepositoryWorkspace.tsx / CommandPalette.tsx add the new hot component names to HOT_COMPONENTS in that test). Do not change the pre-mount closure budget: \`bun run check:entry\` must still pass (Track H1 may run \`bun run build && bun run check:entry\`; Track H2 must not build). Style: no semicolons, single quotes, 2-space, named exports, no \`any\`, no TODO stubs.

DURABLE PROGRESS LOG: ${SCRATCH}/progress/<track>.md (path below). Resume from it if it exists. After each section append \`## <id> <status>\` + bullets (files, tests, gates, deviations, needs-owner). Write before moving on.

PER-SECTION GATES: \`bun run lint\`, \`bun run typecheck\`, \`bun test <covering tests>\`, and \`npx react-doctor@latest --verbose\` (record the warning count and whether the score printed).

FINAL OUTPUT: JSON per the output schema: per-section status/summary/files/tests/gates/deviations; gateSummary (final warning count, score if printed, verify results); blockers; reviewNotes.`

const TRACK_H1 = `${COMMON}

TRACK: H1 — react-doctor, renderer. Progress log: ${SCRATCH}/progress/trackH1.md
OWNERSHIP: everything under src/renderer/src/** EXCEPT scripts and the files Track H2 owns (none in src/renderer). Includes App.tsx, AppView.tsx, CommandPalette.tsx, RepositoryWorkspace.tsx, DiffSurface.tsx, AgentPanel.tsx, GitHubPanel.tsx, PerformanceChart.tsx, PerformanceHud.tsx, PullRequestReviewBar.tsx, FolderPicker.tsx, editor/EditorStatusBar.tsx and their tests; new files you split out; src/renderer/src/styles.css and per-component CSS if a split needs a class moved.
SECTIONS (in order):
- H1-1 \`no-multi-component-file\` x6 in AppView.tsx: split into one file per component (Titlebar.tsx, DiffToolbar.tsx, etc. — keep the names the tests import; re-export from AppView.tsx only if a test or App.tsx needs the old path, and prefer updating imports). Keep the lazy PerformanceHud mount and the P11 behaviour.
- H1-2 \`no-giant-component\` App.tsx and CommandPalette.tsx: extract cohesive hooks/subcomponents (e.g. App's open-folder handlers into useFolderOpen(), the external PR listener into useExternalPullRequest(), CommandPalette's rows into PaletteResults/PaletteRow files). Preserve every dom test; extend reactCompiler.test.ts HOT_COMPONENTS with the new components.
- H1-3 \`no-high-complexity-react-function\` x11 (AgentPanel, App AppLayout, AppView DiffToolbar, DiffSurface, EditorStatusBar, GitHubPanel, PerformanceChart, PerformanceHud, PullRequestReviewBar, RepositoryWorkspace x2): reduce control flow by extracting pure helpers (state -> view-model functions, unit-tested) and small subcomponents. Aim for each flagged function to drop below the rule's threshold; verify with react-doctor after each file.
- H1-4 RepositoryWorkspace.tsx \`no-reset-all-state-on-prop-change\` + \`no-adjust-state-on-prop-change\` x2 (~:1305-1308): replace the "reset state when prop changes" effects with the React-recommended pattern (keyed subcomponent remount, or derive-during-render with the previous-value comparison as React docs describe), preserving P27's skeleton->live behaviour and the tree tests.
- H1-5 FolderPicker.tsx \`prefer-html-dialog\`: render the picker as a \`<dialog>\` (showModal on open, close on Escape/outside click as today), keep FolderPicker.dom.test.tsx and P27's spinner behaviour green; check focus management matches the CommandPaletteShell dialog.
- H1-6 final: \`npx react-doctor@latest --verbose\` must list zero renderer warnings; run \`bun run build && bun run check:entry\` once and record the closure (must stay <= the current MAX_PREMOUNT_BYTES); run \`bun test src/renderer\`.`

const TRACK_H2 = `${COMMON}

TRACK: H2 — react-doctor main/shared/extensions, tool failure, and carry-over cleanup. Progress log: ${SCRATCH}/progress/trackH2.md
OWNERSHIP: src/main/** (+tests), src/shared/** (+tests), extensions/horus/**, scripts/** (+tests), package.json scripts block, .react-doctor config file if one is needed at repo root, plans/perf-instant-plan.md status table rows for your sections only. Do NOT touch src/renderer/** or src/preload/**.
SECTIONS (in order):
- H2-1 react-doctor "maintainability checks failed" / score not printed: find out why (run with any debug/verbose flags the tool offers, read its diagnostics directory, check whether a specific file or config makes the maintainability pass fail — e.g. a parse error in a .mjs/.tsx it scans, or the scripts/**/*.test.mjs files). Fix the cause if it is in the repo (or add a minimal react-doctor config that scopes analysis to src/ and extensions/ if the tool trips on scripts). Goal: the numeric score prints. Record the root cause.
- H2-2 src/main/folderIndex.ts \`async-await-in-loop\` x4 (:47 :50 :56 :150) and \`server-sequential-independent-await\` (:81): restructure with Promise.all / bounded concurrency where the awaits are independent; where they are intentionally sequential (rate limiting), restructure so the rule is satisfied without changing behaviour, or document with the tool's disable comment ONLY if the sequential form is genuinely required — prefer real fixes. Keep folderIndex tests green and add one for the concurrent path.
- H2-3 extensions/horus/src/open-pull-request.tsx \`no-set-state-after-await-in-effect\` x2: cancellation flag / cleanup in the effect. Run the extension's own typecheck/lint if it has scripts.
- H2-4 carries: W3-X1 (thread \`lane\` from getPullRequestReview(intent) through #loadPullRequestReview/runGitHubReadCommand so warmup gh hops run on the background lane), W3-X2 (named "no vendor-shiki chunk in the pre-mount closure" assertion in scripts/check-entry-chunk.mjs next to the WorkerPool check), W3-X4 (RepositoryService.open(folderPath, resolved=false) + repositorySessions passes true — removes the last redundant realpath), W3-X3 + W3-X5 (scripts/perf/startup-probe.mjs: report paletteOpenAppMs from the 'horus:palette-open-to-focus' performance measure, and read emptyRows only once the count is stable across two polls or after a 100 ms settle). Tests for each.
- H2-5 final: \`npx react-doctor@latest --verbose\` lists zero warnings in src/main, src/shared, extensions; \`bun test src/main src/shared scripts extensions\` green; lint + typecheck green. Do NOT run \`bun run build\`.`

phase('Wave 4')
log('Wave 4: launching Track H1 (renderer react-doctor) and Track H2 (main/shared/extensions/scripts + carries)')
const results = await parallel([
  () => agent(TRACK_H1, { label: 'trackH1:react-doctor-renderer', phase: 'Wave 4', model: 'opus', effort: 'max', schema: SCHEMA }),
  () => agent(TRACK_H2, { label: 'trackH2:react-doctor-main-cleanup', phase: 'Wave 4', model: 'opus', effort: 'max', schema: SCHEMA }),
])
const [trackH1, trackH2] = results
const brief = (t) => (t ? t.sections.map((s) => s.id + ':' + s.status).join(' ') : 'NULL')
log(`Wave 4 done: H1=${brief(trackH1)} | H2=${brief(trackH2)}`)
return { trackH1, trackH2 }
