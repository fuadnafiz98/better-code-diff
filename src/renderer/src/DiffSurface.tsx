import { memo, useCallback, useMemo, useState, type CSSProperties } from 'react'
import type { DiffLineAnnotation, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { File, MultiFileDiff, Virtualizer, WorkerPoolContextProvider } from '@pierre/diffs/react'
import {
  IconCodeSearch,
  IconFile,
  IconFileCode,
  IconRefresh,
  IconWarningOctogonFill
} from '@pierre/icons'

import type { FileComparison } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import {
  DIFF_HIGHLIGHTER_LANGUAGES,
  DIFF_HIGHLIGHTER_LIMITS,
  DIFF_WORKER_POOL_OPTIONS
} from './diffWorkerConfig'
import { CODE_FONTS, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'

const DIFF_OPTIONS = {
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  stickyHeader: true,
  tokenizeMaxLineLength: 2_000,
  enableLineSelection: true,
  enableGutterUtility: true,
  lineHoverHighlight: 'number' as const
}
const INTERACTION_CSS = `
  *,
  *::before,
  *::after {
    corner-shape: squircle;
  }

  button {
    touch-action: manipulation;
    transition: transform 100ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  button:active:not(:disabled) {
    transform: scale(0.97);
  }

  [data-separator="line-info-basic"] {
    border-block: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  [data-separator-wrapper] {
    min-height: 30px;
  }

  [data-expand-button] {
    border-radius: 7px;
    corner-shape: squircle;
    cursor: pointer;
    color: rgba(231, 232, 235, 0.72);
  }

  [data-expand-button]:hover {
    background: rgba(120, 169, 255, 0.14);
    color: #a9c9ff;
  }

  [data-unmodified-lines] {
    color: rgba(179, 182, 189, 0.78);
    font-family: var(--diffs-header-font-family);
    font-size: 11px;
  }

  [data-selected-line] {
    background: rgba(64, 139, 230, 0.16) !important;
  }

  [data-drag-range] {
    background: rgba(64, 139, 230, 0.16) !important;
  }

  [data-gutter] [data-drag-range] {
    position: relative;
  }

  [data-gutter] [data-drag-range]::after {
    content: "";
    position: absolute;
    z-index: 2;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 2px;
    border-radius: 2px;
    background: #58a6ff;
    pointer-events: none;
  }

  [data-gutter] [data-drag-range="first"]::after {
    top: 50%;
  }

  [data-gutter] [data-drag-range="last"]::after {
    bottom: 50%;
  }

  [data-gutter] [data-drag-range="single"]::after {
    display: none;
  }

  [data-utility-button] {
    position: relative;
    border-radius: 7px;
    corner-shape: squircle;
    background: #58a6ff;
    color: #07111f;
  }

`
const dragGuideTeardowns = new WeakMap<HTMLElement, () => void>()

interface DragLine {
  index: number
  lineNumber: number
}

interface DragGuideState {
  side: HTMLElement
  sideName: 'additions' | 'deletions'
  start: DragLine
  current: DragLine
  moved: boolean
}

function findClosestGutterLine(side: HTMLElement, pointerY: number): DragLine | null {
  const lines = [...side.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')]
  let closest: { distance: number; line: DragLine } | null = null

  for (const element of lines) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    const lineNumber = Number(element.dataset.columnNumber)
    if (!Number.isFinite(index) || !Number.isFinite(lineNumber)) continue

    const bounds = element.getBoundingClientRect()
    const distance = Math.abs(pointerY - (bounds.top + bounds.height / 2))
    if (closest == null || distance < closest.distance) {
      closest = { distance, line: { index, lineNumber } }
    }
  }

  return closest?.line ?? null
}

function renderDragGuide(side: HTMLElement, startIndex: number, endIndex: number): void {
  const firstIndex = Math.min(startIndex, endIndex)
  const lastIndex = Math.max(startIndex, endIndex)

  for (const element of side.querySelectorAll<HTMLElement>('[data-line-index]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    if (index < firstIndex || index > lastIndex) {
      element.removeAttribute('data-drag-range')
      continue
    }

    const boundary = firstIndex === lastIndex
      ? 'single'
      : index === firstIndex
        ? 'first'
        : index === lastIndex
          ? 'last'
          : ''
    element.setAttribute('data-drag-range', boundary)
  }
}

function clearDragGuide(root: ShadowRoot): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-drag-range]')) {
    element.removeAttribute('data-drag-range')
  }
}

function syncDragGuideLifecycle(
  node: HTMLElement,
  phase: string,
  onRangeSelected: (range: SelectedLineRange) => void
): void {
  if (phase === 'unmount') {
    dragGuideTeardowns.get(node)?.()
    dragGuideTeardowns.delete(node)
    return
  }
  if (dragGuideTeardowns.has(node) || node.shadowRoot == null) return

  const root = node.shadowRoot
  let drag: DragGuideState | null = null
  let suppressClick = false

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const path = pointerEvent.composedPath()
    const utilityButton = path.find(
      (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-utility-button')
    )
    if (utilityButton == null) return

    const side = utilityButton.closest<HTMLElement>('[data-additions], [data-deletions]')
    if (side == null) return
    const start = findClosestGutterLine(side, pointerEvent.clientY)
    if (start == null) return

    drag = {
      side,
      sideName: side.hasAttribute('data-deletions') ? 'deletions' : 'additions',
      start,
      current: start,
      moved: false
    }
    renderDragGuide(side, start.index, start.index)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || (pointerEvent.buttons & 1) === 0) return
    const current = findClosestGutterLine(drag.side, pointerEvent.clientY)
    if (current == null) return

    drag.current = current
    drag.moved ||= current.index !== drag.start.index
    renderDragGuide(drag.side, drag.start.index, current.index)
  }

  const onPointerUp = (event: Event): void => {
    if (drag == null) return
    const completedDrag = drag
    drag = null

    if (completedDrag.moved) {
      suppressClick = true
      event.preventDefault()
      event.stopImmediatePropagation()
      onRangeSelected({
        start: Math.min(completedDrag.start.lineNumber, completedDrag.current.lineNumber),
        end: Math.max(completedDrag.start.lineNumber, completedDrag.current.lineNumber),
        side: completedDrag.sideName
      })
      window.setTimeout(() => { suppressClick = false }, 0)
    }

    window.requestAnimationFrame(() => clearDragGuide(root))
  }

  const onClick = (event: Event): void => {
    if (!suppressClick) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', onPointerUp, true)
  root.addEventListener('pointercancel', onPointerUp, true)
  root.addEventListener('click', onClick, true)

  dragGuideTeardowns.set(node, () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', onPointerUp, true)
    root.removeEventListener('pointercancel', onPointerUp, true)
    root.removeEventListener('click', onClick, true)
    clearDragGuide(root)
  })
}
const HIGHLIGHTER_OPTIONS = {
  langs: DIFF_HIGHLIGHTER_LANGUAGES,
  ...DIFF_HIGHLIGHTER_LIMITS
}

interface DiffSurfaceProps {
  comparison: FileComparison | null
  loading: boolean
  diffStyle: DiffStyle
  preferences: AppPreferences
}

function DiffContents({ comparison, loading, diffStyle, preferences }: DiffSurfaceProps): React.JSX.Element {
  const [reviewCursor, setReviewCursor] = useState<{
    path: string | undefined
    selectedLines: SelectedLineRange | null
    draftRange: SelectedLineRange | null
  }>({ path: undefined, selectedLines: null, draftRange: null })
  const [threadsByPath, setThreadsByPath] = useState<Record<string, ReviewThread[]>>({})

  const comparisonPath = comparison?.path
  const selectedLines = reviewCursor.path === comparisonPath ? reviewCursor.selectedLines : null
  const draftRange = reviewCursor.path === comparisonPath ? reviewCursor.draftRange : null
  const threads = useMemo(
    () => comparisonPath == null ? [] : threadsByPath[comparisonPath] ?? [],
    [comparisonPath, threadsByPath]
  )
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `${preferences.codeFontSize}px`,
    '--diffs-line-height': `${preferences.codeLineHeight}px`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  const beginComment = useCallback((range: SelectedLineRange) => {
    setReviewCursor({ path: comparisonPath, selectedLines: range, draftRange: range })
  }, [comparisonPath])

  const saveComment = useCallback((body: string) => {
    if (comparisonPath == null || draftRange == null) return
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: draftRange.start,
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
  }, [comparisonPath, draftRange])

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
  }, [comparisonPath])

  const renderReviewAnnotation = useCallback((metadata: ReviewAnnotationMetadata): React.JSX.Element => {
    if (metadata.kind === 'draft') {
      return (
        <DraftComment
          range={metadata.range}
          onCancel={() => setReviewCursor({ path: comparisonPath, selectedLines, draftRange: null })}
          onSave={saveComment}
        />
      )
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
  }, [comparisonPath, saveComment, selectedLines, updateThread])

  const reviewMetadata = useMemo<ReviewAnnotationMetadata[]>(() => [
    ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
    ...(draftRange == null ? [] : [{ kind: 'draft' as const, range: draftRange }])
  ], [draftRange, threads])

  const fileAnnotations = useMemo<LineAnnotation<ReviewAnnotationMetadata>[]>(() =>
    reviewMetadata.flatMap((metadata): LineAnnotation<ReviewAnnotationMetadata>[] =>
      metadata.kind === 'draft'
        ? [{ lineNumber: metadata.range.start, metadata }]
        : [{ lineNumber: metadata.thread.lineNumber, metadata }]
    ), [reviewMetadata])

  const diffAnnotations = useMemo<DiffLineAnnotation<ReviewAnnotationMetadata>[]>(() =>
    reviewMetadata.flatMap((metadata): DiffLineAnnotation<ReviewAnnotationMetadata>[] =>
      metadata.kind === 'draft'
        ? [{ lineNumber: metadata.range.start, side: metadata.range.side ?? 'additions', metadata }]
        : [{ lineNumber: metadata.thread.lineNumber, side: metadata.thread.side ?? 'additions', metadata }]
    ), [reviewMetadata])

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
    }
  }), [beginComment, comparisonPath])

  if (loading) return <div className="diff-state"><IconRefresh className="spin" /><span>Loading comparison…</span></div>
  if (comparison == null) return <div className="diff-state"><IconCodeSearch /><span>Select a file in the explorer</span></div>
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

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return (
      <>
        <Virtualizer className="diff-scroll editor-scroll" contentClassName="diff-content editor-content">
          <File<ReviewAnnotationMetadata>
            file={comparison.newFile}
            options={{
              theme: preferences.editorTheme,
              themeType: DIFF_OPTIONS.themeType,
              overflow: preferences.wordWrap ? 'wrap' : 'scroll',
              stickyHeader: DIFF_OPTIONS.stickyHeader,
              tokenizeMaxLineLength: DIFF_OPTIONS.tokenizeMaxLineLength,
              disableFileHeader: true,
              disableLineNumbers: !preferences.showLineNumbers,
              unsafeCSS: INTERACTION_CSS,
              ...interactionOptions
            }}
            selectedLines={selectedLines}
            lineAnnotations={fileAnnotations}
            renderAnnotation={(annotation) => renderReviewAnnotation(annotation.metadata)}
            className="pierre-diff editor-file"
            style={codeStyle}
          />
        </Virtualizer>
      </>
    )
  }

  const diffOptions = {
    ...DIFF_OPTIONS,
    ...interactionOptions,
    theme: preferences.editorTheme,
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    disableLineNumbers: !preferences.showLineNumbers,
    diffStyle,
    hunkSeparators: 'line-info-basic' as const,
    expandUnchanged: false,
    collapsedContextThreshold: 4,
    unsafeCSS: INTERACTION_CSS
  }
  const sharedDiffProps = {
    options: diffOptions,
    selectedLines,
    lineAnnotations: diffAnnotations,
    renderAnnotation: (annotation: DiffLineAnnotation<ReviewAnnotationMetadata>) => renderReviewAnnotation(annotation.metadata),
    className: 'pierre-diff',
    style: codeStyle
  }
  const diff = comparison.oldFile != null && comparison.newFile != null
    ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={comparison.newFile} {...sharedDiffProps} />
    : comparison.oldFile != null
      ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={null} {...sharedDiffProps} />
      : <MultiFileDiff<ReviewAnnotationMetadata> oldFile={null} newFile={comparison.newFile!} {...sharedDiffProps} />

  return <Virtualizer className="diff-scroll" contentClassName="diff-content">{diff}</Virtualizer>
}

const MemoizedDiffContents = memo(DiffContents)

const DiffSurface = memo(function DiffSurface(props: DiffSurfaceProps): React.JSX.Element {
  const highlighterOptions = useMemo(() => ({
    ...HIGHLIGHTER_OPTIONS,
    theme: props.preferences.editorTheme
  }), [props.preferences.editorTheme])

  return (
    <WorkerPoolContextProvider
      poolOptions={DIFF_WORKER_POOL_OPTIONS}
      highlighterOptions={highlighterOptions}
    >
      <MemoizedDiffContents {...props} />
    </WorkerPoolContextProvider>
  )
})

export default DiffSurface
