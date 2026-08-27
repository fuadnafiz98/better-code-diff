# TODO audit — 2026-08-26

This file records the result of checking Claude's backlog against the current code.
Checked items are complete or deliberately rejected. No item below is an unverified
claim.

## Completed verification

- [x] Ran the full `bun run verify` gate. Lint, both TypeScript projects, the full
  automated test suite, and the production build pass.
- [x] Built and installed the arm64 macOS package. The packaged renderer opened the
  125-file review without console errors.
- [x] Smoke-tested Split/Unified switching, Settings, Terminal, and Edit mode in the
  installed app. Save stays disabled for an unchanged editor document.
- [x] Stress-tested 360 large scroll jumps through the 381,000-pixel review. After
  garbage collection, the second batch used 4.9 MB less JavaScript heap than the
  first batch and retained fewer DOM nodes. No unbounded scroll growth appeared.
- [x] React Doctor scores the changed React code 97/100. Its only remaining warning
  is the existing size of `RepositoryWorkspace`; splitting that component is a
  separate architectural refactor.
- [x] Re-reviewed the navigation, session restore, fullscreen, repository reset,
  merge-strategy, PR-cache, watcher, Git workflow, GitHub action, viewer-theme, and
  preference-migration fixes.
- [x] Fixed the remaining Codex replacement race. Stopping an old child now rejects
  its pending startup requests, and late `error`/`exit` events cannot abort its
  replacement. A regression test covers a pending `initialize` request.
- [x] Added a Happy DOM and Testing Library harness through `bunfig.toml`.
- [x] Added interaction coverage for keyboard save, retained edit sessions, both
  disk-conflict decisions, superseded PR loads, disabled Edit reasons, Save state,
  command execution, and command gating without a project.
- [x] Confirmed PR URLs are normalized in both renderer and main-process code. Tests
  cover copied GitHub URLs with `/files`, query strings, and fragments.

## Completed product work

- [x] GitHub conversation failures now show an alert with Retry during a PR review.
- [x] Added opt-in Save on editor blur. It is off by default and never bypasses a
  disk conflict.
- [x] Fixed draft restoration. Stored text now enters the editor document map, and a
  once-per-session toast can open the first recovered draft.
- [x] PR reviews now show the description and submitted review states in the
  scrolling review header. Long descriptions start collapsed.
- [x] Added a native explorer context menu for the safe, common actions: copy the
  relative path, copy the absolute path, and reveal the item in Finder. Main validates
  reveal paths against the open repository.
- [x] Wired the existing approved-root guard into production. Recent paths must have
  been selected by the user before, and old session files migrate their last root.

## Completed polish and platform work

- [x] Fixed the performance popover's false-live and frozen-chart behavior. The
  header now shows each sample time, failed or timed-out sampling becomes Stale or
  Unavailable, visibility gaps start a new continuous timeline, and transient
  working-set spikes no longer produce extreme leak rates. The header, KPI, chart,
  and diagnostics content now use one alignment edge; chart-axis labels no longer
  overlap the plot.
- [x] Reduced native renderer memory spikes during very fast review scrolling. An
  adaptive render governor skips invisible intermediate viewports, uses zero
  overscan during the fling, and always renders the exact final position. A fresh
  packaged benchmark fell from a 1,040 MB peak to 890 MB; repeated passes peaked at
  877 MB and 861 MB, then settled between 640 MB and 709 MB.
- [x] Added a visible yellow warning when the app working set reaches 1 GB. The
  lightweight titlebar sample now refreshes every three seconds while collapsed and
  every two seconds while open. The performance UI uses a flatter telemetry strip,
  aligned metric dividers, and fewer nested surfaces in both themes.
- [x] The repository drawer stays mounted long enough to animate out.
- [x] Added a clamped 1,000–50,000 line terminal scrollback preference. The default
  remains 5,000 and updates the live xterm instance.
- [x] Added rubber-band resistance to split-diff and terminal resizers. Release still
  commits a hard-bounded value.
- [x] Added an Electron clipboard provider. Plain text uses `readText`; Pierre's
  multi-caret MIME payload uses `clipboard.read(format)`.

## Rejected or stale claims

- [x] ~~Inline editing in `CodeView` is unfinished work.~~ Rejected for this change.
  It is a new architecture feature, not a missing part of the completed editor. The
  proposed plan also assumes per-item `expandUnchanged`, but Pierre exposes that as a
  viewer-wide option. The current safe flow keeps multi-file review as the default and
  opens the selected file only for editing.
- [x] ~~Add Open in terminal, Open on GitHub, and Discard to the explorer menu.~~
  Rejected as one bundled task. These actions need separate product rules and the
  destructive Discard action needs a dedicated restore API. The safe context actions
  are implemented without adding a destructive shortcut.
- [x] ~~Migrate all CSS literals to a new spacing scale.~~ Rejected. The values include
  optical adjustments, and no measured UI defect justified a broad visual rewrite.
- [x] ~~Add static scroll-edge masks to every long list.~~ Rejected. Correct masks need
  per-container overflow state; a broad mask can obscure code and short lists.
- [x] ~~The worker pool uses 2–4 workers and an AST cache of 64.~~ Stale. Measured
  memory work already reduced the pool to one worker and both AST caches to four.
- [x] ~~Split this dirty tree into suggested commits and push it.~~ Not authorized.
  The project rule says not to commit or push unless the user asks.

## External manual checks

- [ ] Test live GitHub reply/resolve/submit actions with an authenticated account.
- [ ] Test Claude and Codex login/approval flows with the user's CLI sessions.
- [ ] Keep the installed app hidden for more than five minutes, then confirm viewer
  suspension and restoration on the actual machine.

These checks depend on user accounts or elapsed desktop state. All local release
gates for this work passed: lint, typecheck, unit and interaction tests, build,
packaging, installed-app interaction smoke, and scroll-memory stress.
