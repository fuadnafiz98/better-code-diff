import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from 'react'
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
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { createPullRequestReviewComments } from './pullRequestReviewComments'
import type { AgentAttachment } from './agentAttachments'
import { usePullRequestConversation } from './usePullRequestConversation'
import { useReviewSession } from './useReviewSession'
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

import type { ContentSearchState } from './DiffSurface'

const DiffSurface = lazy(() => import('./DiffSurface'))
const MultiFileReview = lazy(() => import('./MultiFileReview'))

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

interface RepositoryWorkspaceProps {
  snapshot: RepositorySnapshot
  selectedPath: string | null
  comparison: FileComparison | null
  loadingDiff: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  onAttachToAgent(attachment: AgentAttachment): void
  onPreferencesChange(preferences: AppPreferences): void
  repositoryReview: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
  /** Repository search state, surfaced as inline hint markers while editing. */
  contentSearch?: ContentSearchState
  onSelectPath(path: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onClosePullRequestReview(): void
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
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  onClosePullRequestReview(): void
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
  wordWrap,
  foldUnchanged,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  onClosePullRequestReview,
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
      {repositoryReview?.kind === 'github' && repositoryReview.pullRequest.state === 'OPEN' ? (
        <PullRequestReviewBar
          submitting={submittingPullRequestReview}
          message={pullRequestReviewMessage}
          inlineCommentCount={inlineCommentCount}
          viewerCanSubmitDecision={repositoryReview.viewerCanSubmitDecision}
          onOpen={onOpenReviewSummary}
          onSubmit={onSubmitPullRequestReview}
        />
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

function useReviewTreeData(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null,
  threadsByPath: Record<string, ReviewThread[]>
) {
  const unorderedReviewPaths = useMemo(
    () => repositoryReview?.files.map((file) => file.path)
      ?? (snapshot.kind === 'git' ? snapshot.statuses.map((status) => status.path) : snapshot.paths),
    [repositoryReview, snapshot.kind, snapshot.paths, snapshot.statuses]
  )
  const reviewPaths = useMemo(() => orderPathsForTree(unorderedReviewPaths), [unorderedReviewPaths])
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

  return { reviewPaths, treePaths, treeStatuses, reviewComments }
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
  pullRequestConversation: ReturnType<typeof usePullRequestConversation>['conversation']
  repositoryChange: RepositoryChangeEvent | null
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
  onAttachToAgent(attachment: AgentAttachment): void
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
  preferences,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  onClosePullRequestReview,
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
  preferences: AppPreferences
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  onClosePullRequestReview(): void
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
    wordWrap: preferences.wordWrap,
    foldUnchanged: preferences.foldUnchanged,
    fileEdit,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount,
    onClosePullRequestReview,
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
    isFilePreview,
    isGitRepository,
    onClosePullRequestReview,
    onDiffStyleChange,
    onOpenReviewSummary,
    onSubmitPullRequestReview,
    preferences.foldUnchanged,
    preferences.wordWrap,
    pullRequestReviewMessage,
    repositoryReview,
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
  pullRequestConversation,
  repositoryChange,
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
  getEditor
}: RepositoryDiffPanelProps): React.JSX.Element {
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
      ) : (
        <Suspense fallback={<WorkspaceCodeSkeleton />}>
          {workspaceView === 'multi' ? (
            <MultiFileReview
              key={`${reviewIdentity}:${reviewSessionRevision}`}
              paths={reviewPaths}
              diffStyle={diffStyle}
              preferences={viewerPreferences}
              repositoryReview={repositoryReview}
              pullRequestConversation={pullRequestConversation}
              repositoryChange={repositoryChange}
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
          ) : (
            <DiffSurface comparison={surfaceComparison} loading={surfaceLoading} diffStyle={diffStyle}
              preferences={viewerPreferences} editMode={editMode}
              contentSearch={contentSearch} getEditor={getEditor}
              onDraftFileChange={onDraftFileChange} onEditorAttach={onEditorAttach}
              onEditorBlur={onEditorBlur}
              onAttachToAgent={onAttachToAgent}
              threadsByPath={threadsByPath} setThreadsByPath={setThreadsByPath} />
          )}
        </Suspense>
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

const RepositoryWorkspace = memo(function RepositoryWorkspace({
  snapshot, selectedPath, comparison, loadingDiff, diffStyle, workspaceView,
  preferences, onAttachToAgent, onPreferencesChange, repositoryReview, repositoryChange, contentSearch, onSelectPath,
  onDiffStyleChange, onWorkspaceViewChange, onClosePullRequestReview, submittingPullRequestReview,
  pullRequestReviewMessage, onSubmitPullRequestReview, onComparisonSaved, onError
}: RepositoryWorkspaceProps): React.JSX.Element {
  useEffect(markRepositoryWorkspaceRender)
  const isFilePreview = workspaceView === 'file' && comparison?.mode === 'file'
  const reviewIdentity = repositoryReviewIdentity(repositoryReview)
  const { threadsByPath, setThreadsByPath, viewedFiles, setViewedFiles } =
    useReviewSession(snapshot.root, reviewIdentity)
  const conversation = usePullRequestConversation(repositoryReview, onError)
  const [reviewCommand, setReviewCommand] = useState<{
    command: ReviewCommand
    path: string
    revision: number
  } | null>(null)
  const [reviewSessionRevision, setReviewSessionRevision] = useState(0)
  const [reviewScrollRevision, setReviewScrollRevision] = useState(0)
  const viewer = useViewerContext()
  const codeZoom = useCodeZoomGesture(preferences.codeFontSize, preferences.codeLineHeight)
  const hiddenLongEnoughToRelease = useViewerSuspension()
  const visibleMultiFilePathRef = useRef<string | null>(null)
  const { markInstantTreeFollowTarget, consumeInstantTreeFollowTarget } = useInstantTreeFollow()
  const multiFileScrollTopRef = useRef(0)
  const [multiFileNavigationRevision, setMultiFileNavigationRevision] = useState(0)
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
  const { reviewPaths, treePaths, treeStatuses, reviewComments } =
    useReviewTreeData(snapshot, repositoryReview, threadsByPath)
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

  // Switching to the multi-file review unmounts DiffSurface, so the previous
  // file has to be remembered here to survive the trip back.
  const lastComparisonRef = useRef<FileComparison | null>(null)
  useEffect(() => {
    if (fileEditing.renderedComparison != null) lastComparisonRef.current = fileEditing.renderedComparison
  }, [fileEditing.renderedComparison])
  const previousComparison = lastComparisonRef.current
  const surfaceComparison = fileEditing.renderedComparison
    ?? (previousComparison?.path === selectedPath ? previousComparison : null)
  const surfaceLoading = loadingDiff || (fileEditing.renderedComparison == null && surfaceComparison != null)

  const submitPullRequestReview = useCallback(async (event: PullRequestReviewEvent, body: string) => {
    const submitted = await onSubmitPullRequestReview(event, body, reviewComments)
    if (submitted) {
      setThreadsByPath({})
      setReviewSessionRevision((revision) => revision + 1)
    }
    return submitted
  }, [onSubmitPullRequestReview, reviewComments, setThreadsByPath])

  const openReviewSummary = useCallback(() => {
    multiFileScrollTopRef.current = 0
    onWorkspaceViewChange('multi')
    setReviewScrollRevision((revision) => revision + 1)
  }, [onWorkspaceViewChange])

  const handleMultiFileScrollPositionChange = useCallback((scrollTop: number) => {
    multiFileScrollTopRef.current = scrollTop
  }, [])

  const navigateToReviewFile = useCallback((path: string) => {
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    setMultiFileNavigationRevision((revision) => revision + 1)
  }, [markInstantTreeFollowTarget, onSelectPath])

  const runReviewItemCommand = useCallback((command: ReviewCommand, path: string) => {
    setReviewCommand((current) => ({ command, path, revision: (current?.revision ?? 0) + 1 }))
  }, [])

  useReviewShortcuts({
    active: workspaceView === 'multi',
    paths: reviewPaths,
    currentPathRef: visibleMultiFilePathRef,
    onNavigate: navigateToReviewFile,
    onItemCommand: runReviewItemCommand
  })

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
    if (nextView === 'multi') setMultiFileNavigationRevision((revision) => revision + 1)
  }, [fileEditing.hasSession, markInstantTreeFollowTarget, onSelectPath, onWorkspaceViewChange,
    pathSet, reviewPathSet, workspaceView])

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
    setMultiFileNavigationRevision((revision) => revision + 1)
  }, [markInstantTreeFollowTarget, pathSet, selectedPath, workspaceView])

  const handleTreeSelection = useCallback((paths: readonly string[]) => {
    const path = paths.at(-1)
    // Follow moves the selection itself; re-navigating from that would fight the
    // scroll it came from.
    if (path == null || path === visibleMultiFilePathRef.current) return
    activateTreeRow(path)
  }, [activateTreeRow])

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
  }, [consumeInstantTreeFollowTarget, model, pathSet, scrollTreeToPath])

  const reviewHeader = useRepositoryReviewHeader({
    comparison: fileEditing.renderedComparison,
    selectedPath,
    isGitRepository: snapshot.kind === 'git',
    isFilePreview,
    diffStyle,
    workspaceView,
    reviewFileCount: reviewPaths.length,
    repositoryReview,
    preferences,
    fileEdit: fileEditing.controls,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount: reviewComments.length,
    onClosePullRequestReview,
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
        pullRequestConversation={conversation.conversation}
        repositoryChange={repositoryChange}
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
      />
    </>
  )
})

export default RepositoryWorkspace
