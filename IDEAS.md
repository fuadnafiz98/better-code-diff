# Ideas for Horus

GitHub is a website that happens to show diffs. Horus is a desk that already has the repo, the patch, a terminal, a watcher, and an agent in one process. The product is **a local review workspace**: hold several versions of the same project, review the change against the world you actually have, and prove it.

Tabs and markdown preview are on-ramps. They are not the point.

The loop that is worth building:

> Open a PR → show Desk collisions → show changes since checkpoint → walk proof-first → run evidence in Stage → submit anchored comments with a proof receipt.

That is something a browser cannot copy. It is also not an IDE.

---

## Rules

- One window. Several worlds. **One mounted CodeView.**
- A world is a version of the repo, not a URL and not a tab sticker.
- Everyday actions stay instant. No tab-switch animation, no motion on `]`.
- Pierre renders code. New ideas wrap it or reorder it. They do not replace it.
- Deterministic classifications must be explained. Nothing that looks like a green tick unless a human confirmed it.
- If an idea needs the network for the *sensation* of review (embedded GitHub, remote HTML, CI dashboards), it is the wrong idea.
- Inactive world state lives **outside** the viewer. Do not multiply the memory-heavy CodeView.

---

## What the code actually is

The thesis above overshot several shortcuts. These are the constraints, not nits.

The renderer holds one `repositoryReview`, one selected path, and one workspace. Opening a review remounts `RepositoryWorkspace` and replaces the instance (`useGitWorkflow.ts`, `App.tsx`). Main holds one `RepositoryService`, one watcher, one terminal service, and one agent service (`index.ts`). Agent and terminal cwd are that single root.

Linked-worktree watching exists only for Git metadata (`resolveLinkedGitDirectory` in `repositoryWatcher.ts`). It is not a multi-root capability model.

The PR patch cache is keyed by URL + `headRefOid` with **no index of previous snapshots** (`PullRequestReviewCache` in `repository.ts`). Viewed state stores file signatures, not a dated checkpoint. The fallback signature is change type plus line counts, so equal-churn content can collide (`reviewFileSignature` in `viewedFileStorage.ts`).

PR contracts have files, a patch, and omitted files. They have **no commit list and no semantic classification** (`contracts.ts`). `orderReviewItems` can permute; it cannot invent Story or Shape from data we do not have.

Local comments store line number, side, and range (`ReviewThread` in `ReviewComments.tsx`). They will not survive a pushed commit.

The markdown parser is headings, paragraphs, flat lists, quotes, and fenced code (`markdown.ts`). No links, images, tables, task lists, nesting, or source ranges. PR patches are hunks, not complete documents.

Selecting review lines already attaches a path and range for the agent (`agentAttachments.ts`). The prompt tells the agent to **read that path from the repository**. The agent runs in Desk cwd. On a remote Patch, that is the wrong tree.

None of this kills the bet. It says: **model worlds first**, then attach terminals, agents, and documents to a world, not to “the app.”

---

## 1. World foundation

A world is immutable in identity and snapshot, mutable in navigation. Only the active world’s CodeView is mounted.

```text
World
├── identity: worldId
├── source: desk | patch | stage | since
├── snapshot: baseOid + headOid
├── review: files + patch (request-scoped load)
├── navigation: selected path + scroll
├── walk + collapsed state
├── comments (anchored)
├── viewed state
└── checkpoint (if the source is a PR)
```

| Source | Meaning | Alive? |
| --- | --- | --- |
| **Desk** | The opened folder. `HEAD → working tree`. | Yes. Existing watcher. |
| **Patch** | A PR, `main...feature`, or a commit, as a frozen CodeView. | No. Pinned to `baseOid`/`headOid` until refresh. |
| **Stage** | A detached worktree of that snapshot. Diff plus a terminal and agent bound to that tree. | Yes, in its own root. Desk is untouched. |
| **Since** | Files (later hunks) that changed since the last **checkpoint**, not since the last open. | No. |

Desk cannot be closed. The strip names worlds (`Desk`, `#1092`, `#1092 run`, `#1092 since`). `⌘T` / `⌘W` / `⌘⇧[ ]`. Overflow is a menu, not a second scrollbar. Switching worlds restores navigation from stored state and remounts one CodeView.

Loading is **request-scoped** to `worldId`. A late PR page must not land in a world the user already left.

**Collision radar** is exact path intersection: Desk dirty paths ∩ Patch file list. Paint the overlap in the explorer. No heuristics.

The git panel already opens PRs, local compares, and commits. Those calls create or focus a world. They stop replacing Desk.

---

## 2. Checkpoints and “Since”

“Since last time” is the right idea. Opening a PR is not a review. The cache of patches is not a history.

A **ReviewCheckpoint** is explicit:

```text
PR URL + baseOid + headOid + timestamp + patch manifest
```

Advance it only when the user **submits a review** or chooses **Set checkpoint**. Merely opening, scrolling, or marking viewed must not move the baseline.

File signatures used for viewed/checkpoint comparison must prefer blob OIDs. The line-count fallback stays a last resort and must not be treated as identity.

**Since, in this order:**

1. File-level: paths added, removed, or whose blob OID (or strong signature) changed since the checkpoint.
2. Hunk matching later, as its own algorithm. A “moved hunk” is not `diff(patchA, patchB)`.

If there is no checkpoint, Since is empty and says so.

---

## 3. Comments that can survive a push

This is foundational and lands **before** hunk-level Since and before agent ghost comments.

Today a thread is `lineNumber + side + range`. Store an **anchor**:

```text
selected text
+ surrounding context hashes
+ side
+ blob OID
+ optional symbol
```

Re-anchor deterministically. **One match:** move the comment. **Zero or many matches:** mark it orphaned. Do not guess. Orphans are visible and must be confirmed or dropped by a human.

Rendered-document comments (heading / paragraph) wait until document ASTs have stable anchors. Do not invent a second address space early.

---

## 4. Walks and quiet files

`orderReviewItems` is the permutation API. Walks we can ship without new Git data:

- **Tree** — current path order.
- **Proof** — contracts, types, tests, then implementation. Deterministic path/name rules, each file tagged with why it ranked.
- **Risk** — auth, persistence, migrations, configuration, public APIs, then the rest. Same: explain every bump.

Walks that wait for data we do not have:

- **Story** — needs a commit list on the PR contract.
- **Shape** — import-only / formatting-only needs conservative analysis. Guessing here hides real changes.

**Quiet files** start with high-confidence rules only: lockfiles, known generated paths, snapshots. Always show the reason (`lockfile`, `generated`, `snapshot`). Never hide. A hidden file in a review is a lie. One control restores them.

An agent **proposed walk** is a later permutation the human can accept or dismiss. It is not the default.

---

## 5. Claim checks, not claim ticks

A sentence in a PR body such as “no API change” cannot be validated from filenames and hunk headers. A checkbox would be false confidence.

**Claim checks** extract claims from the Brief and show, for each:

- the claim
- supporting or contradicting evidence (paths, hunk headers, later Stage receipts)
- confidence
- **needs human confirmation**

No green tick without that confirmation. Unticked claims stay loud. Files that match no claim stay loud. The agent may propose evidence; the human still confirms.

---

## 6. Stage worlds

A Stage is a **detached worktree pinned to an exact commit**, not a linked checkout of a moving branch.

Main must grow a **multi-root capability**:

- Grant the Stage path as an approved root (realpath-checked), not the Electron user-data tree.
- Terminal cwd and agent cwd follow the **active world’s root**. Desk stays Desk.
- Watcher: content under the Stage root; Git metadata via the existing linked-gitdir resolution.

**Lifecycle.** Closing the UI **detaches** the world. It does not delete the worktree.

- Clean disposable worktree → Horus may delete it.
- Dirty worktree → retain, or confirm before delete.
- Never auto-delete while a terminal or editor in that root still exists.

Stage is where proof happens: run the test that names the current symbol, record the receipt.

---

## 7. World-aware subject and the agent

The subject is not “a path in the open folder.” It is:

```text
worldId + path + revision + side + line range + exact selected text
```

- **Patch worlds** send the exact hunk text. Do not tell the agent to `read` Desk.
- **Stage worlds** may also let the agent read from the Stage cwd, at that revision.
- **Desk** keeps today’s “read the working tree” behaviour.

`formatAgentReviewContext` stays a file-list **map** of the world. The subject is the pin.

Ghost comments, proposed walks, and claim evidence are **proposals**. They write into the local-thread / walk / claim-check models only after human acceptance. The agent is not a second inbox.

---

## 8. Proof ledger

A review is unfinished until there is a receipt. Stage commands append to a per-world ledger:

```text
command + exit code + timestamp + headOid
```

The submit bar can then say something true:

> Tested at `abc123`. 2 Desk collisions remain. 1 claim lacks evidence. 3 comments orphaned after the last push.

That sentence is the product. It is not a dashboard.

---

## 9. Documents and images

The current parser is good enough for agent answers and short PR bodies. It is not document-grade.

Use a real CommonMark/GFM parser and sanitized rendering. Repository images go through a file API with realpath checks against the world’s approved root. No network, no HTML, no scripts.

PR patches are partial hunks. A rendered old/new document needs **complete contents for both revisions** — a revision-content API, not `parsePatchFiles`.

Ship in this order:

1. Current-side markdown preview (Desk file, or the new side of a Patch file once full content exists).
2. Old/new rendered documents, independently scrollable.
3. Block-level document diff after the AST has stable anchors.
4. Comments on heading/paragraph, using those anchors.

Images in a review: before/after slider for `png`/`svg`. Other binaries stay skipped.

The Brief is a Patch-world header, not a fake GitHub page: rendered description, submitted reviews, file list that jumps to the file in the same world.

---

## 10. Seen is exposure, not review

The viewer knows the active rendered **file**, not which semantic hunks were understood. Dwell time is a poor proxy for reading, and a worse one for accessibility.

Keep two words:

- **Seen** — appeared in the viewport for a minimum time. Optional, experimental, never the source of truth.
- **Reviewed** — explicit `V` (or equivalent). This is what the pill counts.

Do not label viewport exposure as “40% of the semantic change.” If Seen ships at all, it is a dimming hint, off by default or behind a preference, and it never replaces Reviewed.

---

## What this is not

- A browser of github.com.
- An IDE. Edit stays the exception, on one file, on Desk or Stage.
- Two CodeViews mounted at once.
- Animated tab switches, file jumps, or viewed checkboxes.
- Remote HTML, remote images, or scripts in document preview.
- A CI dashboard. Checks belong on lines, or they don’t belong.
- Automatic deletion of a dirty Stage.
- Green ticks on claims, walks, or Seen.
- Chat that summarises a PR you can already scroll.
- Telling the agent to read Desk while the user is looking at a Patch.

---

## Build order

1. **World foundation + Patch worlds**  
   Immutable `worldId` and snapshot, per-world navigation stored off the viewer, request-scoped loading, one mounted CodeView, exact-path collision radar. Desk survives opening a PR.

2. **Review checkpoints + re-anchored comments**  
   Explicit checkpoint (submit or Set checkpoint). Stronger signatures (prefer blob OIDs). File-level Since. Anchors with selected text, context hashes, blob OID; orphans on ambiguity.

3. **Proof and Risk walks + quiet files**  
   Deterministic, explained. No Story/Shape yet. Quiet = lockfile / generated / snapshot, reason visible.

4. **Stage worlds + world-aware subject**  
   Detached worktree at an exact commit. Per-world approved root, terminal cwd, agent cwd. Close detaches; delete only a clean disposable tree, confirm if dirty. Patch subject sends exact hunk text.

5. **Proof ledger**  
   Commands, exit codes, timestamps, `headOid`. Receipt on submit.

6. **Document and image surfaces**  
   Real parser. Current-side preview first. Old/new full contents. Block diff after AST anchors. Image before/after.

7. **Agent proposals**  
   Proposed walk, claim evidence, ghost comments. Human acceptance required.

8. **Seen experiment**  
   Optional exposure hint. Never the review’s source of truth.

If only one thing ships: **Desk and Patch as two worlds, one CodeView.**  
If two: **checkpoints, file-level Since, and re-anchored comments.**  
Stage, the ledger, and documents are how it becomes a workspace you can prove a change in — not a tab strip with a prettier README.
