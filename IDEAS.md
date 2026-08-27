# Ideas for Horus

GitHub is a website that happens to show diffs. Horus is a desk that already has the repo, the patch, a terminal, a watcher, and an agent in one process. The next product is not “more panels.” It is **holding several versions of the same project at once, and reviewing the change as a change** — not as a file list that forgot why it exists.

Tabs and markdown preview are the on-ramp. They are not the point.

---

## The bet

A reviewer is doing four jobs GitHub pretends are one:

1. **See** the patch (CodeView already does this).
2. **Understand** the intent (the PR body, the commits, the tests, the docs).
3. **Check it against the world they actually have** (dirty working tree, other branches, the last time they looked).
4. **Prove it** (run it, click it, read the rendered doc, not the source of the doc).

Horus can do 3 and 4 because it is local. Everything below is a way to stop throwing that away.

**Rules that keep this a review app, not an IDE**

- One window. Several worlds. One visible diff.
- A tab is a version of the repo, not a URL.
- Everyday actions stay instant. No tab-switch animation, no “delight” on `]`.
- Pierre renders code. New ideas wrap it or reorder it. They do not replace it.
- If an idea needs the network for the *sensation* of review (embedded GitHub, remote HTML, CI dashboards), it is the wrong idea.

---

## Leap 1 — Parallel worlds

Today `useGitWorkflow` holds one `repositoryReview`. Opening `#1092` evicts the live working tree. The watcher keeps running; the UI pretends the folder left.

The first leap is not a tab strip. It is **several checkouts of meaning, side by side in time**.

### Worlds, not chrome

| World | What it is | Alive? |
| --- | --- | --- |
| **Desk** | The folder you opened. `HEAD → working tree`. | Yes. Existing watcher. |
| **Patch** | A PR, `main...feature`, or a commit, as a frozen CodeView. | No. Pinned to `headRefOid` until refresh. |
| **Stage** | A git worktree of that PR/commit. Diff *and* a terminal whose cwd is that tree. | Yes, in its own tree. Desk is untouched. |
| **Since** | The interdiff: this PR’s patch minus the patch you already reviewed. | No. Two cached `headRefOid`s. |

The strip under the titlebar names worlds (`Desk`, `#1092`, `#1092 run`, `#1092 since Fri`). `⌘T` / `⌘W` / `⌘⇧[ ]`. Overflow is a menu. You cannot close Desk.

The git panel already opens PRs, local compares, and commits. Those calls create or focus a world. They stop being a trap door.

`repositoryWatcher.ts` already knows linked worktrees (`resolveLinkedGitDirectory`). A Stage tab is `git worktree add` under an app-managed directory, scoped to the approved root, deleted when the tab closes. The existing terminal binds to that cwd. That is the honest version of “preview the PR”: **boot it**, don’t iframe github.com.

Stay small: one CodeView on screen. No split of two reviews. No tearing tabs into windows. A Stage is optional; a Patch world is enough to ship first.

### Collision radar

Desk is dirty. A Patch world touches `agentService.ts`, which is also modified on Desk. The explorer already has status. Paint the overlap.

This is the sentence GitHub cannot say: **this PR lands on files you are already changing.** It is free once Desk and Patch coexist.

---

## Leap 2 — Review the change, not the tree

`orderReviewItems` already permutes CodeView. The explorer path order is a default, not a law. A 135-file review in path order is how you miss the point.

### Walks

A review has a **walk**: the order the viewer actually lays out. Built-in walks:

- **Tree** — today’s path order.
- **Story** — commit order, so you watch the change arrive.
- **Risk** — tests and types first, generated and lockfiles last.
- **Shape** — cluster by mechanical kind (rename, import-only, new API, snapshot).

The agent’s job is not a summary. It is a **proposed walk**: “start at the type, then the store, then the UI; skip the snapshots.” That walk is just another permutation of `orderReviewItems`, stored on the world, editable, dismissible. The file list becomes a queue with a reason.

### Quiet files

Lockfiles, snapshots, import-only churn, formatting-only diffs start **collapsed**, counted: `12 quiet`. Never hidden. A hidden file in a review is a lie. One control restores them.

### Claims

A PR body is a list of claims (“adds retry”, “no API change”, “docs follow”). Parse the Brief (we already parse that markdown). Tick each claim against the actual file list and hunk headers. Unticked claims stay loud. Extra files that match no claim stay loud.

This is drift detection for humans. The description and the patch stop being able to ignore each other.

### Since last time

Viewed files are already keyed by **content signature**. PR patches are already cached by `headRefOid`. Two visits to `#1092` at two SHAs are two patches. The `Since` world is the diff of those diffs: only hunks that appeared, disappeared, or moved.

Re-reviewing a pushed PR should feel like inbox zero, not like the first time.

### Seen light

`V` is a checkbox people click to make a number move. The virtualizer already knows which items occupied the viewport (`findActiveReviewItemId` is one sample). **Seen** is “this hunk was on screen long enough to read.” Unseen hunks stay at full contrast; seen ones recede. `V` remains as an override for “I looked, I swear.”

The progress pill becomes honest: `seen 40% of the semantic change` (quiet files discounted), not `12 of 135 reviewed`.

### Comments that follow the code

A GitHub thread is a line number with hope. Horus already drops viewed marks when content changes. Comments should **re-anchor** on the surrounding lines, and prefer a **symbol** when the hunk is a function. The local thread model already exists; the address is what is wrong.

---

## Leap 3 — Surfaces that are not source

### Documents as documents

`MarkdownContent` already renders PR bodies and agent answers. `README.md` in the tree is still a code view. That is a category error.

- **Source / Preview / Split** on a markdown file. Images resolve inside the approved root only.
- **Brief** as its own world: rendered description, submitted reviews, file list that jumps into the Patch world. Unstick `PullRequestContext` from the diff scroll.
- **Rendered diff** for a changed `.md`: old document | new document, block-level add/delete, using the existing `parseMarkdown` block list. This is the review GitHub still cannot do.

Comments on a rendered document attach to a **heading or paragraph**, not to `README.md:47`.

### Pair the test

When the walk is on `agentService.ts`, the right edge can offer the test file that names it (`agentService.test.ts` already sits next to it in this repo). Not a second CodeView forever — a **peek** that becomes a jump. Implementation and proof in one motion.

### Images are diffs

A skipped `png` in a PR is a hole. Before/after slider, same split metaphor as code. Anything else binary stays skipped.

### The three instruments share a subject

Diff, terminal, and agent currently share a window and nothing else. The selected hunk is the **subject**:

- CodeView highlights it.
- The agent receives that hunk (not the 80-file name list, not the entire patch).
- If the world is a Stage, the terminal is already in that tree; a command can be “run the test that names this symbol.”

`formatAgentReviewContext` is a file list on purpose. Keep that as the map. The subject is the pin. **Draft a review of this world** writes ghost comments into the existing local-thread model; the human accepts, edits, or throws them away, then submits. The agent does not become a second inbox.

---

## What this is not

- A browser of github.com.
- An IDE. Edit stays the exception, on one file, on Desk or Stage.
- Two CodeViews fighting in one layout.
- Animated tab switches, file jumps, or viewed checkboxes.
- Remote HTML, remote images, or scripts in document preview.
- A CI dashboard. Checks belong on lines, or they don’t belong.
- Chat that summarises the PR you can already scroll.

---

## Build order

Ship worlds first. Everything else is a surface with nowhere to sit.

1. **Patch worlds** — wrap today’s `repositoryReview` so a PR no longer destroys Desk. Collision radar comes for free.
2. **Walks + quiet files** — permute `orderReviewItems`; collapse the boring tail.
3. **Documents** — file preview, then Brief world, then rendered markdown diff.
4. **Since** — interdiff from the PR cache and viewed signatures you already persist.
5. **Seen light** — viewport-backed progress. Keep `V`.
6. **Stage worlds** — worktree + terminal cwd. This is “run the PR.”
7. **Claims, re-anchored comments, subject-pinned agent, test peek, image diffs.**

If only one thing ships, ship **Desk and Patch as two worlds**. If only two ship, add **walks**. Stage, Seen, and rendered docs are how it becomes something reviewers cannot get in a browser.
