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
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject
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
import type { CommandPaletteHandle } from './CommandPalette'
import { commandFromEvent, formatTerminalToggleShortcut, type AppCommand } from './keybindings'
import {
  CODE_FONTS,
  getEditorThemeType,
  INTERFACE_FONTS,
  loadPreferences,
  savePreferences,
  type AppPreferences
} from './preferences'
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
import { usePresence, useRetainedPresence } from './usePresence'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'
import { useConfirm } from './useConfirm'
import { agentSubjectForWorld, formatAgentReviewContext } from './agentReviewContext'
import { automaticWorkspaceView } from './workspaceMode'
import { WorldStrip } from './WorldStrip'
import { findCollisionPaths } from './useReviewWorlds'
import {
  getLoadedWorkspaceRoot,
  preloadWorkspaceRoot,
  preloadWorkspaceViewer,
  subscribeWorkspaceRoot
} from './workspaceBoot'
import { markRendererStartup } from './startupMetrics'
import { useDebouncedPersist } from './useDebouncedPersist'

const TerminalDock = lazy(() => import('./TerminalDock'))
const RepositoryPanel = lazy(async () => ({
  default: (await import('./GitHubPanel')).RepositoryPanel
}))
const SettingsPage = lazy(async () => ({
  default: (await import('./SettingsPage')).SettingsPage
}))
let commandPaletteModule: Promise<typeof import('./CommandPalette')> | null = null
function preloadCommandPalette(): Promise<typeof import('./CommandPalette')> {
  commandPaletteModule ??= import('./CommandPalette')
  return commandPaletteModule
}
const CommandPaletteController = lazy(async () => ({
  default: (await preloadCommandPalette()).CommandPaletteController
}))

function useCommandPaletteLoader(onError: (message: string) => void): {
  controllerRef: RefObject<CommandPaletteHandle | null>
  mounted: boolean
  attach(handle: CommandPaletteHandle | null): void
  close(): void
  toggle(): void
} {
  const controllerRef = useRef<CommandPaletteHandle>(null)
  const [mounted, setMounted] = useState(false)
  const openOnMountRef = useRef(false)
  const attach = useCallback((handle: CommandPaletteHandle | null) => {
    controllerRef.current = handle
    if (handle == null || !openOnMountRef.current) return
    openOnMountRef.current = false
    handle.toggle()
  }, [])
  const close = useCallback(() => {
    openOnMountRef.current = false
    controllerRef.current?.close()
  }, [])
  const toggle = useCallback(() => {
    const controller = controllerRef.current
    if (controller != null) {
      controller.toggle()
      return
    }
    openOnMountRef.current = true
    setMounted(true)
    void preloadCommandPalette().catch((error: unknown) => {
      openOnMountRef.current = false
      onError(getErrorMessage(error))
    })
  }, [onError])
  return useMemo(
    () => ({ controllerRef, mounted, attach, close, toggle }),
    [attach, close, mounted, toggle]
  )
}

const NO_PATHS: readonly string[] = Object.freeze([])
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

interface AppShortcutOptions {
  commandPaletteRef: RefObject<CommandPaletteHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  keybindings: AppPreferences['keybindings']
  runCommand(command: AppCommand): void
  search: RepositorySearchController
  settingsOpen: boolean
}

function useAppShortcuts({
  commandPaletteRef,
  gitWorkflow,
  keybindings,
  runCommand,
  search,
  settingsOpen
}: AppShortcutOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Meta') void preloadCommandPalette()
    // Leaf surfaces (comment drafts, find, open dialogs) preventDefault first.
    // Settings is a modal <dialog>: Escape reaches it as `cancel`, which runs its
    // own 160ms exit. Closing it from here would skip that.
    if (event.defaultPrevented || event.repeat) return
    if (event.key === 'Escape' && document.querySelector('dialog[open]') != null) return
    if (event.key === 'Escape' && commandPaletteRef.current?.close()) {
      event.preventDefault()
      return
    }
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
    if (!settingsOpen && event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        gitWorkflow.openNewWorld()
        return
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        gitWorkflow.closeReview()
        return
      }
      if (event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        gitWorkflow.cycleWorld(event.key === '[' ? -1 : 1)
        return
      }
    }
    const command = commandFromEvent(event, keybindings)
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
}

interface AppLayoutProps {
  WorkspaceRoot: ReturnType<typeof getLoadedWorkspaceRoot>
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
  commandPaletteMounted: boolean
  setCommandPaletteHandle(handle: CommandPaletteHandle | null): void
  terminalDockRef: React.RefObject<TerminalDockHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  setRecentFolders: React.Dispatch<React.SetStateAction<RecentFolder[]>>
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  onComparisonSaved(comparison: FileComparison): void
  setDiffStyle: React.Dispatch<React.SetStateAction<DiffStyle>>
  setWorkspaceView(view: WorkspaceView): void
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
  const { WorkspaceRoot } = view
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
  const reviewLoadingPresence = usePresence(gitWorkflow.actionKey?.startsWith('review:') ?? false, 160)
  const repositoryPanelPresence = usePresence(gitWorkflow.panelOpen, 220)
  // The message is null the moment the banner is dismissed; the exit still needs text.
  const errorPresence = useRetainedPresence(view.error, 160)
  // Content hits for the file being edited become inline hint markers.
  const contentSearch = useMemo(
    () => ({ query: search.query, results: search.contentResults }),
    [search.contentResults, search.query]
  )
  const workspaceContentSearch = view.workspaceView === 'file' ? contentSearch : undefined
  // Keep the tab/review summary stable while answer tokens stream.
  const agentSubject = useMemo(
    () => agentSubjectForWorld(gitWorkflow.activeWorld),
    [gitWorkflow.activeWorld]
  )
  const agentContext = useMemo(
    () => formatAgentReviewContext(gitWorkflow.repositoryReview, agentSubject),
    [agentSubject, gitWorkflow.repositoryReview]
  )
  const agent = useAgentSession({ context: agentContext, subject: agentSubject })
  const collisionPaths = useMemo(
    () => findCollisionPaths(view.snapshot?.statuses ?? [], gitWorkflow.repositoryReview),
    [gitWorkflow.repositoryReview, view.snapshot?.statuses]
  )
  const activeNewWorld = gitWorkflow.activeWorld?.source === 'new' ? gitWorkflow.activeWorld : null
  return <>
    <WorldStrip
      worlds={gitWorkflow.worlds}
      activeWorldId={gitWorkflow.activeWorld?.worldId ?? null}
      collisionCount={collisionPaths.size}
      onFocus={gitWorkflow.focusWorld}
      onClose={gitWorkflow.closeReview}
      onNew={gitWorkflow.openNewWorld}
    />

    <Titlebar snapshot={activeNewWorld == null ? view.snapshot : null} sidebarVisible={view.sidebarVisible}
      searchQuery={search.query} searchInputRef={search.inputRef} searchingContent={search.searchingContent}
      activeSearchResultId={search.activeResultIndex >= 0
        ? `repository-search-result-${search.activeResultIndex}` : undefined}
      newTab={activeNewWorld != null}
      locator={activeNewWorld?.locator ?? ''}
      locatorBusy={gitWorkflow.actionKey === 'resolve:pull-request'}
      opening={view.opening} keybindings={view.preferences.keybindings}
      onSidebarToggle={view.toggleSidebar}
      onSearchQueryChange={search.changeQuery} onSearchKeyDown={search.handleKeyDown} onOpen={view.openFolder}
      onLocatorChange={gitWorkflow.updateNewWorldLocator}
      onLocatorSubmit={() => {
        const locator = activeNewWorld?.locator.trim() ?? ''
        if (locator === '') return
        void gitWorkflow.openPullRequestFromLocator(locator)
      }}
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

    {view.commandPaletteMounted ? <Suspense fallback={null}>
      <CommandPaletteController ref={view.setCommandPaletteHandle}
        gitRepositoryOpen={view.snapshot?.kind === 'git'} projectOpen={view.snapshot != null}
        keybindings={view.preferences.keybindings} onOpenPullRequest={view.openPullRequestFromPalette}
        onOpenRepository={gitWorkflow.openPanel} onOpenSettings={view.openSettings}
        onToggleTerminal={view.toggleTerminal}
        onRunCommand={view.runCommand}
        recentFiles={view.recentFiles} onOpenFile={view.setSelectedPath}
        branches={paletteBranches} onSwitchBranch={(branch) => void gitWorkflow.switchBranch(branch)} />
    </Suspense> : null}
    {view.settingsOpen ? <Suspense fallback={null}>
      <SettingsPage preferences={view.preferences} onChange={view.setPreferences}
        onClose={() => view.setSettingsOpen(false)} />
    </Suspense> : null}
    {!view.settingsOpen && search.isOpen ? <SearchResults query={search.query}
      fileResults={search.fileResults} contentResults={search.contentResults} searchingContent={search.searchingContent}
      activeIndex={search.activeResultIndex} onActiveIndexChange={search.setActiveResultIndex}
      onSelect={search.selectResult} /> : null}
    {!view.settingsOpen && errorPresence.mounted && errorPresence.retained != null
      ? <ErrorBanner key={errorPresence.retained} message={errorPresence.retained} closing={errorPresence.closing}
          onDismiss={() => view.setError(null)} />
      : null}

    {activeNewWorld != null || view.snapshot == null ? (view.settingsOpen ? null : <Welcome onOpen={view.openFolder} opening={view.opening}
      recentFolders={view.recentFolders} openingRecentPath={view.openingRecentPath} onRecentOpen={view.openRecentFolder}
      onRecentRemove={(path) => view.setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
      keybindings={view.preferences.keybindings} />) : (
      <div className="workspace-host" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
        <div className={`workspace ${view.sidebarVisible ? '' : 'sidebar-hidden'} ${agent.open ? 'agent-open' : ''}`}>
          {WorkspaceRoot == null ? <WorkspaceSkeleton /> : (
              <WorkspaceRoot workspaceKey={view.snapshot.root}
                theme={view.preferences.editorTheme}
                snapshot={view.snapshot} selectedPath={view.selectedPath} comparison={view.comparison}
                loadingDiff={view.loadingDiff} diffStyle={view.diffStyle} workspaceView={view.workspaceView}
                preferences={view.preferences} onPreferencesChange={view.setPreferences}
                onAttachToAgent={agent.attach}
                repositoryReview={gitWorkflow.repositoryReview} repositoryChange={view.repositoryChange}
                reviewWorldSource={gitWorkflow.activeWorld?.source === 'new'
                  ? 'desk'
                  : gitWorkflow.activeWorld?.source ?? 'desk'}
                reviewCheckpoint={gitWorkflow.reviewCheckpoint}
                checkpointChangedFileCount={gitWorkflow.checkpointChangedFileCount}
                checkpointRemovedFileCount={gitWorkflow.checkpointRemovedFileCount}
                reviewReady={gitWorkflow.reviewReady}
                sinceRemovedPaths={gitWorkflow.activeWorld?.source === 'since'
                  ? gitWorkflow.activeWorld.removedPaths : NO_PATHS}
                sinceUncertainPaths={gitWorkflow.activeWorld?.source === 'since'
                  ? gitWorkflow.activeWorld.uncertainPaths : NO_PATHS}
                collisionPaths={collisionPaths}
                initialReviewScrollTop={gitWorkflow.initialReviewScrollTop}
                onReviewScrollPositionChange={gitWorkflow.rememberReviewScroll}
                contentSearch={workspaceContentSearch}
                onSelectPath={view.setSelectedPath} onDiffStyleChange={view.setDiffStyle}
                onWorkspaceViewChange={view.setWorkspaceView} onClosePullRequestReview={gitWorkflow.closeReview}
                onSetReviewCheckpoint={gitWorkflow.setReviewCheckpoint}
                onOpenSinceReview={gitWorkflow.openSinceReview}
                submittingPullRequestReview={gitWorkflow.submittingReview} pullRequestReviewMessage={gitWorkflow.submissionMessage}
                onSubmitPullRequestReview={gitWorkflow.submitReview} onComparisonSaved={view.onComparisonSaved}
                onError={view.setError}
                patchLoadError={gitWorkflow.activeWorld?.source === 'patch'
                  ? gitWorkflow.activeWorld.errorMessage
                  : null}
                reviewWorldId={gitWorkflow.activeWorld?.worldId ?? `desk:${view.snapshot.root}`} />
          )}
          <AgentDock session={agent}
            confirm={view.confirm}
            contextLabel={gitWorkflow.repositoryReview == null ? 'your working tree' : 'this review'} />
        </div>
      </div>
    )}
  </>
})

const RECENT_FILE_LIMIT = 10

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

export interface AppProps {
  initialPreferences?: AppPreferences
  sessionSnapshot?: Promise<RepositorySnapshot | null>
}

export function App({
  initialPreferences = loadPreferences(),
  sessionSnapshot
}: AppProps = {}): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('reactCommitted'), [])
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
  const [preferences, setPreferences] = useState<AppPreferences>(initialPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders)
  const [repositoryChange, setRepositoryChange] = useState<RepositoryChangeEvent | null>(null)
  const [startupSessionSnapshot] = useState(() => sessionSnapshot
    ?? window.repository?.getSessionSnapshot()
    ?? Promise.resolve(null))
  const WorkspaceRoot = useSyncExternalStore(
    subscribeWorkspaceRoot,
    getLoadedWorkspaceRoot,
    getLoadedWorkspaceRoot
  )
  const commandPalette = useCommandPaletteLoader(setError)
  const [recentFiles, setRecentFiles] = useState<readonly string[]>([])
  const confirmation = useConfirm()
  const search = useRepositorySearch(snapshot, setSelectedPath, setError)
  const closeOverlays = useCallback(() => {
    commandPalette.close()
    setSettingsOpen(false)
  }, [commandPalette])
  const terminal = useTerminalVisibility({
    enabled: snapshot != null,
    keybindings: preferences.keybindings,
    onBeforeOpen: closeOverlays
  })

  const appliedSnapshotRef = useRef<RepositorySnapshot | null>(null)

  const ensureWorkspaceRoot = useCallback(() => {
    void preloadWorkspaceRoot().catch((loadError: unknown) => setError(getErrorMessage(loadError)))
  }, [])

  const changeWorkspaceView = useCallback((nextView: WorkspaceView) => {
    void preloadWorkspaceViewer(nextView).catch((loadError: unknown) => setError(getErrorMessage(loadError)))
    setWorkspaceView(nextView)
  }, [])

  const applySnapshot = useCallback(
    (nextSnapshot: RepositorySnapshot) => {
      const previous = appliedSnapshotRef.current
      const snapshotToApply = previous?.root === nextSnapshot.root && samePathList(previous.paths, nextSnapshot.paths)
        ? { ...nextSnapshot, paths: previous.paths }
        : nextSnapshot
      appliedSnapshotRef.current = snapshotToApply
      markRendererStartup('snapshotReady')
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

  const activateSnapshot = useCallback((nextSnapshot: RepositorySnapshot | null) => {
    if (nextSnapshot != null) {
      applySnapshot(nextSnapshot)
      return
    }
    appliedSnapshotRef.current = null
    setSnapshot(null)
    setSelectedPath(null)
    setRepositoryChange(null)
  }, [applySnapshot])

  const gitWorkflow = useGitWorkflow({
    snapshot,
    selectedPath,
    workspaceView,
    applySnapshot,
    activateSnapshot,
    onError: setError,
    onSelectPath: setSelectedPath,
    onWorkspaceViewChange: changeWorkspaceView,
    confirm: confirmation.confirm
  })
  const openPullRequestReview = gitWorkflow.openPullRequestReview
  const openWorkingTree = gitWorkflow.openWorkingTree
  const reviewWorlds = gitWorkflow.worlds
  const syncRepositorySnapshot = gitWorkflow.syncRepositorySnapshot

  const comparisonLoader = useComparisonLoader({
    snapshot,
    selectedPath,
    workspaceView,
    repositoryReview: gitWorkflow.repositoryReview,
    onError: setError
  })

  const openPullRequestFromPalette = useCallback((selector: number | string) => {
    void openPullRequestReview(selector)
  }, [openPullRequestReview])

  const openSettings = useCallback(() => {
    commandPalette.close()
    setSettingsOpen(true)
  }, [commandPalette])

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((visible) => !visible)
  }, [])

  const openFolder = useCallback(async () => {
    ensureWorkspaceRoot()
    setOpening(true)
    setError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().openFolder()
      if (nextSnapshot != null) {
        setSelectedPath(null)
        openWorkingTree(nextSnapshot)
        changeWorkspaceView(automaticWorkspaceView(nextSnapshot, null))
        setRecentFolders((current) => rememberRecentFolder(current, nextSnapshot))
      }
    } catch (openError) {
      setError(getErrorMessage(openError))
    } finally {
      setOpening(false)
    }
  }, [changeWorkspaceView, ensureWorkspaceRoot, openWorkingTree])

  const openRecentFolder = useCallback(async (folder: RecentFolder) => {
    ensureWorkspaceRoot()
    setOpeningRecentPath(folder.path)
    setError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().openPath(folder.path)
      setSelectedPath(null)
      openWorkingTree(nextSnapshot)
      changeWorkspaceView(automaticWorkspaceView(nextSnapshot, null))
      setRecentFolders((current) => rememberRecentFolder(current, nextSnapshot))
    } catch (openError) {
      setError(`Cannot open “${folder.name}”. ${getErrorMessage(openError)}`)
    } finally {
      setOpeningRecentPath(null)
    }
  }, [changeWorkspaceView, ensureWorkspaceRoot, openWorkingTree])

  const handleRepositoryChange = useEffectEvent((change: RepositoryChangeEvent): void => {
    const previousWorld = reviewWorlds.find((world) => world.source !== 'new'
      && world.root === change.snapshot.root)
    const previousSnapshot = previousWorld == null || previousWorld.source === 'new'
      ? null
      : previousWorld.snapshot
    const nextSnapshot: RepositorySnapshot = {
      ...change.snapshot,
      paths: change.snapshot.paths ?? previousSnapshot?.paths ?? []
    }
    syncRepositorySnapshot(nextSnapshot)
    if (appliedSnapshotRef.current?.root !== change.snapshot.root) return
    comparisonLoader.invalidate(change.changedPaths)
    startTransition(() => {
      applySnapshot(nextSnapshot)
      setRepositoryChange(change)
      if (selectedPath != null && change.changedPaths.includes(selectedPath)) {
        comparisonLoader.markRevision(change.revision)
      }
    })
  })

  useEffect(() => requireRepositoryApi().onDidChange(handleRepositoryChange), [])

  const hasSnapshot = snapshot != null

  useEffect(() => {
    let cancelled = false
    void startupSessionSnapshot.then((restoredSnapshot) => {
      if (cancelled || restoredSnapshot == null) return
      ensureWorkspaceRoot()
      openWorkingTree(restoredSnapshot)
      changeWorkspaceView(automaticWorkspaceView(restoredSnapshot, null))
      setRecentFolders((current) => rememberRecentFolder(current, restoredSnapshot))
    }).catch((sessionError: unknown) => {
      if (!cancelled) setError(getErrorMessage(sessionError))
    })
    return () => { cancelled = true }
  }, [changeWorkspaceView, ensureWorkspaceRoot, openWorkingTree, startupSessionSnapshot])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--font-ui', INTERFACE_FONTS[preferences.interfaceFont].fontFamily)
    root.style.setProperty('--font-mono', CODE_FONTS[preferences.codeFont].fontFamily)
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      getEditorThemeType(preferences.editorTheme) === 'light' ? '#f7f8fa' : '#0c0d0f'
    )
  }, [preferences.codeFont, preferences.editorTheme, preferences.interfaceFont])

  useDebouncedPersist(preferences, (settledPreferences) => {
    savePreferences(settledPreferences)
    // Main paints the window background before the renderer exists, so it needs
    // its own copy of the two preferences that decide what the first frame looks like.
    void window.repository?.setStartupPreferences({
      themeType: getEditorThemeType(settledPreferences.editorTheme),
      restoreLastFolder: settledPreferences.restoreLastFolder
    })
  }, 150)

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

  const toggleTerminal = terminal.toggle

  // Shared by the keyboard shortcuts and the command palette, so every command
  // the palette lists actually does something.
  const runCommand = useCallback((command: AppCommand) => {
    // While settings is modal only the two commands that manage overlays run —
    // the palette reaches this too, and everything else would act on inert UI.
    if (settingsOpen && command !== 'openSettings' && command !== 'openCommandPalette') return
    if (command === 'openSettings') {
      commandPalette.close()
      setSettingsOpen(true)
    } else if (command === 'openCommandPalette') {
      commandPalette.toggle()
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
      toggleTerminal()
    }
  }, [commandPalette, hasSnapshot, openFolder, search.inputRef, settingsOpen, toggleSidebar, toggleTerminal])

  useAppShortcuts({
    commandPaletteRef: commandPalette.controllerRef,
    gitWorkflow,
    keybindings: preferences.keybindings,
    runCommand,
    search,
    settingsOpen
  })

  const view: AppLayoutProps = {
    WorkspaceRoot, snapshot, selectedPath, repositoryChange, opening, openingRecentPath,
    comparison: comparisonLoader.comparison, loadingDiff: comparisonLoader.loading,
    error, sidebarVisible, diffStyle, workspaceView,
    terminalOpen: terminal.open, terminalMounted: terminal.mounted,
    terminalHeight: terminal.height, terminalResizing: terminal.resizing,
    preferences, settingsOpen,
    recentFolders, search, commandPaletteRef: commandPalette.controllerRef,
    commandPaletteMounted: commandPalette.mounted, setCommandPaletteHandle: commandPalette.attach,
    terminalDockRef: terminal.dockRef, gitWorkflow,
    setSettingsOpen, setError, setRecentFolders, setPreferences, setSelectedPath, onComparisonSaved: comparisonLoader.save,
    setDiffStyle, setWorkspaceView: changeWorkspaceView,
    setTerminalHeight: terminal.setHeight, setTerminalResizing: terminal.setResizing,
    toggleSidebar, toggleTerminal: terminal.toggle, closeTerminal: terminal.close,
    commitTerminalHeight: terminal.commitHeight, openFolder,
    openRecentFolder, openPullRequestFromPalette, openSettings, runCommand, recentFiles,
    confirmRequest: confirmation.request, confirm: confirmation.confirm, resolveConfirm: confirmation.resolve
  }
  return <AppLayout {...view} />
}
