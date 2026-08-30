# Ideas for Horus

GitHub is a website that happens to show diffs. Horus is a desk that already has the repo, the patch, a terminal, a watcher, and an agent in one process. The product is **a tabbed local review workspace**: keep working trees and reviews from several projects open together, review each change against its exact repository state, and prove it.

The global tab bar is the product shell. Correct repository ownership inside each tab is the point.

The loop that is worth building:

> Open a PR tab → keep it attached to the correct repository → revisit only changes pushed since the last review → keep comments on the correct code → give the agent the exact tab context.

That is something a browser cannot copy. It is also not an IDE.

---

## Rules

- One window. Several visible review tabs. **One mounted CodeView.**
- A tab owns one working tree, PR snapshot, comparison, commit, or Since view. Tabs can belong to different projects.
- “World” is an internal implementation term only. The interface and product documentation say **tab**.
- Everyday actions stay instant. No tab-switch animation, no motion on `]`.
- Pierre renders code. New ideas wrap it or reorder it. They do not replace it.
- If an idea needs the network for the *sensation* of review (embedded GitHub, remote HTML, CI dashboards), it is the wrong idea.
- Inactive tab state lives **outside** the viewer. Do not multiply the memory-heavy CodeView.

---

## What the code actually is

The thesis above overshot several shortcuts. These are the constraints, not nits.

The renderer now has the permanent browser-like tab shell, New Tab state, per-tab navigation, background request ownership, and one mounted `RepositoryWorkspace`. Completed inactive GitHub patch payloads have a 64 MB memory budget and reload through the disk cache when selected.

Main now holds a registry of independent repository services and watchers. A PR URL matches a verified local remote or asks for its checkout. Closing the final tab for a root releases its watcher. Agent requests carry an explicit registered repository root and structured tab subject; main does not infer their repository from whichever tab is active.

Linked-worktree watching exists only for Git metadata (`resolveLinkedGitDirectory` in `repositoryWatcher.ts`). It is not a multi-root capability model.

PR checkpoints now store dated manifests and prefer blob identities. That work supports Since tabs, but it does not provide global multi-project tab ownership by itself.

Review comments now store text and context anchors and expose ambiguous anchors as orphans. They remain owned by the corresponding PR review tab.

The markdown parser is headings, paragraphs, flat lists, quotes, and fenced code (`markdown.ts`). No links, images, tables, task lists, nesting, or source ranges. PR patches are hunks, not complete documents.

Selecting review lines attaches the exact text, path, side, range, blob identity, tab, repository root, and base/head revisions for the agent (`agentAttachments.ts`). Patch and Since requests are read-only. Working-tree requests may use the access level that the user configured.

The required review loop is now implemented. Document surfaces remain optional and should be added only when users need them.

---

## 1. Global review tabs

**Necessity: core product requirement.** Without independent tabs, opening a PR destroys or repoints the current review context. Cross-project review is impossible to trust if repository ownership is implicit.

A review tab is the visible owner of a repository context. It has stable identity and independent navigation. Patch snapshots are immutable; working-tree content stays live. Only the active tab’s CodeView is mounted.

The tab bar is permanent window chrome. It must be visible before a folder or PR is opened and must look and behave like a real browser tab strip:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [ Working tree · horus  × ] [ #221 · owner/repo  × ] [ #42 · other/repo × ] +│
├──────────────────────────────────────────────────────────────────────────────┤
│  Open folder, PR URL, branch comparison, or commit…                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Each tab has a source icon, concise title, close button, tooltip, and clear active state.
- The `+` button creates an immediate **New Tab**. It never changes the current tab.
- New Tab contains one prominent locator for a local folder, PR URL, branch comparison, or commit.
- A working-tree tab shows its repository or folder name and dirty state.
- A PR tab shows `#number` plus `owner/repository`. This disambiguates equal PR numbers across projects.
- A loading tab appears immediately and loads in place. It does not block switching to another tab.
- Every content tab can close. Closing the last content tab leaves one New Tab rather than an empty application shell.
- `⌘T` opens, `⌘W` closes, and `⌘⇧[ / ]` cycles tabs. Tab switching has no animation.
- Overflow uses a searchable menu, not a second horizontal scrollbar.
- Tab chrome must not cause the diff viewer to rerender. Inactive patch payloads use a bounded memory cache backed by the existing disk cache.

A tab may belong to any project. Opening `#221` from one project and `#42` from another must not repoint, replace, or mutate the working-tree tab. For a PR URL, Horus matches `owner/repository` to a registered local checkout. If there is no match, it asks the user to select a checkout. It must never silently bind the PR to the currently active folder.

**Required acceptance case:** keep these three tabs open at the same time:

1. `Working tree · project-a`
2. `#221 · owner/project-a`
3. `#42 · other/project-b`

Switching among them must restore the correct file, scroll position, comments, checkpoint, terminal target, and repository identity. Loading or refreshing one PR must not change either of the other tabs.

```text
ReviewTab
├── identity: tabId
├── source: new | workingTree | patch | since
├── repository: owner/name + localRoot + remote identity
├── snapshot: baseOid + headOid
├── review: files + patch (request-scoped load)
├── navigation: selected path + scroll
├── comments (anchored)
├── viewed state
└── checkpoint (if the source is a PR)
```

| Source | Meaning | Alive? |
| --- | --- | --- |
| **New Tab** | Empty entry point for a folder, PR URL, comparison, or commit. | Yes. No repository yet. |
| **Working tree** | One opened folder. `HEAD → working tree`. | Yes. Its own repository context. |
| **Patch** | A PR, `main...feature`, or a commit, as a frozen CodeView. | No. Pinned to `baseOid`/`headOid` until refresh. |
| **Since** | Files (later hunks) that changed since the last **checkpoint**, not since the last open. | No. |

Switching tabs restores navigation from stored state and remounts one CodeView. Loading is **request-scoped** to `tabId` plus a generation. Switching tabs does not cancel a matching background load. A late PR page can update only its matching tab generation.

**Collision radar** is exact path intersection: matching working-tree dirty paths ∩ Patch file list. Match tabs by verified repository identity, never by the active tab or folder name. Paint the overlap in the explorer. No heuristics.

The git panel already opens PRs, local compares, and commits. Those calls create or focus tabs. They must not replace an existing working-tree or review tab.

---

## 2. Checkpoints and “Since”

**Necessity: required for repeated reviews, not for a first review.** After an author pushes an update, the reviewer needs a stable baseline. Without it, Horus cannot distinguish new work from code that was already reviewed.

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

**Necessity: required when draft comments persist across a push.** A stored line number can point at different code after the PR changes. Anchors prevent Horus from silently submitting a comment on the wrong line.

This is foundational and lands **before** hunk-level Since.

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

## 4. Tab-aware subject and agent

**Necessity: completed correctness work.** Without this binding, a selection from a PR tab could make the agent inspect a different repository or revision. Cross-project tabs made that failure both more likely and harder to notice.

The subject is not “a path in the open folder.” It is:

```text
tabId + repository identity + path + revision + side + line range + exact selected text
```

- **Patch and Since tabs** send the exact selected hunk text and revision identity. They use read-only agent access and do not tell the agent to read another working tree.
- **Working-tree tabs** read from their own registered root and may use the access level that the user configured.
- Attachments and resumable agent sessions are scoped to the tab and revisions. Switching tabs cannot carry selected code or a session into another review.
- Main resolves the repository from the request subject. It rejects unknown roots instead of falling back to the active repository.

This prevents a plausible, silent wrong-repository answer. Exact selected text also prevents an immutable Patch selection from being replaced by newer working-tree content.

---

## 5. Documents and images

**Necessity: optional.** This improves reviews of documentation and visual assets. It is not required for code tabs, repository correctness, comments, or tests. Build it only if users regularly review Markdown or images in Horus.

The current parser is good enough for agent answers and short PR bodies. It is not document-grade.

Use a real CommonMark/GFM parser and sanitized rendering. Repository images go through a file API with realpath checks against the tab’s approved root. No network, no HTML, no scripts.

PR patches are partial hunks. A rendered old/new document needs **complete contents for both revisions** — a revision-content API, not `parsePatchFiles`.

Ship in this order:

1. Current-side markdown preview (working-tree file, or the new side of a Patch file once full content exists).
2. Old/new rendered documents, independently scrollable.
3. Block-level document diff after the AST has stable anchors.
4. Comments on heading/paragraph, using those anchors.

Images in a review: before/after slider for `png`/`svg`. Other binaries stay skipped.

The Brief is a Patch-tab header, not a fake GitHub page: rendered description, submitted reviews, and a file list that jumps within the same tab.

---

## What this is not

- A browser of github.com.
- An IDE. Edit stays the exception, on one file, on a working-tree tab.
- Two CodeViews mounted at once.
- Animated tab switches, file jumps, or viewed checkboxes.
- Remote HTML, remote images, or scripts in document preview.
- A CI dashboard. Checks belong on lines, or they don’t belong.
- Chat that summarises a PR you can already scroll.
- Telling the agent to read one working tree while the user is reviewing a different Patch tab.

---

## Build order

- [x] **1A. Review-tab state foundation** — Done 2026-08-28
  Stable tab identity, immutable Patch snapshots, per-tab navigation stored off the viewer, generation-scoped loading, one mounted CodeView, and exact-path collision radar. Opening a PR no longer replaces the working-tree review state.

- [x] **1B. Visible global tab shell + cross-project ownership** — Done 2026-08-29
  Permanent browser-like tab bar, active/inactive styling, source icons, close buttons, `+`, New Tab locator, overflow, keyboard controls, and real repository ownership per tab. Must pass the three-tab cross-project acceptance case above without mounting more than one CodeView.

- [x] **2. Review checkpoints + re-anchored comments** — Done 2026-08-28
   Explicit persisted checkpoints advance only on submit or Set checkpoint. Blob-first signatures drive file-level Since. Comments use text, context, side, blob, and optional symbol anchors; ambiguous comments block submission until reattached or dropped.

- [x] **3. Tab-aware agent context** — Done 2026-08-29
   Every selection and request is bound to its tab, registered repository root, revision, side, range, blob identity, and exact text. Patch and Since tabs force read-only access. Attachments and resumable sessions remain isolated by tab and revision.

- [ ] **4. Document and image surfaces** — **Optional**
   Real parser. Current-side preview first. Old/new full contents. Block diff after AST anchors. Image before/after.

If only one thing ships: **real working-tree and Patch tabs across projects, with one CodeView.**

If two: **checkpoints, file-level Since, and re-anchored comments.**

No required roadmap item remains. Document and image review is the next optional feature.
