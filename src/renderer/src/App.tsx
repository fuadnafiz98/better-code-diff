import {
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from 'react'

import type {
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
  type WorkspaceView
} from './AppView'
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
import { useAgentSession } from './useAgentSession'
import { useRepositorySearch, type RepositorySearchController } from './useRepositorySearch'
import { AgentDock } from './AgentDock'

const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace'))
const RepositoryPanel = lazy(async () => ({
  default: (await import('./GitHubPanel')).RepositoryPanel
}))
function useWindowVisibilitySync(): void {
  useEffect(() => {
    let frame = 0
    let wasHidden = document.hidden
    const refreshLayout = (): void => {
      void window.repository?.setVisibility(!document.hidden)
      if (document.hidden) {
        wasHidden = true
        return
      }
      if (!wasHidden) return
      wasHidden = false
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
  loadingDiff: boolean
  error: string | null
  sidebarVisible: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  settingsOpen: boolean
  recentFolders: RecentFolder[]
  search: RepositorySearchController
  commandPaletteRef: React.RefObject<CommandPaletteHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  setRecentFolders: React.Dispatch<React.SetStateAction<RecentFolder[]>>
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  setDiffStyle: React.Dispatch<React.SetStateAction<DiffStyle>>
  setWorkspaceView: React.Dispatch<React.SetStateAction<WorkspaceView>>
  toggleSidebar(): void
  openFolder(): Promise<void>
  openRecentFolder(folder: RecentFolder): Promise<void>
  openPullRequestFromPalette(selector: number | string): void
  openSettings(): void
}

const AgentSessionLayout = memo(function AgentSessionLayout(view: AppLayoutProps): React.JSX.Element {
  const { gitWorkflow } = view
  const { search } = view
  const agent = useAgentSession({
    context: gitWorkflow.repositoryReview?.patch ?? ''
  })
  return <main className="app-shell" data-theme-type={getEditorThemeType(view.preferences.editorTheme)}>
    <Titlebar snapshot={view.snapshot} sidebarVisible={view.sidebarVisible}
      searchQuery={search.query} searchInputRef={search.inputRef} searchingContent={search.searchingContent}
      activeSearchResultId={search.activeResultIndex >= 0
        ? `repository-search-result-${search.activeResultIndex}` : undefined}
      opening={view.opening} keybindings={view.preferences.keybindings}
      onSidebarToggle={view.toggleSidebar}
      onSearchQueryChange={search.changeQuery} onSearchKeyDown={search.handleKeyDown} onOpen={view.openFolder}
      onSettingsOpen={view.openSettings} onGitOpen={gitWorkflow.openPanel}
      onBranchesOpen={gitWorkflow.openBranches}
      agentOpen={agent.open} onAgentToggle={agent.toggle} />

    {gitWorkflow.actionKey?.startsWith('review:') ? <PullRequestLoadingIndicator /> : null}
    {gitWorkflow.panelOpen && view.snapshot?.kind === 'git' ? <Suspense fallback={null}>
      <RepositoryPanel initialTab={gitWorkflow.panelTab}
        integration={gitWorkflow.integration} loading={gitWorkflow.loadingIntegration}
        inbox={gitWorkflow.inbox} loadingInbox={gitWorkflow.loadingInbox}
        actionKey={gitWorkflow.actionKey} onClose={() => gitWorkflow.setPanelOpen(false)}
        onSwitchBranch={(name) => void gitWorkflow.switchBranch(name)}
        onReviewLocalBranch={(base, head) => void gitWorkflow.reviewLocalBranch(base, head)}
        onReviewCommit={(oid) => void gitWorkflow.reviewCommit(oid)} onFetch={() => void gitWorkflow.fetchRemote()}
        onPull={() => void gitWorkflow.pullCurrentBranch()} onPush={() => void gitWorkflow.pushCurrentBranch()}
        onReview={(pullRequest) => void gitWorkflow.reviewPullRequest(pullRequest)}
        onMerge={(pullRequest, strategy) => void gitWorkflow.mergePullRequest(pullRequest, strategy)}
        onMarkReady={(pullRequest) => void gitWorkflow.markPullRequestReady(pullRequest)}
        onOpenPullRequest={(selector) => void gitWorkflow.openPullRequestReview(selector)}
        onCheckout={(pullRequest) => void gitWorkflow.checkoutPullRequest(pullRequest)} />
    </Suspense> : null}

    <CommandPaletteController ref={view.commandPaletteRef} gitRepositoryOpen={view.snapshot?.kind === 'git'}
      keybindings={view.preferences.keybindings} onOpenPullRequest={view.openPullRequestFromPalette}
      onOpenRepository={gitWorkflow.openPanel} onOpenSettings={view.openSettings} />
    {view.settingsOpen ? <SettingsPage preferences={view.preferences} onChange={view.setPreferences}
      onClose={() => view.setSettingsOpen(false)} /> : null}
    {!view.settingsOpen && search.isOpen ? <SearchResults query={search.query}
      fileResults={search.fileResults} contentResults={search.contentResults} searchingContent={search.searchingContent}
      activeIndex={search.activeResultIndex} onActiveIndexChange={search.setActiveResultIndex}
      onSelect={search.selectResult} /> : null}
    {!view.settingsOpen && view.error != null ? <ErrorBanner message={view.error} onDismiss={() => view.setError(null)} /> : null}

    {view.snapshot == null ? (view.settingsOpen ? null : <Welcome onOpen={view.openFolder} opening={view.opening}
      recentFolders={view.recentFolders} openingRecentPath={view.openingRecentPath} onRecentOpen={view.openRecentFolder}
      onRecentRemove={(path) => view.setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
      keybindings={view.preferences.keybindings} />) : (
      <div className="workspace-host" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
        <div className={`workspace ${view.sidebarVisible ? '' : 'sidebar-hidden'} ${agent.open ? 'agent-open' : ''}`}>
          <Suspense fallback={<div className="diff-state"><span>Preparing workspace…</span></div>}>
            <RepositoryWorkspace key={`${view.snapshot.root}:${gitWorkflow.repositoryReview == null ? 'working-tree'
              : gitWorkflow.repositoryReview.kind === 'github' ? gitWorkflow.repositoryReview.pullRequest.url : gitWorkflow.repositoryReview.id}`}
              snapshot={view.snapshot} selectedPath={view.selectedPath} comparison={view.comparison}
              loadingDiff={view.loadingDiff} diffStyle={view.diffStyle} workspaceView={view.workspaceView}
              preferences={view.preferences} onPreferencesChange={view.setPreferences}
              onAttachToAgent={agent.attach}
              repositoryReview={gitWorkflow.repositoryReview} repositoryChange={view.repositoryChange}
              onSelectPath={view.setSelectedPath} onDiffStyleChange={view.setDiffStyle}
              onWorkspaceViewChange={view.setWorkspaceView} onClosePullRequestReview={gitWorkflow.closeReview}
              submittingPullRequestReview={gitWorkflow.submittingReview} pullRequestReviewMessage={gitWorkflow.submissionMessage}
              onSubmitPullRequestReview={gitWorkflow.submitReview} onError={view.setError} />
          </Suspense>
          <AgentDock session={agent}
            contextLabel={gitWorkflow.repositoryReview == null ? 'your working tree' : 'this review'} />
        </div>
      </div>
    )}
  </main>
})

const AppLayout = memo(function AppLayout(view: AppLayoutProps): React.JSX.Element {
  const repositoryReview = view.gitWorkflow.repositoryReview
  const agentSessionKey = view.snapshot == null
    ? 'welcome'
    : `${view.snapshot.root}:${repositoryReview == null ? 'working-tree'
      : repositoryReview.kind === 'github' ? repositoryReview.pullRequest.url : repositoryReview.id}`
  return <AgentSessionLayout key={agentSessionKey} {...view} />
})

export function App(): React.JSX.Element {
  useWindowVisibilitySync()
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [comparison, setComparison] = useState<FileComparison | null>(null)
  const [opening, setOpening] = useState(false)
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('file')
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders)
  const [repositoryChange, setRepositoryChange] = useState<RepositoryChangeEvent | null>(null)
  const [comparisonRevision, setComparisonRevision] = useState(0)
  const comparisonRequestRef = useRef(0)
  const lastComparisonPathRef = useRef<string | null>(null)
  const commandPaletteRef = useRef<CommandPaletteHandle>(null)
  const search = useRepositorySearch(snapshot, setSelectedPath, setError)

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

  const openSettings = useCallback(() => setSettingsOpen(true), [])

  const toggleSidebar = useCallback(() => {
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
  }, [applySnapshot, gitWorkflow.reset])

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
  }, [applySnapshot, gitWorkflow.reset])

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
    } else if (command === 'goToFile' || command === 'searchContent') {
      search.inputRef.current?.focus()
    } else if (command === 'openFolder') {
      void openFolder()
    } else if (command === 'toggleSidebar' && snapshot != null) {
      toggleSidebar()
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

  const view: AppLayoutProps = {
    snapshot, selectedPath, comparison, repositoryChange, opening, openingRecentPath,
    loadingDiff, error, sidebarVisible, diffStyle, workspaceView, preferences, settingsOpen,
    recentFolders, search, commandPaletteRef, gitWorkflow,
    setSettingsOpen, setError, setRecentFolders, setPreferences, setSelectedPath,
    setDiffStyle, setWorkspaceView, toggleSidebar, openFolder,
    openRecentFolder, openPullRequestFromPalette, openSettings
  }
  return <AppLayout {...view} />
}
