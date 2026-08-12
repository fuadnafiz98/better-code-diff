import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import {
  parseDiffFromFile,
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation,
  type SelectedLineRange
} from '@pierre/diffs'
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconChevronSm, IconCodeSearch, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { FileComparison, RepositoryChangeEvent, RepositoryReview } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import {
  DIFF_HIGHLIGHTER_LANGUAGES,
  DIFF_HIGHLIGHTER_LIMITS,
  DIFF_WORKER_COUNT,
  DIFF_WORKER_POOL_OPTIONS
} from './diffWorkerConfig'
import { DRAG_SELECTION_CSS, syncDragGuideLifecycle } from './dragSelection'
import { CODE_FONTS, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'

const CODE_VIEW_CSS = `
  *, *::before, *::after { corner-shape: squircle; }
  button { touch-action: manipulation; transition: transform 100ms cubic-bezier(0.23, 1, 0.32, 1); }
  button:active:not(:disabled) { transform: scale(0.97); }
  [data-expand-button] { border-radius: 22% !important; corner-shape: squircle !important; }
  [data-utility-button] { border-radius: 7px !important; corner-shape: squircle !important; }
  [data-expand-button]:hover { background: rgba(120, 169, 255, 0.14); color: #a9c9ff; }
  button[data-review-collapse-button][data-review-collapse-button] {
    filter: brightness(1);
  }
  button[data-review-collapse-button][data-review-collapse-button]:hover { filter: brightness(1.35); }
  button[data-review-collapse-button][data-review-collapse-button]:focus-visible { outline: 2px solid rgba(120, 169, 255, 0.9) !important; outline-offset: 2px !important; }
  button[data-review-collapse-button][data-review-collapse-button]:active { transform: scale(0.96) !important; }
  [data-collapse-chevron] { width: 11px !important; height: 16px !important; z-index: 1; pointer-events: none; transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }
  [data-review-collapse-button][aria-expanded="false"] [data-collapse-chevron] { transform: rotate(-90deg); }
  [data-separator="line-info-basic"] { border-block: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.035); }
  ${DRAG_SELECTION_CSS}
`

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
  background: 'rgba(255, 255, 255, 0.085)',
  color: 'rgba(211, 214, 220, 0.82)',
  cursor: 'pointer',
  clipPath: COLLAPSE_BUTTON_SQUIRCLE
} as const

function enforceCollapseButtonSquircle(button: HTMLButtonElement | null): void {
  if (button == null) return
  for (const [property, value] of Object.entries(COLLAPSE_BUTTON_STYLES)) {
    const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    button.style.setProperty(cssProperty, value, 'important')
  }
}

interface MultiFileReviewProps {
  paths: readonly string[]
  selectedPath: string | null
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview?: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
}

interface ReviewLoadState {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  loadedPaths: Set<string>
  failedCount: number
  skippedCount: number
}

const EMPTY_LOAD_STATE: ReviewLoadState = {
  items: [],
  loadedPaths: new Set(),
  failedCount: 0,
  skippedCount: 0
}

function itemId(path: string): string {
  return `review:${path}`
}

function createReviewItem(comparison: FileComparison): CodeViewItem<ReviewAnnotationMetadata> | null {
  if (comparison.binary || comparison.oversized) return null

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return { id: itemId(comparison.path), type: 'file', file: comparison.newFile }
  }

  if (comparison.oldFile == null && comparison.newFile == null) return null
  return {
    id: itemId(comparison.path),
    type: 'diff',
    fileDiff: parseDiffFromFile(comparison.oldFile, comparison.newFile)
  }
}

function pathFromItemId(id: string): string {
  return id.startsWith('review:') ? id.slice('review:'.length) : id
}

interface DraftReviewComment {
  path: string
  range: SelectedLineRange
}

function createDiffAnnotation(
  metadata: ReviewAnnotationMetadata
): DiffLineAnnotation<ReviewAnnotationMetadata> {
  if (metadata.kind === 'draft') {
    return {
      lineNumber: metadata.range.start,
      side: metadata.range.side ?? 'additions',
      metadata
    }
  }
  return {
    lineNumber: metadata.thread.lineNumber,
    side: metadata.thread.side ?? 'additions',
    metadata
  }
}

function createFileAnnotation(
  metadata: ReviewAnnotationMetadata
): LineAnnotation<ReviewAnnotationMetadata> {
  return metadata.kind === 'draft'
    ? { lineNumber: metadata.range.start, metadata }
    : { lineNumber: metadata.thread.lineNumber, metadata }
}

const MultiFileReview = memo(function MultiFileReview({
  paths,
  selectedPath,
  diffStyle,
  preferences,
  repositoryReview = null,
  repositoryChange
}: MultiFileReviewProps): React.JSX.Element {
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const [loadState, setLoadState] = useState<ReviewLoadState>(EMPTY_LOAD_STATE)
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null)
  const [draftComment, setDraftComment] = useState<DraftReviewComment | null>(null)
  const [threadsByPath, setThreadsByPath] = useState<Record<string, ReviewThread[]>>({})
  const [annotationVersions, setAnnotationVersions] = useState<Record<string, number>>({})
  const [collapsedItemIds, setCollapsedItemIds] = useState<Set<string>>(() => new Set())
  const loading = repositoryReview == null && loadState.loadedPaths.size < paths.length
  const pathsKey = paths.join('\0')
  const stablePaths = useMemo(() => pathsKey === '' ? [] : pathsKey.split('\0'), [pathsKey])

  const externalReviewItems = useMemo<CodeViewItem<ReviewAnnotationMetadata>[] | null>(() => {
    if (repositoryReview == null) return null
    const seenPaths = new Set<string>()
    const items: CodeViewItem<ReviewAnnotationMetadata>[] = []
    const patches = parsePatchFiles(
      repositoryReview.patch,
      repositoryReview.kind === 'github'
        ? `pr-${repositoryReview.pullRequest.number}-${repositoryReview.pullRequest.updatedAt}`
        : repositoryReview.id
    )
    for (const patch of patches) {
      for (const fileDiff of patch.files) {
        if (seenPaths.has(fileDiff.name)) continue
        seenPaths.add(fileDiff.name)
        items.push({ id: itemId(fileDiff.name), type: 'diff', fileDiff })
      }
    }
    return items
  }, [repositoryReview])

  useEffect(() => {
    let cancelled = false
    if (externalReviewItems != null) {
      setLoadState({
        items: externalReviewItems,
        loadedPaths: new Set(stablePaths),
        failedCount: 0,
        skippedCount: Math.max(0, stablePaths.length - externalReviewItems.length)
      })
      return
    }
    setLoadState(EMPTY_LOAD_STATE)

    async function loadComparisons(): Promise<void> {
      const repository = window.repository
      if (repository == null) {
        setLoadState({
          items: [],
          loadedPaths: new Set(stablePaths),
          failedCount: stablePaths.length,
          skippedCount: 0
        })
        return
      }

      for (let start = 0; start < stablePaths.length && !cancelled; start += DIFF_WORKER_COUNT) {
        const batchPaths = stablePaths.slice(start, start + DIFF_WORKER_COUNT)
        const results = await Promise.all(batchPaths.map(async (path) => {
          try {
            const item = createReviewItem(await repository.getComparison(path))
            return { path, item, failed: false }
          } catch {
            return { path, item: null, failed: true }
          }
        }))
        if (cancelled) return

        startTransition(() => {
          setLoadState((current) => {
            const loadedPaths = new Set(current.loadedPaths)
            const nextItems = [...current.items]
            let failedCount = current.failedCount
            let skippedCount = current.skippedCount

            for (const result of results) {
              loadedPaths.add(result.path)
              if (result.failed) failedCount += 1
              else if (result.item == null) skippedCount += 1
              else nextItems.push(result.item)
            }

            return { items: nextItems, loadedPaths, failedCount, skippedCount }
          })
        })
      }
    }

    void loadComparisons()
    return () => { cancelled = true }
  }, [externalReviewItems, stablePaths])

  useEffect(() => {
    if (externalReviewItems != null || repositoryChange == null) return
    const visiblePaths = new Set(stablePaths)
    const pathsToReload = repositoryChange.changedPaths.filter((path) => visiblePaths.has(path))
    if (pathsToReload.length === 0) return
    let cancelled = false

    void Promise.all(pathsToReload.map(async (path) => {
      try {
        return { path, item: createReviewItem(await window.repository!.getComparison(path)) }
      } catch {
        return { path, item: null }
      }
    })).then((results) => {
      if (cancelled) return
      startTransition(() => {
        setAnnotationVersions((current) => {
          const next = { ...current }
          for (const result of results) next[result.path] = (next[result.path] ?? 0) + 1
          return next
        })
        setLoadState((current) => {
          const replacements = new Map(results.map((result) => [itemId(result.path), result.item]))
          const nextItems = current.items.flatMap((item) => {
            if (!replacements.has(item.id)) return [item]
            const replacement = replacements.get(item.id)
            replacements.delete(item.id)
            return replacement == null ? [] : [replacement]
          })
          for (const replacement of replacements.values()) {
            if (replacement != null) nextItems.push(replacement)
          }
          return { ...current, items: nextItems }
        })
      })
    })

    return () => { cancelled = true }
  }, [externalReviewItems, repositoryChange, stablePaths])

  useEffect(() => {
    if (selectedPath == null || !loadState.loadedPaths.has(selectedPath)) return
    const viewer = viewerRef.current
    const id = itemId(selectedPath)
    if (viewer?.getItem(id) == null) return
    viewer.scrollTo({
      type: 'item',
      id,
      align: 'start',
      behavior: 'smooth-auto'
    })
  }, [loadState.loadedPaths, selectedPath])

  const bumpAnnotationVersion = useCallback((path: string) => {
    setAnnotationVersions((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1
    }))
  }, [])

  const toggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    setCollapsedItemIds((current) => {
      const next = new Set(current)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
    bumpAnnotationVersion(pathFromItemId(item.id))
  }, [bumpAnnotationVersion])

  const beginComment = useCallback((selection: CodeViewLineSelection) => {
    setSelectedLines(selection)
    setDraftComment({ path: pathFromItemId(selection.id), range: selection.range })
  }, [])

  const handleSelectedLinesChange = useCallback((selection: CodeViewLineSelection | null) => {
    setSelectedLines(selection)
  }, [])

  const saveComment = useCallback((body: string) => {
    if (draftComment == null) return
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: draftComment.range.start,
      side: draftComment.range.side,
      range: draftComment.range,
      replies: [],
      resolved: false
    }
    setThreadsByPath((current) => ({
      ...current,
      [draftComment.path]: [...(current[draftComment.path] ?? []), thread]
    }))
    bumpAnnotationVersion(draftComment.path)
    setDraftComment(null)
  }, [bumpAnnotationVersion, draftComment])

  const cancelComment = useCallback(() => {
    setDraftComment(null)
    setSelectedLines(null)
  }, [])

  const updateThread = useCallback((
    path: string,
    threadId: string,
    update: (thread: ReviewThread) => ReviewThread | null
  ) => {
    setThreadsByPath((current) => ({
      ...current,
      [path]: (current[path] ?? []).flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const nextThread = update(thread)
        return nextThread == null ? [] : [nextThread]
      })
    }))
    bumpAnnotationVersion(path)
  }, [bumpAnnotationVersion])

  const annotatedItems = useMemo<CodeViewItem<ReviewAnnotationMetadata>[]>(() =>
    loadState.items.map((item) => {
      const path = pathFromItemId(item.id)
      const threads = threadsByPath[path] ?? []
      const metadata: ReviewAnnotationMetadata[] = [
        ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
        ...(draftComment?.path === path
          ? [{ kind: 'draft' as const, range: draftComment.range }]
          : [])
      ]
      const annotations = item.type === 'diff'
        ? metadata.map(createDiffAnnotation)
        : metadata.map(createFileAnnotation)
      const draftVersion = draftComment?.path === path
        ? 1_000_000 + draftComment.range.start * 1_000 + draftComment.range.end
        : 0
      return {
        ...item,
        annotations,
        collapsed: collapsedItemIds.has(item.id),
        version: (annotationVersions[path] ?? 0) + draftVersion
      } as CodeViewItem<ReviewAnnotationMetadata>
    }), [annotationVersions, collapsedItemIds, draftComment, loadState.items, threadsByPath])

  const summaryEntries = useMemo<ReviewSummaryEntry[]>(() =>
    Object.entries(threadsByPath).flatMap(([path, threads]) =>
      threads.map((thread) => ({ path, thread }))
    ), [threadsByPath])

  const renderReviewSummary = useCallback(
    () => <ReviewSummary entries={summaryEntries} />,
    [summaryEntries]
  )

  const renderCollapseButton = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const expanded = !collapsedItemIds.has(item.id)
    return (
      <button
        ref={enforceCollapseButtonSquircle}
        type="button"
        data-review-collapse-button
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${pathFromItemId(item.id)}`}
        title={`${expanded ? 'Collapse' : 'Expand'} file`}
        onClick={(event) => {
          event.stopPropagation()
          toggleItemCollapsed(item)
        }}
      >
        <IconChevronSm data-collapse-chevron aria-hidden="true" />
      </button>
    )
  }, [collapsedItemIds, toggleItemCollapsed])

  const renderReviewAnnotation = useCallback((
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element => {
    const path = pathFromItemId(item.id)
    const metadata = annotation.metadata
    if (metadata.kind === 'draft') {
      return <DraftComment range={metadata.range} onCancel={cancelComment} onSave={saveComment} />
    }
    const { thread } = metadata
    return (
      <ReviewThreadCard
        thread={thread}
        onDelete={() => updateThread(path, thread.id, () => null)}
        onEdit={(body) => updateThread(path, thread.id, (current) => ({ ...current, body }))}
        onReply={(body) => updateThread(path, thread.id, (current) => ({
          ...current,
          replies: [...current.replies, { id: crypto.randomUUID(), body }]
        }))}
        onToggleResolved={() => updateThread(path, thread.id, (current) => ({
          ...current,
          resolved: !current.resolved
        }))}
      />
    )
  }, [cancelComment, saveComment, updateThread])

  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `${preferences.codeFontSize}px`,
    '--diffs-line-height': `${preferences.codeLineHeight}px`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  const codeViewOptions = useMemo<CodeViewReactOptions<ReviewAnnotationMetadata>>(() => ({
    theme: preferences.editorTheme,
    themeType: 'dark',
    diffStyle,
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    overflow: preferences.wordWrap ? 'wrap' : 'scroll',
    disableLineNumbers: !preferences.showLineNumbers,
    tokenizeMaxLineLength: 2_000,
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelectionEnd: (range, context) => {
      if (range == null) {
        setSelectedLines(null)
        return
      }
      beginComment({ id: context.item.id, range })
    },
    onGutterUtilityClick: (range, context) => beginComment({ id: context.item.id, range }),
    onPostRender: (node, _instance, phase, context) => {
      syncDragGuideLifecycle(node, phase, (range) => beginComment({ id: context.item.id, range }))
    },
    lineHoverHighlight: 'number',
    hunkSeparators: 'line-info-basic',
    expandUnchanged: false,
    collapsedContextThreshold: 4,
    stickyHeaders: true,
    layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: preferences.codeLineHeight },
    unsafeCSS: CODE_VIEW_CSS
  }), [beginComment, diffStyle, preferences])

  const highlighterOptions = useMemo(() => ({
    langs: DIFF_HIGHLIGHTER_LANGUAGES,
    theme: preferences.editorTheme,
    ...DIFF_HIGHLIGHTER_LIMITS
  }), [preferences.editorTheme])

  if (paths.length === 0) {
    return <div className="diff-state"><IconCodeSearch /><strong>No files to review</strong><span>This comparison has no visible changes.</span></div>
  }

  if (loadState.items.length === 0 && loading) {
    return <div className="diff-state"><IconRefresh className="spin" /><span>Loading repository review…</span></div>
  }

  return (
    <div className="multi-file-review">
      <div className="multi-file-progress" role="status">
        <span>{loading ? `Loading ${loadState.loadedPaths.size} of ${paths.length}` : `${loadState.items.length} files ready`}</span>
        {loadState.skippedCount > 0 ? <span>{loadState.skippedCount} binary or large</span> : null}
        {loadState.failedCount > 0 ? <span className="multi-file-error"><IconWarningOctogonFill />{loadState.failedCount} failed</span> : null}
      </div>
      <WorkerPoolContextProvider poolOptions={DIFF_WORKER_POOL_OPTIONS} highlighterOptions={highlighterOptions}>
        <CodeView<ReviewAnnotationMetadata>
          ref={viewerRef}
          items={annotatedItems}
          options={codeViewOptions}
          selectedLines={selectedLines}
          onSelectedLinesChange={handleSelectedLinesChange}
          renderCodeViewHeader={renderReviewSummary}
          renderHeaderPrefix={renderCollapseButton}
          renderAnnotation={renderReviewAnnotation}
          className="multi-file-code-view"
          style={codeStyle}
        />
      </WorkerPoolContextProvider>
    </div>
  )
})

export default MultiFileReview
