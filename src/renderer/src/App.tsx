import {
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react'

import type {
  ContentSearchResult,
  FileComparison,
  RepositoryChangeEvent,
  RepositorySnapshot
} from '../../shared/contracts'
import {
  ErrorBanner,
  SearchResults,
  Titlebar,
  Welcome,
  type DiffStyle,
  type SearchMode,
  type WorkspaceView
} from './AppView'
import { createFileSearchIndex, rankFilePaths } from './fileSearch'
import {
  CommandPaletteController,
  type CommandPaletteHandle
} from './CommandPalette'
import { commandFromEvent } from './keybindings'
import {
  CODE_FONTS,
  getEditorThemeType,
  INTERFACE_FONTS,
  loadPreferences,
  savePreferences,
  type AppPreferences
} from './preferences'
import { SettingsPage } from './SettingsPage'
import { PullRequestLoadingIndicator } from './PullRequestLoadingIndicator'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import {
  loadRecentFolders,
  rememberRecentFolder,
  saveRecentFolders,
  type RecentFolder
} from './recentFolders'
import { useGitWorkflow } from './useGitWorkflow'

const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace'))
const RepositoryPanel = lazy(async () => ({
  default: (await import('./GitHubPanel')).RepositoryPanel
}))

function useWindowVisibilitySync(): void {
  useEffect(() => {
    let frame = 0
    const refreshLayout = (): void => {
      void window.repository?.setVisibility(!document.hidden)
      if (document.hidden) return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
      })
    }
    document.addEventListener('visibilitychange', refreshLayout)
    window.addEventListener('focus', refreshLayout)
    void window.repository?.setVisibility(!document.hidden)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', refreshLayout)
      window.removeEventListener('focus', refreshLayout)
      void window.repository?.setVisibility(false)
    }
  }, [])
}

interface AppLayoutProps {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  comparison: FileComparison | null
  repositoryChange: RepositoryChangeEvent | null
  opening: boolean
  openingRecentPath: string | null
  refreshing: boolean
  loadingDiff: boolean
  error: string | null
  sidebarVisible: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  settingsOpen: boolean
  recentFolders: RecentFolder[]
  searchMode: SearchMode
  searchQuery: string
  deferredSearchQuery: string
  fileResults: string[]
  contentResults: ContentSearchResult[]
  searchingContent: boolean
  searchIsOpen: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  commandPaletteRef: React.RefObject<CommandPaletteHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  setSearchMode: React.Dispatch<React.SetStateAction<SearchMode>>
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  setRecentFolders: React.Dispatch<React.SetStateAction<RecentFolder[]>>
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  setDiffStyle: React.Dispatch<React.SetStateAction<DiffStyle>>
  setWorkspaceView: React.Dispatch<React.SetStateAction<WorkspaceView>>
  toggleSidebar(withMotion: boolean): void
  openFolder(): Promise<void>
  openRecentFolder(folder: RecentFolder): Promise<void>
  refreshRepository(): Promise<void>
  selectSearchResult(path: string): void
  openPullRequestFromPalette(selector: number | string): void
  openSettingsFromPalette(): void
}

const AppLayout = memo(function AppLayout(view: AppLayoutProps): React.JSX.Element {
  const { gitWorkflow } = view
  return <main className="app-shell" data-theme-type={getEditorThemeType(view.preferences.editorTheme)}>
    <Titlebar snapshot={view.snapshot} sidebarVisible={view.sidebarVisible} searchMode={view.searchMode}
      searchQuery={view.searchQuery} searchInputRef={view.searchInputRef} searchingContent={view.searchingContent}
      opening={view.opening} refreshing={view.refreshing} keybindings={view.preferences.keybindings}
      onSidebarToggle={() => view.toggleSidebar(true)} onSearchModeChange={view.setSearchMode}
      onSearchQueryChange={view.setSearchQuery} onOpen={view.openFolder} onRefresh={view.refreshRepository}
      onSettingsOpen={() => view.setSettingsOpen(true)} onGitOpen={gitWorkflow.openPanel} />

    {gitWorkflow.actionKey?.startsWith('review:') ? <PullRequestLoadingIndicator /> : null}
    {gitWorkflow.panelOpen && view.snapshot?.kind === 'git' ? <Suspense fallback={null}>
      <RepositoryPanel integration={gitWorkflow.integration} loading={gitWorkflow.loadingIntegration}
        actionKey={gitWorkflow.actionKey} onClose={() => gitWorkflow.setPanelOpen(false)}
        onReload={() => void gitWorkflow.loadIntegration()} onSwitchBranch={(name) => void gitWorkflow.switchBranch(name)}
        onReviewLocalBranch={(base, head) => void gitWorkflow.reviewLocalBranch(base, head)}
        onReviewCommit={(oid) => void gitWorkflow.reviewCommit(oid)} onFetch={() => void gitWorkflow.fetchRemote()}
        onPull={() => void gitWorkflow.pullCurrentBranch()} onPush={() => void gitWorkflow.pushCurrentBranch()}
        onReview={(pullRequest) => void gitWorkflow.reviewPullRequest(pullRequest)}
        onOpenPullRequest={(selector) => void gitWorkflow.openPullRequestReview(selector)}
        onCheckout={(pullRequest) => void gitWorkflow.checkoutPullRequest(pullRequest)} />
    </Suspense> : null}

    <CommandPaletteController ref={view.commandPaletteRef} gitRepositoryOpen={view.snapshot?.kind === 'git'}
      keybindings={view.preferences.keybindings} onOpenPullRequest={view.openPullRequestFromPalette}
      onOpenRepository={gitWorkflow.openPanel} onOpenSettings={view.openSettingsFromPalette} />
    {view.settingsOpen ? <SettingsPage preferences={view.preferences} onChange={view.setPreferences}
      onClose={() => view.setSettingsOpen(false)} /> : null}
    {!view.settingsOpen && view.searchIsOpen ? <SearchResults mode={view.searchMode} query={view.deferredSearchQuery}
      fileResults={view.fileResults} contentResults={view.contentResults} onSelect={view.selectSearchResult} /> : null}
    {!view.settingsOpen && view.error != null ? <ErrorBanner message={view.error} onDismiss={() => view.setError(null)} /> : null}

    {view.snapshot == null ? (view.settingsOpen ? null : <Welcome onOpen={view.openFolder} opening={view.opening}
      recentFolders={view.recentFolders} openingRecentPath={view.openingRecentPath} onRecentOpen={view.openRecentFolder}
      onRecentRemove={(path) => view.setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
      keybindings={view.preferences.keybindings} />) : (
      <div className="workspace-host" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
        <Suspense fallback={<div className="workspace"><div className="diff-state"><span>Preparing workspace…</span></div></div>}>
          <RepositoryWorkspace key={`${view.snapshot.root}:${gitWorkflow.repositoryReview == null ? 'working-tree'
            : gitWorkflow.repositoryReview.kind === 'github' ? gitWorkflow.repositoryReview.pullRequest.url : gitWorkflow.repositoryReview.id}`}
            snapshot={view.snapshot} selectedPath={view.selectedPath} comparison={view.comparison}
            loadingDiff={view.loadingDiff} sidebarVisible={view.sidebarVisible} diffStyle={view.diffStyle}
            workspaceView={view.workspaceView} preferences={view.preferences} onPreferencesChange={view.setPreferences}
            repositoryReview={gitWorkflow.repositoryReview} repositoryChange={view.repositoryChange}
            onSelectPath={view.setSelectedPath} onDiffStyleChange={view.setDiffStyle}
            onWorkspaceViewChange={view.setWorkspaceView} onClosePullRequestReview={gitWorkflow.closeReview}
            submittingPullRequestReview={gitWorkflow.submittingReview} pullRequestReviewMessage={gitWorkflow.submissionMessage}
            onSubmitPullRequestReview={gitWorkflow.submitReview} />
        </Suspense>
      </div>
    )}
  </main>
})

export function App(): React.JSX.Element {
  useWindowVisibilitySync()
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [comparison, setComparison] = useState<FileComparison | null>(null)
  const [opening, setOpening] = useState(false)
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('file')
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders)
  const [searchMode, setSearchMode] = useState<SearchMode>('files')
  const [searchQuery, setSearchQuery] = useState('')
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([])
  const [searchingContent, setSearchingContent] = useState(false)
  const [repositoryChange, setRepositoryChange] = useState<RepositoryChangeEvent | null>(null)
  const [comparisonRevision, setComparisonRevision] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const comparisonRequestRef = useRef(0)
  const contentSearchRequestRef = useRef(0)
  const lastComparisonPathRef = useRef<string | null>(null)
  const commandPaletteRef = useRef<CommandPaletteHandle>(null)
  const deferredSearchQuery = useDeferredValue(searchQuery)

  const indexedPaths = useMemo(
    () => createFileSearchIndex(snapshot?.paths ?? []),
    [snapshot]
  )

  const fileResults = useMemo(() => {
    if (snapshot == null || searchMode !== 'files' || deferredSearchQuery.trim() === '') return []
    return rankFilePaths(indexedPaths, deferredSearchQuery)
  }, [deferredSearchQuery, indexedPaths, searchMode, snapshot])

  const applySnapshot = useCallback(
    (nextSnapshot: RepositorySnapshot) => {
      const nextPaths = new Set(nextSnapshot.paths)
      const changedPaths = new Set(nextSnapshot.statuses.map((status) => status.path))
      setSnapshot(nextSnapshot)
      setSelectedPath((currentPath) =>
        currentPath != null
          && nextPaths.has(currentPath)
          && (nextSnapshot.kind === 'folder' || changedPaths.has(currentPath))
          ? currentPath
          : nextSnapshot.statuses[0]?.path
            ?? (nextSnapshot.kind === 'folder' ? nextSnapshot.paths[0] ?? null : null)
      )
    },
    []
  )

  const gitWorkflow = useGitWorkflow({
    snapshot,
    applySnapshot,
    onError: setError,
    onSelectPath: setSelectedPath,
    onWorkspaceViewChange: setWorkspaceView
  })

  const openPullRequestFromPalette = useCallback((selector: number | string) => {
    void gitWorkflow.openPullRequestReview(selector)
  }, [gitWorkflow.openPullRequestReview])

  const openSettingsFromPalette = useCallback(() => setSettingsOpen(true), [])

  const toggleSidebar = useCallback((withMotion: boolean) => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const shouldAnimate = withMotion && !reduceMotion

    if (!shouldAnimate) {
      document.documentElement.dataset.sidebarMotion = 'instant'
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          delete document.documentElement.dataset.sidebarMotion
        })
      })
    }
    setSidebarVisible((visible) => !visible)
  }, [])

  const openFolder = useCallback(async () => {
    setOpening(true)
    setError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().openFolder()
      if (nextSnapshot != null) {
        gitWorkflow.reset()
        setSelectedPath(null)
        applySnapshot(nextSnapshot)
        setRecentFolders((current) => rememberRecentFolder(current, nextSnapshot))
      }
    } catch (openError) {
      setError(getErrorMessage(openError))
    } finally {
      setOpening(false)
    }
  }, [applySnapshot, gitWorkflow])

  const openRecentFolder = useCallback(async (folder: RecentFolder) => {
    setOpeningRecentPath(folder.path)
    setError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().openPath(folder.path)
      gitWorkflow.reset()
      setSelectedPath(null)
      applySnapshot(nextSnapshot)
      setRecentFolders((current) => rememberRecentFolder(current, nextSnapshot))
    } catch (openError) {
      setError(`Cannot open “${folder.name}”. ${getErrorMessage(openError)}`)
    } finally {
      setOpeningRecentPath(null)
    }
  }, [applySnapshot, gitWorkflow])

  const refreshRepository = useCallback(async () => {
    if (snapshot == null) return
    setRefreshing(true)
    setError(null)
    try {
      applySnapshot(await requireRepositoryApi().refresh())
    } catch (refreshError) {
      setError(getErrorMessage(refreshError))
    } finally {
      setRefreshing(false)
    }
  }, [applySnapshot, snapshot])

  const selectSearchResult = useCallback(
    (path: string) => {
      startTransition(() => setSelectedPath(path))
      setSearchQuery('')
      searchInputRef.current?.blur()
    },
    []
  )

  const handleRepositoryChange = useEffectEvent((change: RepositoryChangeEvent): void => {
    startTransition(() => {
      applySnapshot(change.snapshot)
      setRepositoryChange(change)
      if (selectedPath != null && change.changedPaths.includes(selectedPath)) {
        setComparisonRevision(change.revision)
      }
    })
  })

  useEffect(() => requireRepositoryApi().onDidChange(handleRepositoryChange), [])

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    let cancelled = false
    void repository.getSessionSnapshot().then((sessionSnapshot) => {
      if (cancelled || sessionSnapshot == null) return
      applySnapshot(sessionSnapshot)
      setRecentFolders((current) => rememberRecentFolder(current, sessionSnapshot))
    }).catch((sessionError: unknown) => {
      if (!cancelled) setError(getErrorMessage(sessionError))
    })
    return () => { cancelled = true }
  }, [applySnapshot])

  useEffect(() => {
    const requestId = comparisonRequestRef.current + 1
    comparisonRequestRef.current = requestId
    if (selectedPath == null || workspaceView === 'multi') {
      setComparison(null)
      setLoadingDiff(false)
      return
    }
    const pathChanged = lastComparisonPathRef.current !== selectedPath
    lastComparisonPathRef.current = selectedPath
    if (pathChanged) setLoadingDiff(true)
    setError(null)
    void requireRepositoryApi()
      .getComparison(selectedPath)
      .then((nextComparison) => {
        if (comparisonRequestRef.current === requestId) setComparison(nextComparison)
      })
      .catch((comparisonError: unknown) => {
        if (comparisonRequestRef.current === requestId) setError(getErrorMessage(comparisonError))
      })
      .finally(() => {
        if (comparisonRequestRef.current === requestId) setLoadingDiff(false)
      })
  }, [comparisonRevision, selectedPath, workspaceView])

  useEffect(() => {
    if (searchMode !== 'content' || deferredSearchQuery.trim().length < 2) {
      setContentResults([])
      setSearchingContent(false)
      return
    }

    const requestId = contentSearchRequestRef.current + 1
    contentSearchRequestRef.current = requestId
    setSearchingContent(true)
    const timeout = window.setTimeout(() => {
      void requireRepositoryApi()
        .searchContent(deferredSearchQuery)
        .then((results) => {
          if (contentSearchRequestRef.current === requestId) setContentResults(results)
        })
        .catch((searchError: unknown) => {
          if (contentSearchRequestRef.current === requestId) setError(getErrorMessage(searchError))
        })
        .finally(() => {
          if (contentSearchRequestRef.current === requestId) setSearchingContent(false)
        })
    }, 120)
    return () => window.clearTimeout(timeout)
  }, [deferredSearchQuery, searchMode])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--font-ui', INTERFACE_FONTS[preferences.interfaceFont].fontFamily)
    root.style.setProperty('--font-mono', CODE_FONTS[preferences.codeFont].fontFamily)
    savePreferences(preferences)
  }, [preferences])

  useEffect(() => {
    saveRecentFolders(recentFolders)
  }, [recentFolders])

  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape' && commandPaletteRef.current?.close()) {
      event.preventDefault()
      return
    }
    if (event.key === 'Escape' && settingsOpen) {
      event.preventDefault()
      setSettingsOpen(false)
      return
    }
    if (event.key === 'Escape' && gitWorkflow.panelOpen) {
      event.preventDefault()
      gitWorkflow.setPanelOpen(false)
      return
    }
    if (event.defaultPrevented || event.repeat) return
    const command = commandFromEvent(event, preferences.keybindings)
    if (command == null) return
    event.preventDefault()
    if (command === 'openSettings') {
      commandPaletteRef.current?.close()
      setSettingsOpen(true)
    } else if (command === 'openCommandPalette') {
      commandPaletteRef.current?.toggle()
    } else if (settingsOpen) {
      return
    } else if (command === 'goToFile') {
      setSearchMode('files')
      searchInputRef.current?.focus()
    } else if (command === 'searchContent') {
      setSearchMode('content')
      searchInputRef.current?.focus()
    } else if (command === 'openFolder') {
      void openFolder()
    } else if (command === 'toggleSidebar' && snapshot != null) {
      toggleSidebar(false)
    } else if (command === 'toggleWordWrap') {
      setPreferences((current) => ({ ...current, wordWrap: !current.wordWrap }))
    } else if (command === 'toggleFoldUnchanged') {
      setPreferences((current) => ({ ...current, foldUnchanged: !current.foldUnchanged }))
    } else if (command === 'toggleMultiFile' && snapshot != null) {
      setWorkspaceView((view) => view === 'file' ? 'multi' : 'file')
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const searchIsOpen = snapshot != null && searchQuery.trim().length > 0

  const view: AppLayoutProps = {
    snapshot, selectedPath, comparison, repositoryChange, opening, openingRecentPath, refreshing,
    loadingDiff, error, sidebarVisible, diffStyle, workspaceView, preferences, settingsOpen,
    recentFolders, searchMode, searchQuery, deferredSearchQuery, fileResults, contentResults,
    searchingContent, searchIsOpen, searchInputRef, commandPaletteRef, gitWorkflow, setSearchMode,
    setSearchQuery, setSettingsOpen, setError, setRecentFolders, setPreferences, setSelectedPath,
    setDiffStyle, setWorkspaceView, toggleSidebar, openFolder, openRecentFolder, refreshRepository,
    selectSearchResult, openPullRequestFromPalette, openSettingsFromPalette
  }
  return <AppLayout {...view} />
}
