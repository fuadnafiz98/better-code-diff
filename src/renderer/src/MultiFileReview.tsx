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
  type SetStateAction
} from 'react'
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation
} from '@pierre/diffs'
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconCheck, IconChevronSm, IconCodeSearch, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { RemoteReviewThread, RepositoryChangeEvent, RepositoryReview } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import { CENTERED_COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import { markReviewFileHydrated } from './reviewMetrics'
import { COPY_FILE_PATH_CSS, reportCopiedPath, syncCopyFilePathLifecycle } from './copyFilePath'
import { DRAG_SELECTION_CSS, syncDragGuideLifecycle } from './dragSelection'
import { SPLIT_DIFF_RESIZE_CSS, syncSplitDiffResizeLifecycle } from './splitDiffResize'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  SelectionActions,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import type { AgentAttachment } from './agentAttachments'
import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'
import { RemoteReviewThreadCard } from './RemoteReviewThreads'
import {
  deriveAnnotatedReviewItems,
  planAnnotatedReviewItemMutations,
  type AnnotatedReviewItemCache
} from './annotatedReviewItems'
import {
  findActiveReviewItemId,
  pathFromReviewItemId as pathFromItemId,
  reviewItemId as itemId
} from './reviewItems'
import {
  FOLDER_REVIEW_PAGE_SIZE,
  useReviewLoadState,
  type ReviewLoadState
} from './useReviewLoadState'
import {
  useReviewThreads,
  type DraftReviewComment,
  type UpdateReviewThread
} from './useReviewThreads'
import { BackToTopButton, BACK_TO_TOP_THRESHOLD } from './BackToTopButton'
import { showToast } from './toast'
import type { ReviewCommand } from './keybindings'
import {
  dropChangedViewedFiles,
  markViewedFile,
  reviewFileSignature,
  type ViewedFileSignatures
} from './viewedFileStorage'

const CODE_VIEW_CSS = `
  *, *::before, *::after { corner-shape: squircle; }
  button { touch-action: manipulation; transition: transform 100ms cubic-bezier(0.23, 1, 0.32, 1), background-color 100ms cubic-bezier(0.23, 1, 0.32, 1); }
  button:active:not(:disabled) { transform: scale(0.96); }
  [data-expand-button] { border-radius: 22% !important; corner-shape: squircle !important; }
  [data-utility-button] { border-radius: 7px !important; corner-shape: squircle !important; }
  [data-expand-button]:hover { background: var(--accent-soft); color: var(--path-text); }
  button[data-review-collapse-button][data-review-collapse-button]:hover { background: var(--control-fill-hover) !important; color: var(--text) !important; }
  button[data-review-collapse-button][data-review-collapse-button]:focus-visible { outline: 2px solid var(--focus) !important; outline-offset: 2px !important; }
  button[data-review-collapse-button][data-review-collapse-button]:active { transform: scale(0.96) !important; }
  [data-collapse-chevron] { width: 11px !important; height: 16px !important; z-index: 1; pointer-events: none; transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }
  [data-review-collapse-button][aria-expanded="false"] [data-collapse-chevron] { transform: rotate(-90deg); }
  [data-separator="line-info-basic"] { border-block: 1px solid var(--border); background: var(--control-fill); }
  ${DRAG_SELECTION_CSS}
  ${CENTERED_COLLAPSED_SEPARATOR_CSS}
  ${SPLIT_DIFF_RESIZE_CSS}
  ${COPY_FILE_PATH_CSS}
`

const ACTIVE_PATH_SETTLE_MS = 80

const COLLAPSE_BUTTON_SQUIRCLE = 'polygon(50% 2.34%, 74.25% 3.16%, 83.69% 5.66%, 90.06% 9.94%, 94.34% 16.31%, 96.84% 25.75%, 97.66% 50%, 96.84% 74.25%, 94.34% 83.69%, 90.06% 90.06%, 83.69% 94.34%, 74.25% 96.84%, 50% 97.66%, 25.75% 96.84%, 16.31% 94.34%, 9.94% 90.06%, 5.66% 83.69%, 3.16% 74.25%, 2.34% 50%, 3.16% 25.75%, 5.66% 16.31%, 9.94% 9.94%, 16.31% 5.66%, 25.75% 3.16%)'
const COLLAPSE_BUTTON_STYLES = {
  appearance: 'none',
  width: '28px',
  height: '28px',
  display: 'grid',
  flex: '0 0 28px',
  placeItems: 'center',
  position: 'relative',
  marginInlineStart: '-3px',
  boxSizing: 'border-box',
  border: '0',
  padding: '0',
  background: 'var(--control-fill-selected)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  clipPath: COLLAPSE_BUTTON_SQUIRCLE
} as const

function applyImportantStyles(element: HTMLElement | SVGElement | null, styles: Readonly<Record<string, string>>): void {
  if (element == null) return
  for (const [property, value] of Object.entries(styles)) {
    const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    element.style.setProperty(cssProperty, value, 'important')
  }
}

function enforceCollapseButtonSquircle(button: HTMLButtonElement | null): void {
  applyImportantStyles(button, COLLAPSE_BUTTON_STYLES)
}

const VIEWED_TOGGLE_STYLES = {
  minHeight: '28px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  flex: '0 0 auto',
  position: 'relative',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: '1',
  paddingInlineEnd: '12px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  userSelect: 'none'
} as const

const VIEWED_INPUT_STYLES = {
  appearance: 'none',
  width: '1px',
  height: '1px',
  position: 'absolute',
  overflow: 'hidden',
  margin: '-1px',
  border: '0',
  padding: '0',
  opacity: '0',
  clipPath: 'inset(50%)'
} as const

function enforceViewedToggle(label: HTMLLabelElement | null): void {
  applyImportantStyles(label, VIEWED_TOGGLE_STYLES)
}

function enforceViewedInput(input: HTMLInputElement | null): void {
  applyImportantStyles(input, VIEWED_INPUT_STYLES)
}

function enforceViewedCheckbox(box: HTMLSpanElement | null, viewed: boolean): void {
  applyImportantStyles(box, {
    width: '15px',
    height: '15px',
    display: 'grid',
    flex: '0 0 15px',
    placeItems: 'center',
    boxSizing: 'border-box',
    border: `1px solid ${viewed ? 'var(--accent)' : 'var(--border-strong)'}`,
    borderRadius: '5px',
    background: viewed ? 'var(--accent)' : 'var(--control-fill)',
    color: 'var(--accent-contrast)',
    clipPath: COLLAPSE_BUTTON_SQUIRCLE
  })
  applyImportantStyles(box?.querySelector('svg') ?? null, {
    width: '10px',
    height: '10px',
    display: 'block',
    opacity: viewed ? '1' : '0',
    transform: viewed ? 'scale(1)' : 'scale(0.72)'
  })
}

interface MultiFileReviewProps {
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview?: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
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
  onAttachToAgent(attachment: AgentAttachment): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
}

const SCROLL_RESTORE_MAX_FRAMES = 60
// Any of these means the reader took over; a pending restore must yield to them.
const SCROLL_TAKEOVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

// The viewer maps its logical scroll offset onto a paged scroll scaffold, so the
// container's own scrollTop is not the position the viewer reports or accepts.
function getViewerScrollTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): number | null {
  return viewer?.getInstance()?.getScrollTop() ?? null
}

function scrollToReviewTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void {
  viewer?.scrollTo({ type: 'position', position: 0, behavior: 'smooth-auto' })
}

interface AnnotatedReviewItemsOptions {
  loadState: ReviewLoadState
  threadsByPath: Record<string, ReviewThread[]>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  draftComment: DraftReviewComment | null
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  collapsedItemIds: ReadonlySet<string>
  annotationVersions: Readonly<Record<string, number>>
  viewerRef: React.RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  viewerJustMountedRef: React.RefObject<boolean>
}

function useAnnotatedReviewItems({
  loadState,
  threadsByPath,
  remoteThreadsByPath,
  draftComment,
  pendingSelection,
  collapsedItemIds,
  annotationVersions,
  viewerRef,
  viewerJustMountedRef
}: AnnotatedReviewItemsOptions): CodeViewItem<ReviewAnnotationMetadata>[] {
  const committedCacheRef = useRef<AnnotatedReviewItemCache>(new Map())
  const previousItemsRef = useRef<ReadonlyMap<string, CodeViewItem<ReviewAnnotationMetadata>>>(new Map())
  const derivation = useMemo(() => deriveAnnotatedReviewItems({
    items: loadState.items,
    threadsByPath,
    remoteThreadsByPath,
    draftComment,
    pendingSelection,
    collapsedItemIds,
    annotationVersions,
    previousCache: committedCacheRef.current
  }), [annotationVersions, collapsedItemIds, draftComment, loadState.items, pendingSelection, remoteThreadsByPath, threadsByPath])

  useLayoutEffect(() => {
    committedCacheRef.current = derivation.cache
  }, [derivation.cache])

  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer == null) return
    if (viewerJustMountedRef.current) {
      viewerJustMountedRef.current = false
      previousItemsRef.current = new Map(derivation.items.map((item) => [item.id, item]))
      return
    }
    const mutations = planAnnotatedReviewItemMutations(
      derivation.items,
      previousItemsRef.current,
      (id) => viewer.getItem(id) != null
    )
    for (const item of mutations.updates) viewer.updateItem(item)
    if (mutations.additions.length > 0) viewer.addItems(mutations.additions)
    previousItemsRef.current = mutations.nextItems
  }, [derivation.items, viewerJustMountedRef, viewerRef])

  return derivation.items
}

interface MultiFileViewerProps {
  paths: readonly string[]
  pathsKey: string
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
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
  onAskAgentAboutSelection(): void
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  viewerRef: React.RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  setViewerRef(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void
  setSelectedLines(selection: CodeViewLineSelection | null): void
  beginComment(selection: CodeViewLineSelection): void
  toggleItemCollapsed(item: CodeViewItem<ReviewAnnotationMetadata>): void
  collapseAllFiles(): void
  expandAllFiles(): void
  cancelComment(): void
  saveComment(body: string): void
  updateThread: UpdateReviewThread
}

const MultiFileViewer = memo(function MultiFileViewer({
  paths,
  pathsKey,
  diffStyle,
  preferences,
  repositoryReview,
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
  remoteThreadsByPath,
  pendingRemoteThreadId,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  pendingSelection,
  onSelectLines,
  onCommentOnSelection,
  onAskAgentAboutSelection,
  scrollContainerRef,
  viewerRef,
  onScrollPositionChange,
  onVisiblePathChange,
  setViewerRef,
  setSelectedLines,
  beginComment,
  toggleItemCollapsed,
  collapseAllFiles,
  expandAllFiles,
  cancelComment,
  saveComment,
  updateThread
}: MultiFileViewerProps): React.JSX.Element {
  const [showBackToTop, setShowBackToTop] = useState(false)
  const backToTopVisibleRef = useRef(false)
  const visiblePathRef = useRef<string | null>(null)
  const visiblePathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
  }, [])
  const summaryEntries = useMemo<ReviewSummaryEntry[]>(() =>
    Object.entries(threadsByPath).flatMap(([path, threads]) =>
      threads.map((thread) => ({ path, thread }))
    ), [threadsByPath])
  const renderReviewSummary = useCallback(
    () => <ReviewSummary entries={summaryEntries} />,
    [summaryEntries]
  )
  const renderHeaderPrefix = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const expanded = !collapsedItemIds.has(item.id)
    const path = pathFromItemId(item.id)
    return (
      <button ref={enforceCollapseButtonSquircle} type="button" data-review-collapse-button
        aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${path}`}
        title={`${expanded ? 'Collapse' : 'Expand'} file`} onClick={(event) => {
          event.stopPropagation()
          toggleItemCollapsed(item)
        }}>
        <IconChevronSm data-collapse-chevron aria-hidden="true" />
      </button>
    )
  }, [collapsedItemIds, toggleItemCollapsed])
  // Viewed belongs in the header's metadata slot on the trailing edge. Rendered
  // in the prefix slot it shared a narrow box with the collapse button and
  // wrapped onto a second line under the chevron.
  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const path = pathFromItemId(item.id)
    const viewed = viewedPaths.has(path)
    return (
      <label ref={enforceViewedToggle} data-review-viewed-toggle data-state={viewed ? 'checked' : 'unchecked'}
        title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
        onClick={(event) => event.stopPropagation()}>
        <input ref={enforceViewedInput} type="checkbox" checked={viewed} aria-label={`Mark ${path} as viewed`}
          onFocus={(event) => applyImportantStyles(event.currentTarget.nextElementSibling as HTMLElement | null, {
            outline: '2px solid rgba(120, 169, 255, 0.9)', outlineOffset: '2px'
          })}
          onBlur={(event) => applyImportantStyles(event.currentTarget.nextElementSibling as HTMLElement | null, {
            outline: 'none', outlineOffset: '0'
          })}
          onChange={() => onToggleViewed(path)} />
        <span ref={(box) => enforceViewedCheckbox(box, viewed)} data-review-viewed-checkbox aria-hidden="true"><IconCheck /></span>
        <span>Viewed</span>
      </label>
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
    onResolveRemoteThread, onSelectLines, pendingRemoteThreadId, saveComment, updateThread])
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `${preferences.codeFontSize}px`,
    '--diffs-line-height': `${preferences.codeLineHeight}px`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])
  const codeViewOptions = useMemo<CodeViewReactOptions<ReviewAnnotationMetadata>>(() => ({
    theme: preferences.editorTheme, themeType: getEditorThemeType(preferences.editorTheme), diffStyle, diffIndicators: 'bars', lineDiffType: 'word-alt',
    overflow: preferences.wordWrap ? 'wrap' : 'scroll', disableLineNumbers: !preferences.showLineNumbers,
    tokenizeMaxLineLength: 2_000, enableLineSelection: true, enableGutterUtility: true,
    onLineSelectionEnd: (range, context) => onSelectLines(range == null ? null : { id: context.item.id, range }),
    onGutterUtilityClick: (range, context) => onSelectLines({ id: context.item.id, range }),
    onPostRender: (node, _instance, phase, context) => {
      syncDragGuideLifecycle(node, phase, (range) => onSelectLines({ id: context.item.id, range }))
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
    },
    lineHoverHighlight: 'number', hunkSeparators: 'line-info-basic', expandUnchanged: !preferences.foldUnchanged,
    collapsedContextThreshold: 4, stickyHeaders: true, layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: preferences.codeLineHeight }, unsafeCSS: CODE_VIEW_CSS,
    ...(repositoryReview == null && window.repository != null ? { loadDiffFiles: async (fileDiff) => {
      const comparison = await window.repository!.getComparison(fileDiff.name)
      markReviewFileHydrated(fileDiff.name)
      return { oldFile: comparison.oldFile, newFile: comparison.newFile } as Awaited<ReturnType<NonNullable<CodeViewReactOptions<ReviewAnnotationMetadata>['loadDiffFiles']>>>
    }} : {})
  }), [diffStyle, onSelectLines, preferences, repositoryReview])
  const handleScroll = useCallback((scrollTop: number, viewer: NonNullable<ReturnType<CodeViewHandle<ReviewAnnotationMetadata>['getInstance']>>) => {
    onScrollPositionChange(scrollTop)
    const backToTopVisible = scrollTop > BACK_TO_TOP_THRESHOLD
    if (backToTopVisible !== backToTopVisibleRef.current) {
      backToTopVisibleRef.current = backToTopVisible
      setShowBackToTop(backToTopVisible)
    }

    const positions = viewer.getRenderedItems().flatMap((item) => {
      const top = viewer.getTopForItem(item.id)
      return top == null ? [] : [{ id: item.id, top }]
    })
    const activeId = findActiveReviewItemId(scrollTop, positions)
    const activePath = activeId == null ? null : pathFromItemId(activeId)
    if (activePath == null || activePath === visiblePathRef.current) return
    visiblePathRef.current = activePath
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
    visiblePathTimerRef.current = setTimeout(() => {
      visiblePathTimerRef.current = null
      onVisiblePathChange(activePath)
    }, ACTIVE_PATH_SETTLE_MS)
  }, [onScrollPositionChange, onVisiblePathChange])

  if (paths.length === 0) return <div className="diff-state"><IconCodeSearch /><strong>No files to review</strong><span>This comparison has no visible changes.</span></div>
  if (loadState.items.length === 0 && loading) return <div className="diff-state"><IconRefresh className="spin" /><span>Loading repository review…</span></div>
  const remainingPathCount = paths.length - targetPathCount
  // The pill keeps showing the reviewed count once loading settles: it is the
  // progress through the review, and fading it left an empty floating box behind.
  return <div className="multi-file-review">
    <div className="multi-file-progress"><div role="status">
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
    <CodeView<ReviewAnnotationMetadata> key={pathsKey} ref={setViewerRef} containerRef={scrollContainerRef}
      initialItems={annotatedItems} onScroll={handleScroll}
      options={codeViewOptions} selectedLines={selectedLines} onSelectedLinesChange={onSelectLines}
      renderCodeViewHeader={renderReviewSummary} renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      renderAnnotation={renderReviewAnnotation} className="multi-file-code-view" style={codeStyle} />
    <BackToTopButton visible={showBackToTop} onClick={() => scrollToReviewTop(viewerRef.current)} />
  </div>
})

const MultiFileReview = memo(function MultiFileReview({
  paths,
  diffStyle,
  preferences,
  repositoryReview = null,
  repositoryChange,
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
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const viewerJustMountedRef = useRef(false)
  const handledNavigationRevisionRef = useRef(navigationRevision)
  const restoredScrollPositionRef = useRef(false)
  const pathsKey = paths.join('\0')
  const stablePaths = useMemo(() => pathsKey === '' ? [] : pathsKey.split('\0'), [pathsKey])
  // The load hook needs the reload callback before the threads hook (which owns
  // annotation versions) can exist, so it is forwarded through a ref.
  const onPathsReloadedRef = useRef<(reloadedPaths: readonly string[]) => void>(() => {})
  const onPathsReloaded = useCallback(
    (reloadedPaths: readonly string[]) => onPathsReloadedRef.current(reloadedPaths),
    []
  )
  const { loadState, loading, targetPathCount, loadMoreFiles } = useReviewLoadState({
    pathsKey,
    stablePaths,
    repositoryReview,
    repositoryChange,
    onPathsReloaded
  })
  const {
    selectedLines,
    draftComment,
    annotationVersions,
    collapsedItemIds,
    bumpPathVersions,
    toggleItemCollapsed,
    toggleCollapsedById,
    setCollapsedById,
    collapseAllFiles,
    expandAllFiles,
    beginComment,
    handleSelectedLinesChange,
    saveComment,
    cancelComment,
    updateThread
  } = useReviewThreads({ items: loadState.items, setThreadsByPath })
  // A finished selection offers actions first; committing to a comment is one of
  // them rather than the only outcome.
  const [pendingSelection, setPendingSelection] = useState<{
    id: string
    range: CodeViewLineSelection['range']
  } | null>(null)
  const handleSelectLines = useCallback((selection: CodeViewLineSelection | null) => {
    setPendingSelection(selection)
    handleSelectedLinesChange(selection)
  }, [handleSelectedLinesChange])
  const commentOnSelection = useCallback(() => {
    if (pendingSelection == null) return
    beginComment(pendingSelection)
    setPendingSelection(null)
  }, [beginComment, pendingSelection])
  const askAgentAboutSelection = useCallback(() => {
    if (pendingSelection == null) return
    const { start, end } = pendingSelection.range
    onAttachToAgent({
      path: pathFromItemId(pendingSelection.id),
      // A drag upward reports the anchor first.
      startLine: Math.min(start, end),
      endLine: Math.max(start, end)
    })
    // Clearing the viewer's selection too, because leaving it live let the next
    // selection-change event rebuild the action bar that was just consumed.
    handleSelectLines(null)
  }, [handleSelectLines, onAttachToAgent, pendingSelection])

  // ⌘I sends the current selection to the agent, matching the action bar's hint.
  // The handler is reached through a ref so the listener is bound once per
  // selection rather than re-subscribing whenever the callback's identity changes.
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
  useEffect(() => {
    onPathsReloadedRef.current = bumpPathVersions
  }, [bumpPathVersions])
  const setViewerRef = useCallback((viewer: CodeViewHandle<ReviewAnnotationMetadata> | null) => {
    viewerRef.current = viewer
    viewerJustMountedRef.current = viewer != null
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
    let attempts = 0
    let cancelled = false
    const cancel = (): void => {
      cancelled = true
    }
    const container = scrollContainerRef.current
    for (const type of SCROLL_TAKEOVER_EVENTS) container?.addEventListener(type, cancel, { passive: true })
    const step = (): void => {
      if (cancelled) return
      const viewer = viewerRef.current
      if (viewer == null) return
      const current = getViewerScrollTop(viewer)
      if (current == null || Math.abs(current - restoreTarget) > 1) {
        viewer.scrollTo({ type: 'position', position: restoreTarget, behavior: 'instant' })
      }
      attempts += 1
      if (attempts < SCROLL_RESTORE_MAX_FRAMES) frame = window.requestAnimationFrame(step)
    }
    step()
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      for (const type of SCROLL_TAKEOVER_EVENTS) container?.removeEventListener(type, cancel)
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
  const viewedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const [path, signature] of Object.entries(viewedFiles)) {
      const item = itemsByPath.get(path)
      if (item != null && reviewFileSignature(item) === signature) paths.add(path)
    }
    return paths
  }, [itemsByPath, viewedFiles])

  const toggleViewed = useCallback((path: string) => {
    const item = itemsByPath.get(path)
    if (item == null) return
    const viewed = viewedPaths.has(path)
    setViewedFiles((current) => viewed
      ? dropChangedViewedFiles(current, [path])
      : markViewedFile(current, item))
    setCollapsedById(itemId(path), !viewed)
  }, [itemsByPath, setCollapsedById, setViewedFiles, viewedPaths])

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
    annotationVersions,
    viewerRef,
    viewerJustMountedRef
  })

  return <MultiFileViewer
    paths={stablePaths} pathsKey={pathsKey} diffStyle={diffStyle} preferences={preferences}
    repositoryReview={repositoryReview} loadState={loadState} loading={loading}
    targetPathCount={targetPathCount} onLoadMore={loadMoreFiles}
    selectedLines={selectedLines} annotatedItems={annotatedItems} threadsByPath={threadsByPath}
    collapsedItemIds={collapsedItemIds} viewedPaths={viewedPaths}
    viewedCount={viewedPaths.size} onToggleViewed={toggleViewed} scrollContainerRef={scrollContainerRef}
    viewerRef={viewerRef}
    remoteThreadsByPath={remoteThreadsByPath} pendingRemoteThreadId={pendingRemoteThreadId}
    onReplyToRemoteThread={onReplyToRemoteThread} onResolveRemoteThread={onResolveRemoteThread}
    pendingSelection={pendingSelection} onSelectLines={handleSelectLines}
    onCommentOnSelection={commentOnSelection} onAskAgentAboutSelection={askAgentAboutSelection}
    onScrollPositionChange={onScrollPositionChange} onVisiblePathChange={onVisiblePathChange} setViewerRef={setViewerRef}
    setSelectedLines={handleSelectLines} beginComment={beginComment}
    toggleItemCollapsed={toggleItemCollapsed} collapseAllFiles={collapseAllFiles}
    expandAllFiles={expandAllFiles} cancelComment={cancelComment} saveComment={saveComment}
    updateThread={updateThread}
  />
})

export default MultiFileReview
