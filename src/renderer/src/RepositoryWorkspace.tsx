import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { useFileTree } from '@pierre/trees/react'
import { EditProvider, WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react'

import type { AgentProvider, FileComparison, PullRequestReviewComment, PullRequestReviewEvent, RepositoryChangeEvent, RepositoryFileStatus, RepositoryReview, RepositorySnapshot } from '../../shared/contracts'
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
import {
  DIFF_HIGHLIGHTER_LANGUAGES,
  DIFF_HIGHLIGHTER_LIMITS,
  DIFF_WORKER_POOL_OPTIONS
} from './diffWorkerConfig'
import { markRepositoryWorkspaceRender } from './reviewMetrics'
import { useCodeZoomGesture } from './useCodeZoomGesture'
import { createDiffEditor, useFileEditing } from './useFileEditing'

const DiffSurface = lazy(() => import('./DiffSurface'))
const MultiFileReview = lazy(() => import('./MultiFileReview'))

function DiffWorkerThemeSync({
  theme,
  onThemeReady
}: {
  theme: AppPreferences['editorTheme']
  onThemeReady(theme: AppPreferences['editorTheme']): void
}): null {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool == null) return
    let active = true
    void workerPool.setRenderOptions({ theme, ...DIFF_HIGHLIGHTER_LIMITS })
      .then(() => {
        if (active) onThemeReady(theme)
      })
      .catch((error: unknown) => {
        console.error('Failed to update the diff theme:', error)
      })
    return () => {
      active = false
    }
  }, [onThemeReady, theme, workerPool])

  return null
}

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
  *,
  *::before,
  *::after {
    corner-shape: squircle;
  }

  button {
    touch-action: manipulation;
    transition: transform 100ms cubic-bezier(0.23, 1, 0.32, 1), background-color 100ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  button:active:not(:disabled) {
    transform: scale(0.96);
  }

  [data-type="item"]:active {
    background: rgba(120, 169, 255, 0.1);
  }

  [data-type="item"] {
    border-radius: 7px;
  }

  [data-file-tree-virtualized-scroll][data-auto-follow="true"] {
    scroll-behavior: smooth;
  }

  [data-file-tree-search-input] {
    height: 30px;
    border-radius: 9px;
    font-size: 12px;
  }

  [data-file-tree-search-container] {
    padding: 7px 8px 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    [data-file-tree-virtualized-scroll] {
      scroll-behavior: auto !important;
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
  onWorkspaceViewChange(view: WorkspaceView): void
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
  onWorkspaceViewChange,
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
        onWorkspaceViewChange={onWorkspaceViewChange}
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
  const rawTreePaths = repositoryReview == null ? snapshot.paths : reviewPaths
  const treePathsKey = rawTreePaths.join('\0')
  const treePaths = useMemo(() => treePathsKey === '' ? [] : treePathsKey.split('\0'), [treePathsKey])
  const treeStatuses = useMemo<Array<{ path: string; status: TreeFileStatus }>>(
    () => repositoryReview == null
      ? snapshot.statuses.map((status) => ({ path: status.path, status: toTreeStatus(status.status) }))
      : repositoryReview.files.map((file) => ({ path: file.path, status: 'modified' as const })),
    [repositoryReview, snapshot.statuses]
  )
  const treeStatusesKey = treeStatuses.map((status) => `${status.status}:${status.path}`).join('\0')
  const reviewComments = useMemo(
    () => createPullRequestReviewComments(threadsByPath),
    [threadsByPath]
  )

  return { reviewPaths, treePaths, treePathsKey, treeStatuses, treeStatusesKey, reviewComments }
}

function useViewerConfiguration(
  preferences: AppPreferences,
  codeZoom: { codeFontSize: number; codeLineHeight: number },
  workerTheme: AppPreferences['editorTheme']
) {
  const highlighterOptions = useMemo(() => ({
    langs: DIFF_HIGHLIGHTER_LANGUAGES,
    theme: preferences.editorTheme,
    useTokenTransformer: true,
    ...DIFF_HIGHLIGHTER_LIMITS
  }), [preferences.editorTheme])
  const viewerPreferences = useMemo(
    () => ({
      ...preferences,
      codeFontSize: codeZoom.codeFontSize,
      codeLineHeight: codeZoom.codeLineHeight,
      editorTheme: workerTheme
    }),
    [codeZoom.codeFontSize, codeZoom.codeLineHeight, preferences, workerTheme]
  )
  return { highlighterOptions, viewerPreferences }
}

function repositoryReviewIdentity(repositoryReview: RepositoryReview | null): string {
  if (repositoryReview == null) return 'working-tree'
  return repositoryReview.kind === 'github'
    ? `github:${repositoryReview.pullRequest.url}`
    : repositoryReview.id
}

const RepositoryWorkspace = memo(function RepositoryWorkspace({
  snapshot, selectedPath, comparison, loadingDiff, diffStyle, workspaceView,
  preferences, onAttachToAgent, onPreferencesChange, repositoryReview, repositoryChange, onSelectPath,
  onDiffStyleChange, onWorkspaceViewChange, onClosePullRequestReview, submittingPullRequestReview,
  pullRequestReviewMessage, onSubmitPullRequestReview, onComparisonSaved, onError
}: RepositoryWorkspaceProps): React.JSX.Element {
  useEffect(markRepositoryWorkspaceRender)
  const isFilePreview = workspaceView === 'file' && comparison?.mode === 'file'
  const reviewIdentity = repositoryReviewIdentity(repositoryReview)
  const {
    threadsByPath,
    setThreadsByPath,
    viewedFiles,
    setViewedFiles
  } = useReviewSession(snapshot.root, reviewIdentity)
  const conversation = usePullRequestConversation(repositoryReview, onError)
  const [reviewCommand, setReviewCommand] = useState<{
    command: ReviewCommand
    path: string
    revision: number
  } | null>(null)
  const [reviewSessionRevision, setReviewSessionRevision] = useState(0)
  const [reviewScrollRevision, setReviewScrollRevision] = useState(0)
  const [workerTheme, setWorkerTheme] = useState<AppPreferences['editorTheme']>(() => preferences.editorTheme)
  const codeZoom = useCodeZoomGesture(preferences.codeFontSize, preferences.codeLineHeight)
  const viewerSuspended = useViewerSuspension()
  const visibleMultiFilePathRef = useRef<string | null>(null)
  const instantTreeFollowTargetRef = useRef<string | null>(null)
  const instantTreeFollowResetRef = useRef<number | null>(null)
  const multiFileScrollTopRef = useRef(0)
  const [multiFileNavigationRevision, setMultiFileNavigationRevision] = useState(0)
  const fileEditing = useFileEditing({
    comparison,
    selectedPath,
    workspaceView,
    repositoryReview,
    onWorkspaceViewChange,
    onSelectPath,
    onComparisonChange: onComparisonSaved,
    onError
  })
  const { reviewPaths, treePaths, treePathsKey, treeStatuses, treeStatusesKey, reviewComments } =
    useReviewTreeData(snapshot, repositoryReview, threadsByPath)
  const fileExtension = selectedPath?.split('.').at(-1)?.toUpperCase()
  const { highlighterOptions, viewerPreferences } = useViewerConfiguration(preferences, codeZoom, workerTheme)

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

  const markInstantTreeFollowTarget = useCallback((path: string) => {
    instantTreeFollowTargetRef.current = path
    if (instantTreeFollowResetRef.current != null) window.clearTimeout(instantTreeFollowResetRef.current)
    instantTreeFollowResetRef.current = window.setTimeout(() => {
      instantTreeFollowTargetRef.current = null
      instantTreeFollowResetRef.current = null
    }, TREE_INSTANT_FOLLOW_RESET_MS)
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
  const changedDirectoryPaths = useMemo(
    () => getDirectoryPaths(treeStatuses.map((status) => status.path)),
    [treeStatuses]
  )
  // A click on a tree row is always a request to go to that file, whether or not
  // the row was already selected. Scroll-follow keeps moving the selection onto
  // the file being read, so the row a reader clicks is very often the selected
  // one — and the tree only reports selection *changes*.
  const activateTreeRow = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    if (workspaceView === 'multi') setMultiFileNavigationRevision((revision) => revision + 1)
  }, [markInstantTreeFollowTarget, onSelectPath, pathSet, workspaceView])

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
    onSelectionChange: (paths) => treeSelectionRef.current(paths)
  })

  const scrollTreeToPath = useCallback((path: string, offset: 'nearest' | 'center', animate: boolean) => {
    const scrollElement = model.getFileTreeContainer()?.shadowRoot
      ?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]')
    if (scrollElement != null) {
      if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scrollElement.dataset.autoFollow = 'true'
      } else {
        delete scrollElement.dataset.autoFollow
      }
    }
    model.scrollToPath(path, { focus: false, offset })
  }, [model])

  useEffect(() => () => {
    if (instantTreeFollowResetRef.current != null) window.clearTimeout(instantTreeFollowResetRef.current)
  }, [])

  const appliedTreeContentRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    // Resetting the model collapses every directory, so identical content must not reset it.
    const treeContentKey = `${treePaths.length}:${treePathsKey}${treeStatusesKey}`
    if (appliedTreeContentRef.current === treeContentKey) return
    appliedTreeContentRef.current = treeContentKey
    model.resetPaths(treePaths)
    model.setGitStatus(treeStatuses)
    if (snapshot.kind === 'git') {
      for (const directoryPath of [...directoryPaths].reverse()) {
        const item = model.getItem(directoryPath)
        if (item != null && 'collapse' in item) item.collapse()
      }
      for (const directoryPath of changedDirectoryPaths) {
        const item = model.getItem(directoryPath)
        if (item != null && 'expand' in item) item.expand()
      }
    }
  }, [changedDirectoryPaths, directoryPaths, model, snapshot.kind, treePaths, treePathsKey, treeStatuses, treeStatusesKey])

  useLayoutEffect(() => {
    if (selectedPath == null) return
    selectOnlyTreePath(model, selectedPath)
    scrollTreeToPath(selectedPath, 'nearest', false)
  }, [model, scrollTreeToPath, selectedPath, treePaths])

  const handleVisibleMultiFilePathChange = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    visibleMultiFilePathRef.current = path
    for (const directoryPath of getDirectoryPaths([path])) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
    selectOnlyTreePath(model, path)
    const instantTarget = instantTreeFollowTargetRef.current
    if (path === instantTarget) {
      instantTreeFollowTargetRef.current = null
      if (instantTreeFollowResetRef.current != null) {
        window.clearTimeout(instantTreeFollowResetRef.current)
        instantTreeFollowResetRef.current = null
      }
    }
    const followBehavior = getTreeFollowBehavior(instantTarget == null ? 'review-scroll' : 'direct-navigation')
    scrollTreeToPath(path, followBehavior.offset, followBehavior.animate)
  }, [model, pathSet, scrollTreeToPath])

  return (
    <>
      <Explorer filePaths={treePaths} model={model} themeType={getEditorThemeType(preferences.editorTheme)}
        onRowActivate={activateTreeRow} />
      <SidebarResizer />
      <section ref={codeZoom.surfaceRef} className={`diff-panel ${isFilePreview ? 'file-preview-mode' : 'diff-mode'}`} id="repository-diff">
        <RepositoryReviewHeader
          comparison={fileEditing.renderedComparison}
          selectedPath={selectedPath}
          isGitRepository={snapshot.kind === 'git'}
          isFilePreview={isFilePreview}
          diffStyle={diffStyle}
          workspaceView={workspaceView}
          reviewFileCount={reviewPaths.length}
          repositoryReview={repositoryReview}
          wordWrap={preferences.wordWrap}
          foldUnchanged={preferences.foldUnchanged}
          fileEdit={fileEditing.controls}
          submittingPullRequestReview={submittingPullRequestReview}
          pullRequestReviewMessage={pullRequestReviewMessage}
          inlineCommentCount={reviewComments.length}
          onClosePullRequestReview={onClosePullRequestReview}
          onDiffStyleChange={onDiffStyleChange}
          onWorkspaceViewChange={onWorkspaceViewChange}
          onWordWrapToggle={() => onPreferencesChange({ ...preferences, wordWrap: !preferences.wordWrap })}
          onFoldUnchangedToggle={() => onPreferencesChange({ ...preferences, foldUnchanged: !preferences.foldUnchanged })}
          onOpenReviewSummary={openReviewSummary}
          onSubmitPullRequestReview={submitPullRequestReview}
        />
        <FindBar />
        {viewerSuspended ? (
          <div className="diff-state"><span>Viewer paused while the app is hidden.</span></div>
        ) : (
          <EditProvider<ReviewAnnotationMetadata> createEditor={createDiffEditor}>
            <WorkerPoolContextProvider poolOptions={DIFF_WORKER_POOL_OPTIONS} highlighterOptions={highlighterOptions}>
              <DiffWorkerThemeSync theme={preferences.editorTheme} onThemeReady={setWorkerTheme} />
              <Suspense key={workerTheme} fallback={<div className="diff-state"><span>Preparing viewer…</span></div>}>
              {workspaceView === 'multi' ? (
                <MultiFileReview
              key={`${reviewIdentity}:${reviewSessionRevision}`}
              paths={reviewPaths}
              diffStyle={diffStyle}
              preferences={viewerPreferences}
              repositoryReview={repositoryReview}
              repositoryChange={repositoryChange}
              scrollToReviewRevision={reviewScrollRevision}
              navigationPath={selectedPath}
              navigationRevision={multiFileNavigationRevision}
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
                />
              ) : (
                <DiffSurface comparison={fileEditing.renderedComparison} loading={loadingDiff} diffStyle={diffStyle} preferences={viewerPreferences}
                  editMode={fileEditing.activeSession?.mode ?? 'read'} onDraftFileChange={fileEditing.updateDraftFile}
                  onEditorAttach={fileEditing.attachEditor}
                  threadsByPath={threadsByPath} setThreadsByPath={setThreadsByPath} />
              )}
              </Suspense>
            </WorkerPoolContextProvider>
          </EditProvider>
        )}
        {isFilePreview || fileEditing.activeSession != null ? (
          <footer className="editor-statusbar">
            <span>{fileEditing.activeSession?.mode === 'edit' ? 'Editing' : fileEditing.activeSession?.mode === 'preview' ? 'Draft preview' : 'Read only'}</span>
            <span>UTF-8</span>
            <span>LF</span>
            {fileExtension != null ? <span>{fileExtension}</span> : null}
          </footer>
        ) : null}
      </section>
    </>
  )
})

export default RepositoryWorkspace
