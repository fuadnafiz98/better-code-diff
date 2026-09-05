# Track H1 — react-doctor, renderer (Wave 4, P13)

Started 2026-09-05 ~16:40. Ownership: src/renderer/src/** (not scripts).

## Live baseline (npx react-doctor@latest --verbose, 0.9.13)
30 warnings, score NOT printed.

Renderer (mine, 23):
- no-high-complexity-react-function x11: AgentPanel.tsx:77 (AgentPanel cyc47/cog56/d2),
  App.tsx:314 (AgentSessionLayout 28/55/5), AppView.tsx:387 (DiffToolbar 67/87/3),
  DiffSurface.tsx:247 (DiffContents 20/26/3), GitHubPanel.tsx:161 (RepositoryPanel 49/109/6),
  PerformanceChart.tsx:46 (35/45/3), PerformanceHud.tsx:53 (31/42/3),
  PullRequestReviewBar.tsx:28 (34/40/4), RepositoryWorkspace.tsx:277 (RepositoryReviewHeader 15/21/4),
  RepositoryWorkspace.tsx:806 (RepositoryDiffPanel 14/16/3), editor/EditorStatusBar.tsx:17 (14/21/4)
- no-giant-component x2: App.tsx:560 (App), CommandPalette.tsx:172 (CommandPalette)
- no-multi-component-file x6: AppView.tsx:130/187/286/345/371/387
- prefer-html-dialog: FolderPicker.tsx:225
- no-reset-all-state-on-prop-change: RepositoryWorkspace.tsx:1322
- no-adjust-state-on-prop-change x2: RepositoryWorkspace.tsx:1324/1325

Not mine (7): extensions/horus/src/open-pull-request.tsx:16,28; src/main/folderIndex.ts:47,50,56,150,81

Observed threshold floor for the complexity rule: cyclomatic 14 / cognitive 16 / depth 3 is
still flagged, so targets are cyclomatic <= 12 and cognitive <= 14.

## needs-owner (Track H2 / orchestrator)
- **SCORE BLOCKER**: `npx react-doctor --json` reports
  `skippedChecks: ["dead-code"]`,
  `skippedCheckReasons["dead-code"] = "Maintainability analysis failed: Error: ENOENT: no such
  file or directory, open '<repo>/extensions/horus/src/warmup-clipboard.ts'"`.
  P22 deleted that file from the worktree but the deletion is unstaged (`git status` shows ` D`),
  so `git ls-files` still lists it and react-doctor's dead-code pass opens it and throws.
  Until the deletion is staged (`git rm --cached extensions/horus/src/warmup-clipboard.ts`,
  or the wave's commit), NO numeric score can ever print, whatever the warning count.
  Not fixable from H1: outside ownership and staging is a forbidden git op.

## H1-1 DONE — split AppView.tsx (no-multi-component-file x6 cleared)
Files (new, one component each):
- src/renderer/src/ReviewFolderChip.tsx, ReviewLocator.tsx, Titlebar.tsx,
  ErrorBanner.tsx, FilePathBreadcrumbs.tsx, UnsavedDraftsPill.tsx, DiffToolbar.tsx
- src/renderer/src/AppView.tsx is now the shared view-type module only
  (DiffStyle, WorkspaceView, FileEditControls) — zero components, so the rule clears.
  Kept the path because 13 modules import those types.
- Titlebar.tsx keeps the lazy PerformanceHud + Suspense (P11 behaviour intact).
- Imports updated (no re-export shim): App.tsx (ErrorBanner/Titlebar),
  RepositoryWorkspace.tsx (DiffToolbar).
Tests:
- AppView.dom.test.tsx split into DiffToolbar.dom.test.tsx (6 tests) and
  Titlebar.dom.test.tsx (3 tests); assertions byte-identical, only imports changed.
Extra fix inside the section:
- react-doctor raised a NEW `rerender-memo-with-default-value` at Titlebar.tsx:53
  (`recentFolders = []` default inside `memo`). Hoisted to a module-level frozen
  `NO_RECENT_FOLDERS` constant. Cleared.
Gates: lint 0, typecheck 0, `bun test src/renderer` 601 pass / 0 fail,
react-doctor 24 warnings, **Score: 82 / 100 (it now prints)**.
Note: the dead-code/maintainability ENOENT that suppressed the score in the
baseline no longer fires after the file set changed — the score printed on both
runs after H1-1. Keeping the needs-owner note in case it returns.

## H1-2 DONE — no-giant-component x2 cleared (App, CommandPalette)
App.tsx 1004 -> 734 lines; the `App` component body 448 -> 269 lines.
New hooks (each with the moved code verbatim, behaviour preserved):
- src/renderer/src/useFolderOpen.ts — opening/openingRecentPath/folderPickerOpen state,
  openFolder, openFolderPicker/closeFolderPicker/toggleFolderPicker, openThroughPicker,
  openRecentFolder, openFolderFromPicker. `onError(null)` keeps the pre-open banner clear.
- src/renderer/src/useExternalPullRequest.ts — the Cmd+H / deep-link / pending-URL listener.
- src/renderer/src/useAppPersistence.ts — fonts + theme-color effect and the three
  useDebouncedPersist writes (preferences, workspace UI, file text).
- src/renderer/src/useAppCommands.ts — runCommand + useAppShortcuts (moved out of App.tsx)
  + useCommandPaletteControls.
- src/renderer/src/useSessionRestore.ts — startup snapshot settle + restorePending.
CommandPalette.tsx 575 -> 291 lines; component body 404 -> 235.
New modules:
- src/renderer/src/paletteQuery.ts (+ paletteQuery.test.ts, 8 tests) — isCommandOnlyQuery,
  paletteFilterQuery, searchQueryForRepository, pathCompletion, pullRequestNumber,
  fileNameFromPath. `pathCompletion` moved here (nothing imported it from CommandPalette).
- src/renderer/src/paletteActions.ts — `PaletteAction` type + `usePaletteActions` (the four
  memos: commands/branches, files, content, and the final ranked list).
- src/renderer/src/PaletteResults.tsx — the results region incl. the group offsets.
- src/renderer/src/PaletteRow.tsx — one row (memo), keeps `onClick={action.run}` so P20's
  no-closure-per-row property holds.
- src/renderer/src/PaletteSearchPreview.tsx — was `SearchPreview` inside CommandPalette.tsx.
  Renamed because `SearchPreview.tsx` collides with `searchPreview.ts` on a
  case-insensitive filesystem (tsc TS1261/TS1149).
reactCompiler.test.ts HOT_COMPONENTS extended: PaletteResults, PaletteRow,
usePaletteActions, Titlebar, DiffToolbar. All 9 files CompileSuccess.
Gates: lint 0, typecheck 0, `bun test src/renderer` 609 pass / 0 fail,
react-doctor 20 warnings, Score 83 / 100.

## H1-3 DONE — no-high-complexity-react-function x11 cleared
Measured fact used throughout: the rule counts the component function's OWN control
flow (nested callbacks do not count), and the flagged floor is cyclomatic 14 /
cognitive 16. Every fix moves top-level branches into a pure helper or a subcomponent.

editor/EditorStatusBar.tsx (14/21) -> editor/editorStatus.ts (+ .test.ts, 5 tests:
  editorStatusLabel, caretSelectionLabel), editor/useCaretReadout.ts,
  editor/EditorShortcutsSheet.tsx.
RepositoryWorkspace.tsx:277 RepositoryReviewHeader (15/21) -> reviewHeaderModel.ts
  (+ .test.ts, 6 tests: reviewToolbarTitle/Comparison, reviewBarMode), ReviewStatusBar.tsx.
RepositoryWorkspace.tsx:806 RepositoryDiffPanel (14/16) -> useViewerChunkPreload.ts,
  WorkspaceNoticeBars.tsx (EditConflictBar), ConversationErrorBar.tsx, ReviewFinishBar.tsx.
DiffSurface.tsx DiffContents (20/26) -> diffSurfaceState.ts (+ .test.ts, 5 tests),
  DiffStateScreen.tsx, DiffCodeView.tsx (owns DIFF_OPTIONS/INTERACTION_CSS/codeStyle/
  interactionOptions/fileOptions/diffOptions), VirtualizedBackToTop.tsx.
PerformanceHud.tsx (31/42) -> performanceHudModel.ts (+ .test.ts, 8 tests),
  usePerformanceSampling.ts, usePopoverDismiss.ts, PerformanceDiagnostics.tsx.
PerformanceChart.tsx (35/45) -> performanceChartModel.ts, usePerformanceChartInspector.ts,
  PerformanceChartCanvas.tsx, PerformanceChartTooltip.tsx.
PullRequestReviewBar.tsx (34/40) -> useOptionalState.ts, pullRequestReviewBarModel.ts
  (+ .test.ts, 3 tests), PullRequestReviewSummaryBar.tsx, PullRequestReviewComposer.tsx,
  PullRequestReviewNotices.tsx, PullRequestReviewActions.tsx.
DiffToolbar.tsx (67/87, the worst) -> diffToolbarModel.ts (+ .test.ts, 9 tests),
  DiffToolbarSubject.tsx, FileEditActions.tsx, DiffDisplayControls.tsx, and then
  DiffDisplayControls (24/35) -> FileEditStartButton.tsx, EditorOptionControls.tsx,
  MarkdownViewToggle.tsx, DiffLayoutToggle.tsx.
App.tsx AgentSessionLayout (28/55) -> appLayoutProps.ts (AppLayoutProps/WorkspaceLayoutProps),
  AppChrome.tsx, WorkspaceStage.tsx, CachedWorkspaceFallback.tsx, and then
  WorkspaceStage (15/43) -> WorkspaceRootHost.tsx.
GitHubPanel.tsx RepositoryPanel (49/109) -> gitPanelModel.ts, GitActionIcon.tsx,
  PullRequestRow.tsx, GitSyncBar.tsx, GitPanelTabs.tsx, GitHistoryTab.tsx,
  GitBranchesTab.tsx, GitRemotesTab.tsx, GitPullRequestsTab.tsx, useClosedPullRequests.ts,
  and then RepositoryPanel (14/17) -> GitPanelBody.tsx + gitPanelInbox.ts (+ .test.ts, 3 tests),
  GitPullRequestsTab (18/21) -> OpenPullRequestForm.tsx, ClosedPullRequestList.tsx.
  `formatUpdatedAgo` is re-exported from GitHubPanel.tsx so GitHubPanel.test.ts is untouched.
AgentPanel.tsx (47/56) -> agentPanelOptions.ts, agentFormat.ts, AgentUsageMeter.tsx,
  AgentUsageSummary.tsx, AgentAnswerActions.tsx, AgentLiveStatus.tsx, AgentTurnMeta.tsx,
  AgentActivityIcon.tsx, AgentActivityRow.tsx, AgentActivityTimeline.tsx, AgentTurn.tsx,
  AgentProviderConnection.tsx, AgentSelect.tsx, AgentConfigField.tsx, AgentDockHeader.tsx,
  AgentEmptyState.tsx, AgentApprovalRequests.tsx, AgentCurrentTurn.tsx,
  AgentSettingsPanel.tsx, AgentComposer.tsx.
Two existing tests were repointed (assertions unchanged): workspaceKeepMounted.test.ts now
reads WorkspaceRootHost.tsx for `workspaceKey={snapshot.root}`; reactCompiler.test.ts moved
CachedWorkspaceFallback to its own entry and added AppChrome + WorkspaceStage.
Gates: lint 0, typecheck 0, `bun test src/renderer` 656 pass / 0 fail,
react-doctor 4 warnings, Score 89 / 100. Zero complexity warnings left.

## H1-4 DONE — no-reset-all-state-on-prop-change + no-adjust-state-on-prop-change x2 cleared
RepositoryWorkspace.tsx held `fileFilter`, `reviewComposerExpanded` and `reviewComposerBody`
and reset all three from `useEffect(..., [reviewIdentity])` (:1284-1287).
Replaced by src/renderer/src/useReviewDraft.ts — one hook that owns the three values and
resets them during the render that brings the new identity in (React's
"adjusting some state when a prop changes" pattern, previous-value comparison). A keyed
subcomponent was rejected: the filter drives the explorer tree AND the review list, so the
key would have to sit on the whole workspace and would remount the tree on every review
switch, which is exactly what P27 stopped doing.
The transition render returns the fresh values, so the discarded pass never re-filters a
large tree with the stale query.
New test: useReviewDraft.dom.test.tsx (2 tests) — state survives a same-identity re-render;
a new identity clears it and the stale draft never reaches the DOM.
Also fixed: the other `setFileFilter` effect (:1363) now lists `setFileFilter` in its deps
(the hook's setter is a stable useState setter, so no behaviour change).
Gates: lint 0, typecheck 0, `bun test src/renderer` 658 pass / 0 fail,
react-doctor 1 warning, **Score 97 / 100**.

## H1-5 DONE — prefer-html-dialog cleared
FolderPicker.tsx: the `<div role="dialog">` wrapper is now a real `<dialog>`, opened with
`dialogRef.current?.show()` in the existing layout effect (which still focuses the input,
matching CommandPaletteShell's showModal-then-focus order) and closed on unmount.
DEVIATION from the section text ("showModal on open"): `show()`, not `showModal()`.
The picker is a popover anchored under its trigger button (`.folder-picker-host` is
`position: relative`, the picker is `position: absolute; top: calc(100% + 6px)`), and a
modal dialog is in the top layer, where `position: absolute` resolves against the viewport
instead of the host — `showModal()` would move it to the top-left corner of the window and
add a ::backdrop the design does not have. The rule's own guidance sanctions this:
"open it with `dialog.show()` (non-modal) or `dialog.showModal()` (modal)". Escape and
outside-click keep their existing handlers, because a non-modal dialog fires no `cancel`.
styles.css `.folder-picker` gains `margin: 0; padding: 0` to override the UA dialog sheet.
P27's 80 ms spinner delay untouched.
Gates: lint 0, lint:css 0, typecheck 0, `bun test src/renderer` 658 pass / 0 fail,
**react-doctor: No issues found — Score 100 / 100**.

## H1-6 DONE — final gates
- `npx react-doctor@latest --verbose`: **Score 100 / 100, "No issues found"**, zero renderer
  warnings (and zero anywhere: Track H2 cleared main/extensions in parallel).
  `--json`: `score 100`, `skippedChecks: []`, `complete: true` — the dead-code/maintainability
  pass now completes, so the SCORE BLOCKER noted at the top of this log resolved itself once
  the file set changed. No action needed from H2 for it.
- `bun run lint` 0, `bun run lint:css` 0, `bun run typecheck` 0.
- `bun test` (whole repo) **1,144 pass / 0 fail** across 144 files.
- `bun run build` OK, `bun run check:entry`:
  **Pre-mount closure 1,380,922 B across 26 chunks (limit 1,403,000)** — passes.
  Wave 3 left it at 1,361,302 B, so the split costs **+19,620 B** of ES-module plumbing
  across ~90 new modules (no new pre-mount edge: WorkerPool still absent, no vendor-shiki
  engine chunk in the closure). Entry closure 2,940 B / 65,536.
- Added useOptionalState.dom.test.tsx (2 tests) so the last new module with its own logic
  is covered.

## Style / compatibility notes
- No `any`, no default exports, no semicolons, single quotes, 2-space, named exports.
- reactCompiler.test.ts now covers 9 files / 14 hot components, all CompileSuccess.
- No file outside src/renderer/src/** was touched.
