import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell, type RenderProcessGoneDetails } from 'electron'

import {
  IPC_CHANNELS,
  type MainStartupMetrics,
  type PerformanceMetricsDetail,
  type RendererTermination,
  type RepositorySnapshot
} from '../shared/contracts.js'
import { findHorusReviewRequest, HORUS_PROTOCOL, parseHorusReviewUrl, type HorusReviewRequest } from '../shared/horusUrl.js'
import { extractGitHubPullRequestUrl, normalizeGitHubPullRequestUrl } from '../shared/pullRequestUrl.js'
import { AgentService, coalesceAgentTextEvents } from './agentService.js'
import { parseAgentAskRequest } from './agentRequest.js'
import { FolderIndex, resolveOpenableFolder } from './folderIndex.js'
import { isPathWithinApprovedRoots, parseRemotes, pullRequestTargetsRemotes } from './repository.js'
import { runCommand } from './gitCommands.js'
import { RepositorySessionRegistry } from './repositorySessions.js'
import { DEFAULT_SESSION_STATE, loadSessionState, saveSessionState, type SessionState } from './sessionStore.js'
import { TerminalService } from './terminalService.js'
import { loadWindowState, saveWindowState } from './windowState.js'

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main:', error)
})

const PRODUCT_NAME = 'Horus'
const startHidden = process.env.HORUS_BACKGROUND === '1'
const CLIPBOARD_WARMUP_MS = 800
const WARMUP_COOLDOWN_MS = 60_000
const remoteDebuggingPort = process.env.HORUS_REMOTE_DEBUGGING_PORT?.trim()
if (remoteDebuggingPort != null && remoteDebuggingPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
}
const DEFAULT_WINDOW_WIDTH = 1_440
const DEFAULT_WINDOW_HEIGHT = 920
const GEOMETRY_SAVE_DEBOUNCE_MS = 500
// What Electron paints before first paint, during a resize and behind
// overscroll. A dark value under a light theme flashes on every drag.
const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#f7f8fa' } as const
const mainStartupOrigin = performance.now()
const mainStartupMetrics: MainStartupMetrics = {
  appReady: null,
  windowCreated: null,
  restoreSettled: null
}

function markMainStartup(milestone: keyof MainStartupMetrics): void {
  if (mainStartupMetrics[milestone] == null) {
    mainStartupMetrics[milestone] = performance.now() - mainStartupOrigin
  }
}

// Ahead of the service construction below: a second launch hands its arguments
// to the running instance and must not start a watcher on its way out. A
// background launch is a deliberate extra process, so it never takes the lock.
if (!startHidden && !app.requestSingleInstanceLock()) app.exit(0)

app.setName(PRODUCT_NAME)
process.title = PRODUCT_NAME

const agentService = new AgentService()
const terminalService = new TerminalService()
const folderIndex = new FolderIndex(homedir())
const repositorySessions = new RepositorySessionRegistry(
  (change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.didChange, change)
    }
  },
  (error) => console.error('Repository watcher failed:', error)
)

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
let holdWindowHidden = startHidden
let pendingOpenPullRequestUrl: string | null = null
const queuedExternalReviews: HorusReviewRequest[] = []
const warmupFlights = new Map<string, Promise<void>>()
const recentlyWarmedAt = new Map<string, number>()

function enqueueExternalReview(request: HorusReviewRequest): void {
  queuedExternalReviews.push(request)
}

function revealMainWindow(): void {
  holdWindowHidden = false
  if (process.platform === 'darwin') app.dock?.show()
  const window = BrowserWindow.getAllWindows()[0]
  if (window == null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.webContents.isLoadingMainFrame()) {
    window.show()
    window.focus()
  }
}

function publishPendingOpenPullRequest(): void {
  const url = pendingOpenPullRequestUrl
  if (url == null) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) continue
    window.webContents.send(IPC_CHANNELS.openExternalPullRequest, url)
  }
}

async function warmupPullRequest(url: string): Promise<void> {
  const inFlight = warmupFlights.get(url)
  if (inFlight != null) return inFlight
  const warmedAt = recentlyWarmedAt.get(url)
  if (warmedAt != null && Date.now() - warmedAt < WARMUP_COOLDOWN_MS) return

  const work = (async () => {
    try {
      const matchingRoot = await findPullRequestRoot(url)
      if (matchingRoot == null) return
      const snapshot = await openRepository(matchingRoot, false)
      await repositorySessions.require(snapshot.root).getPullRequestReview(url, undefined, `warmup:${url}`)
      recentlyWarmedAt.set(url, Date.now())
    } catch (error) {
      console.warn(`Could not warm pull request ${url}:`, error)
    }
  })().finally(() => {
    if (warmupFlights.get(url) === work) warmupFlights.delete(url)
  })
  warmupFlights.set(url, work)
  return work
}

function applyExternalReview(request: HorusReviewRequest): void {
  void warmupPullRequest(request.url)
  if (request.intent !== 'open') return
  pendingOpenPullRequestUrl = request.url
  revealMainWindow()
  publishPendingOpenPullRequest()
}

function acceptExternalReview(value: string): void {
  const request = parseHorusReviewUrl(value)
  if (request == null) return
  if (app.isReady()) applyExternalReview(request)
  else enqueueExternalReview(request)
}

function startClipboardWarmup(): void {
  let seen = clipboard.readText()
  setInterval(() => {
    const text = clipboard.readText()
    if (text === seen) return
    seen = text
    const url = extractGitHubPullRequestUrl(text)
    if (url != null) void warmupPullRequest(url)
  }, CLIPBOARD_WARMUP_MS)
}

const launchRequest = findHorusReviewRequest(process.argv)
if (launchRequest != null) enqueueExternalReview(launchRequest)
app.on('open-url', (event, url) => {
  event.preventDefault()
  acceptExternalReview(url)
})
// Only the installed app owns horus://. A `bun run dev` registration would
// steal the scheme from ~/Applications/Horus.app and break Raycast.
if (app.isPackaged) app.setAsDefaultProtocolClient(HORUS_PROTOCOL)

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

function trackSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  repositorySessions.sync(snapshot)
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
  markMainStartup('windowCreated')

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
    if (holdWindowHidden) return
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
    publishPendingOpenPullRequest()
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
): Promise<Pick<PerformanceMetricsDetail, 'mainStartup' | 'memoryByProcessType' | 'mainPrivateMegabytes'>> {
  const mainMemory = await process.getProcessMemoryInfo()
  const megabytesByType = new Map<string, number>()
  for (const metric of processMetrics) {
    megabytesByType.set(
      metric.type,
      (megabytesByType.get(metric.type) ?? 0) + metric.memory.workingSetSize / 1_024
    )
  }
  return {
    mainStartup: { ...mainStartupMetrics },
    memoryByProcessType: [...megabytesByType]
      .map(([type, megabytes]) => ({ type, megabytes }))
      .sort((left, right) => right.megabytes - left.megabytes),
    mainPrivateMegabytes: mainMemory.private / 1_024
  }
}

async function openRepository(folderPath: string, activate = true): Promise<RepositorySnapshot> {
  await restoreLastSession?.catch(() => undefined)
  const snapshot = await repositorySessions.open(folderPath, activate)
  rememberOpenedRoot(snapshot.root, activate)
  return snapshot
}

function requireRepositoryRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Repository root must be an absolute path.')
  }
  return value
}

async function findPullRequestRoot(pullRequestUrl: string): Promise<string | null> {
  const candidates = [...new Set([...repositorySessions.roots, ...sessionState.approvedRoots])]
  const matches = await Promise.all(candidates.map(async (root) => {
    if (await stat(root).catch(() => null) == null) return false
    try {
      const openRepository = repositorySessions.tryGet(root)
      const remotes = openRepository == null
        ? parseRemotes(await runCommand('git', ['-C', root, 'remote', '-v']))
        : await openRepository.getRemotes()
      return pullRequestTargetsRemotes(remotes, pullRequestUrl)
    } catch {
      return false
    }
  }))
  return candidates.find((_root, index) => matches[index]) ?? null
}

async function resolvePullRequestRepository(value: unknown): Promise<RepositorySnapshot | null> {
  if (typeof value !== 'string') throw new Error('Pull request URL must be text.')
  const pullRequestUrl = normalizeGitHubPullRequestUrl(value)
  if (pullRequestUrl == null) throw new Error('Enter a full GitHub pull request URL.')
  const matchingRoot = await findPullRequestRoot(pullRequestUrl)
  if (matchingRoot != null) return openRepository(matchingRoot, false)

  const repositorySlug = new URL(pullRequestUrl).pathname.split('/').slice(1, 3).join('/')
  const result = await dialog.showOpenDialog({
    title: `Select the local checkout for ${repositorySlug}`,
    message: `Select the local checkout for ${repositorySlug}.`,
    properties: ['openDirectory']
  })
  const folderPath = result.filePaths[0]
  if (result.canceled || folderPath == null) return null
  const remotes = parseRemotes(await runCommand('git', ['-C', folderPath, 'remote', '-v']))
  if (!pullRequestTargetsRemotes(remotes, pullRequestUrl)) {
    throw new Error(`The selected folder is not a checkout of ${repositorySlug}.`)
  }
  return openRepository(folderPath, false)
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getSessionSnapshot, async () => {
    await restoreLastSession
    return repositorySessions.getActiveSnapshot()
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
  ipcMain.handle(IPC_CHANNELS.listFolderCandidates, () => folderIndex.list(sessionState.approvedRoots))
  ipcMain.handle(IPC_CHANNELS.openPickedFolder, async (_event, folderPath: unknown) => {
    const resolved = await resolveOpenableFolder(folderPath, {
      home: folderIndex.home,
      approvedRoots: sessionState.approvedRoots
    })
    return openRepository(resolved)
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
  ipcMain.handle(IPC_CHANNELS.activateRepository, (_event, root: unknown) =>
    repositorySessions.activate(requireRepositoryRoot(root)))
  ipcMain.handle(IPC_CHANNELS.releaseRepository, (_event, root: unknown) =>
    repositorySessions.release(requireRepositoryRoot(root)))
  ipcMain.handle(IPC_CHANNELS.resolvePullRequestRepository, (_event, pullRequestUrl: unknown) =>
    resolvePullRequestRepository(pullRequestUrl))
  ipcMain.handle(IPC_CHANNELS.getPendingExternalPullRequest, () => pendingOpenPullRequestUrl)
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
    const snapshot = repositorySessions.getActiveSnapshot()
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
  ipcMain.handle(IPC_CHANNELS.refresh, () => repositorySessions.requireActive().refresh().then(trackSnapshot))
  ipcMain.handle(IPC_CHANNELS.getComparison, (_event, path: string) =>
    repositorySessions.requireActive().getComparison(path)
  )
  ipcMain.handle(IPC_CHANNELS.saveWorkingFile, async (_event, request: unknown) => {
    const repository = repositorySessions.requireActive()
    const comparison = await repository.saveWorkingFile(request)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot != null) trackSnapshot(snapshot)
    return comparison
  })
  ipcMain.handle(IPC_CHANNELS.getWorkingTreePatch, (_event, paths: unknown) =>
    repositorySessions.requireActive().getWorkingTreePatch(paths)
  )
  ipcMain.handle(IPC_CHANNELS.searchContent, (_event, query: string) =>
    repositorySessions.requireActive().searchContent(query)
  )
  ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => repositorySessions.cancelActiveContentSearch())
  ipcMain.handle(IPC_CHANNELS.getGitIntegration, () => repositorySessions.requireActive().getGitIntegration())
  ipcMain.handle(IPC_CHANNELS.getPullRequestInbox, () => repositorySessions.requireActive().getPullRequestInbox())
  ipcMain.handle(IPC_CHANNELS.getClosedPullRequests, () => repositorySessions.requireActive().getClosedPullRequests())
  ipcMain.on(IPC_CHANNELS.cancelPullRequestReview, (_event, root: unknown, requestId: unknown) => {
    if (typeof root !== 'string' || typeof requestId !== 'string' || requestId === '') return
    repositorySessions.tryGet(root)?.cancelPullRequestReview(requestId)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentModels, async () => {
    const snapshot = repositorySessions.getActiveSnapshot()
    if (snapshot == null) throw new Error('Open a repository before loading agent models.')
    return agentService.getModels(snapshot.root)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentStatuses, (_event, provider: unknown) =>
    agentService.getStatuses(provider))
  ipcMain.handle(IPC_CHANNELS.loginAgent, (_event, provider: unknown) =>
    agentService.login(provider))
  ipcMain.handle(IPC_CHANNELS.askAgent, async (event, request: unknown) => {
    const parsedRequest = await parseAgentAskRequest(request)
    const repository = repositorySessions.require(parsedRequest.subject.repositoryRoot)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('The repository tab is not ready for the agent.')
    const sender = event.sender
    const stream = coalesceAgentTextEvents((agentEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.agentEvent, agentEvent)
    })
    try {
      await agentService.ask(parsedRequest, snapshot.root, stream.emit)
    } finally {
      stream.flush()
    }
  })
  ipcMain.handle(IPC_CHANNELS.cancelAgent, (_event, id: unknown) => agentService.cancel(id))
  ipcMain.handle(IPC_CHANNELS.respondAgentApproval, (_event, requestId: unknown, decision: unknown) =>
    agentService.respondApproval(requestId, decision))
  ipcMain.handle(IPC_CHANNELS.createTerminal, (event, columns: unknown, rows: unknown) => {
    const snapshot = repositorySessions.getActiveSnapshot()
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
  ipcMain.handle(IPC_CHANNELS.getPullRequestConversation, (_event, root: unknown, selector: number | string) =>
    repositorySessions.require(requireRepositoryRoot(root)).getPullRequestConversation(selector))
  ipcMain.handle(IPC_CHANNELS.replyToPullRequestThread, (_event, root: unknown, threadId: unknown, body: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).replyToPullRequestThread(threadId, body))
  ipcMain.handle(IPC_CHANNELS.setPullRequestThreadResolved, (_event, root: unknown, threadId: unknown, resolved: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).setPullRequestThreadResolved(threadId, resolved))
  ipcMain.handle(IPC_CHANNELS.mergePullRequest, (_event, root: unknown, selector: number | string, strategy: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).mergePullRequest(selector, strategy))
  ipcMain.handle(IPC_CHANNELS.markPullRequestReady, (_event, root: unknown, selector: number | string) =>
    repositorySessions.require(requireRepositoryRoot(root)).markPullRequestReady(selector))
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_event, name: string) =>
    repositorySessions.requireActive().switchBranch(name).then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.getLocalBranchReview, (_event, baseRef: string, headRef: string) =>
    repositorySessions.requireActive().getLocalBranchReview(baseRef, headRef)
  )
  ipcMain.handle(IPC_CHANNELS.getCommitReview, (_event, oid: string) =>
    repositorySessions.requireActive().getCommitReview(oid)
  )
  ipcMain.handle(IPC_CHANNELS.fetchRemote, () => repositorySessions.requireActive().fetchRemote())
  ipcMain.handle(IPC_CHANNELS.pullCurrentBranch, () =>
    repositorySessions.requireActive().pullCurrentBranch().then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.pushCurrentBranch, () => repositorySessions.requireActive().pushCurrentBranch())
  ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (event, root: unknown, selector: number | string, requestId: unknown) => {
    const repositoryRoot = requireRepositoryRoot(root)
    if (typeof requestId !== 'string' || requestId === '' || requestId.length > 200) {
      throw new Error('Pull request load ID must be short non-empty text.')
    }
    // Streamed back page by page: a review of a few thousand files takes long
    // enough to fetch that waiting for all of it reads as a hang.
    return repositorySessions.require(repositoryRoot).getPullRequestReview(selector, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.pullRequestReviewProgress, {
          ...progress,
          root: repositoryRoot,
          requestId
        })
      }
    }, requestId)
  })
  ipcMain.handle(IPC_CHANNELS.checkoutPullRequest, (_event, number: number) =>
    repositorySessions.requireActive().checkoutPullRequest(number).then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.submitPullRequestReview, (_event, root: unknown, selector: number | string, commitId: unknown, reviewEvent: string, body: string, comments: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).submitPullRequestReview(selector, commitId, reviewEvent, body, comments)
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
    void saveSessionState(userDataPath, sessionState)
    // setBackgroundColor can flash on some macOS versions, so only on a real change.
    if (!repainting) return
    nativeTheme.themeSource = themeType
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(WINDOW_BACKGROUND[themeType])
  })
  ipcMain.handle(IPC_CHANNELS.setVisibility, (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibility must be a boolean.')
    repositorySessions.setSuspended(!visible)
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

function rememberOpenedRoot(root: string, active = true): void {
  // A foreground open replaces the restore. A background PR resolution only
  // authorizes its checkout; it must not replace the folder restored next time.
  if (active) restoreLastSession = null
  const approvedRoots = sessionState.approvedRoots.includes(root)
    ? sessionState.approvedRoots
    : [...sessionState.approvedRoots, root]
  const lastRoot = active ? root : sessionState.lastRoot
  if (sessionState.lastRoot === lastRoot && approvedRoots === sessionState.approvedRoots) return
  sessionState = { ...sessionState, lastRoot, approvedRoots }
  void saveSessionState(userDataPath, sessionState)
}

function beginSessionRestore(): void {
  const root = sessionState.lastRoot
  if (startHidden || !sessionState.restoreLastFolder || root == null || !existsSync(root)) {
    markMainStartup('restoreSettled')
    return
  }
  restoreLastSession = repositorySessions
    .open(root)
    .catch((error) => console.warn(`Could not reopen ${root}:`, error))
    .finally(() => markMainStartup('restoreSettled'))
}

app.whenReady().then(() => {
  markMainStartup('appReady')
  userDataPath = app.getPath('userData')
  repositorySessions.setPullRequestCacheDirectory(join(userDataPath, 'pr-cache'))
  sessionState = loadSessionState(userDataPath)
  nativeTheme.themeSource = sessionState.themeType
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })
  applyDevelopmentDockIcon()
  const initialReviews = queuedExternalReviews.splice(0)
  if (initialReviews.length > 0 && initialReviews.every((request) => request.intent === 'warmup')) {
    holdWindowHidden = true
  }
  if (initialReviews.some((request) => request.intent === 'open')) holdWindowHidden = false
  if (startHidden || holdWindowHidden) app.dock?.hide()
  void loadLastRendererTermination()
  registerIpcHandlers()
  // Started before the window so the git spawns overlap the renderer boot.
  beginSessionRestore()
  void folderIndex.list(sessionState.approvedRoots)
  createMainWindow()
  if (!startHidden) startClipboardWarmup()
  for (const request of initialReviews) applyExternalReview(request)
  app.on('second-instance', (_event, argv) => {
    const request = findHorusReviewRequest(argv)
    if (request != null) {
      applyExternalReview(request)
      return
    }
    revealMainWindow()
    if (BrowserWindow.getAllWindows()[0] == null) createMainWindow()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  repositorySessions.stopAll()
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
