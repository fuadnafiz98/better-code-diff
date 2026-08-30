# Local GitHub at machine speed

**Status:** research and architecture plan. Do not implement from this file until a later pass carves executable work. This is the system we build toward.

**Product:** Horus is a tabbed local review workspace. GitHub is a website that happens to show diffs. The feeling of review must never wait on GitHub.

**Goal:** a local instance of GitHub social state that is extremely fast, correctly synced, safe to write through, and useful for both humans and agents. GitHub remains the source of truth. The Mac is the read path.

---

## 1. Thesis

Every slow GitHub interaction in Horus is the same bug in a different costume: the UI is asking a remote Rails-plus-fileserver cluster to reassemble a page whose objects already exist on disk.

The pull request was pushed hours ago. The diff has not changed. The threads have not changed. The checks finished twenty minutes ago. GitHub still walks a DAG of packfiles, joins MySQL rows, runs GraphQL connection resolvers, serializes a JSON payload, and ships it over the public internet. The user waits 1–5 seconds for a screen they have already seen.

The correct architecture is the one PR Cockpit, Code Storage, Cursor Continuity, and GitHub's own Issues rewrite independently converged on:

1. **Treat GitHub as a write-through origin, not a read replica.**
2. **Keep a warm, structured, local read model.**
3. **Invalidate by event, repair by poll, never rebuild a screen from the network.**
4. **Use local Git objects for blobs, trees, and diffs.** Use the GitHub API only for social state Git cannot store: reviews, checks, mergeability, comments, permissions.
5. **Paint writes locally as pending. Confirm them with GitHub. Reconcile.**

That is a local GitHub instance. It is not a GitHub clone, not a forge, and not a cache of HTTP responses. It is a replica of the *reviewer's working set*, kept consistent with GitHub, served from SQLite and the local object database at tens of milliseconds.

Measured reality, not aspiration:

| Surface | GitHub.com p50 | PR Cockpit warm cache p50 | Ratio |
| --- | ---: | ---: | ---: |
| Open a PR | 1 421 ms | 20 ms | 71× |
| Open a diff | 1 487 ms | 41 ms | 36× |
| Search PRs | 839 ms | 49 ms | 17× |
| Huge PR (1 879 files, ~360 comments) | 3 381 ms | 82 ms | 41× |

Horus already beats GitHub on *code* because Pierre renders local objects. Horus still loses on *GitHub* because every inbox poll, conversation load, check rollup, and `gh pr diff` is a live round trip. The rest of this plan is how to make the GitHub half as local as the Git half.

---

## 2. Why GitHub is slow

Three independent machines, all of them on the critical path of `github.com/owner/repo/pull/N`.

### 2.1 Git itself does not scale as a networked filesystem

Cursor's *Git at any scale* (August 2026) restates what GitHub learned between 2008 and 2013, published as DGit/Spokes:

- Git objects are a DAG. Listing recent changes walks commits → trees → blobs → parents. Each hop depends on the previous. Round-tripping that walk to a distributed store is fatal.
- Packfiles are the unit of storage *and* of the network protocol. Objects inside a pack are delta-encoded against other objects with no correlation to DAG locality. A random walk across gigabytes of pack data only stays fast on local NVMe.
- NFS, GFS2, DRBD, and "put Git in a DHT" all failed at GitHub and Google for this reason. JGit-on-DHT was good enough for operations and too slow for `git clone` because the protocol still demanded packfiles.
- Spokes (2013–) keeps three fully consistent Git replicas on local disks, fans packfiles out, and 3PC's the reference transaction. Reads can hit any replica. Writes need a quorum. That is why `git push` is reliable and why GitHub's web UI still has to talk to a fileserver RPC for every blame, diff, and tree listing.
- Continuity (Cursor, 2026) keeps the local-NVMe replica, but moves the source of truth to an S3 write-ahead log. Disk copies become a warm cache that can be materialized from the WAL. That is the server-side version of what this plan does on a laptop: **the local copy is a cache; the origin is durable; reads that hit the cache are instant and still linearizable when verified.**

The laptop already has the NVMe copy. Horus should stop asking GitHub's fileservers to walk it.

### 2.2 The GitHub API is a cost function, not a database

GitHub documents this, and then every client ignores it until they burn the budget.

**Primary limits (user token, typical `gh` login):**

| Bucket | Limit | Unit |
| --- | ---: | --- |
| REST core | 5 000 | requests / hour |
| GraphQL | 5 000 | points / hour |
| Search | 30 | requests / minute |
| GitHub App installation | 5 000–12 500 | scales with repos/users |

GraphQL points are not requests. Cost is `ceil(total_connection_requests / 100)`, minimum 1. Nested `statusCheckRollup { contexts(first: 100) }` plus `reviewThreads(first: 100) { comments(first: 50) }` plus `files` is a double-digit point query. `gh pr status` with rollups is why a single developer using `gh` as their GitHub UI now hits the 5 000-point ceiling in a normal day ([cli/cli#13433](https://github.com/cli/cli/issues/13433)).

**Secondary limits (shared REST + GraphQL):**

- 100 concurrent requests
- 900 REST points / minute, 2 000 GraphQL points / minute
- 90 seconds of CPU time per 60 seconds of wall time (60 of those for GraphQL)
- Mutations cost 5 secondary points; reads cost 1
- GitHub tells you to pause ≥ 1 second between mutative requests

**What does *not* cost primary quota:**

- HTTP 304 Not Modified on REST (ETag / If-None-Match). Secondary cost is still 1.
- Inbound webhooks. Zero API points. GitHub pushes; you do not pull.
- Git protocol fetch/push. Different budget, usually much healthier, and it moves the objects you actually need.

**What GraphQL does not give you:**

- Conditional requests. GraphQL is POST. There is no ETag. An unchanged pull request still costs its full point value.
- A cheap "did this PR change?" that includes threads, checks, and mergeability in one hash. You have to build that fingerprint yourself.

**Hard ceilings Horus has already hit, measured in this repo:**

- `gh pr list` of 100 PRs *with* `statusCheckRollup`/`mergeable` against `vercel/next.js`: HTTP 504 after 11.3 s, retried three times. Same call without those fields: 6.5 s. `--state open --limit 30` without checks: 2.4 s.
- `gh pr view --json files` stops at 100 files.
- `gh pr diff` returns HTTP 406 `PullRequest.diff too_large` past ~300 files.
- The files REST API pages at 100 and stops answering at 3 000 files. A 3 000-file review fetched serially took nearly two minutes; eight-wide paging is the current workaround.
- Search API: 30 requests / minute. Four `gh search prs` spawns per inbox poll would burn it. Horus already batched the inbox into one GraphQL document for this reason.

### 2.3 The website rebuilds pages that have not changed

GitHub's own engineering blog in 2026 is the confession:

- *The uphill climb of making diff lines performant* (April 2026): large PR pages hit 1 GB JS heap, 400 000 DOM nodes, INP of 450 ms. They cut components per line from eight to two, virtualized, and still hide non-trivial diffs and comment threads "for performance."
- *From latency to instant: Modernizing GitHub Issues navigation* (May 2026): they built a local-first stale-while-revalidate cache in IndexedDB plus a service worker so `issues#show` can paint from disk. Instant navigations went from rare to ~30% overall, ~70% of React navigations. **GitHub is doing for Issues what this plan does for PRs, except they are doing it in the browser against their own origin, and we can do it on the machine against a checkout that already exists.**

The Show HN for PR Cockpit states the user-visible version: click a PR — wait; open the diff — wait; back to the description — wait; nothing on those pages is new.

Horus must not reproduce GitHub's page model. Opening a PR tab in Horus is a local SQLite read plus a CodeView of local objects. Network work happens *after* paint, and only for the slices that the event log says changed.

### 2.4 Spawning `gh` is itself a tax

Every GitHub read in Horus today is `spawn(gh, ['api' | 'pr', ...])`. That is:

- process startup
- `gh` loading its config, looking up the token, talking to `api.github.com`
- JSON on stdout
- parse in the main process
- IPC to the renderer

lazygit v0.61.0 added two GraphQL PR fetches per refresh and regressed post-fetch refresh from ~57 ms to ~575 ms — ~300 ms per round trip even for five PRs. Horus pays that on every inbox poll, every conversation open, every review load that misses the 20-entry disk cache.

A local replica removes `gh` from the read path. `gh` stays for auth bootstrap and as a fallback CLI. The replica talks HTTP with a reused token, connection pool, and ETag store.

---

## 3. What the researched systems actually do

### 3.1 PR Cockpit — the closest working model

Repo: [theolundqvist/pr-cockpit](https://github.com/theolundqvist/pr-cockpit). Site: [theolundqvist.github.io/pr-cockpit](https://theolundqvist.github.io/pr-cockpit/). Show HN: "Loading GitHub PRs in 50ms instead of 1–3s+".

Architecture in one paragraph: a loopback server on the Mac holds SQLite. The UI and a CLI both read it. GitHub webhooks land on a Cloudflare Worker that stores compact *markers*, never pull-request payloads. The Mac polls the Worker every five seconds, fetches only the changed PR (and only the changed *slice*) with the user's `gh` token, writes SQLite, and invalidates the UI over a local WebSocket. A slower GitHub poller repairs missed events. Writes go through a mutation queue, paint as pending, then confirm.

Nuance worth copying, not the chrome:

**Split fetches, never one giant GraphQL document.** `fetchPrDetail` runs three things in parallel: a REST pull + files page (scalars, mergeability, labels, assignees), a GraphQL checks query, a GraphQL review/threads query. Event-driven refreshes pass a scope of `"all" | "checks" | "review"`. A `workflow_run` marker does not refetch threads. An `issue_comment` marker does not refetch check suites. CI is throttled to one trailing refresh per 30 seconds per PR because GitHub emits one event per job transition.

**Cheap change detection before expensive detail.** The background poller searches open PRs with `involves:@me`, then *skips* `fetchPrDetail` when `head_sha`, `updated_at`, and `ci_status` all match the cache. Thread resolution does not move those fields, so a separate detail-staleness path repairs it. This is the local equivalent of an ETag for GraphQL.

**Diffs are content-addressed by head SHA, not PR number.** `CREATE TABLE diffs (head_sha TEXT PRIMARY KEY, patch TEXT NOT NULL)`. A force-push is a new key. A reopen of the same head is a SQLite primary-key lookup. File contents are `(sha, path)`. Images from GitHub user-content are prefetched into a local proxy so markdown does not wait on `camo.githubusercontent.com` at paint.

**Mutations are a durable queue, not a fire-and-forget fetch.** States: `pending → refreshing → done` (row deleted) or `failed`. After a successful write, Cockpit *refetches the PR* before dropping the pending overlay, so the UI never claims GitHub accepted something the replica has not seen. Interrupted pending rows fail on process start. `refreshing` rows recover by refetching. Merge records the base ref and method at click time and refuses if the PR retargeted.

**Relay carries markers, not secrets and not bodies.** Self-hosted Worker + Durable Object, 1 000 compact change markers, HMAC webhook secret. Each local server can read only repositories its own token can access. WebSockets exist only between the local server and the local UI. The relay is not a tunnel for GitHub payloads; it is an invalidation bus. The poller stays on as a repair path. Repositories without live push fall back to polling and are labelled that way.

**Quota is a first-class runtime, not an error handler.** GraphQL cost, used, remaining, reset are recorded per operation into `github_graphql_usage`. Background polls pause when remaining points would not cover a paced reserve until reset. The UI can show "this machine used X points this hour; other processes used Y."

**Agents listen to the replica, not to GitHub.** `pr-cockpit listen owner/repo#123` blocks on a local fingerprint. A push, check, review, or comment changes the fingerprint; the command prints a compact digest of *what changed* and exits. Agents do not poll `api.github.com`. They do not burn the user's 5 000 points. Humans and agents share one cache.

**Local Git still wins for blobs.** Cockpit mirrors the repo and uses `git show` for file-at-revision. The GitHub Contents API is a fallback for files the mirror does not have. That is the right split.

**Loopback only.** The server binds `127.0.0.1`. Remote access is SSH tunnel or mesh VPN. Allowed origins are explicit. This is a security property, not a deployment convenience.

What Horus should not copy: the Electron/web inbox as the product, Greptile score scraping, auto-merge fixer agents, global ⌥⌘K from any app, or replacing Pierre. Horus is a review desk with a mounted CodeView. The replica is infrastructure under that desk.

### 3.2 Code Storage (Pierre Computer Company)

[code.storage](https://code.storage) is a white-label Git infrastructure layer: JWT-authenticated remotes, quorum Git, ephemeral branches, webhooks, GitHub Sync. Limits they publish: unlimited repos, 500+/s Git requests per repo observed, 15k+/s API, 32 TB repo size.

GitHub Sync is the relevant mechanism:

- GitHub is the source of truth.
- `createRepo({ baseRepo: { owner, name } })` links a Code Storage repo to GitHub.
- `pullUpstream()` (or a GitHub webhook) copies default-namespace branches and tags. Ephemeral refs stay local.
- Pushes to Code Storage are forwarded to GitHub, then copied back so nodes converge on GitHub's view.
- During initial sync, reads return 409. After that, reads do not wait for later upstream syncs and may be briefly stale; freshness is a `repo.sync.succeeded` webhook.
- Public mode is a one-shot import without webhooks. Private continuous sync needs a GitHub App.

This is the *git-object* half of a local GitHub. Code Storage does not replicate PRs, reviews, checks, or identities. Horus does not need Code Storage as a dependency: the laptop already has the checkout. The lesson is the sync contract:

- Origin is GitHub.
- Local is a mirror of `refs/heads/*`, `refs/tags/*`, and `refs/pull/*/head`.
- Machine-only state (review checkpoints, viewed files, agent notes) lives in a namespace that is *not* pushed.
- A push from Horus goes to GitHub, then the replica refreshes from GitHub, never from its own write. That prevents "I pushed, the replica diverged, GitHub rebase-merged, now we disagree."

Horus already uses `@pierre/diffs` for the viewer. Code Storage is the same company's answer to "GitHub's git hosting is the wrong latency domain for an app." We take the contract, not the hosted service, unless a later product decision wants a hosted mirror for agents that do not have the checkout.

### 3.3 Cursor Continuity / Origin

Continuity is GitHub Spokes with the source of truth moved off the pets.

Copy these invariants, translated to a single machine:

| Continuity | Horus replica |
| --- | --- |
| WAL in S3 is truth; disk Git is a warm cache | GitHub is truth; SQLite + local `.git` is a warm cache |
| Never acknowledge a push until it is persisted | Never drop a pending mutation until GitHub confirms *and* the replica has refetched |
| Linearize all pushes | Serialize mutations per pull request |
| Conditional GET with ETag: 304 means serve locally | Fingerprint match means serve locally; event or poll miss means refetch the slice |
| Replicas catch up from the WAL, not from each other | UI and agents catch up from SQLite, not from GitHub |
| Idle repos GC from disk and rematerialize | Idle PR details age out; git objects stay; social JSON is re-fetchable |
| Compact on the primary, replicas download packs | Diffs keyed by SHA are immutable; never rewrite, only insert |

Do not build a distributed Git host. Do not 3PC. Do not put packfiles in SQLite. The laptop *is* the NVMe replica Cursor is rediscovering.

### 3.4 GitHub's own local-first work

GitHub Issues (2026) is stale-while-revalidate in IndexedDB. GitHub PR diffs (2026) is "we shipped too many React components per line." Both confirm the same split Horus already made for code: **the renderer must not be the system of record, and it must not wait for the origin to paint.**

DGit/Spokes (2016, GitHub Blog *Introducing DGit*): Git is latency-sensitive; `git log` and `git blame` load thousands of objects sequentially; any disk latency destroys the web UI; keep three local-disk copies; web frontend is a client of the fileserver cluster. The web UI is, architecturally, a remote Git client with extra social tables. Horus is a *local* Git client with extra social tables. That is why it can be faster than GitHub at GitHub's own job.

### 3.5 Adjacent tools, what to steal

| Project | Steal | Leave |
| --- | --- | --- |
| [webhookdb](http://nedbatchelder.com/blog/201412/rest_api_gotcha_and_webhookdb.html) | Webhooks as the incremental input to a relational replica; ETags are not enough because GitHub embeds related objects in every REST body so one avatar change busts the PR ETag | Building a general GitHub warehouse |
| [go-github-kit](https://github.com/pcanilho/go-github-kit) | GitHub's server-side ETag hashes the `Authorization` header; token rotation busts a naive store-and-forward cache. Key ETags by *stable identity*, not by the raw header. Surface 304 as an explicit unchanged signal so you skip JSON parse and DB writes | Go stack |
| [hubproxy](https://github.com/cased/hubproxy) | Persist webhook deliveries for replay; verify HMAC; query by event type / repo / time | Being a generic webhook debugger |
| [firewatch](https://github.com/outfitter-dev/firewatch) | Denormalized PR activity log as JSONL for agents; auto-sync if stale; compact output | jq-centric CLI as the product |
| [gitdeck](https://github.com/debba/gitdeck) | Device-flow OAuth in a local server; token never exposed to the renderer; disk cache of REST/GraphQL | Multi-forge dashboard |
| [github-archive-action](https://github.com/githubocto/github-archive-action) | Append-only event log in SQLite as a recovery stream | Committing the DB to an orphan branch |
| Microsoft Scalar / VFS for Git / partial clone | Blobless or treeless fetch when the checkout is missing objects; `git clone --filter=blob:none` plus on-demand blobs | Virtualizing the working tree |
| Git protocol v2 + `refs/pull/*/head` | Fetch the PR head into the local object DB and `git diff base...head` locally. This is how to beat GitHub's 300-file / 3 000-file caps | Fetching every PR ref on every `git fetch` by default |
| HTTP Git caches (Varnish blog, 2025) | Packfile HTTP is cacheable; a local cache turned a 12 s clone into 1.6 s | Running Varnish in the app |
| GitHub Desktop | `gh` as auth, local git as the object store, API for PRs — the same split, but they still hit the network per view | Their UI |
| Graphite / Reviewable / Gerrit | Stacked PR grouping; "everything needed to decide on one screen"; keyboard review. Gerrit remains the existence proof that review UIs can be fast when they are not a React website over DGit | Hosting a forge |
| GitHub notifications + events APIs | Cheap poll endpoints with `X-Poll-Interval` and ETags, as a repair path when webhooks are off | Using them as the primary inbox |

---

## 4. Where Horus is today

Honest inventory, because the replica has to land in this codebase, not in a green field.

**Already right:**

- Local Git is the code path. Working-tree tabs, patch tabs, Since tabs, CodeView, checkpoints keyed by blob OID, collision radar by verified remote identity.
- `PullRequestReviewCache` on disk, keyed by `hash(url, headRefOid)`, versioned, atomic write via temp+rename, 20 entries / 200 MB. A force-push is a new key. A reopen of the same head does not re-download.
- Inbox GraphQL is one document, four aliased searches, viewer login cached for the life of the repository.
- PR list deliberately omits `statusCheckRollup`/`mergeable` because of the next.js 504. Checks are requested only for a single PR view, and older `gh` builds that reject unknown fields fall back.
- Files API paging is eight-wide after `gh pr diff` 406.
- Writes (review, reply, resolve, merge, ready) go through `gh` with target-remote validation so a pasted URL cannot mutate another repository.
- Renderer comparison cache is bounded (24 entries, 4 MB, 1 MB/file). Inactive patch payloads have a 64 MB memory budget and reload from disk.

**Still a live GitHub client pretending to be a cache:**

- Every inbox poll, conversation open, and cold review is a `gh` spawn against `api.github.com`.
- Conversation threads are not in the disk cache. Opening a PR tab refetches `PULL_REQUEST_THREADS_QUERY` (100 threads × 50 comments, no pagination completion).
- Checks are fetched with the single-PR view, every time, including when the head SHA has not moved.
- Diff cache is per-repository-session files on disk, not a global content-addressed store. Closing the last tab for a root releases the watcher *and* drops the in-memory identity maps. The JSON files survive; the rest of GitHub state does not.
- There is no webhook path. Freshness is "the user opened it" or "the git panel polled."
- There is no mutation queue. A failed review comment is an error toast, not a retryable row. The UI does not paint pending.
- There is no quota accounting. Horus can 504 the user's hour and not know why.
- There is no agent listen surface on GitHub state. Agents that want "wake me when CI finishes" must poll GitHub themselves.
- `gh pr diff` is preferred over `git diff` of fetched `refs/pull/N/head`, so a 300-file PR pays GitHub's renderer instead of the local object DB.
- Multi-repo tabs exist. GitHub state does not: inbox, cache, and `gh` cwd are per open repository service.

The gap is not "add more caching." The gap is "GitHub social state has no replica, so every screen is a request."

---

## 5. Product rule for the replica

From `IDEAS.md`, non-negotiable:

> If an idea needs the network for the *sensation* of review (embedded GitHub, remote HTML, CI dashboards), it is the wrong idea.

Apply that to this system:

| Allowed to block first paint | Must never block first paint |
| --- | --- |
| Missing local checkout (user must pick a folder) | GitHub API |
| Missing `gh` auth for a *write* | GitHub API for a *read* of a PR we have seen before |
| User has never opened this PR and we have no cache row | Webhook relay being down |
| | Check rollup, review threads, mergeability, images |
| | `gh pr diff` |

Cold start of a never-seen PR may show metadata + file tree from a cheap REST `GET /pulls/N` (or from `gh pr view` without files) and stream the patch from local git as objects arrive. It may not show a spinner that waits for GraphQL connections to complete.

The replica is allowed to be *wrong for a short time* on social state, and must be *honest about it*. "Threads as of 14:02, live push delayed" is acceptable. A silent 40-minute-stale approval is not.

---

## 6. Two kinds of data

This is the load-bearing distinction. Mixing them is how GitHub clients get slow and how caches go stale.

### 6.1 Git objects — content-addressed, local, immutable

Blobs, trees, commits, tags. Identity is the OID. Once you have `abcdef…` you never refetch it. Diffs of `baseOid...headOid` are a pure function of the object DB.

Source of objects, in preference order:

1. The registered local checkout's `.git`
2. `git fetch origin refs/pull/N/head:refs/horus/pr/N/head` (and the base ref) into that checkout, or into a per-repo bare mirror under the replica's data dir
3. GitHub Contents / diff APIs only when the object is absent and fetch failed (forks without fetch rights, Git LFS, submodules)

Horus already does (1) for working trees and for patch tabs once OIDs are known. The replica makes (2) the default way to *obtain* those OIDs' bytes, and stops using (3) for diffs of ordinary source files.

`refs/horus/*` is machine state. It is not pushed. It is not a GitHub ref. Mirror `refs/pull/*/head` on demand for open PRs in the working set, not for the entire history of the repository.

### 6.2 Social objects — GitHub-authored, versioned, invalidated

Pull request scalars, body, labels, assignees, review requests, reviews, issue comments, review threads, check suites, workflow runs, mergeability, auto-merge, permissions, viewer-specific fields (`viewerReviewRequested`, `viewerCanMergeAsAdmin`).

These have no Git OID. Their identity is `(repo, number)` plus a *fingerprint* we compute:

```
fingerprint = hash(
  headRefOid,
  updatedAt,
  lastIssueCommentAt,
  lastReviewAt,
  lastThreadEditAt,
  checkRollupState,
  mergeable,
  mergeStateStatus,
  reviewDecision,
  isDraft,
  title,
  bodyHash
)
```

A webhook marker or a cheap poll that does not change the fingerprint is a no-op. A change updates only the slices the event names.

Viewer-specific fields are per GitHub login, not per machine. The replica is single-user (the `gh` login). Do not sync it across accounts. A teammate's replica is their own SQLite, filled by their token, authorized by the same relay's access filter.

---

## 7. Architecture

```
                          ┌────────────────────────────────────────┐
                          │ GitHub.com                             │
                          │  git protocol │ REST │ GraphQL         │
                          │  webhooks ─────────────────┐           │
                          └──────────▲─────────────────┤           │
                                     │                 │           │
                          writes     │                 ▼           │
                          (auth'd)   │         ┌───────────────┐   │
                                     │         │ Relay (opt.)  │   │
                                     │         │ CF Worker +   │   │
                                     │         │ Durable Object│   │
                                     │         │ markers only  │   │
                                     │         └───────┬───────┘   │
                                     │                 │ poll 5s   │
┌────────────────────────────────────┴─────────────────▼───────────┐
│ Main process: GitHub replica                                       │
│                                                                    │
│  Auth      Token from `gh auth token`, in memory, never renderer   │
│  HTTP      undici/fetch pool, REST ETag store, GraphQL cost log    │
│  Git       fetch pull refs, diff/show from object DB               │
│  SQLite    WAL, one DB for all registered repos                    │
│  Queue     mutations per (repo, number)                            │
│  Sync      webhook consumer + poller + quota governor              │
│  Notify    IPC to renderer; optional local socket for agents       │
└────────┬──────────────────────────────┬────────────────────────────┘
         │ IPC (existing contracts)     │ loopback HTTP, optional
         ▼                              ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│ Renderer                │   │ Agent CLI / listen      │
│ Paint from replica      │   │ Same read model         │
│ One CodeView            │   │ Fingerprint wait        │
│ Pending overlays        │   │ Compact digests         │
└─────────────────────────┘   └─────────────────────────┘
```

The replica lives in the Electron main process because Horus already owns repository services, watchers, and `gh` there. It is *not* a second product. It is the GitHub half of `RepositoryService` extracted into a process-wide owner so multi-repo tabs share one cache, one quota budget, and one webhook session.

Loopback HTTP is optional and off by default. Turn it on for agents. Bind `127.0.0.1` only. Require a session token minted at enable time, stored in the user data dir with `0600`.

### 7.1 Process and lifetime

- Start the replica when the app starts, not when the first GitHub tab opens. Inbox and global search are app-level, not tab-level.
- Closing the last tab of a repository must *not* drop replica rows for that repo. It may drop the filesystem watcher. GitHub state is cross-tab and cross-session.
- Quit persists SQLite. In-flight mutations stay in `pending`/`refreshing` and recover on next launch.
- One SQLite file: `~/Library/Application Support/Horus/github-replica.sqlite`. WAL mode, `busy_timeout`, single writer (the replica actor), many readers (queries from IPC handlers).

### 7.2 The replica is an actor

All writes to SQLite go through one queue in the main process. IPC handlers enqueue. The actor:

1. applies the write or starts the GitHub fetch
2. commits
3. emits invalidation `{ type, repo, number, scope, fingerprint }`

Renderer and agent listeners subscribe to invalidations. They do not poll SQLite in a loop; they read on invalidation and on user action.

---

## 8. Data model

SQLite is the social store. Git is the object store. Do not put patches of 3 000 files into a `TEXT` column if the object DB can produce them; do store a *small* unified patch or a file-list manifest when we have already paid to build it, keyed by OID pair.

Suggested schema (names can move; the keys cannot):

```sql
-- Working set. One row per pull request we care about.
prs (
  repo TEXT NOT NULL,                 -- owner/name, lowercase
  number INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL,                -- open | closed | merged
  is_draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_login TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_oid TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  head_repo TEXT,                     -- fork slug if different
  updated_at TEXT NOT NULL,
  mergeable TEXT NOT NULL,            -- MERGEABLE | CONFLICTING | UNKNOWN
  merge_state_status TEXT NOT NULL,
  review_decision TEXT,
  ci_status TEXT NOT NULL,
  additions INTEGER, deletions INTEGER, changed_files INTEGER,
  viewer_is_author INTEGER NOT NULL,
  viewer_review_requested INTEGER NOT NULL,
  viewer_review_state TEXT,
  fingerprint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- Search and closed history. Cheaper and broader than prs.
pr_index (
  repo, number, title, state, is_draft, author_login,
  updated_at, merged_at, closed_at, involves_me,
  PRIMARY KEY (repo, number)
);

-- Threads and conversation. Separate from prs so a checks refresh
-- does not rewrite this blob.
threads (
  repo, number, thread_id, path, line, start_line, diff_side,
  is_resolved, is_outdated, payload_json, fetched_at,
  PRIMARY KEY (thread_id)
);

reviews (
  repo, number, review_id, author_login, state, body, submitted_at,
  PRIMARY KEY (review_id)
);

issue_comments (
  repo, number, comment_id, author_login, body, created_at,
  PRIMARY KEY (comment_id)
);

checks (
  repo, number, head_oid, rollup_state, contexts_json, fetched_at,
  PRIMARY KEY (repo, number, head_oid)
);

-- Immutable. Never update. Force-push = new row.
diffs (
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  patch_path TEXT,                    -- sidecar file if large
  manifest_json TEXT NOT NULL,        -- paths, additions, deletions, blob oids
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (base_oid, head_oid)
);

mutations (
  id INTEGER PRIMARY KEY,
  repo, number, kind, payload_json,
  state,                              -- pending | refreshing | failed
  error, created_at
);

etags (
  identity TEXT PRIMARY KEY,          -- not raw URL+Authorization
  etag TEXT NOT NULL,
  last_modified TEXT,
  body_hash TEXT,
  fetched_at TEXT NOT NULL
);

quota_log (
  occurred_at, source, operation, cost, used, remaining, reset_at, status
);

webhook_cursors (
  relay_id, last_marker_id, last_received_at
);

settings (
  key PRIMARY KEY, value
);
```

FTS5 on `pr_index(title)` plus a tokens column for `owner/name#number` and author login. Local search must not call GitHub's search API on every keystroke. GitHub search is for cache fills and for queries the replica cannot answer (code search, issues outside the working set).

Retention:

- Open PRs in registered repos: keep.
- Closed/merged that `involves_me`: keep last N (start at 200) in `pr_index`; drop detail slices after 30 days.
- Diffs: keep while any open PR or recent tab references the OID pair; GC files older than 30 days.
- `etags`: keep.
- `quota_log`: 7 days.
- Job logs, if we store them at all: 7 days, gzipped, only failed/cancelled.

---

## 9. Sync protocol

Three inputs, one writer, one fingerprint.

### 9.1 Priority

```
user action (open tab, pull-to-refresh, submit review)
  > webhook marker (scoped)
    > poller (working set)
      > idle prefetch (next likely PRs, images, pull refs)
```

User action may bypass the quota pause. Background work may not.

### 9.2 Webhook path (live push)

GitHub will not deliver to `127.0.0.1`. Options, in the order we should offer:

1. **Optional self-hosted relay** — copy PR Cockpit's Worker. One Durable Object, HMAC secret, GitHub App with read-only contents/PRs/checks/actions, events listed in §9.6. Horus polls the relay with the user's token; the relay filters markers by what that token can read. This is the team-friendly path.
2. **Smee / smee-like personal forwarder** — fine for a single developer, not for a product default.
3. **No relay** — poller only. Fully functional, slightly less live. This is the default so install does not require Cloudflare or a GitHub App.

Markers stored on the relay:

```
{ delivery_id, received_at, event, action, repo, number?, head_sha?, run_id? }
```

No bodies. No diffs. No logs. No tokens.

On the Mac, map event → refresh scope:

| Event | Scope |
| --- | --- |
| `push` | git fetch pull ref + `all` if it is a PR head |
| `pull_request` (synchronize, opened, closed, reopened, edited, converted_to_draft, ready_for_review, review_requested, …) | `all` or scalars-only for title/body edits |
| `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment` | `review` |
| `check_run`, `check_suite`, `status`, `workflow_run`, `workflow_job` | `checks` (throttled) |
| `installation`, `installation_repositories` | coverage map, not PR data |

Throttle checks at ~30 s trailing per `(repo, number)` so a matrix build does not spend the GraphQL hour.

Deduplicate by `X-GitHub-Delivery`. GitHub retries. Treat duplicate delivery IDs as no-ops.

### 9.3 Poller (repair and no-relay)

Interval: 60 s when live push is healthy for the repo; 15–30 s when the repo is polling-only; back off when quota remaining is below the paced reserve.

Algorithm, adapted from Cockpit and from Horus's existing inbox query:

1. Read quota. If background not allowed, stop.
2. `search(is:open is:pr involves:@me repo:A repo:B …)` plus the registered-repo open list without `involves` if the user asked to track the whole repo (reviewers of busy repos need this; authors often do not). Cap. Warn if cap hit.
3. For each hit, compare `(head_oid, updated_at, ci_status)` to `prs`. Unchanged → skip.
4. Changed or missing → `refresh(repo, number, "all")`.
5. Evict open rows that disappeared from the search *after* a direct `pullRequest(number)` lookup confirms they are not open. Search is not a lock file.
6. Periodic (30 min) index sweep: recent PRs per repo + closed `involves:@me`.

Do not put `statusCheckRollup` on the list query. That is the next.js 504. CI state on the cheap search can be the last-commit rollup *state* only, or even omitted: the poller then relies on webhooks for CI and on the scoped checks refresh when a tab is open.

### 9.4 Refresh a pull request

Always partitioned:

```
refresh(repo, number, scope):
  scalars  = REST GET /repos/{repo}/pulls/{n}          # ETag
  files    = REST GET /pulls/{n}/files?per_page=100     # only if scalars.changed and we still need a manifest
  checks   = GraphQL DETAIL_CHECKS                      # if scope in {all, checks}
  review   = GraphQL DETAIL_REVIEW                      # if scope in {all, review}
  git      = fetch refs/pull/n/head and base            # if head_oid moved
```

Parallelize the network. Serialize the SQLite commit. Recompute fingerprint. If fingerprint equals previous, emit nothing (avoid renderer churn). If not, emit scoped invalidation.

Complete pagination on threads and check contexts. Cockpit already does this with cursor-cycle guards. Horus's current threads query does not page. A PR with 101 threads is silently truncated today. The replica must not be.

REST ETags: store under identity `rest:pull:{repo}:{n}` and `rest:pull-files:{repo}:{n}:{head_oid}`. On 304, do not parse, do not write. GitHub's ETag includes Authorization, so identity keys by login id, not by token value; when `gh` rotates the token, copy etag rows to the new token's login (same user) instead of dropping the cache.

### 9.5 Git fetch of pull refs

When `head_oid` is not in the local object DB:

```
git fetch --no-tags --filter=blob:none origin \
  +refs/pull/N/head:refs/horus/pr/N/head \
  +refs/heads/BASE:refs/horus/base/BASE
```

Then, for files the review actually opens, either the blob is already packed (common after a normal clone) or Git lazy-fetches it. For diffs, `git diff --find-renames base_oid...head_oid` runs locally and has no 300-file cap.

Fall back to `gh pr diff` / files API only when:

- fetch is forbidden (private fork, missing rights)
- the PR head repo is gone
- binary/LFS objects that git filter omitted and the Contents API can still return

Record the source on the diff row: `git` | `github-diff` | `github-files`. The Since tab and checkpoints already prefer blob OIDs; a git-sourced manifest should include them.

Do not `git fetch` the entire `refs/pull/*` namespace. Busy repos have tens of thousands of PR refs. Fetch the working set, and prefetch the next likely PR heads in idle time.

### 9.6 GitHub App permissions, if we ship a relay

Read-only: Actions, Checks, Commit statuses, Contents, Issues, Metadata, Pull requests.

Events: Check run, Check suite, Issue comment, Pull request, Pull request review, Pull request review comment, Pull request review thread, Push, Status, Workflow job, Workflow run, Installation, Installation repositories.

No contents:write on the App. Writes use the user's `gh` token. The App is an invalidation identity, not an impersonation identity. This is a safety property: a compromised relay can at worst spam markers; it cannot comment, merge, or push.

---

## 10. Read path — making it feel instant

### 10.1 Open a PR tab

```
1. Parse owner/name#n. Match to a registered checkout (existing Horus rule).
2. Read prs row. If present, paint header, file tree from diffs.manifest, conversation from threads/reviews/comments, checks from checks, all in the same tick.
3. Mount CodeView on the first file from local objects or from the cached patch.
4. Enqueue refresh(scope=all) if fetched_at is older than a freshness budget
   (open tab: 30 s; background: rely on events).
5. If no row: paint a loading tab (existing), fetch scalars+git first,
   stream files as the manifest arrives, then threads and checks.
```

Never wait for checks to open the diff. Never wait for threads to open the file tree. Horus already splits metadata progress from files progress in `#loadPullRequestReview`. Keep that streaming contract; feed it from the replica instead of from `gh`.

### 10.2 Inbox / git panel

Paint `prs` + `pr_index` immediately. Lanes (Horus already has review-requested / assigned / mentioned / authored) are a query over those tables, not a live GraphQL search. The poller updates the tables; the UI does not call GitHub to draw the panel.

### 10.3 Search

Keystroke search is FTS5 + `#number` parse + slug prefix. Debounce is for the local query, not for GitHub. A "search GitHub" command exists for the miss path and writes hits into `pr_index`.

### 10.4 Images and avatars

Markdown in PR bodies pulls `user-images.githubusercontent.com` and `camo.githubusercontent.com`. Those are often slower than the API. Prefetch URLs extracted from bodies into a local image cache (Cockpit's `imageproxy.ts`). The renderer loads `horus-image://` or a file URL, not the network. Avatars keyed by login+avatar URL, long TTL, revalidate on 404.

### 10.5 Renderer contract

The renderer never fetches GitHub. It already does not, except through IPC. Keep it that way. IPC methods become "read replica / enqueue mutation / subscribe invalidation" instead of "run this `gh` command."

Invalidation messages are small: `{ repo, number, scope, fingerprint }`. The renderer re-reads the slices it displays. It does not receive full PR JSON over IPC on every check tick.

---

## 11. Write path — safe, pending, confirmed

### 11.1 Protocol

```
UI → enqueueMutation(repo, number, payload)
     → SQLite row state=pending
     → invalidate with pending overlay
     → worker executes GitHub call with user token
         success → state=refreshing → refreshPr → delete row → invalidate
         failure → state=failed, error text → UI retry/discard
```

Serialize per `(repo, number)`. Parallel across PRs, with a global concurrency cap well under GitHub's 100, and ≥ 1 s spacing between mutations to the same resource to stay inside secondary limits.

### 11.2 What may be optimistic

| Action | Optimistic? | Caveat |
| --- | --- | --- |
| Issue comment | Yes | Show pending bubble; replace with server id after refresh |
| Thread reply | Yes | Same |
| Resolve / unresolve thread | Yes | Easy to invert on failure |
| Body / title edit | Yes | Conflict if someone else edited; refresh wins, pending re-applies only on retry |
| Inline comment | Yes | Must send `commitOID`; if head moved, fail and ask to reload (Cockpit's `StalePrHeadError`) |
| Review submit (comment / approve / request-changes) | Pending banner, not a fake review card | Self-review is illegal; Horus already maps that to COMMENT. Keep the rule client-side *and* server-side |
| Merge | Never lie | Show "merging…" and disable the button. Do not paint merged until GitHub says merged *and* the refetch agrees. Snapshot base ref + method at click, refuse if retargeted |
| Ready for review / close | Pending state on the header | Same refetch rule |

### 11.3 Auth and target checks

Keep the existing Horus rules:

- Writes use `gh` / the same token as reads.
- Merge and ready-for-review require the PR to target a remote of the registered checkout.
- Review comments are capped (100 inline, 65 536 body).
- The renderer never sees the token.

Add:

- Mutation payloads are validated in the main process, not trusted from IPC.
- No GitHub App installation token on the write path.
- `repo` in a mutation must match the replica's registry; ignore free-form URLs from agents unless they map to a registered slug.

### 11.4 Recovery

On startup: `failed` stays failed (user retries). `pending` that never left the machine fails as `interrupted` or is retried once if idempotent (resolve-thread, comments are not strictly idempotent — do not auto-retry comments). `refreshing` means GitHub probably accepted; refetch and drop.

---

## 12. API utilization — the actual techniques

This is the catalogue of how we talk to GitHub so the replica stays fast *and* inside budget.

### 12.1 Prefer git protocol over REST for bytes

Diffs, file-at-rev, blame, history of a path: local git after a targeted fetch. REST `application/vnd.github.v3.diff` is a compatibility fallback. GraphQL `files(first: 100)` is a manifest fallback, not a patch source.

### 12.2 Prefer REST for scalars, GraphQL for graphs

REST `GET /pulls/N` is cacheable with ETags, cheap, and includes mergeability. GraphQL is for review threads, nested comments, check contexts with `isRequired(pullRequestNumber:)`, and batched inbox searches. Cockpit's hybrid `fetchPrDetail` is the pattern. Horus's all-GraphQL-through-`gh` is the anti-pattern.

### 12.3 Never mix volatile and stable in one query

Checks change every few seconds during CI. Threads change on comments. Files change on push. One document that asks for all three:

- costs more points
- 504s on large repos
- busts any chance of a REST 304 on the stable half
- makes scope-based webhook refresh impossible

### 12.4 Batch searches, do not poll endpoints

One GraphQL document with aliased `search` fields (Horus already does this for the inbox). One REST search page for palette queries. Never N `gh search prs` spawns. Never poll `/repos/…/pulls` every few seconds for a whole org.

### 12.5 Conditional REST, fingerprints for GraphQL

REST: `If-None-Match`. GraphQL: keep a local fingerprint; skip the query when cheap search says unchanged. There is no third option. Do not invent a GraphQL cache of POST bodies keyed by query text — viewer fields and `updatedAt` make it a stale-bug factory.

### 12.6 Instrument every call

Every GraphQL document includes `rateLimit { cost remaining resetAt }`. Every REST call logs status, remaining, whether it was 304. Persist to `quota_log`. The governor:

- pauses background work when remaining < paced reserve
- surfaces cost per operation in the Performance diagnostics disclosure (Horus already has one)
- predicts hourly burn the way Cockpit does after five minutes of data

Without this, agents + UI + `gh` in a terminal will silently starve each other.

### 12.7 Stay under secondary limits on purpose

- Global in-flight GitHub requests: cap at ~8 (Horus already uses 8 for files pages).
- Mutation spacing: ≥ 1 s per resource.
- Retry 502/503/504 with the existing 0/250/750 ms ladder; on secondary-limit responses (`Retry-After`, 403 with abuse message) honor `Retry-After` and jitter.
- Do not retry 406 too_large; switch strategy.
- Do not retry 401; re-auth.

### 12.8 Drop `gh` from the hot path

Use `gh auth token` (or `gh auth status -t`) once, cache until it fails, call `https://api.github.com` with `fetch` and a keep-alive agent. Spawn `gh` for:

- first-run login (`gh auth login`)
- `gh pr merge` if we want its merge-queue handling — or call the GraphQL merge mutation ourselves; pick one
- debugging

`gh` JSON field allow-lists and version skew (`statusCheckRollup` unknown → whole command fails) go away when we own the documents.

### 12.9 Search API is a fill, not a UI

30 req/min. Use it to populate `pr_index`, not to drive the command palette. Local FTS is the palette.

### 12.10 Notifications API as an optional cheap bus

`GET /notifications` supports ETags and `X-Poll-Interval`. It is a reasonable no-relay repair for "something happened in my working set" when webhooks are off. It is not a PR detail source. Use it as a wake signal that then runs the same scoped refresh.

---

## 13. Agent surface

Horus already has an agent dock with explicit repository roots and structured tab subjects. The replica should be the GitHub sense-organs for those agents.

### 13.1 Read API (loopback, opt-in)

Compact, agent-shaped, no HTML, no GraphQL dumps:

```
GET /pr/:owner/:repo/:number          state, checks, unresolved, fingerprint
GET /pr/:owner/:repo/:number/diff     cached or git-produced patch
GET /pr/:owner/:repo/:number/file     file at head OID from git
GET /pr/:owner/:repo/:number/threads  unresolved only by default
POST /listen                          body: { pr, wake: [push|checks|review|any] }
                                      blocks until fingerprint changes, returns digest
```

`listen` is the feature. Agents waiting on CI today poll GitHub and take the user's hour with them. `listen` waits on SQLite invalidation. When a webhook or poll updates the fingerprint, it returns:

```
- ci  scape#8132  FAILURE  test / linux
- review-comment  @alice  server/mutations.ts:72  Surface the retry path
```

and exits. `--timeout` for bounded waits.

### 13.2 Write API

The same mutation kinds as the UI, same queue, same auth. Agents do not get a bypass. A busy agent that comments in a loop hits the same 1 s spacing and the same pending overlay the human sees if the tab is open.

### 13.3 What not to give agents

- The raw token
- Arbitrary `gh api` proxy (that is how you recreate quota fires)
- Unregistered repos
- Merge without the same gate as the UI

---

## 14. Safety

Fast is not the same as safe. The replica is a privileged local database of private source and review commentary.

### 14.1 Trust boundaries

| Boundary | Rule |
| --- | --- |
| Renderer | No token, no SQLite path, no ability to set relay URL to an arbitrary origin without a confirm. Existing IPC validation stays. |
| Agent loopback | Off by default. `127.0.0.1` only. Session token. CORS allowlist if we ever serve a page. |
| Relay | Markers only. HMAC. Per-caller token filter. No PR bodies. Compromised relay ≠ compromised GitHub account. |
| GitHub App | Read-only. Writes are user-token only. |
| Disk | Replica DB and diff sidecars live in the app support dir. Mode `0600`. Not synced to iCloud if we can help it. |
| Logs | Never log tokens, webhook secrets, or Authorization headers. Quota log stores counts. |
| Multi-user machine | Replica is the OS user's. Do not run a shared local server on `0.0.0.0`. |

### 14.2 Integrity of review

- Pending writes are visually pending. Confirmed writes come from the refetch, not from echoing the payload.
- Merge is not optimistic.
- Head-moved inline comments fail instead of attaching to the wrong line.
- Checkpoints stay Horus-owned and are not overwritten by a GitHub refetch. The replica supplies GitHub threads; Horus checkpoints stay in their existing store.
- Viewer-specific data is from *this* login. Do not cache another user's `viewerReviewState`.

### 14.3 Stale data policy

Every painted GitHub slice can answer "when was this fetched?" Performance diagnostics already records timelines; add `replica.ageMs` per open tab. If live push is down and poller is paused for quota, the UI says so. Silent staleness is a bug.

Maximum social-state age with a live tab: 30 s without a confirming fingerprint, then a background refresh even if webhooks are quiet. Maximum age for a background PR in the inbox: poll interval. Diffs of an unchanged head OID never expire for correctness; they GC for disk.

### 14.4 Supply chain and `gh`

Bootstrap auth with the GitHub CLI the user already trusts. Do not ship a client secret in the app for a Horus OAuth App unless we are ready to run that App as a product. Device flow in-process is a later option (gitdeck does it); it is not required to start.

---

## 15. Consistency model

Name it so we do not improvise later.

**Git objects:** read-your-writes after fetch. OIDs are immutable. If we have the OID, we are consistent with every other replica of that OID in the universe.

**Social objects:** stale-while-revalidate, single-writer, fingerprint-compared. After a local mutation, the slice is *pending* until the refetch lands — stronger than SWR, weaker than linearizability. After someone else comments, we are consistent once the webhook or poll is applied. We do not claim multi-replica linearizability across teammates' laptops. GitHub is the sequencer.

**Git ↔ social:** when `head_oid` on the PR row moves, the diff key moves with it. The old diff remains on disk for Since/checkpoint. The tab that is pinned to a snapshot (Horus patch tabs are frozen at `baseOid`/`headOid`) does *not* auto-advance. Only an explicit refresh of that tab adopts the new head. The replica must not break that product rule.

**Merge:** GitHub's mergeability is computed asynchronously (`UNKNOWN` is a real state). Do not cache `MERGEABLE` longer than a checks-scope refresh. Do not merge from a cached `MERGEABLE` older than the last refetch.

---

## 16. What Horus uniquely should do

PR Cockpit is a GitHub client that happens to have a local git mirror. Horus is a local review desk that happens to need GitHub. Lean into that.

1. **Diffs from the checkout, comments from the replica.** Pierre stays the viewer. The replica supplies thread anchors (`path`, `line`, `diffSide`, blob OID). Horus already attaches exact text, path, side, range, blob identity, tab, root, and revisions for the agent. The replica must provide blob OIDs in the file manifest so those attachments survive a refetch.

2. **Tabs already isolate repository identity.** The replica is global, the tab is the owner of "which PR snapshot am I showing." Invalidation of `acme/app#7` must not flicker `other/repo#7`. Match on `(repo, number)`, never on number alone.

3. **Checkpoints are not GitHub.** Do not store them in the replica. Do not advance them on refetch. The replica can *tell* the Since tab that `head_oid` moved; the user still decides to set a checkpoint.

4. **Collision radar** stays path intersection of working tree dirty paths with the patch file list, matched by verified remotes. The replica's `head_oid` is an input, not a new heuristic.

5. **Startup budgets stay.** Welcome < 400 KB. Replica open is a main-process SQLite open plus optional inbox query — milliseconds, not a GitHub round trip. Do not fetch GitHub on first paint of Welcome. Prefetch the inbox after Welcome is up, the same way restore already parallelizes workspace and snapshot.

---

## 17. Implementation map

Not a sprint board. A build order that respects dependencies. Each stage is independently shippable and leaves the app faster than it found it.

### Stage A — Replica core, no webhooks

Extract GitHub I/O from `RepositoryService` into a process-wide module. Own the token, the HTTP client, the SQLite file, the `prs`/`pr_index`/`etags`/`quota_log` tables. Replace `getPullRequestInbox` and `pr list` with replica reads plus a poller. Keep `gh pr view` / `gh pr diff` as the detail path until Stage B. Success: git panel inbox paints from disk in < 50 ms on a warm DB; quota log exists; next.js list no longer 504s because we stopped asking it to.

### Stage B — Content-addressed diffs from git

On PR open, fetch `refs/pull/N/head` if needed, `git diff base...head`, write `diffs` keyed by OID pair. Fall back to current `#collectPullRequestPatch` on fetch failure. Wire `PullRequestReviewCache` into this table (or replace it). Success: reopen of the same head is a SQLite read; 300-file PRs no longer 406 if git has the objects; the two-minute 3 000-file files-API path is the fallback, not the default.

### Stage C — Partitioned detail

Threads, reviews, comments, checks in their own tables. Split queries as in §9.4. Paginate threads to completion. Cache checks by `head_oid`. Opening a conversation does not refetch the patch. Opening a patch does not refetch threads. Success: tab switch to an already-fetched PR paints conversation + files without a GitHub call.

### Stage D — Mutations

Queue, pending overlay, refetch-before-clear, merge snapshot rules. Move review submit / reply / resolve / merge / ready onto the queue. Success: a comment appears immediately, survives a crash if it was already sent, and retries if it failed.

### Stage E — Live push

Relay as an optional settings path. Marker consumer. Scoped refresh + 30 s CI throttle. Poller interval backs off when live. Success: a teammate's comment appears without a manual refresh, and turning the relay off does not break the app.

### Stage F — Agents listen

Loopback, compact reads, `listen` on fingerprint. Teach the existing agent attachments to prefer replica reads for GitHub slices. Success: an agent can wait on CI without calling `api.github.com`.

### Stage G — Search, images, prefetch

FTS5 palette. Image proxy. Idle prefetch of next-PR heads and avatars. Success: ⌘K over local PRs is < 50 ms; markdown images do not flash-in from camo.

Do not start G before C. Do not start E before A. Do not start F before D if agents write.

---

## 18. Metrics and acceptance

Horus already measures packaged startup. Add a GitHub replica bench, warm and cold, against a real private PR and a public large PR (the Cockpit suite used `microsoft/vscode` and a 1 879-file internal PR). Reproduce with a script, not a screenshot.

**Warm cache (row exists, objects local, no GitHub required):**

| Action | Budget (p50) | Stretch |
| --- | ---: | ---: |
| Paint inbox | 30 ms | 15 ms |
| Open cached PR header + tree | 50 ms | 20 ms |
| Open cached diff in CodeView | existing review-surface budget | |
| Local PR search | 50 ms | 20 ms |
| `listen` wake after local invalidation | 20 ms | 5 ms |

**Cold (never seen, objects may need fetch):**

| Action | Budget (p50) | Notes |
| --- | --- | --- |
| Header from REST scalars | < 800 ms | Network |
| File tree from git diff | < 1.5 s after fetch | Local once objects exist |
| Threads complete | async, must not block tree | |
| Checks complete | async, must not block tree | |

**Quota:**

- Background replica stays under 20% of the GraphQL hour unless the user is staring at a CI-live tab.
- Opening 10 cached PRs in a row costs 0 GraphQL points.
- A full poller tick on 5 repos with no changes is 1 search query (or 1 304), not N detail queries.

**Correctness:**

- Force-push: new `head_oid`, old tab stays on snapshot until refresh, new cache key.
- Relay down: poller covers, UI marks polling-only.
- Token rotate: ETags still hit (keyed by login).
- 101st review thread exists.
- Merge never paints merged before GitHub agrees.

Record replica timings in the existing Performance diagnostics disclosure as a third timeline: GitHub actor (fetch, sqlite, invalidate) distinct from main-process restore and renderer commit.

---

## 19. Anti-patterns

Do not do these even though they look like performance work.

1. **HTTP cache of GitHub HTML.** We are not a browser. We do not want their DOM.
2. **One GraphQL document for a whole PR page.** That is GitHub.com's model. It 504s.
3. **Polling `gh pr view` on an interval from the renderer.** That is lazygit's 10× regression.
4. **SQLite as a packfile store.** Packfiles belong in `.git`. SQLite is for social rows and manifests.
5. **Webhook payloads as the data model.** Payloads are incomplete, retry-duplicated, and viewer-agnostic. They are invalidation, then we fetch with the user token.
6. **Optimistic merge.**
7. **Shared replica across OS users or on a LAN bind.**
8. **Replacing Pierre with GitHub's diff viewer or with Monaco-from-Contents-API.**
9. **Fetching all `refs/pull/*` on every git fetch.**
10. **Treating the replica as a forge.** No local issue tracker, no local identities, no "offline merge that we push later" unless GitHub is unreachable *and* the user is explicitly in offline mode (not in scope).
11. **Keyed ETag stores that include the raw Authorization header.** Token rotation will look like a cache wipe.
12. **Agents with a raw `gh api` proxy.**
13. **Blocking Welcome or startup on GitHub.**
14. **Auto-advancing a frozen patch tab because the replica saw a new head.**

---

## 20. Open questions

Resolve these when implementation starts, not in the abstract.

1. **Bare mirror vs in-checkout refs.** `refs/horus/pr/N/head` inside the user's checkout is simple and matches "the desk already has the repo." A per-repo bare mirror under Application Support keeps `git fetch` from touching the user's repo and is kinder to worktrees. Prefer in-checkout unless we see users' `git status` confused by extra refs (they should not be: `refs/horus` is outside `refs/heads`).
2. **GitHub Enterprise.** Host is not always `github.com`. Auth, API, and git protocol must take the host from the remote. Relay Apps are per-host. Do not assume `api.github.com`.
3. **Fork PRs.** Head lives on another slug. Fetch needs `head_repo`. Writes (push to the branch) may be forbidden; comments are not. The replica must store `head_repo` and not pretend `origin` has the branch.
4. **Merge queue.** `gh pr merge` knows about it; a raw GraphQL merge may not. Decide whether merge stays a `gh` spawn.
5. **Whether to ship a Horus-hosted relay.** Self-host-only is more honest and less support. A hosted relay is nicer install UX and a new security surface. Default: self-host optional, poller default.
6. **Partial clone of unregistered repos.** Opening a PR URL with no local checkout currently asks for a folder. Could we clone `--filter=blob:none` into a replica-managed workdir? That is a product fork (Horus-as-GitHub-browser vs Horus-as-desk). IDEAS.md says ask for the checkout. Keep asking, unless we later decide otherwise.
7. **SQLite vs SQLite-plus-sidecar for diffs.** Multi-hundred-MB patches in `TEXT` are how Cockpit works and how Horus's JSON cache works. Sidecar files plus a manifest in SQLite keep the DB small and mmap-friendly. Prefer sidecars above a few MB.

---

## 21. Research index

Primary:

- [PR Cockpit](https://github.com/theolundqvist/pr-cockpit) — replica, relay, mutations, quota, listen
- [PR Cockpit site / benchmarks](https://theolundqvist.github.io/pr-cockpit/) — 20 ms PR open, 82 ms huge PR
- [Code Storage GitHub Sync](https://code.storage/docs/guides/github-sync) — GitHub as origin, local as mirror, ephemeral refs, webhook pullUpstream
- [Cursor, Git at any scale](https://cursor.com/blog/git-at-any-scale) — packfiles, DGit/Spokes, Continuity WAL, local NVMe as the only fast Git
- [Introducing DGit](https://github.blog/engineering/architecture-optimization/introducing-dgit/) — Git latency, three local replicas
- [GitHub Issues local-first](https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/) — SWR, IndexedDB, service worker
- [GitHub PR diff performance](https://github.blog/engineering/architecture-optimization/the-uphill-climb-of-making-diff-lines-performant/) — why their UI is still slow at the DOM layer
- [GraphQL resource limitations](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [cli/cli#13433](https://github.com/cli/cli/issues/13433) — `gh` tokens and the 5 000-point ceiling

Supporting:

- webhookdb, go-github-kit ETag identity, hubproxy, firewatch, gitdeck, github-archive-action
- lazygit #5506 — GraphQL on every refresh
- Varnish, *Speeding Up Git with HTTP Caching*
- Microsoft Scalar, git filter, `refs/pull/*/head`
- This repo: `src/main/repository.ts`, `src/main/patchBuilder.ts`, `IDEAS.md` performance floor and tab rules

---

## 22. One-sentence summary

Build a single-user, loopback GitHub replica in the Horus main process: SQLite for social state, local git for bytes, webhook markers plus a poller for freshness, a durable mutation queue for writes, and a fingerprint listen API for agents — so every review screen paints from the machine, GitHub stays the source of truth, and the API is used as an invalidation-and-confirm protocol instead of as a filesystem.
