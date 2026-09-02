import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import type { DiffLineAnnotation, FileContents, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { File, MultiFileDiff, useVirtualizer, Virtualizer } from '@pierre/diffs/react'
import type { Editor } from '@pierre/diffs/edit'
import {
  IconCodeSearch,
  IconFile,
  IconFileCode,
  IconRefresh,
  IconWarningOctogonFill
} from '@pierre/icons'

import type { ContentSearchResult, FileComparison } from '../../shared/contracts'
import { hasImagePreview } from '../../shared/imagePreview'
import { ImageDiffPreview } from './ImageDiffPreview'
import { MarkdownFilePreview } from './MarkdownFilePreview'
import { markdownPreviewSource, markdownSurface, type DocumentView } from './documentView'
import { MarkdownSplitResizer } from './MarkdownSplitResizer'
import type { AgentSelection } from './agentAttachments'
import type { DiffStyle } from './AppView'
import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from './codeZoom'
import { reportCopiedPath, syncCopyFilePathLifecycle } from './copyFilePath'
import { syncDragGuideLifecycle } from './dragSelection'
import { syncSplitDiffResizeLifecycle } from './splitDiffResize'
import { syncReviewCaretLifecycle } from './reviewCaret'
import { SELECTION_ACTION_CSS, VIEWER_BASE_CSS } from './viewerCss'
import { contentSearchMarkers, markersEqual, type EditorMarker } from './editor/markers'
import {
  createSelectionActionElement,
  selectionLineRange,
  type SelectionActionContext
} from './editor/selectionAction'
import { useViewerContext, type EditorAnnotations } from './editor/ViewerProviders'
import { createDiffAnnotation, createFileAnnotation, selectedRangeLastLine } from './reviewAnnotations'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import { markRendererStartup } from './startupMetrics'
import { BackToTopButton, BACK_TO_TOP_THRESHOLD, preferredScrollBehavior } from './BackToTopButton'
import { showToast } from './toast'

const DIFF_OPTIONS = {
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  stickyHeader: true,
  tokenizeMaxLineLength: 2_000,
  enableLineSelection: true,
  enableGutterUtility: true,
  lineHoverHighlight: 'number' as const
}
const INTERACTION_CSS = `
  ${VIEWER_BASE_CSS}
  ${SELECTION_ACTION_CSS}

  /* The polygon this used to carry fitted |a|^n + |b|^n = 1 at n≈1.82 — flatter
     than a circle, i.e. a bevel, not a squircle — and clip-path clips the outline,
     so the button had no visible keyboard focus. corner-shape in VIEWER_BASE_CSS
     draws the real thing and leaves the ring alone. */
  button[data-expand-button][data-expand-button] {
    cursor: pointer;
    color: var(--text-secondary);
  }

  [data-separator-wrapper] {
    min-height: 30px;
  }

  [data-unmodified-lines] {
    color: var(--muted);
    font-family: var(--diffs-header-font-family);
    font-size: 11px;
  }
`
export interface ContentSearchState {
  query: string
  results: readonly ContentSearchResult[]
}

export interface DiffSurfaceProps {
  comparison: FileComparison | null
  loading: boolean
  diffStyle: DiffStyle
  preferences: AppPreferences
  editMode: 'read' | 'edit' | 'preview'
  documentView: DocumentView
  contentSearch?: ContentSearchState
  getEditor(): Editor<ReviewAnnotationMetadata> | null
  onDraftFileChange(file: FileContents): void
  onEditorAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onEditorBlur(): void
  onAttachToAgent(selection: AgentSelection): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
}

// Identity is the viewer's change signal for annotations (syncLineAnnotations
// only bails when the array is the same object), so the empty case must not mint
// a new array per render.
const NO_THREADS: ReviewThread[] = []

type DiffContentsProps = Omit<DiffSurfaceProps, 'threadsByPath'> & { threads: ReviewThread[] }

function VirtualizedBackToTop(): React.JSX.Element {
  const virtualizer = useVirtualizer()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const currentVirtualizer = virtualizer
    if (currentVirtualizer == null) return
    const root = currentVirtualizer.getRoot()
    if (!(root instanceof HTMLElement)) return
    // Scroll fires per frame while a long review is flung; reading scrollTop
    // there costs a layout flush, so the read is coalesced into one rAF.
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      setVisible(currentVirtualizer.getScrollTop() > BACK_TO_TOP_THRESHOLD)
    }
    const handleScroll = (): void => {
      if (frame == null) frame = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', handleScroll, { passive: true })
    measure()
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', handleScroll)
    }
  }, [virtualizer])

  return (
    <BackToTopButton
      visible={visible}
      onClick={() => virtualizer?.scrollTo({ top: 0, behavior: preferredScrollBehavior() })}
    />
  )
}

/**
 * Owns the review-comment cursor for one file: which lines are selected, the
 * draft card, and the annotation collection handed to the viewer.
 */
function useReviewComments(
  path: string | undefined,
  threads: ReviewThread[],
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
) {
  const [reviewCursor, setReviewCursor] = useState<{
    path: string | undefined
    selectedLines: SelectedLineRange | null
    draftRange: SelectedLineRange | null
  }>({ path: undefined, selectedLines: null, draftRange: null })

  const comparisonPath = path
  const selectedLines = reviewCursor.path === comparisonPath ? reviewCursor.selectedLines : null
  const draftRange = reviewCursor.path === comparisonPath ? reviewCursor.draftRange : null
  const beginComment = useCallback((range: SelectedLineRange) => {
    setReviewCursor({ path: comparisonPath, selectedLines: range, draftRange: range })
  }, [comparisonPath])

  const saveComment = useCallback((body: string) => {
    if (comparisonPath == null || draftRange == null) return
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: selectedRangeLastLine(draftRange),
      side: draftRange.side,
      range: draftRange,
      replies: [],
      resolved: false
    }
    setThreadsByPath((current) => ({
      ...current,
      [comparisonPath]: [...(current[comparisonPath] ?? []), thread]
    }))
    setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })
  }, [comparisonPath, draftRange, setThreadsByPath])

  const updateThread = useCallback((threadId: string, update: (thread: ReviewThread) => ReviewThread | null) => {
    if (comparisonPath == null) return
    setThreadsByPath((current) => ({
      ...current,
      [comparisonPath]: (current[comparisonPath] ?? []).flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const nextThread = update(thread)
        return nextThread == null ? [] : [nextThread]
      })
    }))
  }, [comparisonPath, setThreadsByPath])

  const renderReviewAnnotation = useCallback((metadata: ReviewAnnotationMetadata): React.JSX.Element => {
    if (metadata.kind === 'draft') {
      return (
        <DraftComment
          range={metadata.range}
          onCancel={() => setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })}
          onSave={saveComment}
        />
      )
    }
    // The single-file view keeps its direct comment flow, so no selection action
    // bar is produced here; remote threads belong to the multi-file review.
    if (metadata.kind === 'remote' || metadata.kind === 'selection' || metadata.kind === 'image') {
      return <></>
    }
    const { thread } = metadata
    return (
      <ReviewThreadCard
        thread={thread}
        onDelete={() => updateThread(thread.id, () => null)}
        onEdit={(body) => updateThread(thread.id, (current) => ({ ...current, body }))}
        onReply={(body) => updateThread(thread.id, (current) => ({
          ...current,
          replies: [...current.replies, { id: crypto.randomUUID(), body }]
        }))}
        onToggleResolved={() => updateThread(thread.id, (current) => ({ ...current, resolved: !current.resolved }))}
      />
    )
  }, [comparisonPath, saveComment, updateThread])

  const reviewMetadata = useMemo<ReviewAnnotationMetadata[]>(() => [
    ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
    ...(draftRange == null ? [] : [{ kind: 'draft' as const, range: draftRange }])
  ], [draftRange, threads])

  const fileAnnotations = useMemo<LineAnnotation<ReviewAnnotationMetadata>[]>(
    () => reviewMetadata.map(createFileAnnotation),
    [reviewMetadata]
  )

  const diffAnnotations = useMemo<DiffLineAnnotation<ReviewAnnotationMetadata>[]>(
    () => reviewMetadata.map(createDiffAnnotation),
    [reviewMetadata]
  )

  return {
    selectedLines,
    beginComment,
    setReviewCursor,
    renderReviewAnnotation,
    fileAnnotations,
    diffAnnotations
  }
}

function DiffContents({
  comparison,
  loading,
  diffStyle,
  preferences,
  editMode,
  documentView,
  contentSearch,
  getEditor,
  onDraftFileChange,
  onEditorAttach,
  onEditorBlur,
  onAttachToAgent,
  threads,
  setThreadsByPath
}: DiffContentsProps): React.JSX.Element {
  const viewer = useViewerContext()
  const comparisonPath = comparison?.path
  const {
    selectedLines,
    beginComment,
    setReviewCursor,
    renderReviewAnnotation,
    fileAnnotations,
    diffAnnotations
  } = useReviewComments(comparisonPath, threads, setThreadsByPath)
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `var(${LIVE_CODE_FONT_SIZE_PROPERTY}, ${preferences.codeFontSize}px)`,
    '--diffs-line-height': `var(${LIVE_CODE_LINE_HEIGHT_PROPERTY}, ${preferences.codeLineHeight}px)`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  // The editor remaps annotation coordinates as the document changes and hands
  // back the whole authoritative collection. Ignoring it left comment cards on
  // the line numbers they had before the edit. The array identity only changes
  // on a structural edit, so ordinary typing costs nothing here, and the update
  // runs inside the editor's own discrete input event, so React commits it
  // before paint without flushSync.
  const publishRemappedAnnotations = useCallback((annotations: EditorAnnotations) => {
    if (annotations == null || comparisonPath == null) return
    const lineByThreadId = new Map<string, number>()
    for (const annotation of annotations) {
      const { metadata } = annotation
      if (metadata?.kind !== 'thread') continue
      lineByThreadId.set(metadata.thread.id, annotation.lineNumber)
    }
    if (lineByThreadId.size === 0) return
    setThreadsByPath((current) => {
      const threadsForPath = current[comparisonPath]
      if (threadsForPath == null) return current
      let changed = false
      const next = threadsForPath.map((thread) => {
        const lineNumber = lineByThreadId.get(thread.id)
        if (lineNumber == null || lineNumber === thread.lineNumber) return thread
        changed = true
        return { ...thread, lineNumber }
      })
      return changed ? { ...current, [comparisonPath]: next } : current
    })
  }, [comparisonPath, setThreadsByPath])

  const lastAnnotationsRef = useRef<EditorAnnotations>(undefined)
  const handleEditorChange = useCallback((file: FileContents, annotations: EditorAnnotations) => {
    onDraftFileChange(file)
    if (annotations === lastAnnotationsRef.current) return
    lastAnnotationsRef.current = annotations
    publishRemappedAnnotations(annotations)
  }, [onDraftFileChange, publishRemappedAnnotations])

  const askAgentAboutSelection = useCallback((context: SelectionActionContext) => {
    if (comparisonPath == null || comparison == null) return
    const { startLine, endLine } = selectionLineRange(context.selection)
    const selectedText = context.getSelectionText()
    if (selectedText === '') {
      showToast('Select code before adding it to the agent')
      return
    }
    const side = comparison.newFile == null ? 'deletions' : 'additions'
    const file = side === 'deletions' ? comparison.oldFile : comparison.newFile
    onAttachToAgent({
      path: comparisonPath,
      startLine,
      endLine,
      side,
      selectedText,
      blobOid: file?.cacheKey ?? null
    })
  }, [comparison, comparisonPath, onAttachToAgent])

  const commentOnSelection = useCallback((context: SelectionActionContext) => {
    const { startLine, endLine } = selectionLineRange(context.selection)
    beginComment({ start: startLine, end: endLine, side: 'additions' })
  }, [beginComment])

  const renderSelectionAction = useCallback((context: SelectionActionContext) => (
    createSelectionActionElement([
      { label: 'Comment', run: commentOnSelection },
      { label: 'Add to chat', run: askAgentAboutSelection },
      { label: 'Copy', run: (selection) => void navigator.clipboard.writeText(selection.getSelectionText()) }
    ], context)
  ), [askAgentAboutSelection, commentOnSelection])

  const setEditorHandlers = viewer?.setEditorHandlers
  useEffect(() => {
    if (setEditorHandlers == null) return
    setEditorHandlers({
      onAttach: onEditorAttach,
      onChange: handleEditorChange,
      onBlur: onEditorBlur,
      renderSelectionAction
    })
    return () => setEditorHandlers(null)
  }, [handleEditorChange, onEditorAttach, onEditorBlur, renderSelectionAction, setEditorHandlers])

  // Markers re-anchor themselves as the document changes, so they only have to
  // be pushed when the provider's own input changes.
  const searchMarkers = useMemo<EditorMarker[]>(
    () => contentSearch == null || comparisonPath == null
      ? []
      : contentSearchMarkers(contentSearch.results, comparisonPath, contentSearch.query),
    [comparisonPath, contentSearch]
  )
  const appliedMarkersRef = useRef<EditorMarker[]>([])
  useEffect(() => {
    if (editMode !== 'edit') return
    if (markersEqual(appliedMarkersRef.current, searchMarkers)) return
    // The editor attaches a frame after the surface renders, and setMarkers
    // throws before it has.
    const frame = window.requestAnimationFrame(() => {
      const editor = getEditor()
      if (editor == null) return
      appliedMarkersRef.current = searchMarkers
      editor.setMarkers(searchMarkers)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editMode, getEditor, searchMarkers])

  const interactionOptions = useMemo(() => ({
    enableLineSelection: DIFF_OPTIONS.enableLineSelection,
    enableGutterUtility: DIFF_OPTIONS.enableGutterUtility,
    lineHoverHighlight: DIFF_OPTIONS.lineHoverHighlight,
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      if (range == null) {
        setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })
        return
      }
      beginComment(range)
    },
    onGutterUtilityClick: beginComment,
    onPostRender: (node: HTMLElement, _instance: unknown, phase: string) => {
      syncDragGuideLifecycle(node, phase, beginComment)
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      syncReviewCaretLifecycle(node, phase)
    }
  }), [beginComment, comparisonPath, setReviewCursor])

  const renderFileAnnotation = useCallback(
    (annotation: LineAnnotation<ReviewAnnotationMetadata>) => renderReviewAnnotation(annotation.metadata),
    [renderReviewAnnotation]
  )
  const renderDiffAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewAnnotationMetadata>) => renderReviewAnnotation(annotation.metadata),
    [renderReviewAnnotation]
  )

  const editorOptions = viewer?.editorOptions
  const editing = editMode === 'edit'

  // `theme` is deliberately absent: the worker pool resolves it and re-renders
  // every instance on a switch, so repeating it here only bought a second full
  // DOM rebuild through the wrapper's forceRender path. `themeType` stays —
  // it colours the chrome and is applied from cached CSS.
  const fileOptions = useMemo(() => ({
    themeType: getEditorThemeType(preferences.editorTheme),
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    stickyHeader: DIFF_OPTIONS.stickyHeader,
    tokenizeMaxLineLength: DIFF_OPTIONS.tokenizeMaxLineLength,
    disableFileHeader: true,
    disableLineNumbers: !preferences.showLineNumbers,
    unsafeCSS: INTERACTION_CSS,
    ...interactionOptions
  }), [interactionOptions, preferences.editorTheme, preferences.showLineNumbers, preferences.wordWrap])

  const diffOptions = useMemo(() => ({
    ...DIFF_OPTIONS,
    ...interactionOptions,
    themeType: getEditorThemeType(preferences.editorTheme),
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    disableLineNumbers: !preferences.showLineNumbers,
    diffStyle,
    hunkSeparators: 'line-info-basic' as const,
    // Folded context is unreachable text: while editing, every line has to be
    // there to be typed in. The fold preference comes back on exit.
    expandUnchanged: editing || !preferences.foldUnchanged,
    collapsedContextThreshold: 4,
    unsafeCSS: INTERACTION_CSS
  }), [diffStyle, editing, interactionOptions, preferences.editorTheme, preferences.foldUnchanged,
    preferences.showLineNumbers, preferences.wordWrap])

  if (loading) return <div className="diff-state"><IconRefresh className="spin" /><span>Loading comparison…</span></div>
  if (comparison == null) return <div className="diff-state"><IconCodeSearch /><span>Select a file in the explorer</span></div>
  if (hasImagePreview(comparison.image)) {
    return (
      <div className="diff-scroll image-diff-scroll">
        <ImageDiffPreview image={comparison.image} status={comparison.status} />
      </div>
    )
  }
  if (comparison.binary || comparison.oversized) {
    return (
      <div className="diff-state">
        {comparison.binary ? <IconFile /> : <IconWarningOctogonFill />}
        <strong>{comparison.binary ? 'Binary file' : 'Large file'}</strong>
        <span>{comparison.binary ? 'Text diff is not available.' : 'Files larger than 2 MB are not rendered yet.'}</span>
      </div>
    )
  }
  if (comparison.oldFile == null && comparison.newFile == null) {
    return <div className="diff-state"><IconFileCode /><span>No renderable file contents</span></div>
  }

  const surface = markdownSurface(comparison, editMode, documentView)
  const previewText = markdownPreviewSource(comparison)
  if (surface === 'preview' && previewText != null) {
    return <MarkdownFilePreview source={previewText} />
  }

  let codeView
  if (comparison.mode === 'file' && comparison.newFile != null) {
    codeView = (
      <Virtualizer className="diff-scroll editor-scroll" contentClassName="diff-content editor-content">
        <File<ReviewAnnotationMetadata>
          file={comparison.newFile}
          edit={editing}
          editorOptions={editorOptions}
          options={fileOptions}
          selectedLines={selectedLines}
          lineAnnotations={fileAnnotations}
          renderAnnotation={renderFileAnnotation}
          className="pierre-diff editor-file"
          style={codeStyle}
        />
        <VirtualizedBackToTop />
      </Virtualizer>
    )
  } else {
    const sharedDiffProps = {
      options: diffOptions,
      edit: editing,
      editorOptions,
      selectedLines,
      lineAnnotations: diffAnnotations,
      renderAnnotation: renderDiffAnnotation,
      className: 'pierre-diff',
      style: codeStyle
    }
    const diff = comparison.oldFile != null && comparison.newFile != null
      ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={comparison.newFile} {...sharedDiffProps} />
      : comparison.oldFile != null
        ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={null} {...sharedDiffProps} />
        : <MultiFileDiff<ReviewAnnotationMetadata> oldFile={null} newFile={comparison.newFile!} {...sharedDiffProps} />
    codeView = <Virtualizer className="diff-scroll" contentClassName="diff-content">{diff}<VirtualizedBackToTop /></Virtualizer>
  }

  if (surface === 'split' && previewText != null) {
    return (
      <div className="markdown-split">
        <div className="markdown-split-source">{codeView}</div>
        <MarkdownSplitResizer />
        <MarkdownFilePreview source={previewText} />
      </div>
    )
  }

  return codeView
}

const MemoizedDiffContents = memo(DiffContents)

const DiffSurface = memo(function DiffSurface({
  threadsByPath,
  ...props
}: DiffSurfaceProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('viewerCommitted'), [])
  const [staleComparison, setStaleComparison] = useState<FileComparison | null>(null)
  // Only a comparison that is actually on screen is worth remembering, and
  // gating on `loading` keeps a same-path update (a save, an external write)
  // from costing a second render pass.
  if (!props.loading && props.comparison != null && props.comparison !== staleComparison) {
    setStaleComparison(props.comparison)
  }
  // Keep the previous file rendered and dimmed while the next one loads, so
  // file-to-file navigation never flashes to a blank spinner. The host is always
  // rendered: returning two structurally different trees made React reconcile
  // them as different elements and tear the whole diff down every time a load
  // finished, which is also why the 120ms dim could never fade out.
  const dimming = props.loading && staleComparison != null
  const renderedComparison = dimming ? staleComparison : props.comparison
  // Resolved here rather than inside the memoized contents so a comment on
  // another file changes nothing this component hands down, and so the array
  // always belongs to the file that is actually on screen while dimming.
  const renderedPath = renderedComparison?.path
  const threads = (renderedPath == null ? undefined : threadsByPath[renderedPath]) ?? NO_THREADS
  return (
    <div className="diff-stale-host">
      {dimming ? <div className="diff-loading-bar" aria-hidden="true" /> : null}
      <div className="diff-stale" data-dim={dimming ? '' : undefined}>
        <MemoizedDiffContents
          {...props}
          threads={threads}
          comparison={renderedComparison}
          loading={dimming ? false : props.loading}
        />
      </div>
    </div>
  )
})

export default DiffSurface
