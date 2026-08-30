import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  type CodeView as CodeViewInstance,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation
} from '@pierre/diffs'
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconCheck, IconChevronSm, IconCodeSearch, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { PullRequestConversation, RemoteReviewThread, RepositoryReview } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import { markReviewFileHydrated } from './reviewMetrics'
import { markRendererStartup } from './startupMetrics'
import { reportCopiedPath, syncCopyFilePathLifecycle } from './copyFilePath'
import { syncDragGuideLifecycle } from './dragSelection'
import { syncSplitDiffResizeLifecycle } from './splitDiffResize'
import { isGutterDoubleClick } from './gutterCommentShortcut'
import { syncReviewCaretLifecycle } from './reviewCaret'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  SelectionActions,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import type { AgentSelection } from './agentAttachments'
import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'
import { RemoteReviewThreadCard } from './RemoteReviewThreads'
import {
  deriveAnnotatedReviewItems,
  type AnnotatedReviewItemCache
} from './annotatedReviewItems'
import {
  findCollapseFollowItemId,
  findActiveReviewItemId,
  findNextUnreadReviewItemId,
  pathFromReviewItemId as pathFromItemId,
  reviewItemId as itemId
} from './reviewItems'
import {
  FOLDER_REVIEW_PAGE_SIZE,
  type ReviewLoadState
} from './useReviewLoadState'
import {
  useReviewThreads,
  type DraftReviewComment,
  type ReattachingReviewThread,
  type UpdateReviewThread
} from './useReviewThreads'
import { BackToTopButton, BACK_TO_TOP_THRESHOLD } from './BackToTopButton'
import { showToast } from './toast'
import type { ReviewCommand } from './keybindings'
import {
  dropChangedViewedFiles,
  markViewedFile,
  type ViewedFileSignatures
} from './viewedFileStorage'
import { VIEWER_BASE_CSS } from './viewerCss'
import { buildViewedPathsKey, parseViewedPathsKey } from './viewedPaths'
import { PullRequestContext } from './PullRequestContext'
import { createReviewCommentAnchor } from './reviewThreadAnchors'

const CODE_VIEW_CSS = `
  ${VIEWER_BASE_CSS}

  [data-utility-button] { border-radius: var(--corner-compact) !important; corner-shape: squircle !important; }
`

const ACTIVE_PATH_SETTLE_MS = 80

export function agentSelectionForReviewItem(
  item: CodeViewItem<unknown>,
  path: string,
  range: CodeViewLineSelection['range']
): AgentSelection | null {
  const startSide = range.side ?? range.endSide ?? 'additions'
  const endSide = range.endSide ?? startSide
  if (startSide !== endSide) return null
  const anchor = createReviewCommentAnchor(item, range)
  if (anchor == null || anchor.selectedText === '') return null
  return {
    path,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    side: anchor.side,
    selectedText: anchor.selectedText,
    blobOid: anchor.blobOid
  }
}

export interface MultiFileReviewProps {
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview?: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation?: PullRequestConversation | null
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  onLoadMore(): void
  scrollToReviewRevision: number
  navigationPath: string | null
  navigationRevision: number
  initialScrollTop: number
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ViewedFileSignatures
  setViewedFiles: Dispatch<SetStateAction<ViewedFileSignatures>>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  onAttachToAgent(selection: AgentSelection): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
}

function SinceNotice({
  removedPaths,
  uncertainPaths
}: {
  removedPaths: readonly string[]
  uncertainPaths: readonly string[]
}): React.JSX.Element | null {
  if (removedPaths.length === 0 && uncertainPaths.length === 0) return null
  return (
    <aside className="since-notice" aria-label="Since checkpoint details">
      <IconWarningOctogonFill />
      <div>
        {removedPaths.length > 0 ? (
          <details>
            <summary>{removedPaths.length} {removedPaths.length === 1 ? 'path is' : 'paths are'} no longer in the pull request</summary>
            <ul>{removedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </details>
        ) : null}
        {uncertainPaths.length > 0 ? (
          <details>
            <summary>{uncertainPaths.length} {uncertainPaths.length === 1 ? 'path uses' : 'paths use'} a conservative fallback signature</summary>
            <p>Horus includes these paths because equal line counts cannot prove identical content.</p>
            <ul>{uncertainPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </details>
        ) : null}
      </div>
    </aside>
  )
}

const SCROLL_RESTORE_SETTLED_FRAMES = 3
const SCROLL_RESTORE_TIMEOUT_MS = 800
// Any of these means the reader took over; a pending restore must yield to them.
const SCROLL_TAKEOVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

function observeScrollTakeover(container: HTMLElement | null, listener: () => void): () => void {
  for (const type of SCROLL_TAKEOVER_EVENTS) container?.addEventListener(type, listener, { passive: true })
  return () => {
    for (const type of SCROLL_TAKEOVER_EVENTS) container?.removeEventListener(type, listener)
  }
}

// The viewer maps its logical scroll offset onto a paged scroll scaffold, so the
// container's own scrollTop is not the position the viewer reports or accepts.
function getViewerScrollTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): number | null {
  return viewer?.getInstance()?.getScrollTop() ?? null
}

function scrollToReviewTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void {
  viewer?.scrollTo({ type: 'position', position: 0, behavior: 'smooth-auto' })
}

interface ReviewScrollAnchor {
  itemId: string
  viewportOffset: number
}

export function reviewScrollAnchorTarget(anchor: ReviewScrollAnchor, itemTop: number): number {
  return Math.max(0, itemTop - anchor.viewportOffset)
}

function captureReviewScrollAnchor(
  viewer: CodeViewInstance<ReviewAnnotationMetadata> | undefined
): ReviewScrollAnchor | null {
  if (viewer == null) return null
  const itemId = findActiveRenderedItemId(viewer)
  if (itemId == null) return null
  const itemTop = viewer.getTopForItem(itemId)
  if (itemTop == null) return null
  return { itemId, viewportOffset: itemTop - viewer.getScrollTop() }
}

function useBackgroundScrollAnchor(
  conversation: PullRequestConversation | null,
  review: RepositoryReview | null,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
): void {
  const anchorRef = useRef<ReviewScrollAnchor | null>(null)

  // Conversation polling and streamed pages can update CodeView while the
  // reader is idle. Keep the same file at the same viewport offset.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    let frame = 0
    let settledFrames = 0
    let cancelled = false
    const startedAt = performance.now()
    const cancel = (): void => {
      cancelled = true
    }
    const stopObservingScrollTakeover = anchor == null
      ? () => {}
      : observeScrollTakeover(scrollContainerRef.current, cancel)

    const restore = (): void => {
      if (cancelled || anchor == null) return
      const viewer = viewerRef.current
      const instance = viewer?.getInstance()
      const itemTop = instance?.getTopForItem(anchor.itemId)
      const current = instance?.getScrollTop()
      if (viewer == null || itemTop == null || current == null) return
      const target = reviewScrollAnchorTarget(anchor, itemTop)
      if (Math.abs(current - target) <= 1) {
        settledFrames += 1
        if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
      } else {
        settledFrames = 0
        viewer.scrollTo({ type: 'position', position: target, behavior: 'instant' })
      }
      if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) {
        frame = window.requestAnimationFrame(restore)
      }
    }
    restore()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      stopObservingScrollTakeover()
      anchorRef.current = captureReviewScrollAnchor(viewerRef.current?.getInstance())
    }
  }, [conversation, review, scrollContainerRef, viewerRef])
}

function findActiveRenderedItemId(viewer: CodeViewInstance<ReviewAnnotationMetadata>): string | null {
  const positions = viewer.getRenderedItems().flatMap((item) => {
    const top = viewer.getTopForItem(item.id)
    return top == null ? [] : [{ id: item.id, top }]
  })
  return findActiveReviewItemId(viewer.getScrollTop(), positions)
}

interface AnnotatedReviewItemsOptions {
  loadState: ReviewLoadState
  threadsByPath: Record<string, ReviewThread[]>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  draftComment: DraftReviewComment | null
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  collapsedItemIds: ReadonlySet<string>
  annotationVersions: Readonly<Record<string, number>>
}

function useAnnotatedReviewItems({
  loadState,
  threadsByPath,
  remoteThreadsByPath,
  draftComment,
  pendingSelection,
  collapsedItemIds,
  annotationVersions
}: AnnotatedReviewItemsOptions): CodeViewItem<ReviewAnnotationMetadata>[] {
  const committedCacheRef = useRef<AnnotatedReviewItemCache>(new Map())
  const committedItemsRef = useRef<CodeViewItem<ReviewAnnotationMetadata>[] | undefined>(undefined)
  const derivation = useMemo(() => deriveAnnotatedReviewItems({
    items: loadState.items,
    threadsByPath,
    remoteThreadsByPath,
    draftComment,
    pendingSelection,
    collapsedItemIds,
    annotationVersions,
    previousCache: committedCacheRef.current,
    previousItems: committedItemsRef.current
  }), [annotationVersions, collapsedItemIds, draftComment, loadState.items, pendingSelection, remoteThreadsByPath, threadsByPath])

  useLayoutEffect(() => {
    committedCacheRef.current = derivation.cache
    committedItemsRef.current = derivation.items
  }, [derivation.cache, derivation.items])

  return derivation.items
}

interface MultiFileViewerProps {
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation: PullRequestConversation | null
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  onLoadMore(): void
  selectedLines: CodeViewLineSelection | null
  annotatedItems: CodeViewItem<ReviewAnnotationMetadata>[]
  threadsByPath: Record<string, ReviewThread[]>
  collapsedItemIds: ReadonlySet<string>
  viewedPaths: ReadonlySet<string>
  viewedCount: number
  onToggleViewed(path: string): void
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  onSelectLines(selection: CodeViewLineSelection | null): void
  onCommentOnSelection(): void
  onBeginComment(selection: CodeViewLineSelection): void
  onAskAgentAboutSelection(): void
  scrollContainerRef: RefObject<HTMLDivElement | null>
  viewerRef: React.RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  setViewerRef(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void
  toggleItemCollapsed(item: CodeViewItem<ReviewAnnotationMetadata>): void
  collapseAllFiles(): void
  expandAllFiles(): void
  cancelComment(): void
  saveComment(body: string): void
  updateThread: UpdateReviewThread
  reattachingThread: ReattachingReviewThread | null
  onBeginReattach(path: string, threadId: string): void
  onCancelReattach(): void
}

const MultiFileViewer = memo(function MultiFileViewer({
  paths,
  diffStyle,
  preferences,
  repositoryReview,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation,
  loadState,
  loading,
  targetPathCount,
  onLoadMore,
  selectedLines,
  annotatedItems,
  threadsByPath,
  collapsedItemIds,
  viewedPaths,
  viewedCount,
  onToggleViewed,
  pendingRemoteThreadId,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  onSelectLines,
  onCommentOnSelection,
  onBeginComment,
  onAskAgentAboutSelection,
  scrollContainerRef,
  viewerRef,
  onScrollPositionChange,
  onVisiblePathChange,
  setViewerRef,
  toggleItemCollapsed,
  collapseAllFiles,
  expandAllFiles,
  cancelComment,
  saveComment,
  updateThread,
  reattachingThread,
  onBeginReattach,
  onCancelReattach
}: MultiFileViewerProps): React.JSX.Element {
  const [showBackToTop, setShowBackToTop] = useState(false)
  const backToTopVisibleRef = useRef(false)
  const visiblePathRef = useRef<string | null>(null)
  const visiblePathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseFollowFrameRef = useRef(0)
  const previousGutterActivationRef = useRef<{
    selection: CodeViewLineSelection
    timestamp: number
  } | null>(null)
  useBackgroundScrollAnchor(pullRequestConversation, repositoryReview, scrollContainerRef, viewerRef)

  useEffect(() => () => {
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
    window.cancelAnimationFrame(collapseFollowFrameRef.current)
  }, [])
  const summaryEntries = useMemo<ReviewSummaryEntry[]>(() =>
    Object.entries(threadsByPath).flatMap(([path, threads]) =>
      threads.map((thread) => ({ path, thread }))
    ), [threadsByPath])
  const beginSummaryReattach = useCallback((entry: ReviewSummaryEntry) => {
    onBeginReattach(entry.path, entry.thread.id)
    const id = itemId(entry.path)
    if (viewerRef.current?.getItem(id) != null) {
      viewerRef.current.scrollTo({ type: 'item', id, align: 'start', behavior: 'smooth-auto' })
    }
    showToast('Select replacement lines, then choose Reattach')
  }, [onBeginReattach, viewerRef])
  const dropSummaryThread = useCallback((entry: ReviewSummaryEntry) => {
    updateThread(entry.path, entry.thread.id, () => null)
    if (reattachingThread?.threadId === entry.thread.id) onCancelReattach()
  }, [onCancelReattach, reattachingThread, updateThread])
  const renderReviewSummary = useCallback(
    () => <>
      <SinceNotice removedPaths={sinceRemovedPaths} uncertainPaths={sinceUncertainPaths} />
      <PullRequestContext conversation={pullRequestConversation} />
      <ReviewSummary entries={summaryEntries}
        reattachingThreadId={reattachingThread?.threadId ?? null}
        onBeginReattach={beginSummaryReattach} onCancelReattach={onCancelReattach}
        onDrop={dropSummaryThread} />
    </>,
    [beginSummaryReattach, dropSummaryThread, onCancelReattach, pullRequestConversation,
      reattachingThread, sinceRemovedPaths, sinceUncertainPaths, summaryEntries]
  )
  const handleToggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    window.cancelAnimationFrame(collapseFollowFrameRef.current)
    collapseFollowFrameRef.current = 0

    const viewer = viewerRef.current?.getInstance()
    const followItemId = collapsedItemIds.has(item.id) || viewer == null
      ? null
      : findCollapseFollowItemId(findActiveRenderedItemId(viewer), item.id, annotatedItems)

    toggleItemCollapsed(item)
    if (followItemId == null) return

    collapseFollowFrameRef.current = window.requestAnimationFrame(() => {
      collapseFollowFrameRef.current = 0
      viewerRef.current?.scrollTo({
        type: 'item',
        id: followItemId,
        align: 'start',
        behavior: 'instant'
      })
    })
  }, [annotatedItems, collapsedItemIds, toggleItemCollapsed, viewerRef])
  const renderHeaderPrefix = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const expanded = !collapsedItemIds.has(item.id)
    const path = pathFromItemId(item.id)
    return (
      <button type="button" data-review-collapse-button
        aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${path}`}
        title={`${expanded ? 'Collapse' : 'Expand'} file`} onClick={(event) => {
          event.stopPropagation()
          handleToggleItemCollapsed(item)
        }}>
        <IconChevronSm data-collapse-chevron aria-hidden="true" />
      </button>
    )
  }, [collapsedItemIds, handleToggleItemCollapsed])
  // Viewed belongs in the header's metadata slot on the trailing edge. Rendered
  // in the prefix slot it shared a narrow box with the collapse button and
  // wrapped onto a second line under the chevron.
  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const path = pathFromItemId(item.id)
    const viewed = viewedPaths.has(path)
    return (
      <span className="review-file-metadata">
        <label data-review-viewed-toggle data-state={viewed ? 'checked' : 'unchecked'}
          title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
          onClick={(event) => event.stopPropagation()}>
          <input type="checkbox" checked={viewed} aria-label={`Mark ${path} as viewed`}
            onChange={() => onToggleViewed(path)} />
          <span data-review-viewed-checkbox aria-hidden="true"><IconCheck /></span>
          <span>Viewed</span>
        </label>
      </span>
    )
  }, [onToggleViewed, viewedPaths])
  const renderReviewAnnotation = useCallback((
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element => {
    const path = pathFromItemId(item.id)
    const metadata = annotation.metadata
    if (metadata.kind === 'selection') {
      return <SelectionActions range={metadata.range}
        commentLabel={reattachingThread == null ? 'Comment' : 'Reattach'}
        onComment={onCommentOnSelection} onAskAgent={onAskAgentAboutSelection}
        onDismiss={() => onSelectLines(null)} />
    }
    if (metadata.kind === 'draft') return <DraftComment range={metadata.range} onCancel={cancelComment} onSave={saveComment} />
    if (metadata.kind === 'remote') {
      return <RemoteReviewThreadCard thread={metadata.thread}
        pending={pendingRemoteThreadId === metadata.thread.id}
        onReply={onReplyToRemoteThread} onToggleResolved={onResolveRemoteThread} />
    }
    const { thread } = metadata
    return <ReviewThreadCard thread={thread}
      onDelete={() => updateThread(path, thread.id, () => null)}
      onEdit={(body) => updateThread(path, thread.id, (current) => ({ ...current, body }))}
      onReply={(body) => updateThread(path, thread.id, (current) => ({ ...current, replies: [...current.replies, { id: crypto.randomUUID(), body }] }))}
      onToggleResolved={() => updateThread(path, thread.id, (current) => ({ ...current, resolved: !current.resolved }))} />
  }, [cancelComment, onAskAgentAboutSelection, onCommentOnSelection, onReplyToRemoteThread,
    onResolveRemoteThread, onSelectLines, pendingRemoteThreadId, reattachingThread,
    saveComment, updateThread])
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `${preferences.codeFontSize}px`,
    '--diffs-line-height': `${preferences.codeLineHeight}px`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])
  const codeViewOptions = useMemo<CodeViewReactOptions<ReviewAnnotationMetadata>>(() => ({
    // No `theme`: the worker pool resolves it and re-renders every instance on a
    // switch, so passing it here only forced a second full rebuild of the DOM.
    themeType: getEditorThemeType(preferences.editorTheme), diffStyle, diffIndicators: 'bars', lineDiffType: 'word-alt',
    overflow: preferences.wordWrap ? 'wrap' : 'scroll', disableLineNumbers: !preferences.showLineNumbers,
    tokenizeMaxLineLength: 2_000, enableLineSelection: true, enableGutterUtility: true,
    onLineSelectionEnd: (range, context) => onSelectLines(range == null ? null : { id: context.item.id, range }),
    onGutterUtilityClick: (range, context) => {
      const selection = { id: context.item.id, range }
      const timestamp = performance.now()
      const opensComment = isGutterDoubleClick(previousGutterActivationRef.current, selection, timestamp)
      previousGutterActivationRef.current = opensComment ? null : { selection, timestamp }
      onSelectLines(selection)
      // CodeView reports selection-end after this callback. Starting the draft
      // on the next microtask lets that report finish before the action bar is cleared.
      if (opensComment) queueMicrotask(() => onBeginComment(selection))
    },
    onPostRender: (node, _instance, phase, context) => {
      syncDragGuideLifecycle(node, phase, (range) => onSelectLines({ id: context.item.id, range }))
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      syncReviewCaretLifecycle(node, phase)
    },
    lineHoverHighlight: 'number', hunkSeparators: 'line-info-basic', expandUnchanged: !preferences.foldUnchanged,
    collapsedContextThreshold: 4, stickyHeaders: true, layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: preferences.codeLineHeight }, unsafeCSS: CODE_VIEW_CSS,
    ...(repositoryReview == null && window.repository != null ? { loadDiffFiles: async (fileDiff) => {
      const comparison = await window.repository!.getComparison(fileDiff.name)
      markReviewFileHydrated(fileDiff.name)
      return { oldFile: comparison.oldFile, newFile: comparison.newFile } as Awaited<ReturnType<NonNullable<CodeViewReactOptions<ReviewAnnotationMetadata>['loadDiffFiles']>>>
    }} : {})
  }), [diffStyle, onBeginComment, onSelectLines, preferences, repositoryReview])
  const handleScroll = useCallback((scrollTop: number) => {
    onScrollPositionChange(scrollTop)
    const backToTopVisible = scrollTop > BACK_TO_TOP_THRESHOLD
    if (backToTopVisible !== backToTopVisibleRef.current) {
      backToTopVisibleRef.current = backToTopVisible
      setShowBackToTop(backToTopVisible)
    }
    // The rendered-item snapshot allocates an array plus an object per item in the
    // render window, and the viewer calls this once per frame. Restarting this
    // timer makes it a trailing debounce: a fast fling produces one tree update
    // after it settles instead of making the sidebar selection jump every 80 ms.
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
    visiblePathTimerRef.current = setTimeout(() => {
      visiblePathTimerRef.current = null
      const instance = viewerRef.current?.getInstance()
      if (instance == null) return
      const activeId = findActiveRenderedItemId(instance)
      const activePath = activeId == null ? null : pathFromItemId(activeId)
      if (activePath == null || activePath === visiblePathRef.current) return
      visiblePathRef.current = activePath
      onVisiblePathChange(activePath)
    }, ACTIVE_PATH_SETTLE_MS)
  }, [onScrollPositionChange, onVisiblePathChange, viewerRef])

  if (paths.length === 0) return <div className="since-empty-state">
    <SinceNotice removedPaths={sinceRemovedPaths} uncertainPaths={sinceUncertainPaths} />
    <div className="diff-state"><IconCodeSearch /><strong>No current diffs to review</strong><span>The changed paths are no longer part of this pull request.</span></div>
  </div>
  if (loadState.items.length === 0 && loading) return <div className="diff-state"><IconRefresh className="spin" /><span>Loading repository review…</span></div>
  if (loadState.items.length === 0) {
    const emptyDetail = loadState.failedCount > 0
      ? 'The changed files could not be loaded.'
      : loadState.omittedFiles.length + loadState.skippedCount > 0
        ? 'Every changed file is too large or binary to open here.'
        : 'The review loaded, but its patch could not be parsed.'
    return <div className="diff-state"><IconWarningOctogonFill /><strong>No diffs to display</strong><span>{emptyDetail}</span></div>
  }
  const remainingPathCount = paths.length - targetPathCount
  // The pill keeps showing the reviewed count once loading settles: it is the
  // progress through the review, and fading it left an empty floating box behind.
  return <div className="multi-file-review">
    <div className="multi-file-progress" style={{
      '--review-progress': loadState.items.length === 0 ? 0 : viewedCount / loadState.items.length
    } as CSSProperties}><div role="status">
      <span>{loading
        ? `Loading ${loadState.loadedPaths.size} of ${targetPathCount}`
        : `${viewedCount} of ${loadState.items.length} reviewed`}</span>
      {loadState.skippedCount > 0 ? <span>{loadState.skippedCount} binary or large</span> : null}
      {loadState.omittedFiles.length > 0 ? <span title={loadState.omittedFiles.map((file) => file.path).join('\n')}>{loadState.omittedFiles.length} too large to diff</span> : null}
      {loadState.failedCount > 0 ? <span className="multi-file-error"><IconWarningOctogonFill />{loadState.failedCount} failed</span> : null}
    </div>{remainingPathCount > 0 ? <div className="multi-file-page-actions">
      <button type="button" onClick={onLoadMore} disabled={loading}>
        Load {Math.min(FOLDER_REVIEW_PAGE_SIZE, remainingPathCount)} more
      </button>
    </div> : null}<div className="multi-file-fold-actions" role="group" aria-label="Multi-file folding">
      <button type="button" onClick={collapseAllFiles} disabled={collapsedItemIds.size === loadState.items.length}>Collapse all</button>
      <button type="button" onClick={expandAllFiles} disabled={collapsedItemIds.size === 0}>Expand all</button>
    </div></div>
    <CodeView<ReviewAnnotationMetadata> ref={setViewerRef} containerRef={scrollContainerRef}
      items={annotatedItems} onScroll={handleScroll}
      options={codeViewOptions} selectedLines={selectedLines} onSelectedLinesChange={onSelectLines}
      renderCodeViewHeader={renderReviewSummary} renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      renderAnnotation={renderReviewAnnotation} className="multi-file-code-view" style={codeStyle} />
    <BackToTopButton visible={showBackToTop} onClick={() => scrollToReviewTop(viewerRef.current)} />
  </div>
})

interface ReviewSelectionOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  reattachingThread: ReattachingReviewThread | null
  beginComment(selection: CodeViewLineSelection): void
  beginReattach(path: string, threadId: string): void
  cancelReattach(): void
  handleSelectedLinesChange(selection: CodeViewLineSelection | null): void
  reattachToSelection(selection: CodeViewLineSelection): boolean
  onAttachToAgent(selection: AgentSelection): void
}

function useReviewSelectionActions({
  items,
  reattachingThread,
  beginComment,
  beginReattach,
  cancelReattach,
  handleSelectedLinesChange,
  reattachToSelection,
  onAttachToAgent
}: ReviewSelectionOptions) {
  // A finished selection offers actions first; commenting is one possible
  // outcome rather than the selection's automatic next state.
  const [pendingSelection, setPendingSelection] = useState<{
    id: string
    range: CodeViewLineSelection['range']
  } | null>(null)
  const handleSelectLines = useCallback((selection: CodeViewLineSelection | null) => {
    setPendingSelection(selection)
    handleSelectedLinesChange(selection)
  }, [handleSelectedLinesChange])
  const beginCommentAtSelection = useCallback((selection: CodeViewLineSelection) => {
    if (reattachingThread != null) {
      if (reattachToSelection(selection)) {
        setPendingSelection(null)
        showToast('Comment reattached')
      } else {
        showToast('Those lines cannot anchor this comment')
      }
      return
    }
    beginComment(selection)
    setPendingSelection(null)
  }, [beginComment, reattachToSelection, reattachingThread])
  const commentOnSelection = useCallback(() => {
    if (pendingSelection != null) beginCommentAtSelection(pendingSelection)
  }, [beginCommentAtSelection, pendingSelection])
  const startReattach = useCallback((path: string, threadId: string) => {
    setPendingSelection(null)
    beginReattach(path, threadId)
  }, [beginReattach])
  const stopReattach = useCallback(() => {
    setPendingSelection(null)
    cancelReattach()
  }, [cancelReattach])
  const askAgentAboutSelection = useCallback(() => {
    if (pendingSelection == null) return
    const item = items.find((candidate) => candidate.id === pendingSelection.id)
    const path = pathFromItemId(pendingSelection.id)
    const selection = item == null
      ? null
      : agentSelectionForReviewItem(item, path, pendingSelection.range)
    if (selection == null) {
      showToast('Select lines from one side of the diff')
      return
    }
    onAttachToAgent(selection)
    handleSelectLines(null)
  }, [handleSelectLines, items, onAttachToAgent, pendingSelection])

  // ⌘I uses the same current selection as the visible action bar.
  const askAgentRef = useRef(askAgentAboutSelection)
  useEffect(() => {
    askAgentRef.current = askAgentAboutSelection
  }, [askAgentAboutSelection])
  const hasPendingSelection = pendingSelection != null
  useEffect(() => {
    if (!hasPendingSelection) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'i' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      askAgentRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasPendingSelection])

  return {
    pendingSelection,
    handleSelectLines,
    beginCommentAtSelection,
    commentOnSelection,
    startReattach,
    stopReattach,
    askAgentAboutSelection
  }
}

const MultiFileReview = memo(function MultiFileReview({
  paths,
  diffStyle,
  preferences,
  repositoryReview = null,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation = null,
  loadState,
  loading,
  targetPathCount,
  onLoadMore,
  scrollToReviewRevision,
  navigationPath,
  navigationRevision,
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
  reviewCommand
}: MultiFileReviewProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('viewerCommitted'), [])
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const viewedAdvanceFrameRef = useRef(0)
  const handledNavigationRevisionRef = useRef(navigationRevision)
  const restoredScrollPositionRef = useRef(false)
  const pathsKey = paths.join('\0')
  const stablePaths = useMemo(() => pathsKey === '' ? [] : pathsKey.split('\0'), [pathsKey])
  const {
    selectedLines,
    draftComment,
    annotationVersions,
    collapsedItemIds,
    toggleItemCollapsed,
    toggleCollapsedById,
    setCollapsedById,
    collapseAllFiles,
    expandAllFiles,
    beginComment,
    handleSelectedLinesChange,
    saveComment,
    cancelComment,
    reattachingThread,
    beginReattach,
    cancelReattach,
    reattachToSelection,
    updateThread
  } = useReviewThreads({
    items: loadState.items,
    threadsByPath,
    setThreadsByPath
  })
  const {
    pendingSelection,
    handleSelectLines,
    beginCommentAtSelection,
    commentOnSelection,
    startReattach,
    stopReattach,
    askAgentAboutSelection
  } = useReviewSelectionActions({
    items: loadState.items,
    reattachingThread,
    beginComment,
    beginReattach,
    cancelReattach,
    handleSelectedLinesChange,
    reattachToSelection,
    onAttachToAgent
  })
  const setViewerRef = useCallback((viewer: CodeViewHandle<ReviewAnnotationMetadata> | null) => {
    viewerRef.current = viewer
  }, [])

  useEffect(() => {
    if (navigationRevision === handledNavigationRevisionRef.current || navigationPath == null) return
    const viewer = viewerRef.current
    const id = itemId(navigationPath)
    const item = viewer?.getItem(id)
    if (item == null) {
      // A file that belongs to the review but has not loaded yet will navigate on
      // a later pass, so leave the request pending. A file outside the comparison
      // never will — say so, because a ⌘P result that does nothing reads as broken.
      if (paths.includes(navigationPath)) return
      handledNavigationRevisionRef.current = navigationRevision
      showToast(`${navigationPath.split('/').at(-1) ?? navigationPath} has no changes in this review`)
      return
    }
    handledNavigationRevisionRef.current = navigationRevision
    viewer?.scrollTo({
      type: 'item',
      id,
      align: 'start',
      behavior: 'smooth-auto'
    })
  }, [loadState.loadedPaths, navigationPath, navigationRevision, paths])

  // Only the position this view carried in at mount is ever restored. Reading the
  // live prop instead let a later parent render (a conversation poll, a saved
  // review session) start a restore mid-scroll and pin the reader in place.
  const restoreTargetRef = useRef(initialScrollTop)
  useEffect(() => {
    if (restoredScrollPositionRef.current || loading || loadState.items.length === 0) return
    restoredScrollPositionRef.current = true
    const restoreTarget = restoreTargetRef.current
    if (restoreTarget <= 0) return
    // Virtualized content settles asynchronously (highlighting, measurement),
    // so a single scrollTo clamps early; retry until the target holds or the
    // user takes over scrolling.
    let frame = 0
    let settledFrames = 0
    let cancelled = false
    const startedAt = performance.now()
    const cancel = (): void => {
      cancelled = true
    }
    const stopObservingScrollTakeover = observeScrollTakeover(scrollContainerRef.current, cancel)
    const step = (): void => {
      if (cancelled) return
      const viewer = viewerRef.current
      if (viewer == null) return
      const current = getViewerScrollTop(viewer)
      if (current != null && Math.abs(current - restoreTarget) <= 1) {
        settledFrames += 1
        // Late measurement can still move the target out from under a position that
        // looked right, so hold it for a few frames before letting go.
        if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
      } else {
        settledFrames = 0
        viewer.scrollTo({ type: 'position', position: restoreTarget, behavior: 'instant' })
      }
      // Bounded by elapsed time rather than a frame count, so a 120 Hz display does
      // not give up in half the time.
      if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) frame = window.requestAnimationFrame(step)
    }
    step()
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      stopObservingScrollTakeover()
    }
  }, [loadState.items.length, loading])

  useEffect(() => {
    if (scrollToReviewRevision === 0) return
    scrollToReviewTop(viewerRef.current)
  }, [scrollToReviewRevision])

  const itemsByPath = useMemo(() => {
    const byPath = new Map<string, CodeViewItem<ReviewAnnotationMetadata>>()
    for (const item of loadState.items) byPath.set(pathFromItemId(item.id), item)
    return byPath
  }, [loadState.items])

  // Stale entries are filtered out rather than deleted, so a file whose contents
  // changed reads as unviewed without writing to state during render.
  const viewedPathsKey = useMemo(
    () => buildViewedPathsKey(itemsByPath, viewedFiles),
    [itemsByPath, viewedFiles]
  )
  // Rebuilding the Set per load page changed `renderHeaderMetadata`'s identity, and
  // CodeView memoizes its header portals on exactly that. Keying on the contents
  // means the headers re-render when the viewed set moves and not before.
  const viewedPaths = useMemo(() => parseViewedPathsKey(viewedPathsKey), [viewedPathsKey])

  const toggleViewed = useCallback((path: string) => {
    window.cancelAnimationFrame(viewedAdvanceFrameRef.current)
    viewedAdvanceFrameRef.current = 0

    const item = itemsByPath.get(path)
    if (item == null) return
    const viewed = viewedPaths.has(path)
    const viewer = viewerRef.current?.getInstance()
    const followItemId = viewed || viewer == null
      ? null
      : findNextUnreadReviewItemId(
          findActiveRenderedItemId(viewer),
          item.id,
          loadState.items,
          viewedPaths
        )

    setViewedFiles((current) => viewed
      ? dropChangedViewedFiles(current, [path])
      : markViewedFile(current, item))
    setCollapsedById(itemId(path), !viewed)
    if (followItemId == null) return

    viewedAdvanceFrameRef.current = window.requestAnimationFrame(() => {
      viewedAdvanceFrameRef.current = 0
      viewerRef.current?.scrollTo({
        type: 'item',
        id: followItemId,
        align: 'start',
        behavior: 'instant'
      })
    })
  }, [itemsByPath, loadState.items, setCollapsedById, setViewedFiles, viewedPaths])

  useEffect(() => () => {
    window.cancelAnimationFrame(viewedAdvanceFrameRef.current)
  }, [])

  const handledReviewCommandRef = useRef(reviewCommand?.revision ?? 0)
  useEffect(() => {
    if (reviewCommand == null || reviewCommand.revision === handledReviewCommandRef.current) return
    handledReviewCommandRef.current = reviewCommand.revision
    if (reviewCommand.command === 'toggleReviewViewed') toggleViewed(reviewCommand.path)
    else if (reviewCommand.command === 'toggleReviewCollapsed') toggleCollapsedById(itemId(reviewCommand.path))
  }, [reviewCommand, toggleCollapsedById, toggleViewed])

  const annotatedItems = useAnnotatedReviewItems({
    loadState,
    threadsByPath,
    remoteThreadsByPath,
    draftComment,
    pendingSelection,
    collapsedItemIds,
    annotationVersions
  })

  return <MultiFileViewer
    paths={stablePaths} diffStyle={diffStyle} preferences={preferences}
    repositoryReview={repositoryReview} pullRequestConversation={pullRequestConversation}
    sinceRemovedPaths={sinceRemovedPaths} sinceUncertainPaths={sinceUncertainPaths}
    loadState={loadState} loading={loading}
    targetPathCount={targetPathCount} onLoadMore={onLoadMore}
    selectedLines={selectedLines} annotatedItems={annotatedItems} threadsByPath={threadsByPath}
    collapsedItemIds={collapsedItemIds} viewedPaths={viewedPaths}
    viewedCount={viewedPaths.size} onToggleViewed={toggleViewed} scrollContainerRef={scrollContainerRef}
    viewerRef={viewerRef}
    remoteThreadsByPath={remoteThreadsByPath} pendingRemoteThreadId={pendingRemoteThreadId}
    onReplyToRemoteThread={onReplyToRemoteThread} onResolveRemoteThread={onResolveRemoteThread}
    pendingSelection={pendingSelection} onSelectLines={handleSelectLines}
    onCommentOnSelection={commentOnSelection} onBeginComment={beginCommentAtSelection}
    onAskAgentAboutSelection={askAgentAboutSelection}
    onScrollPositionChange={onScrollPositionChange} onVisiblePathChange={onVisiblePathChange} setViewerRef={setViewerRef}
    toggleItemCollapsed={toggleItemCollapsed} collapseAllFiles={collapseAllFiles}
    expandAllFiles={expandAllFiles} cancelComment={cancelComment} saveComment={saveComment}
    updateThread={updateThread} reattachingThread={reattachingThread}
    onBeginReattach={startReattach} onCancelReattach={stopReattach}
  />
})

export default MultiFileReview
