import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { FileTree as FileTreeModel, TreeThemeStyles } from '@pierre/trees'
import { themeToTreeStyles } from '@pierre/trees'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
import { IconChevronsClose, IconExpandAll, IconSearch, IconX } from '@pierre/icons'

import { getDirectoryPaths } from './treeExpansion'
import type { EditorThemeType } from './preferences'

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
  onRowActivate(path: string): void
}

export const Explorer = memo(function Explorer({ filePaths, model, themeType, onRowActivate }: ExplorerProps) {
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
        <strong>Explorer</strong>
        <div className="sidebar-heading-actions">
          <span className="sidebar-file-count">{visibleFileCount.toLocaleString()} files</span>
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
      <FileTree className="project-tree" model={model} style={treeStyle} onClick={activateClickedRow} />
    </aside>
  )
})
