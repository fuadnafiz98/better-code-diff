import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type Ref, type SetStateAction } from 'react'
import type { FileContents } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { useFileTree } from '@pierre/trees/react'

import type { FileComparison, PullRequestReviewComment, PullRequestReviewEvent, RepositoryChangeEvent, RepositoryFileStatus, RepositoryReview, RepositorySnapshot } from '../../shared/contracts'
import { DiffToolbar, type DiffStyle, type FileEditControls, type WorkspaceView } from './AppView'
import { Explorer } from './Explorer'
import { getEditorThemeType, type AppPreferences } from './preferences'
import { SidebarResizer } from './SidebarResizer'
import { PullRequestReviewBar } from './PullRequestReviewBar'
import { ReviewCheckpointBar } from './ReviewCheckpointBar'
import type { ReviewCheckpoint } from './reviewCheckpoints'
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { createPullRequestReviewComments } from './pullRequestReviewComments'
import type { AgentSelection } from './agentAttachments'
import { usePullRequestConversation } from './usePullRequestConversation'
import { useReviewSession } from './useReviewSession'
import { useReviewLoadState, type ReviewLoadState } from './useReviewLoadState'
import { useViewerSuspension } from './useViewerSuspension'
import type { ReviewCommand } from './keybindings'
import { useReviewShortcuts } from './useReviewShortcuts'
import { getDirectoryPaths, getTreeFollowBehavior, orderPathsForTree } from './treeExpansion'
import { FindBar } from './FindBar'
import { WorkspaceCodeSkeleton } from './WorkspaceSkeleton'
import { markRepositoryWorkspaceRender } from './reviewMetrics'
import { useCodeZoomGesture } from './useCodeZoomGesture'
import { useFileEditing } from './useFileEditing'
import { EditorStatusBar } from './editor/EditorStatusBar'
import { useViewerContext } from './editor/ViewerProviders'
import { workspaceViewForTreePath } from './workspaceMode'
import { getErrorMessage } from './repositoryApi'
import {
  getLoadedDiffSurface,
  getLoadedMultiFileReview,
  preloadWorkspaceViewer,
  subscribeDiffSurface,
  subscribeMultiFileReview
} from './workspaceBoot'
import { markRendererStartup } from './startupMetrics'

import type { ContentSearchState } from './DiffSurface'

type TreeFileStatus = Exclude<RepositoryFileStatus, 'conflicted'>

function selectOnlyTreePath(model: FileTreeModel, path: string): void {
  const selectedPaths = model.getSelectedPaths()
  if (selectedPaths.length === 1 && selectedPaths[0] === path) return
  for (const selectedPath of selectedPaths) {
    if (selectedPath !== path) model.getItem(selectedPath)?.deselect()
  }
  if (!selectedPaths.includes(path)) model.getItem(path)?.select()
}

// The file tree has no conflicted state, so conflicts ride along as modified there.
function toTreeStatus(status: RepositoryFileStatus): TreeFileStatus {
  return status === 'conflicted' ? 'modified' : status
}

const TREE_STYLES = `
  :host {
    /* @pierre/trees reads its row font from these overrides inside the shadow
       root; --font-mono follows the code-font preference on :root. */
    --trees-font-family-override: var(--font-mono);
    --trees-font-size-override: 12px;
  }

  button,
  [data-type="item"],
  [data-file-tree-search-input],
  [data-horus-tree-menu] {
    corner-shape: squircle;
  }

  button {
    touch-action: manipulation;
    transition: scale 110ms var(--ease-out), background-color 100ms var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, 100ms;
  }

  /* A full-width, unselected row answers a press with a tint; a ratio scale
     would squash it by 20px and read as the row being crushed. */
  [data-type="item"]:active:not([data-item-selected="true"]) {
    scale: 1;
    background: var(--accent-soft);
  }

  [data-type="item"] {
    border-radius: var(--corner-compact);
  }

  /* A stationary pointer must not paint every virtualized row that passes under
     it during wheel or trackpad scrolling. The selected row stays visible. */
  [data-file-tree-virtualized-root="true"][data-is-scrolling] [data-type="item"] {
    pointer-events: none;
    transition: none;
  }

  [data-file-tree-virtualized-root="true"][data-is-scrolling]
  [data-type="item"]:hover:not([data-item-selected="true"]),
  [data-file-tree-virtualized-root="true"][data-is-scrolling]
  [data-type="item"][data-item-context-hover="true"]:not([data-item-selected="true"]) {
    background-color: var(--trees-bg);
    --truncate-marker-background-overlay-color: transparent;
  }

  /* The tree marks pointer-focused rows with data-item-focused, which makes its
     focus outline jump between rows on every click. Keep the outline for
     keyboard navigation, where it communicates focus, and let pointer clicks
     use the stable selection fill. */
  [data-type="item"][data-item-focused="true"]:not(:focus-visible)::before {
    content: none;
  }

  [data-file-tree-search-input] {
    height: var(--control-height);
    border-radius: var(--corner-control);
    font-size: var(--text-md);
  }

  [data-file-tree-search-container] {
    padding: 7px 8px 6px;
  }

  [data-horus-tree-menu] {
    min-width: 190px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border-strong);
    border-radius: var(--corner-card);
    padding: 4px;
    background: var(--popover);
    box-shadow: var(--elev-2);
  }

  [data-horus-tree-menu] button {
    min-height: 28px;
    display: flex;
    align-items: center;
    border: 0;
    border-radius: var(--corner-compact);
    padding: 0 9px;
    background: transparent;
    color: var(--text-secondary);
    font: 12px var(--font-ui);
    text-align: left;
    cursor: pointer;
  }

  [data-horus-tree-menu] button:hover,
  [data-horus-tree-menu] button:focus-visible {
    outline: 0;
    background: var(--control-fill-hover);
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    button {
      transition-property: background-color, color, border-color !important;
      transition-duration: 160ms !important;
      transition-timing-function: ease !important;
    }

    button:active:not(:disabled) {
      scale: 1 !important;
      transform: none !important;
    }
  }
`

const TREE_INSTANT_FOLLOW_RESET_MS = 800

export interface RepositoryWorkspaceProps {
  snapshot: RepositorySnapshot
  selectedPath: string | null
  comparison: FileComparison | null
  loadingDiff: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  onAttachToAgent(selection: AgentSelection): void
  onPreferencesChange(preferences: AppPreferences): void
  repositoryReview: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  repositoryChange: RepositoryChangeEvent | null
  collisionPaths: ReadonlySet<string>
  initialReviewScrollTop: number
  onReviewScrollPositionChange(scrollTop: number): void
  /** Repository search state, surfaced as inline hint markers while editing. */
  contentSearch?: ContentSearchState
  onSelectPath(path: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string, comments: PullRequestReviewComment[]): Promise<boolean>
  onComparisonSaved(comparison: FileComparison): void
  onError(message: string | null): void
}

interface RepositoryReviewHeaderProps {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  repositoryReview: RepositoryReview | null
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  onOpenReviewSummary(): void
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

function RepositoryReviewHeader({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  repositoryReview,
  reviewWorldSource,
  reviewCheckpoint,
  checkpointChangedFileCount,
  checkpointRemovedFileCount,
  reviewReady,
  wordWrap,
  foldUnchanged,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  onClosePullRequestReview,
  onSetReviewCheckpoint,
  onOpenSinceReview,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  onOpenReviewSummary,
  onSubmitPullRequestReview
}: RepositoryReviewHeaderProps): React.JSX.Element {
  const pathSegments = selectedPath?.split('/') ?? []

  return (
    <>
      <DiffToolbar
        comparison={comparison}
        selectedPath={selectedPath}
        isGitRepository={isGitRepository}
        isFilePreview={isFilePreview}
        diffStyle={diffStyle}
        workspaceView={workspaceView}
        reviewFileCount={reviewFileCount}
        reviewTitle={repositoryReview == null ? undefined : repositoryReview.kind === 'github' ? `#${repositoryReview.pullRequest.number} ${repositoryReview.pullRequest.title}` : repositoryReview.title}
        reviewComparison={repositoryReview == null ? undefined : repositoryReview.kind === 'github' ? `${repositoryReview.pullRequest.baseRefName} → ${repositoryReview.pullRequest.headRefName}` : `${repositoryReview.baseRefName} → ${repositoryReview.headRefName}`}
        wordWrap={wordWrap}
        foldUnchanged={foldUnchanged}
        fileEdit={fileEdit}
        onCloseExternalReview={repositoryReview == null ? undefined : onClosePullRequestReview}
        onDiffStyleChange={onDiffStyleChange}
        onWordWrapToggle={onWordWrapToggle}
        onFoldUnchangedToggle={onFoldUnchangedToggle}
      />
      {repositoryReview?.kind === 'github' && reviewWorldSource === 'patch' ? (
        <ReviewCheckpointBar
          checkpoint={reviewCheckpoint}
          changedFileCount={checkpointChangedFileCount}
          removedFileCount={checkpointRemovedFileCount}
          reviewReady={reviewReady}
          onSetCheckpoint={onSetReviewCheckpoint}
          onOpenSince={onOpenSinceReview}
        />
      ) : null}
      {repositoryReview?.kind === 'github' && repositoryReview.pullRequest.state === 'OPEN' && reviewWorldSource === 'patch' ? (
        <PullRequestReviewBar
          submitting={submittingPullRequestReview}
          message={pullRequestReviewMessage}
          inlineCommentCount={inlineCommentCount}
          orphanedCommentCount={orphanedCommentCount}
          viewerCanSubmitDecision={repositoryReview.viewerCanSubmitDecision}
          onOpen={onOpenReviewSummary}
          onSubmit={onSubmitPullRequestReview}
        />
      ) : repositoryReview?.kind === 'github' && reviewWorldSource === 'since' ? (
        <div className="pr-review-readonly" role="status">
          File-level changes since the checkpoint. Return to the Patch world to submit a review.
        </div>
      ) : repositoryReview?.kind === 'github' ? (
        <div className="pr-review-readonly" role="status">
          This pull request is {repositoryReview.pullRequest.state.toLowerCase()}. Review submission is disabled.
        </div>
      ) : repositoryReview?.kind === 'local' ? (
        <div className="pr-review-readonly" role="status">Local branch review. Comments stay local and can be copied from the review summary.</div>
      ) : null}
      {isFilePreview && pathSegments.length > 0 ? (
        <nav className="editor-breadcrumbs" aria-label="File path">
          {pathSegments.map((segment, index) => (
            <span key={`${segment}:${index}`}>
              {index > 0 ? <span className="breadcrumb-separator" aria-hidden="true">›</span> : null}
              <span>{segment}</span>
            </span>
          ))}
        </nav>
      ) : null}
    </>
  )
}

function useReviewPaths(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null
): string[] {
  const unorderedReviewPaths = useMemo(
    () => repositoryReview?.files.map((file) => file.path)
      ?? (snapshot.kind === 'git' ? snapshot.statuses.map((status) => status.path) : snapshot.paths),
    [repositoryReview, snapshot.kind, snapshot.paths, snapshot.statuses]
  )
  return useMemo(() => orderPathsForTree(unorderedReviewPaths), [unorderedReviewPaths])
}

function useReviewTreeData(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null,
  reviewPaths: readonly string[],
  threadsByPath: Record<string, ReviewThread[]>
) {
  // Both source arrays are already memoized, so identity is the whole test the
  // tree needs. Joining them into multi-megabyte keys on every render was the
  // most expensive thing this component did on a large repository.
  const treePaths = repositoryReview == null ? snapshot.paths : reviewPaths
  const treeStatuses = useMemo<Array<{ path: string; status: TreeFileStatus }>>(
    () => repositoryReview == null
      ? snapshot.statuses.map((status) => ({ path: status.path, status: toTreeStatus(status.status) }))
      : repositoryReview.files.map((file) => ({ path: file.path, status: 'modified' as const })),
    [repositoryReview, snapshot.statuses]
  )
  const reviewComments = useMemo(
    () => createPullRequestReviewComments(threadsByPath),
    [threadsByPath]
  )
  const orphanedCommentCount = useMemo(
    () => Object.values(threadsByPath).reduce(
      (count, threads) => threads.reduce(
        (pathCount, thread) => pathCount + (thread.orphaned ? 1 : 0),
        count
      ),
      0
    ),
    [threadsByPath]
  )

  return { treePaths, treeStatuses, reviewComments, orphanedCommentCount }
}

function useViewerPreferences(
  preferences: AppPreferences,
  codeZoom: { codeFontSize: number; codeLineHeight: number }
): AppPreferences {
  return useMemo(
    () => ({
      ...preferences,
      codeFontSize: codeZoom.codeFontSize,
      codeLineHeight: codeZoom.codeLineHeight
    }),
    [codeZoom.codeFontSize, codeZoom.codeLineHeight, preferences]
  )
}

// Ancestors of every path, shallowest first. Unlike getDirectoryPaths this does
// not sort — the tree only needs deepest-first for the collapse pass, which the
// single sorted list already provides.
function collectDirectoryPaths(paths: readonly string[]): Set<string> {
  const directories = new Set<string>()
  for (const path of paths) {
    let index = path.indexOf('/')
    while (index > 0) {
      directories.add(path.slice(0, index))
      index = path.indexOf('/', index + 1)
    }
  }
  return directories
}

function repositoryReviewIdentity(repositoryReview: RepositoryReview | null): string {
  if (repositoryReview == null) return 'working-tree'
  return repositoryReview.kind === 'github'
    ? `github:${repositoryReview.pullRequest.url}`
    : repositoryReview.id
}

function createTreeContextMenu(
  root: string,
  item: { path: string },
  close: () => void
): HTMLElement {
  const menu = document.createElement('div')
  menu.dataset.horusTreeMenu = ''
  menu.setAttribute('role', 'menu')
  const addAction = (label: string, run: () => void): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = label
    button.addEventListener('click', () => {
      close()
      run()
    })
    menu.append(button)
  }
  addAction('Copy relative path', () => void navigator.clipboard.writeText(item.path))
  const absolutePath = `${root.replace(/[/\\]$/, '')}/${item.path}`
  addAction('Copy absolute path', () => void navigator.clipboard.writeText(absolutePath))
  addAction('Reveal in Finder', () => void window.repository?.revealPath(item.path))
  return menu
}

// Applying the same paths again would collapse every directory, so the model is
// only reset when the content behind it actually changed.
function useTreeContentSync(
  model: FileTreeModel,
  isGitRepository: boolean,
  treePaths: readonly string[],
  treeStatuses: readonly { path: string; status: TreeFileStatus }[],
  directoryPaths: readonly string[],
  changedDirectoryPaths: readonly string[]
): void {
  const appliedTreeContentRef = useRef<{
    paths: readonly string[]
    statuses: readonly { path: string; status: TreeFileStatus }[]
  } | null>(null)

  useLayoutEffect(() => {
    // Resetting the model collapses every directory, so identical content must not reset it.
    const applied = appliedTreeContentRef.current
    if (applied?.paths === treePaths && applied.statuses === treeStatuses) return
    appliedTreeContentRef.current = { paths: treePaths, statuses: treeStatuses }
    model.resetPaths(treePaths)
    model.setGitStatus(treeStatuses)
    if (isGitRepository) {
      for (const directoryPath of [...directoryPaths].reverse()) {
        const item = model.getItem(directoryPath)
        if (item != null && 'collapse' in item) item.collapse()
      }
      for (const directoryPath of changedDirectoryPaths) {
        const item = model.getItem(directoryPath)
        if (item != null && 'expand' in item) item.expand()
      }
    }
  }, [changedDirectoryPaths, directoryPaths, isGitRepository, model, treePaths, treeStatuses])

}

/**
 * A direct navigation (tree click, ⌘P, review shortcut) should land instantly,
 * while the review's own scroll-follow animates. The pending target says which
 * of the two the next visible-path report came from.
 */
function useInstantTreeFollow(): {
  markInstantTreeFollowTarget(path: string): void
  consumeInstantTreeFollowTarget(path: string): string | null
} {
  const targetRef = useRef<string | null>(null)
  const resetRef = useRef<number | null>(null)

  const clearReset = useCallback(() => {
    if (resetRef.current == null) return
    window.clearTimeout(resetRef.current)
    resetRef.current = null
  }, [])

  const markInstantTreeFollowTarget = useCallback((path: string) => {
    targetRef.current = path
    clearReset()
    resetRef.current = window.setTimeout(() => {
      targetRef.current = null
      resetRef.current = null
    }, TREE_INSTANT_FOLLOW_RESET_MS)
  }, [clearReset])

  const consumeInstantTreeFollowTarget = useCallback((path: string) => {
    const target = targetRef.current
    if (target !== path) return target
    targetRef.current = null
    clearReset()
    return target
  }, [clearReset])

  useEffect(() => clearReset, [clearReset])

  return { markInstantTreeFollowTarget, consumeInstantTreeFollowTarget }
}

interface RepositoryDiffPanelProps {
  surfaceRef: Ref<HTMLElement>
  isFilePreview: boolean
  header: RepositoryReviewHeaderProps
  conflict: { path: string } | null
  onKeepDraft(): void
  onReloadFromDisk(): void
  conversationUnavailable: string | null
  onRetryConversation(): void
  viewerSuspended: boolean
  workspaceView: WorkspaceView
  reviewIdentity: string
  reviewSessionRevision: number
  reviewPaths: readonly string[]
  diffStyle: DiffStyle
  viewerPreferences: AppPreferences
  repositoryReview: RepositoryReview | null
  reviewLoadState: ReviewLoadState
  reviewLoading: boolean
  reviewTargetPathCount: number
  onLoadMoreReviewFiles(): void
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation: ReturnType<typeof usePullRequestConversation>['conversation']
  reviewScrollRevision: number
  selectedPath: string | null
  multiFileNavigationRevision: number
  initialScrollTop: number
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ReturnType<typeof useReviewSession>['viewedFiles']
  setViewedFiles: ReturnType<typeof useReviewSession>['setViewedFiles']
  remoteThreadsByPath: ReturnType<typeof usePullRequestConversation>['threadsByPath']
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  onAttachToAgent(selection: AgentSelection): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
  surfaceComparison: FileComparison | null
  surfaceLoading: boolean
  contentSearch?: ContentSearchState
  editMode: 'edit' | 'preview' | 'read'
  onDraftFileChange(file: FileContents): void
  onEditorAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onEditorBlur(): void
  showStatusBar: boolean
  fileExtension: string | undefined
  dirty: boolean
  getEditor(): Editor<ReviewAnnotationMetadata> | null
  onError(message: string | null): void
}

function useRepositoryReviewHeader({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  repositoryReview,
  reviewWorldSource,
  reviewCheckpoint,
  checkpointChangedFileCount,
  checkpointRemovedFileCount,
  reviewReady,
  preferences,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  onClosePullRequestReview,
  onSetReviewCheckpoint,
  onOpenSinceReview,
  onDiffStyleChange,
  onPreferencesChange,
  onOpenReviewSummary,
  onSubmitPullRequestReview
}: {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  repositoryReview: RepositoryReview | null
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  preferences: AppPreferences
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
  onDiffStyleChange(style: DiffStyle): void
  onPreferencesChange(preferences: AppPreferences): void
  onOpenReviewSummary(): void
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
}): RepositoryReviewHeaderProps {
  const toggleWordWrap = useCallback(() => {
    onPreferencesChange({ ...preferences, wordWrap: !preferences.wordWrap })
  }, [onPreferencesChange, preferences])
  const toggleFoldUnchanged = useCallback(() => {
    onPreferencesChange({ ...preferences, foldUnchanged: !preferences.foldUnchanged })
  }, [onPreferencesChange, preferences])
  return useMemo(() => ({
    comparison,
    selectedPath,
    isGitRepository,
    isFilePreview,
    diffStyle,
    workspaceView,
    reviewFileCount,
    repositoryReview,
    reviewWorldSource,
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
    wordWrap: preferences.wordWrap,
    foldUnchanged: preferences.foldUnchanged,
    fileEdit,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount,
    orphanedCommentCount,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
    onDiffStyleChange,
    onWordWrapToggle: toggleWordWrap,
    onFoldUnchangedToggle: toggleFoldUnchanged,
    onOpenReviewSummary,
    onSubmitPullRequestReview
  }), [
    comparison,
    diffStyle,
    fileEdit,
    inlineCommentCount,
    orphanedCommentCount,
    isFilePreview,
    isGitRepository,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
    onDiffStyleChange,
    onOpenReviewSummary,
    onSubmitPullRequestReview,
    preferences.foldUnchanged,
    preferences.wordWrap,
    pullRequestReviewMessage,
    repositoryReview,
    reviewWorldSource,
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
    reviewFileCount,
    selectedPath,
    submittingPullRequestReview,
    toggleFoldUnchanged,
    toggleWordWrap,
    workspaceView
  ])
}

const RepositoryDiffPanel = memo(function RepositoryDiffPanel({
  surfaceRef,
  isFilePreview,
  header,
  conflict,
  onKeepDraft,
  onReloadFromDisk,
  conversationUnavailable,
  onRetryConversation,
  viewerSuspended,
  workspaceView,
  reviewIdentity,
  reviewSessionRevision,
  reviewPaths,
  diffStyle,
  viewerPreferences,
  repositoryReview,
  reviewLoadState,
  reviewLoading,
  reviewTargetPathCount,
  onLoadMoreReviewFiles,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation,
  reviewScrollRevision,
  selectedPath,
  multiFileNavigationRevision,
  initialScrollTop,
  onScrollPositionChange,
  onVisiblePathChange,
  threadsByPath,
  setThreadsByPath,
  viewedFiles,
  setViewedFiles,
  remoteThreadsByPath,
  pendingRemoteThreadId,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  onAttachToAgent,
  reviewCommand,
  surfaceComparison,
  surfaceLoading,
  contentSearch,
  editMode,
  onDraftFileChange,
  onEditorAttach,
  onEditorBlur,
  showStatusBar,
  fileExtension,
  dirty,
  getEditor,
  onError
}: RepositoryDiffPanelProps): React.JSX.Element {
  const DiffSurface = useSyncExternalStore(
    subscribeDiffSurface,
    getLoadedDiffSurface,
    getLoadedDiffSurface
  )
  const MultiFileReview = useSyncExternalStore(
    subscribeMultiFileReview,
    getLoadedMultiFileReview,
    getLoadedMultiFileReview
  )

  useEffect(() => {
    let active = true
    void preloadWorkspaceViewer(workspaceView).catch((error: unknown) => {
      if (active) onError(getErrorMessage(error))
    })
    return () => { active = false }
  }, [onError, workspaceView])

  return (
    <section ref={surfaceRef} className={`diff-panel ${isFilePreview ? 'file-preview-mode' : 'diff-mode'}`} id="repository-diff">
      <RepositoryReviewHeader {...header} />
      <FindBar />
      {conflict != null ? (
        <div className="pr-review-readonly" role="alert">
          {conflict.path} changed on disk while you were editing it.
          <button type="button" onClick={onKeepDraft}>Keep my draft</button>
          <button type="button" onClick={onReloadFromDisk}>Reload from disk</button>
        </div>
      ) : null}
      {conversationUnavailable != null ? (
        <div className="pr-review-readonly" role="alert">
          {conversationUnavailable}
          <button type="button" onClick={onRetryConversation}>Retry</button>
        </div>
      ) : null}
      {viewerSuspended ? (
        <div className="diff-state"><span>Viewer paused while the app is hidden.</span></div>
      ) : workspaceView === 'multi' ? (
        MultiFileReview == null ? <WorkspaceCodeSkeleton /> : (
            <MultiFileReview
              key={`${reviewIdentity}:${reviewSessionRevision}`}
              paths={reviewPaths}
              diffStyle={diffStyle}
              preferences={viewerPreferences}
              repositoryReview={repositoryReview}
              loadState={reviewLoadState}
              loading={reviewLoading}
              targetPathCount={reviewTargetPathCount}
              onLoadMore={onLoadMoreReviewFiles}
              sinceRemovedPaths={sinceRemovedPaths}
              sinceUncertainPaths={sinceUncertainPaths}
              pullRequestConversation={pullRequestConversation}
              scrollToReviewRevision={reviewScrollRevision}
              navigationPath={selectedPath}
              navigationRevision={multiFileNavigationRevision}
              initialScrollTop={initialScrollTop}
              onScrollPositionChange={onScrollPositionChange}
              onVisiblePathChange={onVisiblePathChange}
              threadsByPath={threadsByPath}
              setThreadsByPath={setThreadsByPath}
              viewedFiles={viewedFiles}
              setViewedFiles={setViewedFiles}
              remoteThreadsByPath={remoteThreadsByPath}
              pendingRemoteThreadId={pendingRemoteThreadId}
              onReplyToRemoteThread={onReplyToRemoteThread}
              onResolveRemoteThread={onResolveRemoteThread}
              onAttachToAgent={onAttachToAgent}
              reviewCommand={reviewCommand}
            />
        )
      ) : (
        DiffSurface == null ? <WorkspaceCodeSkeleton /> : (
            <DiffSurface comparison={surfaceComparison} loading={surfaceLoading} diffStyle={diffStyle}
              preferences={viewerPreferences} editMode={editMode}
              contentSearch={contentSearch} getEditor={getEditor}
              onDraftFileChange={onDraftFileChange} onEditorAttach={onEditorAttach}
              onEditorBlur={onEditorBlur}
              onAttachToAgent={onAttachToAgent}
              threadsByPath={threadsByPath} setThreadsByPath={setThreadsByPath} />
        )
      )}
      {showStatusBar ? (
        <EditorStatusBar
          mode={editMode}
          dirty={dirty}
          fileExtension={fileExtension}
          getEditor={getEditor}
        />
      ) : null}
    </section>
  )
})

function useRetainedComparison(
  comparison: FileComparison | null,
  selectedPath: string | null,
  loading: boolean
): { comparison: FileComparison | null; loading: boolean } {
  // Multi-file review unmounts DiffSurface. Retain only the last comparison for
  // the same path so returning to a file does not flash an empty viewer.
  const retainedRef = useRef<FileComparison | null>(null)
  useEffect(() => {
    if (comparison != null) retainedRef.current = comparison
  }, [comparison])
  const retained = comparison ?? (retainedRef.current?.path === selectedPath ? retainedRef.current : null)
  return {
    comparison: retained,
    loading: loading || (comparison == null && retained != null)
  }
}

function usePullRequestReviewSubmission(
  orphanedCommentCount: number,
  reviewComments: PullRequestReviewComment[],
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>,
  submit: RepositoryWorkspaceProps['onSubmitPullRequestReview']
): {
  reviewSessionRevision: number
  submitReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
} {
  const [reviewSessionRevision, setReviewSessionRevision] = useState(0)
  const submitReview = useCallback(async (event: PullRequestReviewEvent, body: string) => {
    if (orphanedCommentCount > 0) return false
    const submitted = await submit(event, body, reviewComments)
    if (submitted) {
      setThreadsByPath({})
      setReviewSessionRevision((revision) => revision + 1)
    }
    return submitted
  }, [orphanedCommentCount, reviewComments, setThreadsByPath, submit])
  return { reviewSessionRevision, submitReview }
}

function useRepositoryReviewSession({
  root,
  reviewIdentity,
  reviewPaths,
  workspaceView,
  repositoryReview,
  repositoryChange,
  reviewWorldSource
}: {
  root: string
  reviewIdentity: string
  reviewPaths: readonly string[]
  workspaceView: WorkspaceView
  repositoryReview: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
  reviewWorldSource: RepositoryWorkspaceProps['reviewWorldSource']
}) {
  const active = workspaceView === 'multi'
  const activePaths = useMemo(() => active ? [...reviewPaths] : [], [active, reviewPaths])
  const pathsKey = useMemo(() => activePaths.join('\0'), [activePaths])
  const load = useReviewLoadState({
    pathsKey,
    stablePaths: activePaths,
    repositoryReview: active ? repositoryReview : null,
    repositoryChange: active ? repositoryChange : null
  })
  const session = useReviewSession(root, reviewIdentity, {
    items: load.loadState.items,
    loading: load.loading,
    enabled: active && reviewWorldSource === 'patch' && repositoryReview?.kind === 'github'
  })
  return { ...session, load }
}

function useReviewNavigation({
  paths,
  workspaceView,
  initialScrollTop,
  markInstantTreeFollowTarget,
  onSelectPath,
  onWorkspaceViewChange,
  onScrollPositionChange
}: {
  paths: readonly string[]
  workspaceView: WorkspaceView
  initialScrollTop: number
  markInstantTreeFollowTarget(path: string): void
  onSelectPath(path: string): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onScrollPositionChange(scrollTop: number): void
}) {
  const [reviewCommand, setReviewCommand] = useState<{
    command: ReviewCommand
    path: string
    revision: number
  } | null>(null)
  const [scrollRevision, setScrollRevision] = useState(0)
  const [navigationRevision, setNavigationRevision] = useState(0)
  const visiblePathRef = useRef<string | null>(null)
  const scrollTopRef = useRef(initialScrollTop)
  const advance = useCallback(() => setNavigationRevision((revision) => revision + 1), [])
  const openSummary = useCallback(() => {
    scrollTopRef.current = 0
    onWorkspaceViewChange('multi')
    setScrollRevision((revision) => revision + 1)
  }, [onWorkspaceViewChange])
  const rememberScroll = useCallback((scrollTop: number) => {
    scrollTopRef.current = scrollTop
    onScrollPositionChange(scrollTop)
  }, [onScrollPositionChange])
  const navigate = useCallback((path: string) => {
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    advance()
  }, [advance, markInstantTreeFollowTarget, onSelectPath])
  const runItemCommand = useCallback((command: ReviewCommand, path: string) => {
    setReviewCommand((current) => ({ command, path, revision: (current?.revision ?? 0) + 1 }))
  }, [])

  useReviewShortcuts({
    active: workspaceView === 'multi',
    paths,
    currentPathRef: visiblePathRef,
    onNavigate: navigate,
    onItemCommand: runItemCommand
  })

  return {
    advance,
    navigationRevision,
    openSummary,
    rememberScroll,
    reviewCommand,
    scrollRevision,
    scrollTopRef,
    visiblePathRef
  }
}

const RepositoryWorkspace = memo(function RepositoryWorkspace({
  snapshot, selectedPath, comparison, loadingDiff, diffStyle, workspaceView,
  preferences, onAttachToAgent, onPreferencesChange, repositoryReview, reviewWorldSource,
  reviewCheckpoint, checkpointChangedFileCount, checkpointRemovedFileCount, reviewReady,
  sinceRemovedPaths, sinceUncertainPaths,
  repositoryChange, contentSearch, onSelectPath,
  collisionPaths, initialReviewScrollTop, onReviewScrollPositionChange,
  onDiffStyleChange, onWorkspaceViewChange, onClosePullRequestReview, onSetReviewCheckpoint,
  onOpenSinceReview, submittingPullRequestReview,
  pullRequestReviewMessage, onSubmitPullRequestReview, onComparisonSaved, onError
}: RepositoryWorkspaceProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('explorerCommitted'), [])
  useEffect(markRepositoryWorkspaceRender)
  const isFilePreview = workspaceView === 'file' && comparison?.mode === 'file'
  const reviewIdentity = repositoryReviewIdentity(repositoryReview)
  const reviewPaths = useReviewPaths(snapshot, repositoryReview)
  const { threadsByPath, setThreadsByPath, viewedFiles, setViewedFiles, load: reviewLoad } =
    useRepositoryReviewSession({
      root: snapshot.root,
      reviewIdentity,
      reviewPaths,
      workspaceView,
      repositoryReview,
      repositoryChange,
      reviewWorldSource
    })
  const conversation = usePullRequestConversation(repositoryReview, onError)
  const viewer = useViewerContext()
  const codeZoom = useCodeZoomGesture(preferences.codeFontSize, preferences.codeLineHeight)
  const hiddenLongEnoughToRelease = useViewerSuspension()
  const { markInstantTreeFollowTarget, consumeInstantTreeFollowTarget } = useInstantTreeFollow()
  const {
    advance: advanceMultiFileNavigation,
    navigationRevision: multiFileNavigationRevision,
    openSummary: openReviewSummary,
    rememberScroll: handleMultiFileScrollPositionChange,
    reviewCommand,
    scrollRevision: reviewScrollRevision,
    scrollTopRef: multiFileScrollTopRef,
    visiblePathRef: visibleMultiFilePathRef
  } = useReviewNavigation({
    paths: reviewPaths,
    workspaceView,
    initialScrollTop: initialReviewScrollTop,
    markInstantTreeFollowTarget,
    onSelectPath,
    onWorkspaceViewChange,
    onScrollPositionChange: onReviewScrollPositionChange
  })
  const collisionPathsRef = useRef(collisionPaths)
  useLayoutEffect(() => {
    collisionPathsRef.current = collisionPaths
  }, [collisionPaths])
  const fileEditing = useFileEditing({
    root: snapshot.root,
    comparison,
    selectedPath,
    workspaceView,
    repositoryReview,
    autosaveOnBlur: preferences.autosaveOnBlur,
    onWorkspaceViewChange,
    onSelectPath,
    onComparisonChange: onComparisonSaved,
    onError
  })
  const { treePaths, treeStatuses, reviewComments, orphanedCommentCount } =
    useReviewTreeData(snapshot, repositoryReview, reviewPaths, threadsByPath)
  const reviewPathSet = useMemo(() => new Set(reviewPaths), [reviewPaths])
  const fileExtension = selectedPath?.split('.').at(-1)?.toUpperCase()
  const viewerPreferences = useViewerPreferences(preferences, codeZoom)
  // Releasing the viewer would destroy the edit session and every unsaved draft
  // with it, so a dirty workspace keeps its memory.
  const viewerSuspended = hiddenLongEnoughToRelease
    && fileEditing.activeSession == null
    && fileEditing.controls.unsavedPaths.length === 0

  // Unmounting the viewer only frees DOM; the workers and their AST caches are
  // the expensive part, so the provider tears the pool down too.
  const setViewerSuspended = viewer?.setViewerSuspended
  useEffect(() => {
    setViewerSuspended?.(viewerSuspended)
  }, [setViewerSuspended, viewerSuspended])

  const { comparison: surfaceComparison, loading: surfaceLoading } = useRetainedComparison(
    fileEditing.renderedComparison,
    selectedPath,
    loadingDiff
  )

  const { reviewSessionRevision, submitReview: submitPullRequestReview } =
    usePullRequestReviewSubmission(
      orphanedCommentCount,
      reviewComments,
      setThreadsByPath,
      onSubmitPullRequestReview
    )

  const pathSet = useMemo(() => new Set(treePaths), [treePaths])
  const directoryPaths = useMemo(() => getDirectoryPaths(treePaths), [treePaths])
  // Reusing the sorted list keeps the expensive sort to one pass per path set.
  const changedDirectoryPaths = useMemo(() => {
    const changed = collectDirectoryPaths(treeStatuses.map((status) => status.path))
    return directoryPaths.filter((directoryPath) => changed.has(directoryPath))
  }, [directoryPaths, treeStatuses])
  // A click on a tree row is always a request to go to that file, whether or not
  // the row was already selected. Scroll-follow keeps moving the selection onto
  // the file being read, so the row a reader clicks is very often the selected
  // one — and the tree only reports selection *changes*.
  const activateTreeRow = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    const nextView = workspaceViewForTreePath(workspaceView, reviewPathSet.has(path), fileEditing.hasSession)
    if (nextView !== workspaceView) onWorkspaceViewChange(nextView)
    if (nextView === 'multi') advanceMultiFileNavigation()
  }, [fileEditing.hasSession, markInstantTreeFollowTarget, onSelectPath, onWorkspaceViewChange,
    advanceMultiFileNavigation, pathSet, reviewPathSet, workspaceView])

  // ⌘P search, review shortcuts and the tree all change the selected path; in the
  // multi-file review that has to move the viewer, or picking a result looks like
  // it did nothing at all.
  const navigatedSelectionRef = useRef(selectedPath)
  useEffect(() => {
    const previous = navigatedSelectionRef.current
    navigatedSelectionRef.current = selectedPath
    if (selectedPath == null || selectedPath === previous) return
    if (workspaceView !== 'multi' || selectedPath === visibleMultiFilePathRef.current) return
    if (!pathSet.has(selectedPath)) return
    markInstantTreeFollowTarget(selectedPath)
    advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, markInstantTreeFollowTarget, pathSet, selectedPath,
    visibleMultiFilePathRef, workspaceView])

  const handleTreeSelection = useCallback((paths: readonly string[]) => {
    const path = paths.at(-1)
    // Follow moves the selection itself; re-navigating from that would fight the
    // scroll it came from.
    if (path == null || path === visibleMultiFilePathRef.current) return
    activateTreeRow(path)
  }, [activateTreeRow, visibleMultiFilePathRef])

  // useFileTree captures its options once at model creation, so the selection
  // callback must be delegated through a ref to see current view state.
  const treeSelectionRef = useRef(handleTreeSelection)
  useEffect(() => {
    treeSelectionRef.current = handleTreeSelection
  }, [handleTreeSelection])

  const { model } = useFileTree({
    id: 'repository-tree',
    paths: [],
    initialExpansion: snapshot.kind === 'git' ? 0 : 1,
    flattenEmptyDirectories: true,
    itemHeight: 27,
    overscan: 12,
    stickyFolders: true,
    search: true,
    icons: { set: 'complete', colored: true },
    renderRowDecoration: ({ item }) => collisionPathsRef.current.has(item.path)
      ? {
          text: 'Desk',
          title: 'This path also has changes on Desk',
          parts: [{ text: 'Desk', color: 'var(--status-warning-text)' }]
        }
      : null,
    unsafeCSS: TREE_STYLES,
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: 'when-needed',
        render: (item, context) => createTreeContextMenu(snapshot.root, item, context.close)
      }
    },
    onSelectionChange: (paths) => treeSelectionRef.current(paths)
  })

  const scrollTreeToPath = useCallback((path: string, offset: 'nearest' | 'center') => {
    model.scrollToPath(path, { focus: false, offset })
  }, [model])

  useTreeContentSync(model, snapshot.kind === 'git', treePaths, treeStatuses, directoryPaths, changedDirectoryPaths)

  useLayoutEffect(() => {
    if (selectedPath == null) return
    selectOnlyTreePath(model, selectedPath)
    scrollTreeToPath(selectedPath, 'nearest')
  }, [model, scrollTreeToPath, selectedPath, treePaths])

  const handleVisibleMultiFilePathChange = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    visibleMultiFilePathRef.current = path
    for (const directoryPath of collectDirectoryPaths([path])) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
    selectOnlyTreePath(model, path)
    const instantTarget = consumeInstantTreeFollowTarget(path)
    const followBehavior = getTreeFollowBehavior(instantTarget == null ? 'review-scroll' : 'direct-navigation')
    scrollTreeToPath(path, followBehavior.offset)
  }, [consumeInstantTreeFollowTarget, model, pathSet, scrollTreeToPath, visibleMultiFilePathRef])

  const reviewHeader = useRepositoryReviewHeader({
    comparison: fileEditing.renderedComparison,
    selectedPath,
    isGitRepository: snapshot.kind === 'git',
    isFilePreview,
    diffStyle,
    workspaceView,
    reviewFileCount: reviewPaths.length,
    repositoryReview,
    reviewWorldSource,
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
    preferences,
    fileEdit: fileEditing.controls,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount: reviewComments.length,
    orphanedCommentCount,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
    onDiffStyleChange,
    onPreferencesChange,
    onOpenReviewSummary: openReviewSummary,
    onSubmitPullRequestReview: submitPullRequestReview
  })

  return (
    <>
      <Explorer filePaths={treePaths} model={model} themeType={getEditorThemeType(preferences.editorTheme)}
        onRowActivate={activateTreeRow} />
      <SidebarResizer />
      <RepositoryDiffPanel
        surfaceRef={codeZoom.surfaceRef}
        isFilePreview={isFilePreview}
        header={reviewHeader}
        conflict={fileEditing.conflict}
        onKeepDraft={fileEditing.keepDraft}
        onReloadFromDisk={fileEditing.reloadFromDisk}
        conversationUnavailable={repositoryReview?.kind === 'github' ? conversation.unavailableMessage : null}
        onRetryConversation={conversation.refresh}
        viewerSuspended={viewerSuspended}
        workspaceView={workspaceView}
        reviewIdentity={reviewIdentity}
        reviewSessionRevision={reviewSessionRevision}
        reviewPaths={reviewPaths}
        diffStyle={diffStyle}
        viewerPreferences={viewerPreferences}
        repositoryReview={repositoryReview}
        reviewLoadState={reviewLoad.loadState}
        reviewLoading={reviewLoad.loading}
        reviewTargetPathCount={reviewLoad.targetPathCount}
        onLoadMoreReviewFiles={reviewLoad.loadMoreFiles}
        sinceRemovedPaths={sinceRemovedPaths}
        sinceUncertainPaths={sinceUncertainPaths}
        pullRequestConversation={conversation.conversation}
        reviewScrollRevision={reviewScrollRevision}
        selectedPath={selectedPath}
        multiFileNavigationRevision={multiFileNavigationRevision}
        initialScrollTop={multiFileScrollTopRef.current}
        onScrollPositionChange={handleMultiFileScrollPositionChange}
        onVisiblePathChange={handleVisibleMultiFilePathChange}
        threadsByPath={threadsByPath}
        setThreadsByPath={setThreadsByPath}
        viewedFiles={viewedFiles}
        setViewedFiles={setViewedFiles}
        remoteThreadsByPath={conversation.threadsByPath}
        pendingRemoteThreadId={conversation.pendingThreadId}
        onReplyToRemoteThread={conversation.reply}
        onResolveRemoteThread={conversation.setResolved}
        onAttachToAgent={onAttachToAgent}
        reviewCommand={reviewCommand}
        surfaceComparison={surfaceComparison}
        surfaceLoading={surfaceLoading}
        contentSearch={contentSearch}
        editMode={fileEditing.activeSession?.mode ?? 'read'}
        onDraftFileChange={fileEditing.updateDraftFile}
        onEditorAttach={fileEditing.attachEditor}
        onEditorBlur={fileEditing.handleEditorBlur}
        showStatusBar={isFilePreview || fileEditing.activeSession != null}
        fileExtension={fileExtension}
        dirty={fileEditing.controls.dirty}
        getEditor={fileEditing.getEditor}
        onError={onError}
      />
    </>
  )
})

export default RepositoryWorkspace
