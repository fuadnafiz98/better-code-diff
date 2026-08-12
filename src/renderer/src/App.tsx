import {
  lazy,
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
  CODE_FONTS,
  INTERFACE_FONTS,
  loadPreferences,
  savePreferences,
  type AppPreferences
} from './preferences'
import { SettingsPage } from './SettingsPage'
import { RepositoryPanel } from './GitHubPanel'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import {
  loadRecentFolders,
  rememberRecentFolder,
  saveRecentFolders,
  type RecentFolder
} from './recentFolders'
import { useGitWorkflow } from './useGitWorkflow'

const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace'))

export function App(): React.JSX.Element {
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
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key === ',') {
      event.preventDefault()
      setSettingsOpen(true)
    } else if (event.key.toLowerCase() === 'p') {
      event.preventDefault()
      setSearchMode('files')
      searchInputRef.current?.focus()
    } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setSearchMode('content')
      searchInputRef.current?.focus()
    } else if (event.key.toLowerCase() === 'o') {
      event.preventDefault()
      void openFolder()
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const searchIsOpen = snapshot != null && searchQuery.trim().length > 0

  return (
    <main className="app-shell">
      <Titlebar
        snapshot={snapshot}
        sidebarVisible={sidebarVisible}
        searchMode={searchMode}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        searchingContent={searchingContent}
        opening={opening}
        refreshing={refreshing}
        onSidebarToggle={() => setSidebarVisible((visible) => !visible)}
        onSearchModeChange={setSearchMode}
        onSearchQueryChange={setSearchQuery}
        onOpen={openFolder}
        onRefresh={refreshRepository}
        onSettingsOpen={() => setSettingsOpen(true)}
        onGitOpen={gitWorkflow.openPanel}
      />

      {gitWorkflow.panelOpen && snapshot?.kind === 'git' ? (
        <RepositoryPanel
          integration={gitWorkflow.integration}
          loading={gitWorkflow.loadingIntegration}
          actionKey={gitWorkflow.actionKey}
          onClose={() => gitWorkflow.setPanelOpen(false)}
          onReload={() => void gitWorkflow.loadIntegration()}
          onSwitchBranch={(name) => void gitWorkflow.switchBranch(name)}
          onReviewLocalBranch={(baseRef, headRef) => void gitWorkflow.reviewLocalBranch(baseRef, headRef)}
          onReviewCommit={(oid) => void gitWorkflow.reviewCommit(oid)}
          onFetch={() => void gitWorkflow.fetchRemote()}
          onPull={() => void gitWorkflow.pullCurrentBranch()}
          onPush={() => void gitWorkflow.pushCurrentBranch()}
          onReview={(pullRequest) => void gitWorkflow.reviewPullRequest(pullRequest)}
          onOpenPullRequest={(number) => void gitWorkflow.openPullRequestReview(number)}
          onCheckout={(pullRequest) => void gitWorkflow.checkoutPullRequest(pullRequest)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPage preferences={preferences} onChange={setPreferences} onClose={() => setSettingsOpen(false)} />
      ) : null}

      {!settingsOpen && searchIsOpen ? (
        <SearchResults
          mode={searchMode}
          query={deferredSearchQuery}
          fileResults={fileResults}
          contentResults={contentResults}
          onSelect={selectSearchResult}
        />
      ) : null}

      {!settingsOpen && error != null ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

      {settingsOpen ? null : snapshot == null ? (
        <Welcome
          onOpen={openFolder}
          opening={opening}
          recentFolders={recentFolders}
          openingRecentPath={openingRecentPath}
          onRecentOpen={openRecentFolder}
          onRecentRemove={(path) => setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
        />
      ) : (
        <Suspense fallback={<div className="workspace"><div className="diff-state"><span>Preparing workspace…</span></div></div>}>
          <RepositoryWorkspace
            key={snapshot.root}
            snapshot={snapshot}
            selectedPath={selectedPath}
            comparison={comparison}
            loadingDiff={loadingDiff}
            sidebarVisible={sidebarVisible}
            diffStyle={diffStyle}
            workspaceView={workspaceView}
            preferences={preferences}
            repositoryReview={gitWorkflow.repositoryReview}
            repositoryChange={repositoryChange}
            onSelectPath={setSelectedPath}
            onDiffStyleChange={setDiffStyle}
            onWorkspaceViewChange={setWorkspaceView}
            onClosePullRequestReview={gitWorkflow.closeReview}
            submittingPullRequestReview={gitWorkflow.submittingReview}
            pullRequestReviewMessage={gitWorkflow.submissionMessage}
            onSubmitPullRequestReview={(reviewEvent, body) => void gitWorkflow.submitReview(reviewEvent, body)}
          />
        </Suspense>
      )}
    </main>
  )
}
