# GitHub working-set replica

**Status:** revised architecture plan after a second-pass critique. Not executor-sliced. Do not implement until a later pass cuts work from Stage 0–2.

**Companion:** [`grok-github-fast.html`](./grok-github-fast.html) — interactive diagrams of the same system.

**Product:** Horus is a tabbed local review workspace. GitHub is a website that happens to show diffs. The feeling of review must never wait on GitHub.

**Goal:** a process-wide **working-set replica** of GitHub *social* state, served from SQLite, with Git objects read from the local object database. GitHub remains the source of truth and the sequencer. The Mac is the read path.

This is **not** a local GitHub, not a forge, and not Continuity-on-a-laptop. Those metaphors caused the first draft to overbuild.

---

## 0. Critique of the first draft

The first draft (`grok-github-fast.md` before this revision) copied PR Cockpit too faithfully and analogized Cursor's storage layer too hard. A second pass against *this* codebase, not against Cockpit's README, found real faults.

Outcome of the rethink: **revised**. The research still holds. The architecture is narrower, the first slice is smaller, and three factual errors are gone.

### 0.1 Must fix (were wrong)

**1. Cockpit's 20 ms is not a Horus budget.**
PR Cockpit paints a custom HTML PR page from SQLite. Horus mounts Pierre CodeView. Packaged warm-cache *review usable* is already **652 ms median** (`IDEAS.md`, 2026-08-30). A replica can make *GitHub metadata* tens of milliseconds. It cannot make CodeView 20 ms. Mixing those numbers would make Stage B look like a failure when the viewer is doing its real job.

Budgets below are split: **replica read** vs **review surface**. Never add them into one vanity ratio against GitHub.com.

**2. `--filter=blob:none` cannot produce a diff.**
`git diff` needs blob bytes. A blobless fetch of `refs/pull/N/head` gives commits and trees. The first `git diff base...head` then lazy-fetches every changed blob, or fails. The first draft recommended blobless fetch as the default path to local diffs. That is the opposite of an optimization for the review desk.

Correct default: use objects already in the checkout; if the PR head is missing, fetch **that one ref with blobs** (normal `git fetch` of `refs/pull/N/head`). Partial clone is a tool for *unregistered* giant repos, which Horus currently refuses — it asks for a checkout.

**3. GitHub review threads are on GitHub's line map, not ours.**
Remote threads arrive as `path + line + diffSide` on GitHub's merge-base diff. Horus already repositions *local* drafts with text/context/blob anchors (`reviewThreadAnchors.ts`). Substituting `git diff --find-renames` for `gh pr diff` can shift hunks (rename detection, algorithm, ignore-space, submodule ellipsis). Comments then sit on the wrong line or vanish.

Correct split:

- **Bytes** (file sides in CodeView) → local Git objects, blob OIDs.
- **Coordinates** for GitHub threads and for submitting inline comments → GitHub's patch / GitHub's `line`+`side`+`commit_id`.
- Local git diff is allowed as a *fallback* when GitHub returns 406 `too_large`, and thread attachment then uses the existing text-anchor path, not GitHub line numbers blindly.

**4. One fingerprint fights scoped refresh.**
Hashing head + comments + checks + mergeable into one value means a CI tick invalidates threads. Cockpit avoids that with `PrDetailScope`. A single hash is fine as an **agent wake key** (tuple of slice versions). It is not the cache identity.

**5. ETags do not survive token rotation.**
GitHub's server-side ETag includes the `Authorization` header. Keying rows by login and copying them onto a new token still 200s. On token change, drop REST ETags. Do not promise 304s across `gh auth token` refresh.

**6. Comment POST is not idempotent.**
The first draft said mutations "retry if it failed." Auto-retry of `POST /issues/{n}/comments` duplicates comments. Only idempotent writes may auto-retry (resolve thread, some PATCHes). Comments, reviews, and inline comments wait for an explicit user/agent retry.

**7. `involves:@me` is not the git panel.**
Horus `pr list` is **open PRs in the current repo**, limit 30, no check rollup. The inbox query is a separate, viewer-scoped search. Replacing the panel with Cockpit's `involves:@me` search would hide PRs in the open repository that do not involve the user. Keep both lists. Do not merge them in the replica.

### 0.2 Should fix (overbuilt or misplaced)

**8. "Local GitHub instance" and Continuity/Spokes as architecture.**
Useful as *why GitHub.com is slow*. Misleading as *what to build*. A laptop SQLite file is stale-while-revalidate. It is not a WAL-primary with rendezvous hashing. Demoted to background.

**9. Webhook relay as a load-bearing piece.**
GitHub App + Cloudflare Worker + HMAC is a product of its own. Horus already has a cheaper leak: `usePullRequestConversation` spawns `gh api graphql` every **30 s** (backoff to 5 min on failure). Replacing that poll with a disk read is the first user-visible win. Relay stays **optional Stage 4**.

**10. Agent loopback HTTP in v1.**
Horus agents already speak IPC with an explicit repository root and tab subject. A second HTTP server is another bind, token, and CORS surface. `listen` can be an IPC method (and later a CLI that talks to the running app). Loopback HTTP is Stage 4+, off by default.

**11. Fetching into the user's checkout.**
`refs/horus/pr/N/head` updates reflogs and can fire `RepositoryWatcher`. Default: a **bare mirror** under Application Support with `objects/info/alternates` pointing at the checkout's object store. Fetch writes new objects into the mirror; the checkout sees them via alternates if we ever look up OIDs there. The user's `refs/heads` never moves.

**12. Starting GitHub work at app launch.**
SQLite open at launch is cheap. Network is not. Welcome must stay the fast path (`IDEAS.md`). First GitHub bytes after Welcome has painted, and only for repos from the restored session.

**13. Schema cloned from Cockpit.**
v1 does not store workflow job logs, image proxy blobs, Greptile scores, or merge-method learning. Tables: summaries, conversation, checks, diff manifests, mutations, quota. Everything else waits for a demonstrated need.

**14. Stage A claimed to make "the app faster" while leaving `gh pr view` / `gh pr diff` in place.**
That only speeds the inbox. The revised stages name the actual user-visible win per stage, and Stage 0 is smaller than original Stage A.

**15. Mutation spacing "per resource."**
GitHub's published guidance is to pause ≥ 1 s between mutative requests, globally. Secondary REST is 900 points/min (POST = 5). v1 uses **global 1 s** between mutations. Do not invent a per-PR exception.

### 0.3 Leave alone

- GitHub as source of truth, Mac as read path.
- Partitioned fetches (REST scalars / GraphQL review / GraphQL checks).
- Poller as repair, webhooks as invalidation.
- Optimistic *paint* for comments, never for merge.
- Frozen patch tabs do not auto-advance on a new head.
- Checkpoints stay Horus-owned.
- `gh` for login, HTTP client on the hot path.
- Loopback-only if we ever serve HTTP.
- Research on DGit, rate limits, Cockpit, Code Storage — still the right bibliography.

### 0.4 Simpler system that still hits the goal

Re-derived as if the first draft did not exist:

Horus already has a content-addressed **patch** cache (`PullRequestReviewCache`, url+headOid, 20 / 200 MB) and a **conversation** that is refetched from scratch every 30 s. The minimum system that makes GitHub feel local:

1. Persist conversation and inbox the way patches already persist.
2. Revalidate in the background; paint from disk.
3. Stop spawning `gh` when `updated_at` / head OID have not moved.
4. Own HTTP + quota so the next.js 504 cannot happen on a list query.

That is Stage 0–1. A durable mutation queue, git alternates, FTS, relay, and agent `listen` layer on once those reads are instant and correct.

---

## 1. Thesis (revised)

Every slow GitHub *chrome* interaction in Horus is the same bug: the UI asks `api.github.com` to reassemble social state we have already seen. The diff viewer is a different machine and already local.

The architecture we actually want:

1. **GitHub is the write-through origin and the comment coordinate system.**
2. **SQLite holds the reviewer's working set of social state** (summaries, threads, checks), keyed by `(repo, number)` and by **per-slice versions**.
3. **The local object database holds bytes.** CodeView file sides come from blob OIDs. GitHub's patch (cached on disk, already implemented) is the line map for remote threads.
4. **Invalidate by cheap signal, repair by poll, fetch only the slice that moved.**
5. **Paint comments as pending. Confirm by refetch. Never auto-retry POSTs. Never optimistic-merge.**

Measured **other products** (context, not our SLA):

| Surface | GitHub.com p50 | PR Cockpit warm p50 |
| --- | ---: | ---: |
| Open a PR (their UI) | 1 421 ms | 20 ms |
| Open a diff (their UI) | 1 487 ms | 41 ms |
| Huge PR page | 3 381 ms | 82 ms |

Measured **Horus today** (packaged warm-cache, 2026-08-30):

| Milestone | Median |
| --- | ---: |
| Renderer navigation | 325 ms |
| First contentful paint | 497 ms |
| Explorer usable | 547 ms |
| Multi-file review usable | 652 ms |

Target after the replica, **same machine, same CodeView**:

| Slice | Today | Target p50 |
| --- | --- | ---: |
| Inbox / git panel PR list (warm) | live `gh pr list` + GraphQL inbox, ~0.5–2.4 s | **≤ 30 ms** replica read |
| Conversation reopen (same head) | `gh api graphql` on open + every 30 s | **≤ 30 ms** replica read |
| PR metadata reopen (same head) | `gh pr view` | **≤ 50 ms** replica read |
| Patch reopen (same head) | already disk-cached | keep; do not regress |
| CodeView first file | review-surface budget 750 ms | keep; not the replica's job |
| Background conversation freshness | 30 s `gh` spawn even when unchanged | 0 GitHub points if cheap signal matches |

---

## 2. Why GitHub is slow

Still three machines on `github.com/owner/repo/pull/N`. We use this as a diagnosis, not as a license to rebuild DGit.

### 2.1 Git is a local-disk data structure

Cursor, *Git at any scale* (August 2026), and GitHub, *Introducing DGit* (2016):

- Object lookup is a DAG walk. Each pointer is known only after the previous object is loaded. Networked filesystems and DHTs die here.
- Packfiles delta-compress with no DAG locality. Random reads want NVMe.
- Spokes keeps three consistent Git replicas on local disks; the web UI is an RPC client of that cluster.
- Continuity moves durability to an S3 WAL and treats disk Git as a warm cache.

**Translation for Horus:** the laptop already has the NVMe copy for every registered checkout. Stop asking GitHub's fileservers for blob bytes we can `git cat-file`. Do **not** implement a WAL, quorum, or packfile store in SQLite.

### 2.2 The API is a cost function

| Bucket | Limit | Unit |
| --- | ---: | --- |
| REST core | 5 000 | requests / hour |
| GraphQL | 5 000 | points / hour |
| Search | 30 | requests / minute |
| Concurrent (REST+GraphQL) | 100 | in flight |
| REST secondary | 900 | points / minute (GET 1, POST 5) |
| GraphQL secondary | 2 000 | points / minute (query 1, mutation 5) |

GraphQL cost is `ceil(total_connection_requests / 100)`, minimum 1. Nested rollups are double-digit points. `gh` user tokens share the 5 000-point hour with the terminal, CI scripts, and Horus ([cli/cli#13433](https://github.com/cli/cli/issues/13433)).

Free of **primary** quota: REST 304, inbound webhooks, git protocol. GraphQL has **no** ETag. Unchanged threads still cost full points unless we skip the query.

Horus already measured:

- `vercel/next.js` `pr list` 100 with `statusCheckRollup`/`mergeable`: HTTP 504 after 11.3 s.
- Same without those fields: 6.5 s. Open, limit 30, no checks: 2.4 s.
- `gh pr view --json files` caps at 100.
- `gh pr diff` → 406 past ~300 files.
- Files REST API pages of 100, hard stop at 3 000. Serial 3 000-file review ≈ 2 minutes; eight-wide is the current workaround.
- Conversation poll: one GraphQL spawn / 30 s / open PR tab.

### 2.3 The website rebuilds pages that have not changed

GitHub Issues (May 2026) moved to IndexedDB stale-while-revalidate. GitHub PR diffs (April 2026) still hid threads and hunks to survive React. We will not render GitHub HTML. We will do the Issues trick for **social state**, while Pierre keeps doing what their diff viewer cannot.

---

## 3. Research — keep, do not clone

### 3.1 PR Cockpit

[theolundqvist/pr-cockpit](https://github.com/theolundqvist/pr-cockpit). Steal:

- Partitioned detail fetch (REST scalars ∥ GraphQL checks ∥ GraphQL review).
- Scope `"all" | "checks" | "review"` on invalidation.
- Cheap pre-check (`head_sha`, `updated_at`, `ci_status`) before expensive detail.
- Diffs / file bytes keyed by OID, not PR number.
- Mutation row states `pending → refreshing → done|failed`, refetch before clearing pending.
- Quota log + pause background work.
- Relay carries **markers**, not bodies; poller remains.
- `listen` on a local change, not on GitHub.

Do not steal: Electron inbox as the product, Greptile, auto-merge fixer agents, global hotkey, replacing Pierre, storing job logs in v1, `involves:@me` as the only list.

### 3.2 Code Storage

GitHub is origin. Local is a mirror of default-namespace refs. Ephemeral refs do not sync. Pushes go to GitHub, then the mirror refreshes from GitHub — never from its own write. We take that **contract**. We do not add `@pierre/storage` as a runtime.

### 3.3 Adjacent

| Project | Steal | Leave |
| --- | --- | --- |
| webhookdb | Webhooks increment a relational replica | General GitHub warehouse |
| go-github-kit | ETag includes Authorization; 304 must skip parse **and** DB write | Copying ETags across tokens |
| firewatch | Compact agent digests | JSONL as the store |
| gitdeck | Token never in the renderer | Multi-forge dashboard |
| GitHub notifications API | ETag + `X-Poll-Interval` as a no-relay wake | Using it as PR detail |
| Scalar / partial clone | Last resort for missing objects | Default fetch filter |
| `refs/pull/*/head` | Fetch **one** PR ref | Fetch the whole namespace |

---

## 4. Where Horus is today

**Already right**

- Local Git is the code path. Patch tabs freeze `baseOid`/`headOid`. Checkpoints prefer blob OIDs. Collision radar is verified remotes × path intersection.
- `PullRequestReviewCache`: `hash(url, headOid)`, atomic temp+rename, 20 entries / 200 MB. Force-push is a new key.
- Inbox is one GraphQL document, four aliased searches, viewer login cached per repository service.
- PR **list** omits check rollup (the 504).
- Files API eight-wide after 406.
- Writes validate that the PR targets a remote of the registered checkout.
- `RepositorySessionRegistry`: one `RepositoryService` + watcher per root. Multi-project tabs already exist.
- Conversation equality (`sameConversation`) already avoids renderer churn when GraphQL returns the same bytes — but we still **pay** for the spawn.

**Still a live client**

- Inbox, list, conversation, checks, cold patch: `spawn(gh, …)`.
- Conversation is **not** on disk. Open tab ⇒ fetch. Then every 30 s.
- Checks ride along with `gh pr view` when the field is known.
- GitHub state dies when the last tab for a root closes (in-memory identity maps). Patch JSON files survive; social state does not.
- No quota accounting.
- No mutation queue; failed comment is a toast.
- Agents have no way to wait on GitHub state without polling GitHub.
- Session GitHub I/O is **per root**, so two tabs on the same `owner/name` (two worktrees) can double-fetch.

---

## 5. Product rules

From `IDEAS.md`:

> If an idea needs the network for the *sensation* of review, it is the wrong idea.

| May block first paint | Must not block first paint |
| --- | --- |
| No checkout (user picks a folder) | GitHub API for a PR we have cached |
| No `gh` auth for a **write** | Checks, threads, images, mergeability |
| Never-seen PR, empty cache (show the existing loading tab) | Relay / poller health |
| | Welcome / startup |

Honest staleness is required. "Threads 14:02, polling" is fine. A silent 40-minute-stale approval is a bug.

Frozen patch tabs **do not** adopt a new `head_oid` until the user refreshes that tab. The replica must not break this.

---

## 6. Two kinds of data, three coordinate systems

### 6.1 Git objects

Blobs, trees, commits. Identity is the OID. Once present, never refetch.

Source order:

1. Registered checkout object DB (and its worktree Git dir).
2. Bare mirror with `alternates` → that checkout, after `git fetch origin refs/pull/N/head` **with blobs**.
3. GitHub Contents / `gh pr diff` / files API only if fetch is forbidden (fork without rights, vanished head repo).

### 6.2 Social objects

PR scalars, body, labels, assignees, reviews, issue comments, **review threads**, check rollup, mergeability, viewer-specific flags.

Identity: `(repo, number)` plus **slice versions**, not one hash:

```
scalars_v   = hash(title, body, is_draft, base_oid, head_oid, updated_at,
                   mergeable, merge_state_status, review_decision, labels, …)
review_v    = hash(thread_ids+resolved+comment_ids, review_ids, issue_comment_ids)
checks_v    = hash(head_oid, rollup_state, context identities+conclusions)
listen_key  = scalars_v || review_v || checks_v     # agent wake only
```

Invalidation messages carry `{ repo, number, slice, version }`. A checks tick does not reload threads.

Viewer-specific fields (`viewerReviewRequested`, `viewerCanMergeAsAdmin`) are per `gh` login. One replica per OS user. No cross-account rows.

### 6.3 Line coordinates (the third system)

| Thing | Coordinate |
| --- | --- |
| CodeView file side | blob OID + file text |
| GitHub remote thread | GitHub `path` + `line` + `diffSide` on GitHub's three-dot patch |
| Horus local draft / checkpoint | text + context hash + blob OID (`reviewThreadAnchors.ts`) |
| Submit inline comment | GitHub `commit_id` = tab `headOid`, plus GitHub line/side/path |

Do not mix them. If the displayed patch is GitHub's, GitHub lines work. If we are on the 406 fallback (local git diff or paged files API), map remote threads through the text-anchor path and show orphans when they do not attach — Horus already has orphans for ambiguous local anchors.

GitHub three-dot: `git diff $(git merge-base BASE_TIP HEAD)...HEAD`. REST `base.sha` is the **base branch tip**, not the merge base. If we ever synthesize a local diff, use three-dot against that tip, not two-dot against `base.sha`.

---

## 7. Architecture

```
 GitHub.com
   git protocol │ REST │ GraphQL │ webhooks (optional)
         ▲                    │
         │ writes             │ markers (optional relay)
         │                    ▼
 ┌───────┴────────────────────────────────────────────┐
 │ Main process: GitHubReplica (one per app)            │
 │  token in memory from `gh auth token`                │
 │  HTTP pool, REST ETags (dropped on token change)     │
 │  SQLite WAL  ~/Library/Application Support/Horus/    │
 │              github-replica.sqlite                   │
 │  bare mirrors …/github-mirrors/<host>/<owner>/<name> │
 │  mutation actor, poller, quota governor              │
 │  IPC: read slices / enqueue mutation / subscribe     │
 └───────────┬──────────────────────────┬───────────────┘
             │                          │
             ▼                          ▼
   RepositorySessionRegistry     Renderer (no GitHub, no token)
   per-root git + watchers       paints replica slices + Pierre
   maps owner/name → roots       tab owns frozen snapshot
```

`GitHubReplica` is process-wide, keyed by `host/owner/name`. `RepositorySessionRegistry` stays per-root. A PR URL still matches remotes of a registered checkout before opening; the replica does not invent checkouts.

Invalidation is coalesced per `(repo, number, slice)` with rAF-sized batching on the renderer side so a CI storm does not thrash React.

### Lifetime

- Open SQLite at app start. No network.
- After Welcome/restore paint: if restored tabs include GitHub PRs, revalidate those slices in background.
- Closing the last tab of a root **does not** drop replica rows.
- Quit: SQLite persists. `pending` comments stay pending (no auto-retry). `refreshing` refetches on next launch.

---

## 8. Data model (v1)

```sql
replica_meta (key PRIMARY KEY, value);          -- schema epoch, login id, token fingerprint

pr_summaries (
  host, repo, number,
  node_id, state, is_draft, title, author_login,
  base_ref, base_oid, head_ref, head_oid, head_repo,
  updated_at, review_decision,
  additions, deletions, changed_files,
  viewer_is_author, viewer_review_requested, viewer_review_state,
  involves_me,              -- inbox membership, independent of "listed in git panel"
  in_repo_list,             -- last seen on pr list for a registered checkout
  scalars_v, fetched_at,
  PRIMARY KEY (host, repo, number)
);

conversations (
  host, repo, number,
  body, threads_json, reviews_json, issue_comments_json,
  review_v, fetched_at,
  PRIMARY KEY (host, repo, number)
);

checks (
  host, repo, number, head_oid,
  rollup_state, mergeable, merge_state_status,
  contexts_json,            -- cap: rollup + required + failed; not every matrix cell in v1
  checks_v, fetched_at,
  PRIMARY KEY (host, repo, number, head_oid)
);

-- Patch bytes stay files on disk (existing PullRequestReviewCache).
-- This table is the index the replica can query without opening JSON.
diff_manifests (
  host, repo, number, base_oid, head_oid,
  file_count, source,       -- github-diff | github-files | git-fallback
  cache_key,                -- existing hash(url, headOid)
  fetched_at,
  PRIMARY KEY (host, repo, number, base_oid, head_oid)
);

mutations (
  id INTEGER PRIMARY KEY,
  host, repo, number, kind, payload_json,
  state,                    -- pending | refreshing | failed
  idempotent INTEGER,       -- 1 = auto-retry allowed
  error, created_at
);

etags (
  identity PRIMARY KEY,     -- rest:host:login:GET /repos/…/pulls/N
  etag, last_modified, fetched_at
);

quota_log (
  occurred_at, source, operation, cost, used, remaining, reset_at, status, http_status
);
```

`threads_json` in v1 is acceptable: conversation is read as one IPC payload today. Normalize to a `threads` table only if we query per-path in SQL. Do not premature-split.

Retention: open summaries + conversations for registered repos; closed `involves_me` last 200 in summaries only; conversation/checks GC after 30 days closed; quota_log 7 days; ETags until token fingerprint changes.

FTS and image proxy are **not** v1.

---

## 9. Sync protocol

Priority:

```
user action
  > open-tab revalidate (cheap signal, then slice fetch)
    > poller
      > optional webhook markers
        > idle prefetch (not v1)
```

User action bypasses quota pause. Background work does not.

### 9.1 Cheap signal (the skip)

Before any GraphQL conversation/checks query:

1. REST `GET /repos/{repo}/pulls/{n}` with If-None-Match.
2. 304, or 200 with same `head.sha` + `updated_at` as `pr_summaries` → **do not** fetch conversation.
3. If `head.sha` moved → fetch all slices; new diff cache key.
4. If `updated_at` moved but head did not → fetch **review** slice only (comment/title/body). Checks may still be stale; if a tab is focused, also refresh checks (mergeability lives here).

This replaces the 30 s conversation spawn when nothing happened.

### 9.2 Poller (default freshness)

- Interval: 30 s for **focused** PR tab (same as today, but skip on cheap signal); 60–90 s for inbox + registered repo lists; exponential backoff on failure (already in `nextConversationPollDelay`).
- Repo git panel: REST `GET /repos/{repo}/pulls?state=open&per_page=30` with ETag. **Not** GraphQL search, **not** check rollup.
- Inbox: existing four-alias GraphQL search, cached in `pr_summaries.involves_me`. Run at most once per 60 s.
- Do not walk every open PR's detail on a poll tick. Only rows whose cheap signal moved, plus the focused tab.

### 9.3 Webhooks (optional, Stage 4)

Same marker design as Cockpit. Event → slice:

| Event | Slice |
| --- | --- |
| `pull_request` synchronize / opened / closed | scalars + git fetch + diff |
| `pull_request` edited, ready, draft, review_requested | scalars |
| `issue_comment`, `pull_request_review*` | review |
| `check_*`, `status`, `workflow_*` | checks, **30 s trailing throttle per PR** |

Default install: poller only. No GitHub App required.

### 9.4 Refresh implementation

```
refresh(repo, number, slice):
  scalars: REST GET /pulls/n          # ETag
  review:  GraphQL threads+reviews    # only if slice in {all, review}
           paginate to completion (101st thread exists)
  checks:  GraphQL rollup             # only if slice in {all, checks}
           store required + failed + rollup; page the rest only when the checks UI is open
  git:     fetch pull ref into mirror # only if head_oid missing from object DB
  diff:    existing collect path      # GitHub patch first; files API on 406; git diff last
```

Network in parallel. One SQLite transaction. Emit invalidation only if that slice's version changed.

### 9.5 Git fetch (when bytes are missing)

```
git --git-dir="$MIRROR" fetch --no-tags origin \
  +refs/pull/N/head:refs/pull/N/head
```

Mirror `alternates` file lists the checkout's `objects` directory. New objects land in the mirror. **No blob filter.** Do not fetch `refs/pull/*`. Do not write into the user's `refs/heads`.

---

## 10. Read path

### Open a PR tab

1. Parse host/owner/name#n. Match registered remotes (existing). Ask for a folder if none.
2. Read `pr_summaries`, `conversations`, `diff_manifests` + patch cache, `checks` for `head_oid`.
3. Paint whatever slices exist **now**. Loading tab only for slices that have never been fetched.
4. Mount CodeView from cached patch + local blobs when OIDs exist.
5. Background: cheap signal → maybe slice fetch.

Do not wait for checks to show the tree. Do not wait for threads to show the patch. Keep today's metadata-then-files streaming events.

### Git panel list / inbox

Paint SQLite. Revalidate in background. Two queries, two flags (`in_repo_list`, `involves_me`).

### Renderer

Still no GitHub. IPC becomes `replica.read` / `replica.mutate` / `replica.subscribe`. Existing contracts (`PullRequestReview`, `PullRequestConversation`) stay; the main process fills them from SQLite first.

---

## 11. Write path

```
UI → enqueueMutation
   → row pending, idempotent=0|1
   → paint pending overlay
   → worker (global ≥1 s since last mutation)
        success → refreshing → refresh slice → delete row → paint confirmed
        failure → failed + error (explicit retry only if idempotent=0)
```

Serialize per `(host, repo, number)` so two comments on one PR keep order. Cap global in-flight GitHub **reads** at 8. Mutations: one at a time globally in v1 (simplest way to honor the 1 s rule).

| Action | Optimistic paint | Auto-retry |
| --- | --- | --- |
| Issue comment / reply / inline | Yes (pending bubble) | **No** |
| Resolve / unresolve thread | Yes | Yes |
| Body / title PATCH | Yes | Yes (If-Match / retry on 409 → fail) |
| Review submit | Pending banner, not a fake review card | **No** |
| Ready / close | Pending header | **No** |
| Merge | "Merging…" only | **No**; snapshot `base_ref`+method at click; refuse if retargeted; GitHub decides |

Self-review still cannot APPROVE; existing mapping to COMMENT stays, enforced in main, not only in the renderer.

Target-remote checks stay. `headOid` on inline comments must match the tab snapshot; if GitHub head moved, fail with reload (Cockpit `StalePrHeadError`).

Startup: `pending` non-idempotent → `failed` interrupted (do not send). `refreshing` → refetch slice, then drop.

---

## 12. API utilization

1. **Git protocol for missing blobs**, REST for scalars, GraphQL for graphs. Never GraphQL `files` as the patch.
2. **Do not mix volatile and stable** in one document (the 504).
3. **Batch inbox searches** (already done). Do not poll Search for the palette in v1 (no FTS yet; palette can scan `pr_summaries` in memory — hundreds of rows, not thousands).
4. **REST ETags**; drop on token fingerprint change.
5. **Skip GraphQL** when cheap REST says unchanged.
6. **Instrument** every call into `quota_log`. Pause background under paced reserve.
7. **`gh` off the hot path.** Token once; `fetch` with keep-alive. Keep `gh auth login`. Merge: prefer `gh pr merge` until we prove GraphQL merge-queue parity (open question).
8. **Honor `Retry-After`.** Existing 0/250/750 only for 502/503/504. No retry on 406, 401, or 403 abuse without delay.
9. Notifications API is an optional Stage 4 wake, not a detail source.

---

## 13. Agents

v1: the replica is what `getPullRequestConversation` and inbox IPC already are, just cached. Agent attachments keep using structured tab context.

v2: IPC `replica.listen({ repo, number, slices, abortSignal })` resolves when `listen_key` changes, returning a compact digest. A CLI can call the running app the way existing agent code already does.

v3: optional loopback HTTP, off by default, `127.0.0.1`, session token `0600`.

Never: raw token, generic `gh api` proxy, merge without the UI gate, unregistered repos.

---

## 14. Safety

| Boundary | Rule |
| --- | --- |
| Renderer | No token, no SQLite path, no relay URL without confirm |
| Main | Validate mutation payloads; repo must be a registered slug |
| Disk | `0600` support dir; exclude from iCloud if the OS lets us |
| Logs | No tokens, no `Authorization`, no webhook secrets |
| HTTP | Off in v1; if ever on, loopback only |
| App (relay) | Read-only; writes use user token |
| Watcher | Mirror fetch must not look like a working-tree change |

Pending is visible. Confirmed state comes from refetch. Checkpoints never live in the replica.

---

## 15. Consistency

- **Git objects:** OID immutability. Read-your-writes after fetch.
- **Social slices:** stale-while-revalidate. After our mutation, pending until refetch (stronger than SWR).
- **Teammates:** eventual, via poll/webhook. GitHub is the sequencer. No cross-laptop linearizability.
- **Tabs:** frozen `baseOid`/`headOid` until explicit refresh.
- **Mergeability:** `UNKNOWN` is real. Do not merge from a cached `MERGEABLE` older than the last checks refresh of the focused tab.

---

## 16. Horus-specific constraints

1. Pierre stays the viewer. Replica supplies GitHub thread **coordinates** and blob OIDs when we have them.
2. Invalidation of `acme/app#7` must not touch `other/repo#7`. Match `(host, repo, number)`.
3. Checkpoints, viewed files, local drafts stay in existing stores.
4. Collision radar unchanged.
5. Welcome / startup budgets unchanged. Replica network is post-paint.
6. One mounted CodeView. Replica invalidation must not remount it; conversation overlay updates independently (already true).

---

## 17. Implementation map (revised)

Each stage names the user-visible win. Stoppable after any stage.

### Stage 0 — Stop paying for unchanged bytes

Ship without a new daemon.

- Persist `PullRequestConversation` on disk keyed by `(url, headOid)`, same atomic write as the patch cache.
- `usePullRequestConversation`: paint cache first; poll cheap REST `updated_at`/`head`; skip GraphQL when unchanged.
- Memory+disk cache last inbox + last `pr list` per repo; background revalidate.
- Quota headers logged to the existing performance diagnostics.

**Win:** reopen conversation is a disk read; a 30-minute review is no longer ~60 identical GraphQL spawns. **Does not** require SQLite.

### Stage 1 — Process-wide replica, summaries + HTTP

- `GitHubReplica` in main. SQLite `pr_summaries`, `conversations`, `checks`, `quota_log`, `etags`.
- HTTP client + `gh auth token`. `RepositoryService` asks the replica instead of spawning `gh` for list/inbox/conversation/checks.
- Poller with cheap skip. Thread pagination to completion.
- Checks stored by `head_oid`; opening a PR does not refetch them if head is unchanged.

**Win:** git panel and inbox ≤ 30 ms warm; next.js-scale list cannot 504 because we never ask for rollup on the list; two worktrees of the same slug share one conversation fetch.

### Stage 2 — Mutation queue

- Table + pending overlay + refetch-before-clear.
- Idempotent vs not (section 11).
- Merge snapshot rules.

**Win:** comments feel instant; no duplicate-comment retry bug; merge cannot lie.

### Stage 3 — Missing bytes via mirror

- Bare mirror + alternates.
- Fetch one `refs/pull/N/head` when the OID is absent.
- CodeView sides from `git cat-file` when blob OIDs exist.
- Patch source remains GitHub first; git diff only on 406, with thread-orphan fallback.

**Win:** 300-file 406 path can still **open file sides** locally even when GitHub will not emit one patch; fork PRs that we can fetch stop using Contents API.

### Stage 4 — Optional live push + listen

- Self-hosted relay or notifications ETag wake.
- IPC `replica.listen`.
- Loopback HTTP still optional and off.

**Win:** teammate comment without waiting for the 30–90 s poll; agents wait without burning quota.

### Stage 5 — Search and images, if needed

FTS5, image proxy, idle prefetch. Only after Stage 1 search-over-`pr_summaries` is shown to be insufficient.

**Do not** start Stage 4 before 0–1. **Do not** start Stage 3 as a rewrite of the patch cache — extend it.

---

## 18. Metrics

Add `bun run perf:github-replica` (or extend `perf:startup`) with a fixture repo.

**Replica reads (no CodeView):**

| Action | p50 budget |
| --- | ---: |
| Warm inbox / list | 30 ms |
| Warm conversation | 30 ms |
| Warm PR summary | 50 ms |
| Cheap-signal 304 skip | < 200 ms network, 0 GraphQL points |

**Review surface:** existing 750 ms packaged budget. Replica work must not add a GitHub wait in front of it on cache hit.

**Quota:** 10 cached PR opens = 0 GraphQL. Poller tick, 5 quiet repos = 1 ETag list each + at most one inbox search, **zero** conversation queries.

**Correctness tests (must exist before Stage 2 ships):**

- Force-push: new head, frozen tab stays, new cache key.
- 101st thread is present.
- Token rotate: ETags cleared; data still paints from SQLite.
- Comment fail + retry: **one** comment on GitHub, not two.
- Merge refused on retarget.
- `acme/app#7` invalidation does not refresh `other/repo#7`.
- Watcher does not fire on mirror fetch.

---

## 19. Anti-patterns

1. GitHub HTML cache / embedded github.com.
2. One GraphQL document for a whole PR.
3. Renderer-interval `gh pr view` (lazygit #5506).
4. Packfiles in SQLite.
5. Webhook payload as the data model.
6. Optimistic merge.
7. LAN bind / shared replica.
8. Replacing Pierre.
9. Fetching all `refs/pull/*`.
10. `git diff` as the GitHub line map.
11. `blob:none` as the review fetch.
12. Auto-retry POST comments.
13. Copying ETags across tokens.
14. Replacing repo `pr list` with `involves:@me`.
15. Blocking Welcome on GitHub.
16. Auto-advancing a frozen patch tab.
17. Generic `gh api` proxy for agents.
18. Calling this a local GitHub instance in UI copy.

---

## 20. Decisions

**Resolved by this revision**

| Question | Decision |
| --- | --- |
| Blobless fetch? | No, not for review diffs |
| Line map? | GitHub patch for GitHub threads |
| Fingerprint? | Per-slice versions; composed key only for listen |
| ETags after token rotate? | Drop them |
| Comment retry? | Explicit only |
| Inbox vs panel? | Both, separate flags |
| Relay in v1? | No |
| Agent HTTP in v1? | No |
| Where to fetch PR refs? | Bare mirror + alternates |
| Network at launch? | After Welcome paint |
| Mutation spacing? | Global 1 s |
| Continuity as design? | Diagnosis only |

**Still open**

1. Merge via `gh pr merge` vs GraphQL (merge queue).
2. GitHub Enterprise host differences (must parameterize `host` from remotes; do not assume `api.github.com` — already in the schema).
3. Hosted relay vs self-host vs never. Default remains never.
4. Clone `--filter=blob:none` for a PR URL with **no** checkout — still **ask for the folder** (`IDEAS.md`).
5. Fine-grained PAT vs `gh` OAuth scopes when `workflow` is missing (checks may 403; show that, do not pretend CI is green).
6. How many check contexts to store in v1 (proposal: rollup + required + failed; full page when the checks UI is open).

---

## 21. Research index

- [PR Cockpit](https://github.com/theolundqvist/pr-cockpit) and [benchmarks](https://theolundqvist.github.io/pr-cockpit/)
- [Code Storage GitHub Sync](https://code.storage/docs/guides/github-sync)
- [Cursor, Git at any scale](https://cursor.com/blog/git-at-any-scale)
- [Introducing DGit](https://github.blog/engineering/architecture-optimization/introducing-dgit/)
- [GitHub Issues local-first](https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/)
- [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [cli/cli#13433](https://github.com/cli/cli/issues/13433)
- This repo: `repository.ts`, `patchBuilder.ts`, `usePullRequestConversation.ts`, `reviewThreadAnchors.ts`, `repositorySessions.ts`, `IDEAS.md`

---

## 22. One-sentence summary

Cache GitHub social state in a process-wide SQLite replica, skip GraphQL when REST says nothing moved, keep GitHub's patch as the comment coordinate system, take blob bytes from a bare mirror of the checkout, and only then add mutations, webhooks, and agent listen — so Horus chrome goes from hundreds of `gh` spawns to disk reads, without pretending CodeView is a 20 ms HTML page.
