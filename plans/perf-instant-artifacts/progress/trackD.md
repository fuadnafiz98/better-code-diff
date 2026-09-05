# Track D — Cmd+H

## NOTE from reviewer (2026-09-05 14:31): previous Track D run died on a rate limit before editing anything. Start from P21.

## P21 DONE
- `src/main/pullRequestRoots.ts` rewritten: `PullRequestRootResolver` class (URL-keyed
  resolution map, 5 s TTL after settle; remotes cache 60 s; per-slug negative cache 60 s;
  `resolve(url, 'quick'|'full')`, `pending(url)`, `forgetRoot(root)`). Quick stage probes
  tiers [remembered] -> [open session roots] -> [approved roots] with no folder walk;
  full stage adds `catalogRoots()` (folderIndex) filtered against what quick already
  probed. `findMatchingPullRequestRoot` lost `preferredRoots` (always [] now) and gained
  `firstMatchingRootInTiers` (exported, tier-sequential, wave-concurrent inside a tier).
- `src/main/index.ts`: module-level `pullRequestRoots` resolver replaces
  `findPullRequestRoot`; `previewPullRequestFolder` now stats the remembered folder and
  otherwise joins a live resolution — never walks, never spawns; `resolvePullRequestRepository`
  uses `resolve(url)` (full); `applyExternalReview` is async, races a quick resolution
  against `EXTERNAL_REVIEW_ROOT_DEADLINE_MS = 150` and publishes the root with the open
  request; `publishPendingOpenPullRequest` sends `(url, root)`; new `pendingOpenPullRequestRoot`.
- Contract: `onOpenExternalPullRequest(listener: (url, root: string | null) => void)`
  (`src/shared/contracts.ts`), preload forwards the second argument.
- Tests: `src/main/pullRequestRoots.test.ts` rewritten (17 tests: remembered-only probe,
  tier fallthrough, no catalog on quick, catalog only after a quick miss, catalog skips
  probed roots, shared promise across 3 concurrent callers, quick->full upgrade reuse,
  TTL reuse/expiry, remotes cache across URLs, negative cache, `pending`, `forgetRoot`,
  probe failure isolation).
- Gates: `bun run lint` clean; `bun run typecheck` clean;
  `bun test src/main/pullRequestRoots.test.ts src/main/pullRequestWarmup.test.ts src/main/sessionStore.test.ts` 31 pass.
- Deviations: resolver is a class with injected sources instead of module-level maps —
  same single instance in index.ts, but unit-testable with a fake clock.
- needs-owner (App.tsx, Track C): `src/renderer/src/App.tsx:~702` `const open = (url: string)`
  should become `(url: string, root: string | null)` and call
  `gitWorkflow.openPullRequestFromLocator(url, root)` so the resolved root is used as
  `preferredRoot`. Not applied: App.tsx is Track C's. Main already de-duplicates the
  resolution, so this is a small extra win, not a correctness fix.

## P22 DONE
- `src/main/index.ts`: `CLIPBOARD_WARMUP_MS` 800 -> 2000; `startClipboardWarmup` polls
  through the new pure `clipboardWarmupDecision` (skips entirely and keeps the `seen`
  marker while no window is visible, so the URL is still picked up on the next poll after
  the window returns) and also polls on `browser-window-focus` / `activate`.
- `warmupPullRequest`: cooldown recorded before the work (`warmupCooledDown` helper), so a
  slug with no local checkout is cooled down too; it now calls `primePullRequest`, which
  quick-resolves the root (stage 1 only, never the folder catalog) and starts the review
  flight only when a session for that root already exists. No `openRepository`, no
  `refreshActive`, no repository refresh on any warmup path.
- New `src/main/pullRequestWarmup.ts` + `.test.ts` (7 tests: new URL, unchanged text,
  non-PR text, hidden window keeps the marker, cooldown before/inside/after).
- Raycast: deleted `extensions/horus/src/warmup-clipboard.ts`, removed the `warmup-clipboard`
  10 s background command from `extensions/horus/package.json`, dropped its generated types
  from `raycast-env.d.ts`, updated the extension description and `README.md` (the app polls
  the clipboard itself while visible).
- Gates: `bun run lint` clean; `bun run typecheck` clean;
  `bun test src/main/pullRequestWarmup.test.ts` 7 pass.
- Deviations: none. Resumption after the window returns is the next 2 s tick plus the
  focus/activate hooks rather than a dedicated resume path.

## P23 DONE
- New `src/main/pullRequestFlights.ts`: `PullRequestReviewFlight` — multicast fan-out,
  synchronous replay for a late joiner (metadata, pages or the replacement that
  superseded them, checks, done), `streamed` flag, `abort` controller owned by the
  flight, `attach`/`detach` refcount so a fetch ends only when the last *claiming*
  caller cancels (a warmup never claims).
- `src/main/repository.ts`:
  - `#reviewAborts` -> `#reviewRequests: Map<requestId, PullRequestReviewFlight>`;
    `#reviewFlights: Map<selector, PullRequestReviewFlight>`. `getPullRequestReview`
    gained a 4th arg `intent: 'foreground' | 'warmup'`; a joiner replays and shares
    the promise; the reply is stripped per caller (`onProgress != null && streamed`).
    Deleted the dead `cancelPullRequestReview(requestId)` at the top (PR-14).
  - `PullRequestReviewCache`: `<sha1('index', normalizedUrl)>.latest.json` pointer
    (`readIndex`, `#writeIndex`, `#indexPath` normalizes both spellings of the URL);
    `sweep` skips index files when counting entries and caps them by mtime.
    `MAX_PULL_REQUEST_CACHE_ENTRIES` 20 -> 60.
  - `#loadPullRequestReview` split into `#openCachedPullRequestReview` (URL index ->
    entry -> metadata + one files page + done, no `gh` at all, works with gh absent),
    `#revalidateCachedPullRequestReview` (`gh pr view --json headRefOid` + background
    checks; same oid -> cached, different -> silent refetch + `{ kind: 'replace' }`),
    and `#fetchPullRequestReview` (diff started concurrently with the metadata hop,
    pages staged until the metadata event; legacy oid-keyed cache hit aborts the diff
    and writes the index back; `changedFiles > 300` aborts the diff and pages the
    files API instead).
  - `PULL_REQUEST_REVIEW_FIELDS` dropped `files` and the check fields; new
    `#loadPullRequestChecks`/`#emitPullRequestChecks` emit `{ kind: 'checks' }`;
    `#runPullRequestJsonCommand` deleted. `#seedPullRequestIdentity` seeds
    `#pullRequestIdentities` from the metadata (selector + canonical URL).
- Contracts: `PullRequestReviewProgress` gains `replace` and `checks`;
  `SessionRestoreHint` gains `pendingPullRequestUrl` (`parseRestoreHint` normalizes it).
- `src/main/index.ts`: `currentRestoreHint()` carries `pendingOpenPullRequestUrl`;
  `primePullRequest` passes `intent: 'warmup'`.
- Renderer: `useGitWorkflow` handles `checks` (new `setPatchChecks`) and `replace`;
  new module-level `fetchPullRequestPatch` collects streamed pages for
  `restoreReleasedWorld` (the reply is now stripped on the cached path);
  `openPullRequestFromLocator` cancels the outstanding review of the tab it retargets.
  `useReviewWorlds` gains the `set-patch-checks` action + reducer case.
  `boot.tsx` preloads MultiFileReview when the hint carries a pending PR URL.
- Raycast: `lib/horus.ts` rewritten around a pure `horusLaunchPlan` — `pgrep -x Horus`
  first, running -> `open horus://…`, cold -> `open -a Horus --args --horus-url=…`,
  warmup never launches; distinct HUD for an unregistered scheme
  (`HORUS_SCHEME_UNREGISTERED`) vs a missing app. `lib/open.ts` and
  `open-pull-request.tsx` dispatch the deep link before `closeMainWindow`. README note.
- Item 8 (ack pending URL) was already in place from an earlier round; verified.
- Tests: `src/main/pullRequestFlights.test.ts` (10), `repository.test.ts` +4
  (index round-trip/normalization, corrupt index, cached open emits
  metadata/files/done and replies stripped, warmup no longer steals the flight),
  `sessionRestore.test.ts` +1, `boot.dom.test.tsx` +1,
  `extensions/horus/src/lib/horus.test.ts` (4). Updated the two cache tests for the
  new cap and the index files.
- Gates: `bun run lint` clean; `bun run typecheck` clean;
  `bun test src/main/pullRequestFlights.test.ts src/main/repository.test.ts src/main/pullRequestRoots.test.ts src/main/pullRequestWarmup.test.ts src/shared/sessionRestore.test.ts src/renderer/src/boot.dom.test.tsx src/renderer/src/useGitWorkflow.dom.test.tsx src/renderer/src/useReviewWorlds.test.ts extensions/horus/src/lib/horus.test.ts` all pass.
- Deviations:
  1. Item 9's "abort the previous foreground flight when a different PR arrives" is
     implemented in the renderer (cancel the outstanding request of the tab being
     retargeted) rather than in `RepositoryService`. Main cannot tell a retarget from
     a second tab, and aborting a flight another world is still reading would break
     that tab. The main half is the refcounted `attach`/`detach`.
  2. The cached open emits one files page rather than re-chunking the stored patch:
     it is already complete, and chunking only helps a stream.
  3. `#openCachedPullRequestReview` runs before `getGhExecutable()` so a cached review
     opens even when `gh` cannot be found.
  4. The cached-path reply is stripped, which made `restoreReleasedWorld`'s
     "empty reply -> reopen -> retry" dance unable to recover the patch; it now reads
     the progress stream via `fetchPullRequestPatch`.
- needs-owner: none.

## P17 (main half) DONE
- `src/main/repository.ts`:
  - `MAX_SEARCH_RESULTS` 200 -> 24; new `MAX_OPEN_FILE_SEARCH_RESULTS = 200`,
    `CONTENT_SEARCH_MATCHES_PER_FILE = 20`, `CONTENT_SEARCH_MAX_FILESIZE = '1M'`,
    `CONTENT_SEARCH_THREADS = max(1, min(4, cpus().length))`.
  - `searchContent(query, forOpenPath?)`: one logical search, one or two rg children
    (`ActiveContentSearch { children: Set<ChildProcess> }`), run through the new
    private `#runContentSearch(search, root, query, { cap, matchesPerFile, path })`.
    The open-file pass is capped at 200 with `--max-count 200` and never rejects the
    palette's search (a deleted open file resolves to []).
    `mergeContentSearchResults` keeps the repository hits first and appends the
    open file's extras, deduped on path:line:column.
  - rg args gained `--max-filesize 1M` and `--threads <cap>`.
  - Cap reached -> `capped = true`, drop the buffer, `stdout.destroy()`, kill: the
    JSON stream is no longer parsed (or even concatenated) past the cap.
  - `classifySearchCompletion` takes an optional `resultCap` (defaults to
    `MAX_SEARCH_RESULTS`) so the 200-cap pass is not misread as interrupted.
  - New exported pure helpers `contentSearchOpenPath` (refuses absolute paths, `..`,
    empty and over-long values) and `mergeContentSearchResults`.
  - `#cancelActiveSearch` kills every child of the active search.
- Wiring: `contracts.ts` `searchContent(query, forOpenPath?)`, preload forwards
  `forOpenPath ?? null`, `index.ts` searchContent handler passes it through.
- Tests (repository.test.ts, +6): `contentSearchOpenPath` accept/refuse,
  `mergeContentSearchResults` order + dedupe + empty, `classifySearchCompletion`
  with an explicit cap, and two rg integration tests (30 files + a 40-hit open file:
  24 rows without `forOpenPath`, all 40 open-file hits with it, no duplicates;
  an escaping open path is ignored).
- Gates: `bun run lint` clean; `bun run typecheck` clean;
  `bun test src/main/repository.test.ts` 139 pass.
- Deviations: the `searchContent` IPC handler in `index.ts` is outside the PR/clipboard
  functions my brief lists, but P17's main half cannot reach the renderer without it;
  it is a 2-line Edit and nobody else owns index.ts this wave.
- needs-owner (Track C, `useRepositorySearch.ts`): nothing passes `forOpenPath` yet.
  The renderer should call `searchContent(query, openPath)` with the currently open
  file's repository-relative path so the DiffSurface markers stay complete now that
  the repository-wide cap is 24.

## P23 addendum — `replace` had to rekey the world
- `patchWorldId(review)` embeds `baseOid:headOid`, so the existing `replace-patch`
  reducer guard (`patchWorldId(action.review) === world.worldId`) silently dropped a
  force-pushed replacement — the whole point of the `replace` event. Added
  `patchReviewIdentity(review)` (pull request URL, or the local review id) and a
  separate `replace-patch-head` action that matches on that identity and rewrites
  `review`, `patchPages`, `patchLength`, `baseOid`, `headOid` in place.
  `useGitWorkflow` uses `replacePatchHead` for `kind: 'replace'`; the existing
  `replace-patch` path (adopting the resolved review at the same oids) is untouched.
- Known wart (documented, not fixed): the tab keeps the `worldId` it was opened with,
  so it no longer matches `patchWorldId(currentReview)`. Rekeying would orphan the
  navigation/view caches and strand the in-flight loader, which holds the old id.
  Consequence: reopening the same pull request after a force push while the updated
  tab is still open creates a second tab. `openPatchWorld`'s identity matching is
  Track E/C territory.
- Tests: `useReviewWorlds.test.ts` +2 (force-pushed replace keeps the tab id and takes
  the new oids/patch, and refuses a different pull request; checks patch the header
  without disturbing the patch pages).
- react-doctor: `npx react-doctor@latest --verbose` reports the same 25 warnings as
  the baseline and none in any file this track touched. It printed
  "Score not shown because lint or maintainability analysis could not complete"
  (maintainability checks failed) so the numeric score could not be compared; the
  warning list is identical to the baseline.
