import {
  memo,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { parseDiffFromFile, type CodeViewItem } from '@pierre/diffs'
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconCodeSearch, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { FileComparison } from '../../shared/contracts'
import type { DiffStyle } from './AppView'
import {
  DIFF_HIGHLIGHTER_LANGUAGES,
  DIFF_HIGHLIGHTER_LIMITS,
  DIFF_WORKER_COUNT,
  DIFF_WORKER_POOL_OPTIONS
} from './diffWorkerConfig'
import { CODE_FONTS, INTERFACE_FONTS, type AppPreferences } from './preferences'

const CODE_VIEW_CSS = `
  *, *::before, *::after { corner-shape: squircle; }
  button { touch-action: manipulation; transition: transform 100ms cubic-bezier(0.23, 1, 0.32, 1); }
  button:active:not(:disabled) { transform: scale(0.97); }
  [data-expand-button], [data-utility-button] { border-radius: 7px; corner-shape: squircle; }
  [data-expand-button]:hover { background: rgba(120, 169, 255, 0.14); color: #a9c9ff; }
  [data-separator="line-info-basic"] { border-block: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.035); }
`

interface MultiFileReviewProps {
  paths: readonly string[]
  selectedPath: string | null
  diffStyle: DiffStyle
  preferences: AppPreferences
}

interface ReviewLoadState {
  items: CodeViewItem[]
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

function createReviewItem(comparison: FileComparison): CodeViewItem | null {
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

const MultiFileReview = memo(function MultiFileReview({
  paths,
  selectedPath,
  diffStyle,
  preferences
}: MultiFileReviewProps): React.JSX.Element {
  const viewerRef = useRef<CodeViewHandle<undefined> | null>(null)
  const [loadState, setLoadState] = useState<ReviewLoadState>(EMPTY_LOAD_STATE)
  const loading = loadState.loadedPaths.size < paths.length

  useEffect(() => {
    let cancelled = false
    setLoadState(EMPTY_LOAD_STATE)

    async function loadComparisons(): Promise<void> {
      const repository = window.repository
      if (repository == null) {
        setLoadState({
          items: [],
          loadedPaths: new Set(paths),
          failedCount: paths.length,
          skippedCount: 0
        })
        return
      }

      for (let start = 0; start < paths.length && !cancelled; start += DIFF_WORKER_COUNT) {
        const batchPaths = paths.slice(start, start + DIFF_WORKER_COUNT)
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
  }, [paths])

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

  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `${preferences.codeFontSize}px`,
    '--diffs-line-height': `${preferences.codeLineHeight}px`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  const codeViewOptions = useMemo<CodeViewReactOptions>(() => ({
    theme: preferences.editorTheme,
    themeType: 'dark',
    diffStyle,
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    overflow: preferences.wordWrap ? 'wrap' : 'scroll',
    disableLineNumbers: !preferences.showLineNumbers,
    tokenizeMaxLineLength: 2_000,
    enableLineSelection: true,
    enableGutterUtility: false,
    lineHoverHighlight: 'number',
    hunkSeparators: 'line-info-basic',
    expandUnchanged: false,
    collapsedContextThreshold: 4,
    stickyHeaders: true,
    layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: preferences.codeLineHeight },
    unsafeCSS: CODE_VIEW_CSS
  }), [diffStyle, preferences])

  const highlighterOptions = useMemo(() => ({
    langs: DIFF_HIGHLIGHTER_LANGUAGES,
    theme: preferences.editorTheme,
    ...DIFF_HIGHLIGHTER_LIMITS
  }), [preferences.editorTheme])

  if (paths.length === 0) {
    return <div className="diff-state"><IconCodeSearch /><strong>No files to review</strong><span>The working tree has no visible changes.</span></div>
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
        <CodeView
          ref={viewerRef}
          items={loadState.items}
          options={codeViewOptions}
          className="multi-file-code-view"
          style={codeStyle}
        />
      </WorkerPoolContextProvider>
    </div>
  )
})

export default MultiFileReview
