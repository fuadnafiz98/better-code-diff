import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { FileTree as FileTreeModel, TreeThemeStyles } from '@pierre/trees'
import { themeToTreeStyles } from '@pierre/trees'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
import {
  IconBranch,
  IconChevronsClose,
  IconExpandAll,
  IconSearch,
  IconSidebarLeft,
  IconSidebarLeftOpen,
  IconX
} from '@pierre/icons'

import { getDirectoryPaths } from './treeExpansion'
import type { EditorThemeType } from './preferences'
import {
  EMPTY_REVIEW_FILE_FILTER,
  reviewFileFilterIsActive,
  type ReviewFileFilter
} from './reviewFileFilter'

// Only one palette is ever rendered, so the other one stays out of the workspace
// chunk: the light theme is fetched the first time it is selected and kept for the
// rest of the session. The first frame after that switch paints dark.
const DARK_TREE_STYLES = themeToTreeStyles(pierreDarkTheme)
let lightTreeStyles: Promise<TreeThemeStyles> | null = null

function loadLightTreeStyles(): Promise<TreeThemeStyles> {
  lightTreeStyles ??= import('@pierre/theme/pierre-light')
    .then((module) => themeToTreeStyles(module.default))
  return lightTreeStyles
}

function useTreeThemeStyles(themeType: EditorThemeType): TreeThemeStyles {
  const [lightStyles, setLightStyles] = useState<TreeThemeStyles | null>(null)
  useEffect(() => {
    if (themeType !== 'light') return
    let cancelled = false
    void loadLightTreeStyles().then((styles) => {
      if (!cancelled) setLightStyles(styles)
    })
    return () => { cancelled = true }
  }, [themeType])
  return themeType === 'light' ? lightStyles ?? DARK_TREE_STYLES : DARK_TREE_STYLES
}

interface ExplorerProps {
  filePaths: readonly string[]
  model: FileTreeModel
  themeType: EditorThemeType
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
  isGit: boolean
  branchName: string | null
  onBranchesOpen(): void
  onRowActivate(path: string): void
  fileFilter?: ReviewFileFilter
  onFileFilterChange?(filter: ReviewFileFilter): void
  unfilteredFileCount?: number
}

export const Explorer = memo(function Explorer({
  filePaths,
  model,
  themeType,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut,
  isGit,
  branchName,
  onBranchesOpen,
  onRowActivate,
  fileFilter = EMPTY_REVIEW_FILE_FILTER,
  onFileFilterChange,
  unfilteredFileCount
}: ExplorerProps) {
  const search = useFileTreeSearch(model)
  const directoryPaths = useMemo(() => getDirectoryPaths(filePaths), [filePaths])
  const visibleFileCount = search.value.length > 0 ? search.matchingPaths.length : filePaths.length
  const themeStyles = useTreeThemeStyles(themeType)
  const treeStyle = useMemo(() => ({
    ...themeStyles,
    height: '100%',
    colorScheme: themeType,
    // TREE_STYLES only reaches [data-type="item"], so the library's sticky row
    // and context-menu trigger keep their 6px unless the variable is overridden.
    '--trees-border-radius-override': 'var(--corner-compact)'
  }) as React.CSSProperties, [themeStyles, themeType])

  const expandAll = useCallback(() => {
    for (const directoryPath of directoryPaths) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
  }, [directoryPaths, model])

  const collapseAll = useCallback(() => {
    for (const directoryPath of [...directoryPaths].reverse()) {
      const item = model.getItem(directoryPath)
      if (item != null && 'collapse' in item) item.collapse()
    }
  }, [directoryPaths, model])

  // The tree reports selection *changes*, so clicking the row that is already
  // selected reports nothing. Rows are read straight off the click instead, which
  // makes every click a navigation request.
  const activateClickedRow = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const row = event.nativeEvent.composedPath().find(
      (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-item-path')
    )
    const path = row?.getAttribute('data-item-path')
    if (path == null || row?.getAttribute('data-item-type') !== 'file') return
    onRowActivate(path)
  }, [onRowActivate])

  return (
    <aside className="sidebar" id="repository-explorer">
      <div className="sidebar-heading">
        <div className="sidebar-heading-identity">
          <button
            type="button"
            aria-label={sidebarVisible ? 'Hide explorer' : 'Show explorer'}
            title={`${sidebarVisible ? 'Hide' : 'Show'} Explorer (${sidebarShortcut})`}
            onClick={onSidebarToggle}
          >
            <span className="icon-swap sidebar-icon-swap" data-state={sidebarVisible ? 'base' : 'alt'}>
              <IconSidebarLeft /><IconSidebarLeftOpen />
            </span>
          </button>
          {isGit ? (
            <button
              className="chrome-branch-button"
              type="button"
              onClick={onBranchesOpen}
              aria-label={`Switch branch. Current branch: ${branchName ?? 'detached HEAD'}`}
              title="Switch branch"
            >
              <IconBranch />
              <span>{branchName ?? 'Detached HEAD'}</span>
            </button>
          ) : null}
        </div>
        <div className="sidebar-heading-actions">
          <span className="sidebar-file-count">
            {unfilteredFileCount != null && unfilteredFileCount !== visibleFileCount
              ? `${visibleFileCount.toLocaleString()} of ${unfilteredFileCount.toLocaleString()}`
              : `${visibleFileCount.toLocaleString()} files`}
          </span>
          <button type="button" aria-label="Expand all folders" title="Expand all folders" onClick={expandAll}>
            <IconExpandAll />
          </button>
          <button type="button" aria-label="Collapse all folders" title="Collapse all folders" onClick={collapseAll}>
            <IconChevronsClose />
          </button>
          <button
            type="button"
            aria-label={search.isOpen ? 'Close file search' : 'Search files in explorer'}
            aria-pressed={search.isOpen}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => search.isOpen ? search.close() : search.open()}
          >
            {search.isOpen ? <IconX /> : <IconSearch />}
          </button>
        </div>
      </div>
      {onFileFilterChange == null ? null : (
        <div className="sidebar-file-filter">
          <input
            type="search"
            value={fileFilter.query}
            placeholder="Filter files, e.g. /api/* or *.test.ts"
            aria-label="Filter files"
            onChange={(event) => onFileFilterChange({ ...fileFilter, query: event.target.value })}
          />
          <div className="sidebar-file-filter-chips" role="group" aria-label="Hide file groups">
            <button
              type="button"
              aria-pressed={fileFilter.hideTests}
              onClick={() => onFileFilterChange({ ...fileFilter, hideTests: !fileFilter.hideTests })}
            >
              Hide tests
            </button>
            <button
              type="button"
              aria-pressed={fileFilter.hideApi}
              onClick={() => onFileFilterChange({ ...fileFilter, hideApi: !fileFilter.hideApi })}
            >
              Hide API
            </button>
            <button
              type="button"
              aria-pressed={fileFilter.query.trim() === '/api/*'}
              onClick={() => onFileFilterChange({
                ...fileFilter,
                query: fileFilter.query.trim() === '/api/*' ? '' : '/api/*'
              })}
            >
              /api/*
            </button>
            {reviewFileFilterIsActive(fileFilter) ? (
              <button
                type="button"
                className="sidebar-file-filter-clear"
                onClick={() => onFileFilterChange(EMPTY_REVIEW_FILE_FILTER)}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      )}
      <FileTree className="project-tree" model={model} style={treeStyle} onClick={activateClickedRow} />
    </aside>
  )
})
