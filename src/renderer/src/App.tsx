import {
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties
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
import { commandFromEvent, formatTerminalToggleShortcut, type AppCommand } from './keybindings'
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
import {
  isInsideSearchSurface,
  useRepositorySearch,
  type RepositorySearchController
} from './useRepositorySearch'
import { AgentDock } from './AgentDock'
import type { TerminalDockHandle } from './TerminalDock'
import { useTerminalVisibility } from './useTerminalVisibility'
import { includesPath, samePathList } from './snapshotPaths'
import { useComparisonLoader } from './useComparisonLoader'
import { WorkspaceSkeleton } from './WorkspaceSkeleton'
import { ViewerProviders } from './editor/ViewerProviders'
import { usePresence, useRetainedPresence } from './usePresence'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'
import { useConfirm } from './useConfirm'
import { formatAgentReviewContext } from './agentReviewContext'

const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace'))
const TerminalDock = lazy(() => import('./TerminalDock'))
const RepositoryPanel = lazy(async () => ({
  default: (await import('./GitHubPanel')).RepositoryPanel
}))
// The titlebar reserves 92px for the traffic lights; in fullscreen there are
// none, so the CSS collapses the reserve off this attribute.
function useFullscreenSync(): void {
  useEffect(() => window.repository?.onFullscreenChange((fullscreen) => {
    document.documentElement.dataset.fullscreen = fullscreen ? 'true' : ''
  }), [])
}

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
  terminalOpen: boolean
  terminalMounted: boolean
  terminalHeight: number
  terminalResizing: boolean
  preferences: AppPreferences
  settingsOpen: boolean
  recentFolders: RecentFolder[]
  search: RepositorySearchController
  commandPaletteRef: React.RefObject<CommandPaletteHandle | null>
  terminalDockRef: React.RefObject<TerminalDockHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  setRecentFolders: React.Dispatch<React.SetStateAction<RecentFolder[]>>
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  onComparisonSaved(comparison: FileComparison): void
  setDiffStyle: React.Dispatch<React.SetStateAction<DiffStyle>>
  setWorkspaceView: React.Dispatch<React.SetStateAction<WorkspaceView>>
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  setTerminalResizing: React.Dispatch<React.SetStateAction<boolean>>
  toggleSidebar(): void
  toggleTerminal(): void
  closeTerminal(): void
  commitTerminalHeight(height: number): void
  openFolder(): Promise<void>
  openRecentFolder(folder: RecentFolder): Promise<void>
  openPullRequestFromPalette(selector: number | string): void
  openSettings(): void
  runCommand(command: AppCommand): void
  recentFiles: readonly string[]
  confirmRequest: ConfirmRequest | null
  confirm(request: ConfirmRequest): Promise<boolean>
  resolveConfirm(confirmed: boolean): void
}

const AgentSessionLayout = memo(function AgentSessionLayout(view: AppLayoutProps): React.JSX.Element {
  const { gitWorkflow } = view
  const { search } = view
  // The palette lists branches the integration snapshot already holds; it never
  // fetches on its own, so this stays empty until the panel has been opened once.
  const branches = gitWorkflow.integration?.branches
  const paletteBranches = useMemo(() => {
    if (branches == null) return undefined
    const names: string[] = []
    for (const branch of branches) if (!branch.current) names.push(branch.name)
    return names
  }, [branches])
  // Both surfaces have a closed-state rule in styles.css that only bites while
  // the node is still in the tree, so presence holds them for the exit.
  const reviewLoadingPresence = usePresence(gitWorkflow.actionKey?.startsWith('review:') ?? false, 140)
  const repositoryPanelPresence = usePresence(gitWorkflow.panelOpen, 220)
  // The message is null the moment the banner is dismissed; the exit still needs text.
  const errorPresence = useRetainedPresence(view.error, 140)
  // Content hits for the file being edited become inline hint markers.
  const contentSearch = useMemo(
    () => ({ query: search.query, results: search.contentResults }),
    [search.contentResults, search.query]
  )
  // Rebuilt per render this string re-joined the whole review patch on every
  // streamed token, and re-created `ask` with it.
  const agentContext = useMemo(
    () => formatAgentReviewContext(gitWorkflow.repositoryReview),
    [gitWorkflow.repositoryReview]
  )
  const agent = useAgentSession({ context: agentContext })
  return <>
    <Titlebar snapshot={view.snapshot} sidebarVisible={view.sidebarVisible}
      searchQuery={search.query} searchInputRef={search.inputRef} searchingContent={search.searchingContent}
      activeSearchResultId={search.activeResultIndex >= 0
        ? `repository-search-result-${search.activeResultIndex}` : undefined}
      opening={view.opening} keybindings={view.preferences.keybindings}
      onSidebarToggle={view.toggleSidebar}
      onSearchQueryChange={search.changeQuery} onSearchKeyDown={search.handleKeyDown} onOpen={view.openFolder}
      onSettingsOpen={view.openSettings} onGitOpen={gitWorkflow.openPanel}
      onBranchesOpen={gitWorkflow.openBranches}
      agentOpen={agent.open} onAgentToggle={agent.toggle}
      terminalOpen={view.terminalOpen} onTerminalToggle={view.toggleTerminal} />

    {reviewLoadingPresence.mounted ? <PullRequestLoadingIndicator closing={reviewLoadingPresence.closing} /> : null}
    {repositoryPanelPresence.mounted && view.snapshot?.kind === 'git' ? <Suspense fallback={null}>
      <RepositoryPanel open={gitWorkflow.panelOpen} initialTab={gitWorkflow.panelTab}
        integration={gitWorkflow.integration} loading={gitWorkflow.loadingIntegration}
        inbox={gitWorkflow.inbox} loadingInbox={gitWorkflow.loadingInbox}
        actionKey={gitWorkflow.actionKey} onClose={() => gitWorkflow.setPanelOpen(false)}
        onRefresh={gitWorkflow.refreshPanelData} updatedAt={gitWorkflow.integrationFetchedAt}
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
      projectOpen={view.snapshot != null}
      keybindings={view.preferences.keybindings} onOpenPullRequest={view.openPullRequestFromPalette}
      onOpenRepository={gitWorkflow.openPanel} onOpenSettings={view.openSettings}
      onToggleTerminal={view.toggleTerminal}
      onRunCommand={view.runCommand}
      recentFiles={view.recentFiles} onOpenFile={view.setSelectedPath}
      branches={paletteBranches} onSwitchBranch={(branch) => void gitWorkflow.switchBranch(branch)} />
    {view.settingsOpen ? <SettingsPage preferences={view.preferences} onChange={view.setPreferences}
      onClose={() => view.setSettingsOpen(false)} /> : null}
    {!view.settingsOpen && search.isOpen ? <SearchResults query={search.query}
      fileResults={search.fileResults} contentResults={search.contentResults} searchingContent={search.searchingContent}
      activeIndex={search.activeResultIndex} onActiveIndexChange={search.setActiveResultIndex}
      onSelect={search.selectResult} /> : null}
    {!view.settingsOpen && errorPresence.mounted && errorPresence.retained != null
      ? <ErrorBanner key={errorPresence.retained} message={errorPresence.retained} closing={errorPresence.closing}
          onDismiss={() => view.setError(null)} />
      : null}

    {view.snapshot == null ? (view.settingsOpen ? null : <Welcome onOpen={view.openFolder} opening={view.opening}
      recentFolders={view.recentFolders} openingRecentPath={view.openingRecentPath} onRecentOpen={view.openRecentFolder}
      onRecentRemove={(path) => view.setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
      keybindings={view.preferences.keybindings} />) : (
      <div className="workspace-host" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
        <div className={`workspace ${view.sidebarVisible ? '' : 'sidebar-hidden'} ${agent.open ? 'agent-open' : ''}`}>
          <Suspense fallback={<WorkspaceSkeleton />}>
            <ViewerProviders theme={view.preferences.editorTheme}>
              <RepositoryWorkspace key={`${view.snapshot.root}:${gitWorkflow.repositoryReview == null ? 'working-tree'
                : gitWorkflow.repositoryReview.kind === 'github' ? gitWorkflow.repositoryReview.pullRequest.url : gitWorkflow.repositoryReview.id}`}
                snapshot={view.snapshot} selectedPath={view.selectedPath} comparison={view.comparison}
                loadingDiff={view.loadingDiff} diffStyle={view.diffStyle} workspaceView={view.workspaceView}
                preferences={view.preferences} onPreferencesChange={view.setPreferences}
                onAttachToAgent={agent.attach}
                repositoryReview={gitWorkflow.repositoryReview} repositoryChange={view.repositoryChange}
                contentSearch={contentSearch}
                onSelectPath={view.setSelectedPath} onDiffStyleChange={view.setDiffStyle}
                onWorkspaceViewChange={view.setWorkspaceView} onClosePullRequestReview={gitWorkflow.closeReview}
                submittingPullRequestReview={gitWorkflow.submittingReview} pullRequestReviewMessage={gitWorkflow.submissionMessage}
                onSubmitPullRequestReview={gitWorkflow.submitReview} onComparisonSaved={view.onComparisonSaved}
                onError={view.setError} />
            </ViewerProviders>
          </Suspense>
          <AgentDock session={agent}
            confirm={view.confirm}
            contextLabel={gitWorkflow.repositoryReview == null ? 'your working tree' : 'this review'} />
        </div>
      </div>
    )}
  </>
})

const RECENT_FILE_LIMIT = 10

// A chunk that fails to prefetch is retried for real by the lazy boundary, so
// the failure has nowhere useful to go here.
function ignorePrefetchFailure(): void {}

const AppLayout = memo(function AppLayout(view: AppLayoutProps): React.JSX.Element {
  // Keyed on the repository only. Opening a pull request review keys the
  // workspace below, not this: remounting here would tear down the agent
  // transcript (useAgentAnswer cancels the in-flight request on unmount) and,
  // with ViewerProviders inside, the worker pool and every cached edit session.
  const agentSessionKey = view.snapshot?.root ?? 'welcome'
  const shellStyle = {
    '--terminal-panel-height': `${view.terminalHeight}px`,
    '--terminal-dock-offset': view.terminalOpen ? `${view.terminalHeight}px` : '0px'
  } as CSSProperties
  return <main
    className={`app-shell ${view.terminalOpen ? 'terminal-open' : ''} ${view.terminalResizing ? 'terminal-resizing' : ''}`}
    data-theme-type={getEditorThemeType(view.preferences.editorTheme)}
    style={shellStyle}
  >
    <AgentSessionLayout key={agentSessionKey} {...view} />
    {view.snapshot != null && view.terminalMounted ? <Suspense fallback={null}>
      <TerminalDock
        key={view.snapshot.root}
        ref={view.terminalDockRef}
        open={view.terminalOpen}
        projectName={view.snapshot.name}
        projectRoot={view.snapshot.root}
        height={view.terminalHeight}
        fontFamily={CODE_FONTS[view.preferences.codeFont].fontFamily}
        fontSize={view.preferences.codeFontSize}
        lineHeight={Math.min(1.8, Math.max(1, view.preferences.codeLineHeight / view.preferences.codeFontSize))}
        scrollback={view.preferences.terminalScrollback}
        themeType={getEditorThemeType(view.preferences.editorTheme)}
        shortcutLabel={formatTerminalToggleShortcut()}
        onClose={view.closeTerminal}
        onHeightChange={view.setTerminalHeight}
        onHeightCommit={view.commitTerminalHeight}
        onResizingChange={view.setTerminalResizing}
      />
    </Suspense> : null}
    {view.confirmRequest == null ? null : (
      <ConfirmDialog {...view.confirmRequest} onResolve={view.resolveConfirm} />
    )}
  </main>
})

export function App(): React.JSX.Element {
  useWindowVisibilitySync()
  useFullscreenSync()
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('multi')
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders)
  const [repositoryChange, setRepositoryChange] = useState<RepositoryChangeEvent | null>(null)
  const commandPaletteRef = useRef<CommandPaletteHandle>(null)
  const [recentFiles, setRecentFiles] = useState<readonly string[]>([])
  const confirmation = useConfirm()
  const search = useRepositorySearch(snapshot, setSelectedPath, setError)
  const closeOverlays = useCallback(() => {
    commandPaletteRef.current?.close()
    setSettingsOpen(false)
  }, [])
  const terminal = useTerminalVisibility({
    enabled: snapshot != null,
    keybindings: preferences.keybindings,
    onBeforeOpen: closeOverlays
  })

  const appliedSnapshotRef = useRef<RepositorySnapshot | null>(null)

  const applySnapshot = useCallback(
    (nextSnapshot: RepositorySnapshot) => {
      const previous = appliedSnapshotRef.current
      const snapshotToApply = previous != null && samePathList(previous.paths, nextSnapshot.paths)
        ? { ...nextSnapshot, paths: previous.paths }
        : nextSnapshot
      appliedSnapshotRef.current = snapshotToApply
      setSnapshot(snapshotToApply)
      // A watcher tick must never move the reader: the selection only falls back
      // once the selected file has actually left the repository.
      setSelectedPath((currentPath) =>
        currentPath != null && includesPath(snapshotToApply.paths, currentPath)
          ? currentPath
          : snapshotToApply.statuses[0]?.path
            ?? (snapshotToApply.kind === 'folder' ? snapshotToApply.paths[0] ?? null : null)
      )
    },
    []
  )

  const gitWorkflow = useGitWorkflow({
    snapshot,
    applySnapshot,
    onError: setError,
    onSelectPath: setSelectedPath,
    onWorkspaceViewChange: setWorkspaceView,
    confirm: confirmation.confirm
  })

  const comparisonLoader = useComparisonLoader({
    snapshot,
    selectedPath,
    workspaceView,
    repositoryReview: gitWorkflow.repositoryReview,
    onError: setError
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
    comparisonLoader.invalidate(change.changedPaths)
    startTransition(() => {
      const previous = appliedSnapshotRef.current
      const nextSnapshot: RepositorySnapshot = {
        ...change.snapshot,
        paths: change.snapshot.paths
          ?? (previous?.root === change.snapshot.root ? previous.paths : [])
      }
      applySnapshot(nextSnapshot)
      setRepositoryChange(change)
      if (selectedPath != null && change.changedPaths.includes(selectedPath)) {
        comparisonLoader.markRevision(change.revision)
      }
    })
  })

  useEffect(() => requireRepositoryApi().onDidChange(handleRepositoryChange), [])

  // The workspace chunk is what a folder needs first and the two viewer chunks
  // are what it needs second. Pulling them in while the main thread is idle is
  // what keeps the Suspense skeletons off screen in the common case.
  const hasSnapshot = snapshot != null
  useEffect(() => {
    const handle = window.requestIdleCallback(() => {
      void import('./RepositoryWorkspace').catch(ignorePrefetchFailure)
      if (!hasSnapshot) return
      void import('./DiffSurface').catch(ignorePrefetchFailure)
      void import('./MultiFileReview').catch(ignorePrefetchFailure)
    })
    return () => window.cancelIdleCallback(handle)
  }, [hasSnapshot])

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
    const root = document.documentElement
    root.style.setProperty('--font-ui', INTERFACE_FONTS[preferences.interfaceFont].fontFamily)
    root.style.setProperty('--font-mono', CODE_FONTS[preferences.codeFont].fontFamily)
    savePreferences(preferences)
    // Main paints the window background before the renderer exists, so it needs
    // its own copy of the two preferences that decide what the first frame looks like.
    void window.repository?.setStartupPreferences({
      themeType: getEditorThemeType(preferences.editorTheme),
      restoreLastFolder: preferences.restoreLastFolder
    })
  }, [preferences])

  useEffect(() => {
    saveRecentFolders(recentFolders)
  }, [recentFolders])

  // Most-recently-opened files, for the palette's Files group. Kept here because
  // it is the only place that sees every selection, wherever it came from.
  const snapshotRoot = snapshot?.root
  useEffect(() => {
    setRecentFiles([])
  }, [snapshotRoot])

  useEffect(() => {
    if (selectedPath == null) return
    setRecentFiles((current) => current[0] === selectedPath
      ? current
      : [selectedPath, ...current.filter((path) => path !== selectedPath)].slice(0, RECENT_FILE_LIMIT))
  }, [selectedPath])

  // Shared by the keyboard shortcuts and the command palette, so every command
  // the palette lists actually does something.
  const runCommand = useCallback((command: AppCommand) => {
    // While settings is modal only the two commands that manage overlays run —
    // the palette reaches this too, and everything else would act on inert UI.
    if (settingsOpen && command !== 'openSettings' && command !== 'openCommandPalette') return
    if (command === 'openSettings') {
      commandPaletteRef.current?.close()
      setSettingsOpen(true)
    } else if (command === 'openCommandPalette') {
      commandPaletteRef.current?.toggle()
    } else if (command === 'goToFile' || command === 'searchContent') {
      search.inputRef.current?.focus()
    } else if (command === 'openFolder') {
      void openFolder()
    } else if (command === 'toggleSidebar' && hasSnapshot) {
      toggleSidebar()
    } else if (command === 'toggleWordWrap') {
      setPreferences((current) => ({ ...current, wordWrap: !current.wordWrap }))
    } else if (command === 'toggleFoldUnchanged') {
      setPreferences((current) => ({ ...current, foldUnchanged: !current.foldUnchanged }))
    } else if (command === 'toggleTerminal' && hasSnapshot) {
      terminal.toggle()
    }
  }, [hasSnapshot, openFolder, search.inputRef, settingsOpen, terminal.toggle, toggleSidebar])

  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape' && commandPaletteRef.current?.close()) {
      event.preventDefault()
      return
    }
    // Settings is a modal <dialog>: Escape reaches it as `cancel`, which runs its
    // own 140ms exit. Closing it from here would skip that.
    if (event.key === 'Escape' && settingsOpen) return
    if (event.key === 'Escape' && gitWorkflow.panelOpen) {
      event.preventDefault()
      gitWorkflow.setPanelOpen(false)
      return
    }
    if (event.key === 'Escape' && search.isOpen) {
      event.preventDefault()
      search.dismiss()
      return
    }
    if (event.defaultPrevented || event.repeat) return
    const command = commandFromEvent(event, preferences.keybindings)
    if (command == null) return
    event.preventDefault()
    runCommand(command)
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const dismissSearchOnOutsidePointer = useEffectEvent((event: PointerEvent): void => {
    if (!search.isOpen || isInsideSearchSurface(event.target)) return
    search.dismiss()
  })

  useEffect(() => {
    window.addEventListener('pointerdown', dismissSearchOnOutsidePointer, true)
    return () => window.removeEventListener('pointerdown', dismissSearchOnOutsidePointer, true)
  }, [])

  const view: AppLayoutProps = {
    snapshot, selectedPath, repositoryChange, opening, openingRecentPath,
    comparison: comparisonLoader.comparison, loadingDiff: comparisonLoader.loading,
    error, sidebarVisible, diffStyle, workspaceView,
    terminalOpen: terminal.open, terminalMounted: terminal.mounted,
    terminalHeight: terminal.height, terminalResizing: terminal.resizing,
    preferences, settingsOpen,
    recentFolders, search, commandPaletteRef, terminalDockRef: terminal.dockRef, gitWorkflow,
    setSettingsOpen, setError, setRecentFolders, setPreferences, setSelectedPath, onComparisonSaved: comparisonLoader.save,
    setDiffStyle, setWorkspaceView, setTerminalHeight: terminal.setHeight, setTerminalResizing: terminal.setResizing,
    toggleSidebar, toggleTerminal: terminal.toggle, closeTerminal: terminal.close,
    commitTerminalHeight: terminal.commitHeight, openFolder,
    openRecentFolder, openPullRequestFromPalette, openSettings, runCommand, recentFiles,
    confirmRequest: confirmation.request, confirm: confirmation.confirm, resolveConfirm: confirmation.resolve
  }
  return <AppLayout {...view} />
}
