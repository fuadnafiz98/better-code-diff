import { memo, useCallback, useMemo } from 'react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { themeToTreeStyles } from '@pierre/trees'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
import { IconSearch, IconX } from '@pierre/icons'

import { getDirectoryPaths } from './treeExpansion'

const TREE_STYLE = {
  ...themeToTreeStyles(pierreDarkTheme),
  height: '100%',
  colorScheme: 'dark',
  fontFamily: '"Fira Code Variable", "Fira Code", monospace'
} as React.CSSProperties

interface ExplorerProps {
  filePaths: readonly string[]
  model: FileTreeModel
}

function ExpandAllIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 3 4 4 4-4M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CollapseAllIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 7 4-4 4 4M4 13l4-4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const Explorer = memo(function Explorer({ filePaths, model }: ExplorerProps) {
  const search = useFileTreeSearch(model)
  const directoryPaths = useMemo(() => getDirectoryPaths(filePaths), [filePaths])
  const visibleFileCount = search.value.length > 0 ? search.matchingPaths.length : filePaths.length

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

  return (
    <aside className="sidebar" id="repository-explorer">
      <div className="sidebar-heading">
        <span>Explorer</span>
        <div className="sidebar-heading-actions">
          <span>{visibleFileCount.toLocaleString()} files</span>
          <button type="button" aria-label="Expand all folders" title="Expand all folders" onClick={expandAll}>
            <ExpandAllIcon />
          </button>
          <button type="button" aria-label="Collapse all folders" title="Collapse all folders" onClick={collapseAll}>
            <CollapseAllIcon />
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
      <FileTree className="project-tree" model={model} style={TREE_STYLE} />
    </aside>
  )
})
