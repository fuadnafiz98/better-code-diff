# Track R — Wave 1 review fixes + probe fixes

## NOTE from reviewer (2026-09-05 14:31): previous Track R run died on a rate limit before logging.
Edits already on disk from that run (verify, finish, test, then log each section properly):
- R1: ignoredListing.ts walkIgnoredDirectory — depth>0 condition removed (done on disk); test additions in ignoredListing.test.ts (check they pass).
- R3: withIgnoredListingDeadline now takes a `run` token and passes it to onLate (done on disk); repository.ts #startIgnoredListing/#mergeIgnoredPaths partially updated — verify the guard is wired.
- R4: workspaceListing.ts 'vendor' removed and `stage: 'skeleton'` set (done on disk); contracts.ts has the `stage` line; check #refreshSnapshot/#refreshFolder set `stage: 'live'`.
- R2, R5, R6, R7: not started.

## R1 DONE
- Verified on disk (from the killed run): `src/main/ignoredListing.ts` `walkIgnoredDirectory` nested-repository check is now `if (entries.some((entry) => entry.name === '.git'))` — no `depth > 0`; comment explains the depth-0 case (`vendor/`).
- Test: `src/main/ignoredListing.test.ts` fixture `buildFixture` creates top-level ignored `vendor/` with its own `.git` and `vendor/lib/x.js`; equivalence test asserts legacy == new via `mergeVisiblePaths` and lists `vendor/`; new case `reports an ignored directory that is its own repository without descending into it` asserts `vendor/` present and `vendor/lib/x.js` absent.
- Gate: `bun test src/main/ignoredListing.test.ts src/main/workspaceListing.test.ts` -> 17 pass / 0 fail (1.39 s).
- Deviations: none.

## R2 DONE
- Code was already on disk from the killed run and is correct: `src/main/repository.ts` `refreshAfterExternalChange()` (`this.#mutation += 1; return this.refresh()`) with a doc comment; `src/main/repositorySessions.ts` `#createSession` builds `new RepositoryWatcher(() => repository.refreshAfterExternalChange(), ...)`.
- Tests added:
  - `src/main/repository.test.ts` `runs a fresh cycle for the external change a watcher tick reports`: starts `refresh()`, writes `watched.ts` after it started, calls `refreshAfterExternalChange()`; asserts the promise is not the in-flight one, that it settles after it (chained, not raced) and that it observes `{ path: 'watched.ts', status: 'modified' }`.
  - `src/main/repositorySessions.test.ts` `counts a watcher tick as an external change instead of joining an older refresh`: real `fs.watch` tick, `spyOn(registry.requireActive(), 'refreshAfterExternalChange')` is called.
- Gates: `bun test src/main/repository.test.ts -t 'external change'` -> 1 pass, run 3x (no flake); `bun test src/main/repositorySessions.test.ts` -> 14 pass / 0 fail; `bun run lint` -> only warning is Track C's `CommandPaletteHost.tsx` exhaustive-deps (not mine); `bun run typecheck` -> 5 errors, all in Track C's `App.tsx` / `CommandPalette.dom.test.tsx` (mid-edit, not mine) — retried in R7.
- Deviations: none.

## R3 DONE
- `src/main/ignoredListing.ts` (already on disk): `withIgnoredListingDeadline<Run>(listing, deadlineMs, run, onLate)` carries a run token and hands it to `onLate`; doc comment explains why (cooperative cancellation).
- `src/main/repository.ts`: `#startIgnoredListing` keeps the `AbortController` as the run identity and passes it through the deadline helper; `#mergeIgnoredPaths(ignoredPaths, run)` returns early on `this.#ignoredRun !== run`. This run widened the parameter to `AbortController | null` and added `mergeIgnoredPathsForTests(paths, 'current' | 'superseded')` next to it (same convention as the existing `getContentSearchMetricsForTests` / `getHeadCacheStatsForTests` hooks) because the real window is a few microseconds between two git walks.
- Tests: `src/main/ignoredListing.test.ts` `names the run that produced the late set so a superseded one can be dropped`; `src/main/repository.test.ts` `drops a gitignored set that lands after a newer refresh replaced its run` (superseded run -> no observer call and the snapshot's `paths` array identity is untouched; current run -> exactly one publish carrying the merged list).
- Gates: `bun test src/main/repository.test.ts -t 'gitignored set'` -> 1 pass; `bun test src/main/ignoredListing.test.ts` -> pass (see R1); `npx tsc -b tsconfig.node.json` -> zero errors in my files (remaining errors are Track D's `index.ts`/`pullRequestRoots.*`).
- Deviations: added the `mergeIgnoredPathsForTests` hook (not in the brief) rather than leaving the guard untested; documented in place.

## R4 DONE
- Already on disk from the killed run, verified: `src/main/workspaceListing.ts` `SKIP_DIRECTORIES = new Set([...EXCLUDED_DIRECTORY_SET, '.git'])` (no `'vendor'`) and `listRootSnapshot` returns `stage: 'skeleton'`; `src/shared/contracts.ts` `RepositorySnapshot` has one added line `stage?: 'skeleton' | 'live'` with a one-line doc comment; `src/main/repository.ts` `#refreshSnapshot` and `#refreshFolder` both set `stage: 'live'`.
- Tests updated this run:
  - `src/main/workspaceListing.test.ts`: fixture now has a tracked `vendor/pkg/lib.go`, asserted present in the listing; asserts `snapshot.stage === 'skeleton'`.
  - `src/main/repository.test.ts` new `marks the opening listing as a skeleton and every refreshed snapshot as live`: `open()` -> `skeleton`, `refresh()` -> `live` for a git repository and for an ordinary folder (`#refreshFolder`).
- Gates: `bun test src/main/workspaceListing.test.ts` -> 4 pass; `bun test src/main/repository.test.ts -t 'skeleton'` -> 1 pass.
- Deviations: none. No renderer code touched (P27 consumes `stage` in Wave 3).

## R5 DONE
- `scripts/check-entry-chunk.mjs`: `MAX_PREMOUNT_BYTES` 1_900_000 -> 1_700_000 (Wave 1 closure measured 1,649,485 B). No other reference to the old number in the repo.
- Gate: `bun test scripts/` -> 14 pass / 0 fail. Did not run `bun run build` / `bun run check:entry` (Track C runs the build at the end), so the new ceiling is unverified against a fresh build in this run.

## R6 DONE
Files: `scripts/perf/cdp.mjs`, `scripts/perf/timeline.mjs` (new) + `timeline.test.mjs` (new), `scripts/perf/startup-probe.mjs`, `scripts/perf/open-folder-probe.mjs`, `scripts/perf/pr-open-probe.mjs`, `scripts/perf/cdp.test.mjs`, `scripts/perf/README.md`.

(a) startup-probe FCP: added `PAINT_SETTLE_MS = 1_000` + `paintsWithContentfulPaint()`, which re-reads `performance.getEntriesByType('paint')` for up to 1 s after the poll loop until `first-contentful-paint` exists. Added `fcpRendererMs` (renderer clock, the number the plan targets at <= 200 ms) next to `fcpMs` (from the `open` call). Verified: fcpMs 946/486, fcpRendererMs 308/164 (was null in every Wave 1 sample).

(b) open-folder-probe: rewritten as ONE poll loop with a single 20 s deadline (`OPEN_TIMEOUT_MS`) recording first-seen for heading / treeRows / branch / published.
- Ground truth taken from the installed build (scratchpad/probe-dev/inspect-*.mjs): (1) only ONE `.sidebar-heading-identity` is in the DOM at a time and it holds the sidebar toggle + branch button — never the folder name, so scoping alone could not have worked; the folder's identity is the active world tab label (`useReviewWorlds` sets `label: snapshot.name`). (2) `.project-tree` is a `<file-tree-container>` custom element that renders its rows into a SHADOW ROOT — `document.querySelectorAll('#repository-explorer [role="treeitem"]')` is 0 however many rows are on screen. New shared `TREE_ROW_COUNT` reads `container.shadowRoot.querySelectorAll('[data-item-path]')`; the startup probe's `rows` used the same broken selector and now reports 44 instead of 8.
- liveSnapshot: `window.repository` is FROZEN and non-configurable (contextBridge) — verified live: assigning a method is a silent no-op and `Object.defineProperty(window, 'repository', …)` throws `TypeError: Cannot redefine property`. Wrapping openPath/openPickedFolder/openFolder in HOOKS as the brief describes is therefore impossible. Instead the probe takes the earlier of two sightings and reports which one won as `liveSource`: a publish carrying `branch != null || stage === 'live'` (`change`), or the branch rendered in the explorer heading for the active folder (`dom`) — a skeleton has `branch: null` and renders "Detached HEAD", so the branch is exactly the skeleton/live boundary.
- Verified against the real DOM: imux 16 ms, materialsx-core-3 196 ms, better-code-diff 103 ms — headingMs/treeRowsMs/liveSnapshotMs all non-null, `liveSource: "dom"` in all three (the P04 race wins and nothing is published, which is precisely why Wave 1 got nulls).

(c) pr-open-probe: `measure()` is one poll loop with a single 20 s deadline (`PR_TIMEOUT_MS`); DOM conditions (tab, surface, first code view) are timed by first sighting, progress events by `summarizePullRequestProgress` (metadata, first file page — keyed on the payload carrying `files`, not on a kind list, so `replace`/`checks` cannot be mistaken for a page — done, fileCount, and `progressKinds` with the first time and count of EVERY kind seen). Exits on done+codeView, else at the deadline with `timedOut: true`. Verified on PR 717: warm firstCodeViewMs 1,440 ms and cold 2,696 ms (Wave 1 reported 106,205 ms for the same moment); `progressKinds: [metadata]` and `timedOut: true` now show honestly that no `files`/`done` event reaches the renderer for a cached PR (finding PR-2, Track D's P23).

(d) `statistics()` + `summaryLine()` in cdp.mjs; every probe prints a final `PERF {"probe":…,"label":…,"metrics":{name:{samples,median,min,max}}}` line. README documents it plus the new fields and env vars.

Tests: `scripts/perf/timeline.test.mjs` (7 tests: first-seen bookkeeping, independent conditions, progress digest incl. unknown kinds and out-of-order events), `scripts/perf/cdp.test.mjs` (+2: statistics, summaryLine).
Gates: `bun test scripts/` -> 24 pass / 0 fail; `node --check` on all five probe files; three live probe runs against `~/Applications/Horus.app` (quit afterwards, `pgrep -x Horus` empty).
Deviations: the IPC wrap in HOOKS is impossible (frozen contextBridge object) — replaced by the DOM branch marker, documented above and in the README.

## R7 DONE
- `bun run lint` -> exit 0, no warnings (the earlier `CommandPaletteHost.tsx` warning was Track C's and is gone).
- `bun run typecheck` (`tsc -b tsconfig.json`) -> exit 0, whole repo (Track C/D errors seen mid-run are resolved).
- `bun test src/main/` -> 321 pass / 0 fail across 20 files (16.7 s).
- `bun test scripts/` -> 24 pass / 0 fail across 3 files.
- Did NOT run `bun run build` / `bun run check:entry` / `update:mac` (Track C owns the build at the end), and did not run the full `bun test` to completion: it is dominated by renderer dom tests owned by the other two tracks and was still running after 10 minutes, so it was killed. Nothing in this track touches the renderer; `stage` is an optional field and typecheck covers the renderer.
- Live probe runs used for verification are in scratchpad/results/r6-verify.jsonl; `pgrep -x Horus` is empty.
