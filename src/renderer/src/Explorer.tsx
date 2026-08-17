import { memo, useCallback, useMemo } from 'react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { themeToTreeStyles } from '@pierre/trees'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
import pierreLightTheme from '@pierre/theme/pierre-light'
import { IconChevronsClose, IconExpandAll, IconSearch, IconX } from '@pierre/icons'

import { getDirectoryPaths } from './treeExpansion'
import type { EditorThemeType } from './preferences'

interface ExplorerProps {
  filePaths: readonly string[]
  model: FileTreeModel
  themeType: EditorThemeType
}

export const Explorer = memo(function Explorer({ filePaths, model, themeType }: ExplorerProps) {
  const search = useFileTreeSearch(model)
  const directoryPaths = useMemo(() => getDirectoryPaths(filePaths), [filePaths])
  const visibleFileCount = search.value.length > 0 ? search.matchingPaths.length : filePaths.length
  const treeStyle = useMemo(() => ({
    ...themeToTreeStyles(themeType === 'light' ? pierreLightTheme : pierreDarkTheme),
    height: '100%',
    colorScheme: themeType,
    fontFamily: '"Fira Code Variable", "Fira Code", monospace'
  }) as React.CSSProperties, [themeType])

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
      <FileTree className="project-tree" model={model} style={treeStyle} />
    </aside>
  )
})
