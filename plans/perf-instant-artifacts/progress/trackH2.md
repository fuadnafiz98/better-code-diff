# Track H2 — react-doctor main/shared/extensions + carries

Baseline at start (live run, `npx react-doctor@latest --verbose`):
30 warnings, "Score not shown because lint or maintainability analysis could not complete",
"Results are incomplete: maintainability checks failed."

## H2-1 DONE (root cause found; fix is an owner action, measurement path added)

Root cause (proved, not guessed):
- react-doctor enumerates source files with
  `git ls-files -z --stage --others --exclude-standard`
  (`dist/index.js` `listGitSourceFilePaths`). That listing includes files that are
  still in git's index but deleted from the working tree.
- Wave 2 track D (P22) deleted `extensions/horus/src/warmup-clipboard.ts` from the
  working tree (manifest + raycast-env.d.ts + README already updated) but the deletion
  is unstaged, so `git ls-files` still reports it.
- The maintainability / dead-code pass then `open()`s every listed file and throws.
  Machine-readable proof from `--json`:
  `projects[0].skippedChecks == ["dead-code"]`,
  `skippedCheckReasons["dead-code"] == "Maintainability analysis failed: Error: ENOENT: no such file or directory, open '<repo>/extensions/horus/src/warmup-clipboard.ts'"`.
  One ENOENT aborts the whole maintainability pass, and with it the score
  (`summary.score == null`).
- Confirmed by experiment: writing a 1-line placeholder at that path makes the run
  print `Score: 81 / 100`, `skippedChecks: []`; deleting it again restores the failure.

Not the cause: `scripts/**/*.test.mjs`, a parse error, or config. Everything else scans
fine (315 files, lint pass completes).

Fix attempts:
- `doctor.config.jsonc` with `ignore.files: ["extensions/horus/src/warmup-clipboard.ts"]`
  does NOT help — the maintainability pass builds its file list from git before the
  ignore filter is applied (verified: still `skippedChecks: ["dead-code"]`, score null).
  Config file removed again; no config committed.
- The only real fix is to remove the stale index entry, which needs a git index write
  (`git rm --cached extensions/horus/src/warmup-clipboard.ts`, or just committing the
  working tree). This track is forbidden from touching the index -> needs-owner.

Measurement path used for every gate in this track (does not touch the repo):
`scratchpad/rd.sh` copies `.git/index` to `scratchpad/scan-index`, runs
`GIT_INDEX_FILE=<copy> git update-index --force-remove extensions/horus/src/warmup-clipboard.ts`
on the copy only, then runs react-doctor with `GIT_INDEX_FILE` pointed at the copy.
The repo's real index is unchanged (`git status` still shows ` D`).
With it: **Score 81/100, 30 warnings** — the score prints.

needs-owner:
- exact edit: `git rm --cached extensions/horus/src/warmup-clipboard.ts` (or commit the
  working tree). After that the score prints from a plain `npx react-doctor@latest`.
- upstream-worthy: react-doctor should skip ENOENT files in the maintainability pass
  instead of dropping the whole check and the score.

- files: none changed
- tests: none
- gates: react-doctor 30 warnings / score 81 (via rd.sh); lint+typecheck not re-run (no edits)
- deviations: fix is an owner action, see needs-owner

## NOTE from reviewer (16:45): H2-1 root cause already found by H1 and fixed by the orchestrator
react-doctor's dead-code pass reads `git ls-files`; the unstaged deletion of
`extensions/horus/src/warmup-clipboard.ts` (P22) made it throw ENOENT and skip the
maintainability analysis, which is why the score never printed. The deletion is now
staged (`git rm --cached`). Re-run `npx react-doctor@latest --verbose`; the score
should print. Record the confirmation under H2-1 and move on.

## H2-2 DONE — folderIndex.ts async-await-in-loop x4 + server-sequential-independent-await

- `src/main/folderIndex.ts`:
  - `collectFolderCandidates`: the six default-scan-root probes and the remembered-root
    probes now resolve in one `Promise.all` round (`resolveScanRoot` / `resolveExtraRoot`).
    `resolveScanRoot` also runs its `stat` and `realpath` together (they never needed
    each other). Insertion order into `found` is unchanged: remembered roots first, then
    scan roots in `DEFAULT_SCAN_ROOT_NAMES` order.
  - `walk`: per-directory children are collected in one pass into a promise array and
    resolved with `Promise.all` (`describeChild` = realpath + `.git` probe). A directory
    of 40 children went from 80 serial syscalls to one round.
  - New `visitInOrder(items, visit)` promise chain replaces both sequential `for`-await
    loops (scan roots, and the depth-first descent inside `walk`). Order is load-bearing
    because of the `MAX_FOLDERS` cap, so the sequencing is kept — as structure, not a
    comment — and shared by both call sites instead of being hand-rolled twice.
  - `resolveOpenableFolder`: the home realpath and the approved-root realpaths now
    resolve together; only the scan roots still depend on the resolved home. Error
    precedence (absolute -> exists -> not-a-file -> home -> unapproved) unchanged.
- Equivalence proof (not just tests): `scratchpad/folderIndexOriginal.ts` holds the
  pre-refactor algorithm verbatim; `scratchpad/compare-folderindex.ts` runs both against
  the real `$HOME` plus a directory, a missing path and a file as remembered roots.
  3/3 rounds: 103 vs 103 candidates, `JSON.stringify` identical. Timing 15.0/10.1/12.0 ms
  before vs 8.1/8.0/7.4 ms after.
- Why the rule fired here but not on the identical-looking loop in `ignoredListing.ts`:
  probed the rule with throwaway files. `react-doctor/async-await-in-loop` only fires in
  TS/TSX (a `.mjs` copy is silent), and it skips a loop when the body itself mutates the
  accumulator the loop guard reads. `ignoredListing.ts` happens to satisfy that; a
  verbatim copy of it scans clean, so there was no shape to imitate. `visitInOrder`
  removes the loop instead.
- files: src/main/folderIndex.ts, src/main/folderIndex.test.ts
- tests: `bun test src/main/folderIndex.test.ts` 8 pass (2 new: wide-directory concurrent
  round keeps every child exactly once, with node_modules/dot/file entries still excluded;
  remembered roots + default roots resolved in the same round, missing path and file
  rejected). `bun test src/main src/shared` 441 pass.
- gates: lint exit 0; typecheck exit 0; react-doctor 14 warnings, **score 84/100 printed**
  (via rd.sh) — src/main and src/shared now have zero warnings. Down from 30 at wave start
  (some renderer warnings also cleared by track H1 in parallel).
- deviations: none. `js-combine-iterations` appeared on an intermediate
  `entries.filter().map()` and was folded into a single loop.

## H2-3 DONE — extensions/horus/src/open-pull-request.tsx no-set-state-after-await-in-effect x2

- The rule is inter-procedural: it follows local helpers out of the effect, so an
  `AbortSignal` checked inside `warmup`/`openUrl` did not clear it (verified — first
  attempt still reported both effects). The post-await setters had to move into the
  effects, behind a visible `cancelled` flag with a cleanup.
- Restructure (behaviour preserved):
  - the single `[incoming]` effect became two: one for the launch-argument open, one for
    the clipboard read. Both return a cleanup that flips `cancelled`, and the clipboard
    `.then` now drops a superseded read instead of writing `clipboardUrl` over a newer one.
  - warmup is now one effect keyed on the derived `candidate` (`typed ?? clipboardUrl`)
    instead of one warmup call in each of the two old effects. `claimWarmup` still
    dedupes per URL, so the coverage is the same; the failure path always releases the
    claim (URL stays retryable) and only the badge write is gated on `cancelled`.
  - `openUrl` was split: the pure part (`deliver`) hoisted to module scope — it touches
    no component state — and `openUrl` is now only the action-panel path, where there is
    no effect run to be superseded by. `warmUrl` is the action-panel warmup.
  - `prefer-module-scope-pure-function` fired on `deliver` while it was still inside the
    component; hoisting it cleared that too.
- files: extensions/horus/src/open-pull-request.tsx
- tests: none exist for the Raycast UI command (`extensions/horus/src/lib/horus.test.ts`
  covers the transport and still passes). No test added: the file is JSX against
  `@raycast/api`, which is not installed in this checkout.
- gates: `npx react-doctor@latest extensions/horus/src/open-pull-request.tsx` 100/100,
  zero issues. Root `bun run lint` / `bun run typecheck` do not cover extensions/.
  `npx tsc --noEmit` inside extensions/horus reports 4 errors, all from the missing
  `extensions/horus/node_modules` (`Cannot find module '@raycast/api'` x3 plus the
  implicit-any `text` that follows from it) — identical before and after this change;
  `npx ray lint` needs the same install. No install run (would add a node_modules tree
  to the worktree mid-wave).
- deviations: none.

## H2-4 DONE — Wave 3 carries W3-X1, W3-X2, W3-X3, W3-X4, W3-X5

**W3-X1 lane through the PR review path** (`src/main/repository.ts`)
- New exported `pullRequestReviewLane(intent)` ('warmup' -> 'background', else
  'interactive'), and `runGitHubReadCommand` now takes a `lane` and forwards it to
  `runCommand` (it is the one place the retry loop could drop it).
- `getPullRequestReview` computes the lane from `intent` and hands it to
  `#loadPullRequestReview`, which threads it through `#revalidateCachedPullRequestReview`,
  `#fetchPullRequestReview`, `#loadPullRequestChecks`, `#emitPullRequestChecks`,
  `#collectPullRequestDiff`, `#collectPullRequestPatchFromFilesApi`,
  `#resolvePullRequestIdentity` and `#getGitHubViewerLogin`. The last two default to
  'interactive' because non-review callers (conversation, submit review) also use them.
- Known limit, not fixed here: a foreground reader that JOINS a warmup flight inherits
  the background lane, because the hops are already queued when it joins. Re-laning a
  running flight needs the semaphore to support promotion.
- tests (`src/main/repository.test.ts`): the intent -> lane mapping, and a real-semaphore
  test that a background `runGitHubReadCommand` queues behind a saturated background lane
  while an interactive one overtakes it (uses `/bin/echo`, not `gh`).

**W3-X2 named shiki assertion** (`scripts/check-entry-chunk.mjs`, `scripts/premountClosure.mjs`)
- New `closureChunksInGroup(closure, group, siblingGroups)` — Rollup hashes contain
  hyphens (`vendor-diffs-BEU-U29u.js`), so a group cannot be read off the last segment.
- The check now fails with "the shiki engine must stay lazy" when a `vendor-shiki` chunk
  is in the pre-mount closure, next to the WorkerPool check, and the summary line names it.
- FINDING while wiring it: a plain `vendor-shiki` prefix match FAILS against the current
  build — `vendor-shiki-langs-ByDSOINb.js` (31 KB) IS in the pre-mount closure, imported
  statically by `vendor-diffs`, which DiffSurface / MultiFileReview / WorkspaceRoot pull
  in. The engine itself (`vendor-shiki-BEzecXZ0.js`, 143 KB) is NOT — it is only in a
  `vite__mapDeps` dynamic list, so P31 holds. `vendor-shiki-langs` is the lazy-language
  table, not grammars, so the assertion is scoped to the engine and the exclusion is
  documented in the script. Worth a look if someone wants the last 31 KB.
- tests (`scripts/premountClosure.test.mjs`): a group with a hyphenated hash is matched;
  a sibling group sharing the prefix is excluded, and is still findable on its own.

**W3-X4 one realpath per open** (`src/main/repository.ts`, `src/main/repositorySessions.ts`)
- `RepositoryService.open(folderPath, resolved = false)`; `repositorySessions.open` passes
  `true` because it has already resolved the path. Every other caller keeps the old
  behaviour through the default.
- test: `open(path)` answers the realpath, `open(path, true)` answers the path as given
  (macOS temp roots are symlinked, so the two strings differ).

**W3-X3 + W3-X5 startup probe** (`scripts/perf/startup-probe.mjs`, `scripts/perf/cdp.mjs`)
- `paletteOpenAppMs`: read from the `horus:palette-open-to-focus` measure after focus,
  reported next to `openMs` and in both the medians and the PERF summary line.
- `emptyRows` now goes through a new `stableReading(read, {settleMs, everyMs, sleep})` in
  cdp.mjs: polls until two consecutive counts agree or the 100 ms settle window is up.
  Nulls never count as settled, so a renderer that stops answering is not mistaken for a
  stable count.
- `scripts/perf/README.md` documents both.
- tests (`scripts/perf/cdp.test.mjs`): settles on the first agreeing pair without draining
  the readings, answers the last reading when the count never settles, never settles on nulls.

- gates: lint exit 0; typecheck exit 0; `bun test src/main src/shared scripts` green;
  `bun run check:entry` passes against the existing out/renderer (not rebuilt).
- deviations: the W3-X2 assertion is scoped to the shiki engine, see the finding above.

## H2-5 DONE — final gates

- `npx react-doctor@latest` per owned tree, all zero issues:
  src/main 100/100, src/shared 100/100, extensions/horus 100/100, scripts 100/100.
- Whole repo (via `scratchpad/rd.sh`, which neutralises the stale index entry):
  **Score 87/100, 9 warnings, all in src/renderer** (track H1's ownership, still running):
  no-high-complexity-react-function x4 (AgentPanel:77, DiffDisplayControls:30,
  GitHubPanel:161, WorkspaceStage:26), prefer-html-dialog (FolderPicker:225),
  duplicate-jsx-subtree (GitHubPanel:99), no-reset-all-state-on-prop-change and
  no-adjust-state-on-prop-change x2 (RepositoryWorkspace:1284/1286/1287).
  Wave start was 30 warnings / no score at all.
- `bun run lint` exit 0. `bun run typecheck` exit 0.
- `bun test src/main src/shared scripts extensions`: 484 pass, 0 fail, 35 files.
- `bun run check:entry` passes against the existing out/renderer (no build run, per brief):
  entry closure 2,935 B, "WorkerPool absent · no vendor-shiki engine chunk in the
  pre-mount closure".
- `plans/perf-instant-plan.md` P13 row updated with H2's outcome (Notes cell only).
- Re-verified the folderIndex equivalence after every later edit: 103 vs 103 candidates,
  `JSON.stringify` identical, 14.8/15.3 ms before vs 10.2/9.1 ms after.

## needs-owner (repeated for the handoff)
- `git rm --cached extensions/horus/src/warmup-clipboard.ts` (or commit the working tree).
  Until the index stops listing that deleted file, `npx react-doctor@latest` prints
  "Results are incomplete: maintainability checks failed" and no score. This track is
  forbidden from writing the git index, so it was measured around instead of fixed.

## H2-1 UPDATE — the score now prints from a plain run

While this track was finishing H2-5, `extensions/horus/src/warmup-clipboard.ts` left the
git index (`git status` went from ` D` to `D `; not done by this track — no git index
command was run here). `git ls-files` no longer reports it, the ENOENT is gone, and a
plain `npx react-doctor@latest` prints **Score 87/100** with the maintainability pass
complete. That confirms the diagnosis exactly, and the needs-owner item is now satisfied.

Consequence worth flagging to the reviewer: with the maintainability pass finally running,
the project-level rules it owns report for the first time. `duplicate-jsx-subtree` went
from 1 site to 7 (GitBranchesTab:28, GitHistoryTab:14, GitHubPanel:99/286/346/373 …) —
partly H1's in-flight component splits, partly rules that were invisible while the pass
was failing. Whoever closes P13 at 100/100 has to clear those too; they are all in
src/renderer (H1's tree). Nothing outside src/renderer reports at all:
verified with `npx react-doctor@latest --verbose | grep -v src/renderer` -> no warnings.

`scratchpad/rd.sh` is no longer needed but is left in place: it is the way to measure
around this failure mode if an unstaged deletion turns up again.
