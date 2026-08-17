import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { DiffLineAnnotation, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { File, MultiFileDiff, useVirtualizer, Virtualizer } from '@pierre/diffs/react'
import {
  IconCodeSearch,
  IconFile,
  IconFileCode,
  IconRefresh,
  IconWarningOctogonFill
} from '@pierre/icons'

import type { FileComparison } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import { DRAG_SELECTION_CSS, syncDragGuideLifecycle } from './dragSelection'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from './preferences'
import {
  DraftComment,
  ReviewThreadCard,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import { BackToTopButton, BACK_TO_TOP_THRESHOLD, preferredScrollBehavior } from './BackToTopButton'

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

  button[data-expand-button][data-expand-button] {
    border-radius: 24% !important;
    corner-shape: squircle !important;
    clip-path: polygon(18% 0, 82% 0, 91% 3%, 97% 9%, 100% 18%, 100% 82%, 97% 91%, 91% 97%, 82% 100%, 18% 100%, 9% 97%, 3% 91%, 0 82%, 0 18%, 3% 9%, 9% 3%) !important;
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

  ${DRAG_SELECTION_CSS}
`
interface DiffSurfaceProps {
  comparison: FileComparison | null
  loading: boolean
  diffStyle: DiffStyle
  preferences: AppPreferences
}

function VirtualizedBackToTop(): React.JSX.Element {
  const virtualizer = useVirtualizer()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const currentVirtualizer = virtualizer
    if (currentVirtualizer == null) return
    const root = currentVirtualizer.getRoot()
    if (!(root instanceof HTMLElement)) return
    const handleScroll = (): void => setVisible(currentVirtualizer.getScrollTop() > BACK_TO_TOP_THRESHOLD)
    root.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => root.removeEventListener('scroll', handleScroll)
  }, [virtualizer])

  return (
    <BackToTopButton
      visible={visible}
      onClick={() => virtualizer?.scrollTo({ top: 0, behavior: preferredScrollBehavior() })}
    />
  )
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
              themeType: getEditorThemeType(preferences.editorTheme),
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
          <VirtualizedBackToTop />
        </Virtualizer>
      </>
    )
  }

  const diffOptions = {
    ...DIFF_OPTIONS,
    ...interactionOptions,
    theme: preferences.editorTheme,
    themeType: getEditorThemeType(preferences.editorTheme),
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    disableLineNumbers: !preferences.showLineNumbers,
    diffStyle,
    hunkSeparators: 'line-info-basic' as const,
    expandUnchanged: !preferences.foldUnchanged,
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

  return <Virtualizer className="diff-scroll" contentClassName="diff-content">{diff}<VirtualizedBackToTop /></Virtualizer>
}

const MemoizedDiffContents = memo(DiffContents)

const DiffSurface = memo(function DiffSurface(props: DiffSurfaceProps): React.JSX.Element {
  return <MemoizedDiffContents {...props} />
})

export default DiffSurface
