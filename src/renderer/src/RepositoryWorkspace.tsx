import { lazy, memo, Suspense, useCallback, useLayoutEffect, useMemo } from 'react'
import { useFileTree } from '@pierre/trees/react'

import type { FileComparison, RepositorySnapshot } from '../../shared/contracts'
import { DiffToolbar, type DiffStyle, type WorkspaceView } from './AppView'
import { Explorer } from './Explorer'
import type { AppPreferences } from './preferences'
import { SidebarResizer } from './SidebarResizer'
import { getDirectoryPaths } from './treeExpansion'

const DiffSurface = lazy(() => import('./DiffSurface'))
const MultiFileReview = lazy(() => import('./MultiFileReview'))

const TREE_STYLES = `
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

  [data-type="item"]:active {
    background: rgba(120, 169, 255, 0.1);
  }

  [data-type="item"] {
    border-radius: 7px;
  }

  [data-file-tree-search-input] {
    border-radius: 9px;
  }
`

interface RepositoryWorkspaceProps {
  snapshot: RepositorySnapshot
  selectedPath: string | null
  comparison: FileComparison | null
  loadingDiff: boolean
  sidebarVisible: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  onSelectPath(path: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
}

const RepositoryWorkspace = memo(function RepositoryWorkspace({
  snapshot,
  selectedPath,
  comparison,
  loadingDiff,
  sidebarVisible,
  diffStyle,
  workspaceView,
  preferences,
  onSelectPath,
  onDiffStyleChange,
  onWorkspaceViewChange
}: RepositoryWorkspaceProps): React.JSX.Element {
  const isFilePreview = workspaceView === 'file' && comparison?.mode === 'file'
  const reviewPaths = useMemo(
    () => snapshot.kind === 'git' ? snapshot.statuses.map((status) => status.path) : snapshot.paths,
    [snapshot.kind, snapshot.paths, snapshot.statuses]
  )
  const pathSegments = selectedPath?.split('/') ?? []
  const fileExtension = selectedPath?.split('.').at(-1)?.toUpperCase()
  const pathSet = useMemo(() => new Set(snapshot.paths), [snapshot.paths])
  const directoryPaths = useMemo(() => getDirectoryPaths(snapshot.paths), [snapshot.paths])
  const changedDirectoryPaths = useMemo(
    () => getDirectoryPaths(snapshot.statuses.map((status) => status.path)),
    [snapshot.statuses]
  )
  const handleTreeSelection = useCallback((paths: readonly string[]) => {
    const path = paths.at(-1)
    if (path != null && pathSet.has(path)) onSelectPath(path)
  }, [onSelectPath, pathSet])

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
    onSelectionChange: handleTreeSelection
  })

  useLayoutEffect(() => {
    model.resetPaths(snapshot.paths)
    model.setGitStatus(snapshot.statuses)
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
  }, [changedDirectoryPaths, directoryPaths, model, snapshot.kind, snapshot.paths, snapshot.statuses])

  useLayoutEffect(() => {
    if (selectedPath == null) return
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' })
  }, [model, selectedPath, snapshot.paths])

  return (
    <div className={`workspace ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
      {sidebarVisible ? <Explorer filePaths={snapshot.paths} model={model} /> : null}
      {sidebarVisible ? <SidebarResizer /> : null}
      <section className={`diff-panel ${isFilePreview ? 'file-preview-mode' : 'diff-mode'}`} id="repository-diff">
        <DiffToolbar
          comparison={comparison}
          selectedPath={selectedPath}
          isGitRepository={snapshot.kind === 'git'}
          isFilePreview={isFilePreview}
          diffStyle={diffStyle}
          workspaceView={workspaceView}
          reviewFileCount={reviewPaths.length}
          onDiffStyleChange={onDiffStyleChange}
          onWorkspaceViewChange={onWorkspaceViewChange}
        />
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
        <Suspense fallback={<div className="diff-state"><span>Preparing viewer…</span></div>}>
          {workspaceView === 'multi' ? (
            <MultiFileReview
              paths={reviewPaths}
              selectedPath={selectedPath}
              diffStyle={diffStyle}
              preferences={preferences}
            />
          ) : (
            <DiffSurface comparison={comparison} loading={loadingDiff} diffStyle={diffStyle} preferences={preferences} />
          )}
        </Suspense>
        {isFilePreview ? (
          <footer className="editor-statusbar">
            <span>Read only</span>
            <span>UTF-8</span>
            <span>LF</span>
            {fileExtension != null ? <span>{fileExtension}</span> : null}
          </footer>
        ) : null}
      </section>
    </div>
  )
})

export default RepositoryWorkspace
