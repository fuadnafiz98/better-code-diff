# Track A — main-process git path

## P01 DONE
- New `src/main/ignoredListing.ts`: two-phase ignored listing. Phase 1
  `git ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z`,
  phase 2 `partitionIgnoredEntries` (drop excluded dirs, filter .pyc/.pyd/.pyo) +
  async `readdir` expansion with nested-repo boundary (`<dir>/`), `.git` skip,
  depth cap 12, `MAX_EXPANDED_IGNORED_DIRECTORIES = 32`, `maxPaths` cap, sorted output.
  Ported from scratchpad verify3.mjs (not imported).
- Moved `EXCLUDED_DIRECTORIES` / `EXCLUDED_DIRECTORY_SET` / `EXCLUDED_IGNORED_EXTENSIONS`
  from repository.ts into ignoredListing.ts (repository.ts imports them) so the
  listing module owns them and the test can rebuild the legacy pathspecs.
  Deleted `GIT_IGNORED_EXCLUSION_PATHSPECS` (no other user).
- `ignoredListing.withIgnoredListingDeadline(listing, ms, onLate)`: resolves with the
  paths inside the deadline, else null + `onLate` when it lands; rejection -> null,
  no onLate.
- repository.ts: `refresh()` now runs two spawns on the critical path plus the
  ignored listing raced against `IGNORED_LISTING_DEADLINE_MS = 400`
  (`IGNORED_LISTING_TIMEOUT_MS = 10_000` hard abort). Fields `#ignoredPaths`
  (last successful set, reused on a miss) and `#ignoredRun` (AbortController,
  aborted by a newer run and by `dispose()`). `#mergeIgnoredPaths` folds a late set
  into the published snapshot (guarded on `snapshot.paths === trackedCache.paths`)
  and announces it through the new `setSnapshotObserver` hook.
- repositorySessions.ts: `#createSession(repository)` factory now wires the watcher,
  the self-write observer and the new snapshot observer (publishes
  `{ snapshot, changedPaths: [], revision: Date.now() }` after `watcher.sync`);
  `#stopSession` clears it.
- `#visiblePaths` cache kept; ignored side now stored by reference with an identity
  fast path before `sameStringList`.
- Files: src/main/ignoredListing.ts (new), src/main/ignoredListing.test.ts (new),
  src/main/repository.ts, src/main/repositorySessions.ts, src/main/repository.test.ts.
- Tests: ignoredListing.test.ts (11) — legacy-vs-new equivalence on a temp git repo
  (tracked/untracked/ignored dirs/node_modules/nested repo/.pyc), nested-repo shape,
  path cap, abort, partition unit tests, deadline helper incl. slow phase-1 injection.
  repository.test.ts +1 — refresh lists ignored files and re-lists a new one.
- Gates: `bun run lint` 0; `bun run typecheck` 0;
  `bun test src/main/ignoredListing.test.ts src/main/repository.test.ts
   src/main/repositorySessions.test.ts src/main/repositoryWatcher.test.ts
   src/main/workspaceListing.test.ts` -> 160 pass / 0 fail.
- Measured `RepositoryService.refresh()` on ~/Developer/materialx/materialsx-core-3:
  107 / 59 / 72 ms (was 3,520 ms), 3,026 paths — same count as the old command.
- Deviations: the `#visiblePaths` key is the expanded ignored list (identity, then
  element-wise) rather than the phase-1 buffer; the expanded list subsumes it.
  The service-level late merge is covered through `withIgnoredListingDeadline`
  (deterministic) rather than by slowing a real git child.
- needs-owner: none.

## P02 DONE
- gitCommands.ts: new `commandEnvironment()` (`{ ...process.env, GIT_OPTIONAL_LOCKS: '0' }`)
  applied to `runCommand`'s execFile options and to `GitObjectReader`'s
  `git cat-file --batch` spawn. Verified on a temp repo: a plain
  `git status --porcelain=v2` moves `.git/index` mtime, the same command with
  `GIT_OPTIONAL_LOCKS=0` does not.
- repository.ts: `refresh()` announces `GIT_INDEX_PATH = '.git/index'` through the
  existing `#selfWriteObserver` before the git commands and again after they settle
  (re-arms the 1 s window however long they took). `normalizeChangedPath` untouched.
- Files: src/main/gitCommands.ts, src/main/repository.ts,
  src/main/gitCommands.test.ts (new), src/main/repositoryWatcher.test.ts,
  src/main/repository.test.ts.
- Tests: gitCommands.test.ts (5) — child sees `GIT_OPTIONAL_LOCKS=0`, rest of env
  intact, abort message, split/compare helpers. repositoryWatcher.test.ts +1 —
  an announced `.git/index` write triggers no refresh across six armed rewrites
  while an unannounced one does, and `.git/HEAD` still refreshes with the index
  armed (added `rewriteMetadataUntil`, since `.git/*` uses the 350 ms metadata
  debounce and the existing 150 ms rewrite loop never let it flush).
  repository.test.ts +1 — `refresh()` leaves `.git/index` mtime unchanged and
  emits `['.git/index', '.git/index']` to the self-write observer.
- Gates: `bun run lint` 0; `bun run typecheck` 0;
  `bun test src/main/gitCommands.test.ts src/main/repositoryWatcher.test.ts
   src/main/repository.test.ts src/main/ignoredListing.test.ts
   src/main/repositorySessions.test.ts` -> 164 pass / 0 fail.
- Deviations: none.
- needs-owner: none.

## P03 DONE
- repository.ts: public `refresh()` is now a dedupe wrapper around the renamed
  `#refreshSnapshot()`. New fields `#refreshRun`, `#mutation`, `#refreshMutation`
  and a module-level `ignoreSettled()`. A caller whose `#mutation` matches the
  in-flight run joins it; a caller after a write chains a new run behind it
  (`pending.then(ignoreSettled, ignoreSettled).then(start)`) rather than racing.
  The queued run re-reads `#mutation` when it actually starts, so callers arriving
  while it waits need no extra cycle. `dispose()` clears `#refreshRun` and both
  counters.
- `#mutation += 1` in `switchBranch`, `pullCurrentBranch`, `checkoutPullRequest`
  (before their `return this.refresh()`) and in `saveWorkingFile` (right after the
  rename lands, next to the existing `#snapshotRevision` bump).
- Files: src/main/repository.ts, src/main/repository.test.ts.
- Tests: repository.test.ts +2 — two concurrent `refresh()` calls return the same
  promise and the same snapshot object while a settled run is not reused; a refresh
  started before `saveWorkingFile` does not satisfy the request made after it, the
  two settle in order (chained) and the second observes the write.
- Gates: `bun run lint` 0; `bun run typecheck` 0; `bun test src/main/` ->
  292 pass / 0 fail (19 files).
- Deviations: the "in-flight run does not observe the write" assertion was dropped
  from the test — a refresh that spawns `git status` at the same moment as the save
  legitimately sees either state. The test asserts distinct promises, chained
  ordering and that the post-write refresh observes the write.
- needs-owner: none.

## P04 DONE
- workspaceListing.ts: `listRootSnapshot` rewritten as a bounded walk —
  `MAX_LISTING_PATHS 400 -> 2_000`, `MAX_LISTING_DEPTH = 3`, files of a level before
  its subdirectories (a truncated listing is the top of the tree), dot-entries
  included, `SKIP_DIRECTORIES = EXCLUDED_DIRECTORY_SET + '.git' + 'vendor'`.
  Measured on core-3: 266 paths (was 84), 1.0-2.7 ms warm / 25 ms cold.
- repositorySessions.ts: new `#raceLiveSnapshot(session)` starts `refresh()` and
  races it against `LIVE_SNAPSHOT_DEADLINE_MS = 150`. Win -> `watcher.sync(live)`,
  return the live snapshot, publish nothing (the caller already has it). Loss ->
  return the listing and publish the refresh when it lands via the extracted
  `#publishRefreshed(session, previous, live)` (also used by `#refreshAndPublish`).
  Applied in `open()` to the new-session branch, the `known != null &&
  current == null` branch and the realpath-collision `existing != null &&
  current == null` branch. The new session's watcher now starts with the snapshot
  actually returned.
- Files: src/main/workspaceListing.ts, src/main/repositorySessions.ts,
  src/main/workspaceListing.test.ts, src/main/repositorySessions.test.ts,
  src/main/repository.test.ts.
- Tests: repositorySessions.test.ts +2 — a refresh resolving in 10 ms is what
  `open()` returns with zero publishes; a refresh resolving in 400 ms returns the
  listing and later publishes the live snapshot with `changedPaths: ['readme.md']`.
  workspaceListing.test.ts rewritten +1 — three levels, `.github/workflows/ci.yml`
  kept, `node_modules` / `.venv` skipped, path cap takes the top of the tree first.
  repository.test.ts — the folder-open assertion now expects `.env` in the listing
  (the live folder snapshot has always listed it; the old listing hid every
  dotfile, which is exactly the skeleton-vs-live mismatch P04 removes) and adds
  `not.toContain('node_modules/dependency.js')`.
- Gates: `bun run lint` 0; `bun run typecheck` 0; `bun test` -> 887 pass / 0 fail
  (118 files).
- Deviations: no snapshot discriminator was added (see needs-owner); nothing in
  `RepositorySnapshot` fits, and `shared/contracts.ts` is Track D's file.
- needs-owner (src/shared/contracts.ts, Track D): add a stage discriminator to
  `RepositorySnapshot` so P27 can re-derive the workspace view when a skeleton is
  replaced. Exact edit wanted:
      export interface RepositorySnapshot {
        root: string
        name: string
        kind: 'git' | 'folder'
    +   /** 'skeleton' is the bounded directory listing shown while git answers. */
    +   stage?: 'skeleton' | 'live'
        ...
  With it, `listRootSnapshot` would set `stage: 'skeleton'` and
  `RepositoryService.#refreshSnapshot` / `#refreshFolder` would set `stage: 'live'`.
  Until then the only signal is `kind === 'git' && branch == null && statuses === []`.

## P05 DONE
- repositorySessions.ts: new `refresh(root)` resolves the session by root and reuses
  `#refreshAndPublish`; `refreshActive()` is now a one-line delegate to it.
- index.ts (`openRepository`, one line): the cache-hit branch calls
  `repositorySessions.refresh(snapshot.root)` instead of `refreshActive()`, so a
  background open (`activate = false`, PR warmup) refreshes the repository it just
  opened rather than whichever one the user is looking at.
  `persistWorkspaceFromSnapshot` stays gated on `live.root === activeRoot`.
- Files: src/main/repositorySessions.ts, src/main/index.ts,
  src/main/repositorySessions.test.ts.
- Tests: repositorySessions.test.ts +1 — with two sessions open and the second
  active, `refresh(backgroundRoot)` calls the background repository's `refresh`
  once and the active one's not at all; an unknown root resolves to null.
- Gates: `bun run lint` 0; `bun run typecheck` 0; `bun test` -> 888 pass / 0 fail.
- Deviations: none.
- needs-owner: none.

## Post-P05 fix (found while re-measuring)
- The P03 dedupe released `#refreshRun` in a `.finally` chained after the run, two
  microtask hops behind the caller's own `await`, so `await refresh()` followed
  immediately by `refresh()` handed back the settled run (measured as a 0 ms second
  "refresh"). The release now happens inside the run's own then-handlers, guarded by
  a `#refreshGeneration` counter that `dispose()` also bumps. Test strengthened:
  the caller that just awaited a run gets a new promise and a new snapshot.
- Re-measured `refresh()` on core-3: 53 / 45 / 52 ms across three real cycles.
