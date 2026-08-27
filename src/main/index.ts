import { isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell, type RenderProcessGoneDetails } from 'electron'

import { IPC_CHANNELS, type PerformanceMetricsDetail, type RendererTermination } from '../shared/contracts.js'
import { AgentService, coalesceAgentTextEvents } from './agentService.js'
import { isPathWithinApprovedRoots, RepositoryService } from './repository.js'
import { RepositoryWatcher } from './repositoryWatcher.js'
import { DEFAULT_SESSION_STATE, loadSessionState, saveSessionState, type SessionState } from './sessionStore.js'
import { TerminalService } from './terminalService.js'
import { loadWindowState, saveWindowState } from './windowState.js'

const PRODUCT_NAME = 'Horus'
const startHidden = process.env.HORUS_BACKGROUND === '1'
const DEFAULT_WINDOW_WIDTH = 1_440
const DEFAULT_WINDOW_HEIGHT = 920
const GEOMETRY_SAVE_DEBOUNCE_MS = 500
// What Electron paints before first paint, during a resize and behind
// overscroll. A dark value under a light theme flashes on every drag.
const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#f7f8fa' } as const

// Ahead of the service construction below: a second launch hands its arguments
// to the running instance and must not start a watcher on its way out. A
// background launch is a deliberate extra process, so it never takes the lock.
if (!startHidden && !app.requestSingleInstanceLock()) app.exit(0)

app.setName(PRODUCT_NAME)
process.title = PRODUCT_NAME

const repository = new RepositoryService()
const agentService = new AgentService()
const terminalService = new TerminalService()
const repositoryWatcher = new RepositoryWatcher(
  () => repository.refresh(),
  (change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.didChange, change)
    }
  },
  (error) => console.error('Repository watcher failed:', error)
)
repository.setSelfWriteObserver((path) => repositoryWatcher.expectSelfWrite(path))

const MAX_AUTOMATIC_RECOVERIES = 3
const RECOVERY_WINDOW_MS = 60_000
const UNRESPONSIVE_RECOVERY_DELAY_MS = 8_000
const MAX_RENDERER_TERMINATION_RECORDS = 20
let lastRendererTermination: RendererTermination | null = null
let userDataPath = ''
let sessionState: SessionState = DEFAULT_SESSION_STATE
// Held so the getSessionSnapshot handler can wait for it: the restore runs
// alongside the renderer boot, and without the wait the renderer asks before
// the first git call lands and falls back to the Welcome screen.
let restoreLastSession: Promise<unknown> | null = null
// Bumped whenever the user opens a folder, so a session restore still resolving
// in the background knows it has been superseded.
let sessionGeneration = 0

function rendererDiagnosticsPath(): string {
  return join(app.getPath('userData'), 'renderer-terminations.json')
}

async function loadLastRendererTermination(): Promise<void> {
  try {
    const records = JSON.parse(await readFile(rendererDiagnosticsPath(), 'utf8')) as RendererTermination[]
    lastRendererTermination = records.at(-1) ?? null
  } catch {
    lastRendererTermination = null
  }
}

async function recordRendererTermination(details: RenderProcessGoneDetails): Promise<void> {
  const record: RendererTermination = {
    reason: details.reason,
    exitCode: details.exitCode,
    occurredAt: Date.now()
  }
  lastRendererTermination = record
  let records: RendererTermination[] = []
  try {
    records = JSON.parse(await readFile(rendererDiagnosticsPath(), 'utf8')) as RendererTermination[]
  } catch {
    // The diagnostic file is optional and can be created on first failure.
  }
  records.push(record)
  await writeFile(
    rendererDiagnosticsPath(),
    JSON.stringify(records.slice(-MAX_RENDERER_TERMINATION_RECORDS), null, 2),
    'utf8'
  ).catch((error) => console.error('Could not persist renderer termination diagnostics:', error))
}

function trackSnapshot(snapshot: Awaited<ReturnType<RepositoryService['refresh']>>): typeof snapshot {
  repositoryWatcher.sync(snapshot)
  return snapshot
}

function startTracking(snapshot: Awaited<ReturnType<RepositoryService['open']>>): typeof snapshot {
  repositoryWatcher.start(snapshot)
  return snapshot
}

function persistWindowGeometry(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const write = (): void => {
    if (window.isDestroyed()) return
    saveWindowState(userDataPath, { ...window.getNormalBounds(), maximized: window.isMaximized() })
  }

  const schedule = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(write, GEOMETRY_SAVE_DEBOUNCE_MS)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  // A debounced write loses the last drag when the app quits, and by 'closed'
  // the bounds are already gone, so this one goes straight to disk.
  window.on('close', () => {
    if (timer != null) clearTimeout(timer)
    timer = null
    write()
  })
}

function createMainWindow(): BrowserWindow {
  const savedGeometry = startHidden
    ? null
    : loadWindowState(userDataPath, screen.getAllDisplays().map((display) => display.workArea))
  const window = new BrowserWindow({
    x: savedGeometry?.x,
    y: savedGeometry?.y,
    width: savedGeometry?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedGeometry?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: PRODUCT_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: WINDOW_BACKGROUND[sessionState.themeType],
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  const recoveryTimes: number[] = []

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer == null) return
    clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  const loadRenderer = (): void => {
    if (process.env.ELECTRON_RENDERER_URL != null) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  const scheduleRecovery = (reason: string, delay = 400): void => {
    if (window.isDestroyed()) return
    const now = Date.now()
    while (recoveryTimes[0] != null && now - recoveryTimes[0] > RECOVERY_WINDOW_MS) {
      recoveryTimes.shift()
    }
    if (recoveryTimes.length >= MAX_AUTOMATIC_RECOVERIES) {
      console.error(`Renderer recovery stopped after repeated failures: ${reason}`)
      window.show()
      return
    }
    clearRecoveryTimer()
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      recoveryTimes.push(Date.now())
      console.warn(`Reloading renderer after ${reason}.`)
      loadRenderer()
    }, delay)
  }

  window.once('ready-to-show', () => {
    if (startHidden) return
    if (savedGeometry?.maximized === true) window.maximize()
    window.show()
  })
  // Fires only when the renderer's beforeunload handler objected, which it does
  // while a draft is unsaved. preventDefault here means "ignore the objection
  // and close", so it is the discard branch.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Close without saving?',
      detail: 'Edits that have not been saved will be lost.'
    })
    if (choice === 0) event.preventDefault()
  })
  if (!startHidden) persistWindowGeometry(window)
  window.on('responsive', clearRecoveryTimer)
  window.on('unresponsive', () => scheduleRecovery('the window stopped responding', UNRESPONSIVE_RECOVERY_DELAY_MS))
  window.on('closed', clearRecoveryTimer)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A dropped link or a stray anchor must never replace the app with a web page:
  // the renderer has preload privileges and there is no way back from a navigation.
  window.webContents.on('will-navigate', (event, url) => {
    // A reload — the error boundary's only way out — is a renderer-initiated
    // navigation to the page already loaded, so it must be let through.
    if (url === window.webContents.getURL()) return
    const devServerUrl = process.env.ELECTRON_RENDERER_URL
    if (devServerUrl != null && url.startsWith(devServerUrl)) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
  // The 92px traffic-light reserve in the titlebar collapses in fullscreen.
  const publishFullscreen = (fullscreen: boolean) => (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(IPC_CHANNELS.fullscreenChange, fullscreen)
  }
  window.on('enter-full-screen', publishFullscreen(true))
  window.on('leave-full-screen', publishFullscreen(false))
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed() && window.isFullScreen()) publishFullscreen(true)()
  })
  window.webContents.on('found-in-page', (_event, result) => {
    window.webContents.send(IPC_CHANNELS.foundInPage, {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate
    })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    void recordRendererTermination(details)
    // Nothing is left to receive the answer, and the CLI would keep spending
    // plan tokens on it until its own timeout.
    agentService.cancelAll()
    scheduleRecovery(`renderer process exit (${details.reason})`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      scheduleRecovery(`main document load failure (${errorCode}: ${errorDescription})`)
    }
  })

  loadRenderer()

  return window
}

async function collectPerformanceDetail(
  processMetrics: Electron.ProcessMetric[]
): Promise<Pick<PerformanceMetricsDetail, 'memoryByProcessType' | 'mainPrivateMegabytes'>> {
  const mainMemory = await process.getProcessMemoryInfo()
  const megabytesByType = new Map<string, number>()
  for (const metric of processMetrics) {
    megabytesByType.set(
      metric.type,
      (megabytesByType.get(metric.type) ?? 0) + metric.memory.workingSetSize / 1_024
    )
  }
  return {
    memoryByProcessType: [...megabytesByType]
      .map(([type, megabytes]) => ({ type, megabytes }))
      .sort((left, right) => right.megabytes - left.megabytes),
    mainPrivateMegabytes: mainMemory.private / 1_024
  }
}

// One `RepositoryService` serves every open, so a user-initiated open must not
// interleave with the session restore still running at boot: both mutate the same
// root, caches and watcher binding.
async function openRepository(folderPath: string): Promise<ReturnType<typeof startTracking>> {
  sessionGeneration += 1
  await restoreLastSession?.catch(() => undefined)
  repositoryWatcher.stop()
  const snapshot = await repository.open(folderPath).then(startTracking)
  terminalService.killAll()
  agentService.cancelAll()
  rememberOpenedRoot(snapshot.root)
  return snapshot
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getSessionSnapshot, async () => {
    await restoreLastSession
    return repository.getSessionSnapshot()
  })
  ipcMain.handle(IPC_CHANNELS.openFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open folder',
      properties: ['openDirectory']
    })
    const folderPath = result.filePaths[0]
    if (result.canceled || folderPath == null) return null
    return openRepository(folderPath)
  })
  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) {
      throw new Error('Recent folder path must be absolute.')
    }
    if (!isPathWithinApprovedRoots(sessionState.approvedRoots, folderPath)) {
      throw new Error('Select this folder with Open Folder before reopening it from history.')
    }
    return openRepository(folderPath)
  })
  ipcMain.handle(IPC_CHANNELS.readClipboardText, (_event, type: unknown) => {
    if (type == null) return clipboard.readText()
    if (typeof type !== 'string' || type === '' || type.length > 200) {
      throw new Error('Clipboard format must be a short non-empty string.')
    }
    // @pierre/diffs uses a custom MIME format to preserve one value per caret.
    // Electron's readText argument selects a clipboard buffer, not a MIME type.
    return type === 'selection' || type === 'clipboard'
      ? clipboard.readText(type)
      : clipboard.read(type)
  })
  ipcMain.handle(IPC_CHANNELS.revealPath, (_event, relativePath: unknown) => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a repository before revealing a file.')
    if (typeof relativePath !== 'string' || relativePath === '' || isAbsolute(relativePath)) {
      throw new Error('Reveal path must be a relative repository path.')
    }
    const candidate = join(snapshot.root, relativePath)
    if (!isPathWithinApprovedRoots([snapshot.root], candidate)) {
      throw new Error('Reveal path must stay inside the open repository.')
    }
    shell.showItemInFolder(candidate)
  })
  ipcMain.handle(IPC_CHANNELS.refresh, () => repository.refresh().then(trackSnapshot))
  ipcMain.handle(IPC_CHANNELS.getComparison, (_event, path: string) =>
    repository.getComparison(path)
  )
  ipcMain.handle(IPC_CHANNELS.saveWorkingFile, async (_event, request: unknown) => {
    const comparison = await repository.saveWorkingFile(request)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot != null) trackSnapshot(snapshot)
    return comparison
  })
  ipcMain.handle(IPC_CHANNELS.getWorkingTreePatch, (_event, paths: unknown) =>
    repository.getWorkingTreePatch(paths)
  )
  ipcMain.handle(IPC_CHANNELS.searchContent, (_event, query: string) =>
    repository.searchContent(query)
  )
  ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => repository.cancelContentSearch())
  ipcMain.handle(IPC_CHANNELS.getGitIntegration, () => repository.getGitIntegration())
  ipcMain.handle(IPC_CHANNELS.getPullRequestInbox, () => repository.getPullRequestInbox())
  ipcMain.handle(IPC_CHANNELS.getClosedPullRequests, () => repository.getClosedPullRequests())
  ipcMain.on(IPC_CHANNELS.cancelPullRequestReview, () => repository.cancelPullRequestReview())
  ipcMain.handle(IPC_CHANNELS.getAgentModels, async () => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a repository before loading agent models.')
    return agentService.getModels(snapshot.root)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentStatuses, (_event, provider: unknown) =>
    agentService.getStatuses(provider))
  ipcMain.handle(IPC_CHANNELS.loginAgent, (_event, provider: unknown) =>
    agentService.login(provider))
  ipcMain.handle(IPC_CHANNELS.askAgent, async (event, request: unknown) => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a repository before asking the agent.')
    const sender = event.sender
    const stream = coalesceAgentTextEvents((agentEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.agentEvent, agentEvent)
    })
    try {
      await agentService.ask(request, snapshot.root, stream.emit)
    } finally {
      stream.flush()
    }
  })
  ipcMain.handle(IPC_CHANNELS.cancelAgent, (_event, id: unknown) => agentService.cancel(id))
  ipcMain.handle(IPC_CHANNELS.respondAgentApproval, (_event, requestId: unknown, decision: unknown) =>
    agentService.respondApproval(requestId, decision))
  ipcMain.handle(IPC_CHANNELS.createTerminal, (event, columns: unknown, rows: unknown) => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a project before starting a terminal.')
    return terminalService.create(event.sender, snapshot.root, columns, rows, app.getVersion())
  })
  ipcMain.on(IPC_CHANNELS.readyTerminal, (event, sessionId: unknown) => {
    terminalService.ready(event.sender.id, sessionId)
  })
  ipcMain.on(IPC_CHANNELS.writeTerminal, (event, sessionId: unknown, data: unknown) => {
    try {
      terminalService.write(event.sender.id, sessionId, data)
    } catch (error) {
      console.error('Rejected terminal input:', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.resizeTerminal, (event, sessionId: unknown, columns: unknown, rows: unknown) => {
    try {
      terminalService.resize(event.sender.id, sessionId, columns, rows)
    } catch (error) {
      console.error('Rejected terminal resize:', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.clearTerminal, (event, sessionId: unknown) => {
    terminalService.clear(event.sender.id, sessionId)
  })
  ipcMain.on(IPC_CHANNELS.setTerminalVisibility, (event, sessionId: unknown, visible: unknown) => {
    terminalService.setVisible(event.sender.id, sessionId, visible)
  })
  ipcMain.handle(IPC_CHANNELS.killTerminal, (event, sessionId: unknown) => {
    terminalService.kill(event.sender.id, sessionId)
  })
  ipcMain.handle(IPC_CHANNELS.getPullRequestConversation, (_event, selector: number | string) =>
    repository.getPullRequestConversation(selector))
  ipcMain.handle(IPC_CHANNELS.replyToPullRequestThread, (_event, threadId: unknown, body: unknown) =>
    repository.replyToPullRequestThread(threadId, body))
  ipcMain.handle(IPC_CHANNELS.setPullRequestThreadResolved, (_event, threadId: unknown, resolved: unknown) =>
    repository.setPullRequestThreadResolved(threadId, resolved))
  ipcMain.handle(IPC_CHANNELS.mergePullRequest, (_event, selector: number | string, strategy: unknown) =>
    repository.mergePullRequest(selector, strategy))
  ipcMain.handle(IPC_CHANNELS.markPullRequestReady, (_event, selector: number | string) =>
    repository.markPullRequestReady(selector))
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_event, name: string) =>
    repository.switchBranch(name).then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.getLocalBranchReview, (_event, baseRef: string, headRef: string) =>
    repository.getLocalBranchReview(baseRef, headRef)
  )
  ipcMain.handle(IPC_CHANNELS.getCommitReview, (_event, oid: string) =>
    repository.getCommitReview(oid)
  )
  ipcMain.handle(IPC_CHANNELS.fetchRemote, () => repository.fetchRemote())
  ipcMain.handle(IPC_CHANNELS.pullCurrentBranch, () =>
    repository.pullCurrentBranch().then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.pushCurrentBranch, () => repository.pushCurrentBranch())
  ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (event, selector: number | string) =>
    // Streamed back page by page: a review of a few thousand files takes long
    // enough to fetch that waiting for all of it reads as a hang.
    repository.getPullRequestReview(selector, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.pullRequestReviewProgress, progress)
    })
  )
  ipcMain.handle(IPC_CHANNELS.checkoutPullRequest, (_event, number: number) =>
    repository.checkoutPullRequest(number).then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.submitPullRequestReview, (_event, selector: number | string, commitId: unknown, reviewEvent: string, body: string, comments: unknown) =>
    repository.submitPullRequestReview(selector, commitId, reviewEvent, body, comments)
  )
  ipcMain.handle(IPC_CHANNELS.getPerformanceMetrics, async (_event, detailed: unknown) => {
    const processMetrics = app.getAppMetrics()
    let cpuPercent = 0
    let gpuProcessCpuPercent: number | null = null
    let memoryKilobytes = 0

    for (const metric of processMetrics) {
      cpuPercent += metric.cpu.percentCPUUsage
      memoryKilobytes += metric.memory.workingSetSize
      if (metric.type === 'GPU') {
        gpuProcessCpuPercent = (gpuProcessCpuPercent ?? 0) + metric.cpu.percentCPUUsage
      }
    }

    return {
      cpuPercent,
      gpuProcessCpuPercent,
      workingSetMegabytes: memoryKilobytes / 1_024,
      lastRendererTermination,
      processCount: processMetrics.length,
      production: app.isPackaged,
      sampledAt: Date.now(),
      detail: detailed === true ? await collectPerformanceDetail(processMetrics) : null
    }
  })
  ipcMain.handle(IPC_CHANNELS.setStartupPreferences, (event, preferences: unknown) => {
    if (typeof preferences !== 'object' || preferences == null) {
      throw new Error('Startup preferences must be an object.')
    }
    const { themeType, restoreLastFolder } = preferences as Record<string, unknown>
    if (themeType !== 'dark' && themeType !== 'light') throw new Error('Theme type must be dark or light.')
    if (typeof restoreLastFolder !== 'boolean') throw new Error('restoreLastFolder must be a boolean.')
    if (sessionState.themeType === themeType && sessionState.restoreLastFolder === restoreLastFolder) return
    const repainting = sessionState.themeType !== themeType
    sessionState = { ...sessionState, themeType, restoreLastFolder }
    saveSessionState(userDataPath, sessionState)
    // setBackgroundColor can flash on some macOS versions, so only on a real change.
    if (!repainting) return
    nativeTheme.themeSource = themeType
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(WINDOW_BACKGROUND[themeType])
  })
  ipcMain.handle(IPC_CHANNELS.setVisibility, (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibility must be a boolean.')
    repositoryWatcher.setSuspended(!visible)
  })
  ipcMain.handle(IPC_CHANNELS.findInPage, (event, query: unknown, forward: unknown, findNext: unknown) => {
    if (typeof query !== 'string' || typeof forward !== 'boolean' || typeof findNext !== 'boolean') {
      throw new Error('Invalid find request.')
    }
    if (query === '') return -1
    return event.sender.findInPage(query, { forward, findNext })
  })
  ipcMain.handle(IPC_CHANNELS.stopFindInPage, (event) => {
    event.sender.stopFindInPage('clearSelection')
  })
}

// An unpackaged run has no bundle icon, so macOS falls back to Electron's default.
// Pointing the dock at the same source image electron-builder packages makes a dev
// run look like the installed app.
function applyDevelopmentDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

function rememberOpenedRoot(root: string): void {
  // Whatever the user just opened replaces the restore, so later snapshot reads
  // must not keep waiting on it — and the restore that is still resolving must
  // not rebind the watcher to the repository it was reopening.
  restoreLastSession = null
  sessionGeneration += 1
  const approvedRoots = sessionState.approvedRoots.includes(root)
    ? sessionState.approvedRoots
    : [...sessionState.approvedRoots, root]
  if (sessionState.lastRoot === root && approvedRoots === sessionState.approvedRoots) return
  sessionState = { ...sessionState, lastRoot: root, approvedRoots }
  saveSessionState(userDataPath, sessionState)
}

function beginSessionRestore(): void {
  const root = sessionState.lastRoot
  if (startHidden || !sessionState.restoreLastFolder || root == null || !existsSync(root)) return
  const generation = sessionGeneration
  restoreLastSession = repository
    .open(root)
    .then((snapshot) => generation === sessionGeneration ? startTracking(snapshot) : snapshot)
    .catch((error) => console.warn(`Could not reopen ${root}:`, error))
}

app.whenReady().then(() => {
  userDataPath = app.getPath('userData')
  repository.setPullRequestCacheDirectory(join(userDataPath, 'pr-cache'))
  sessionState = loadSessionState(userDataPath)
  nativeTheme.themeSource = sessionState.themeType
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })
  applyDevelopmentDockIcon()
  if (startHidden) app.dock?.hide()
  void loadLastRendererTermination()
  registerIpcHandlers()
  // Started before the window so the git spawns overlap the renderer boot.
  beginSessionRestore()
  createMainWindow()
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing == null) {
      createMainWindow()
      return
    }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  repositoryWatcher.stop()
  terminalService.killAll()
  agentService.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  terminalService.killAll()
  // The Claude CLI and the codex app-server (with the user's MCP servers behind
  // it) are children of this process but are not killed with it.
  agentService.cancelAll()
})
