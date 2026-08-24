import { isAbsolute, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell, type RenderProcessGoneDetails } from 'electron'

import { IPC_CHANNELS, type RendererTermination } from '../shared/contracts.js'
import { AgentService } from './agentService.js'
import { RepositoryService } from './repository.js'
import { RepositoryWatcher } from './repositoryWatcher.js'
import { TerminalService } from './terminalService.js'

const PRODUCT_NAME = 'Horus'
const startHidden = process.env.HORUS_BACKGROUND === '1'

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

const MAX_AUTOMATIC_RECOVERIES = 3
const RECOVERY_WINDOW_MS = 60_000
const UNRESPONSIVE_RECOVERY_DELAY_MS = 8_000
const MAX_RENDERER_TERMINATION_RECORDS = 20
let lastRendererTermination: RendererTermination | null = null

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

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: PRODUCT_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#0c0d0f',
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
    if (!startHidden) window.show()
  })
  window.on('responsive', clearRecoveryTimer)
  window.on('unresponsive', () => scheduleRecovery('the window stopped responding', UNRESPONSIVE_RECOVERY_DELAY_MS))
  window.on('closed', clearRecoveryTimer)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
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

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getSessionSnapshot, () => repository.getSessionSnapshot())
  ipcMain.handle(IPC_CHANNELS.openFolder, async (event) => {
    const result = await dialog.showOpenDialog({
      title: 'Open folder',
      properties: ['openDirectory']
    })
    const folderPath = result.filePaths[0]
    if (result.canceled || folderPath == null) return null
    repositoryWatcher.stop()
    const snapshot = await repository.open(folderPath).then(startTracking)
    terminalService.killAll()
    BrowserWindow.fromWebContents(event.sender)?.maximize()
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.openPath, async (event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) {
      throw new Error('Recent folder path must be absolute.')
    }
    repositoryWatcher.stop()
    const snapshot = await repository.open(folderPath).then(startTracking)
    terminalService.killAll()
    BrowserWindow.fromWebContents(event.sender)?.maximize()
    return snapshot
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
  ipcMain.handle(IPC_CHANNELS.getAgentModels, async () => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a repository before loading agent models.')
    return agentService.getModels(snapshot.root)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentStatuses, () => agentService.getStatuses())
  ipcMain.handle(IPC_CHANNELS.loginAgent, (_event, provider: unknown) =>
    agentService.login(provider))
  ipcMain.handle(IPC_CHANNELS.askAgent, async (event, request: unknown) => {
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Open a repository before asking the agent.')
    const sender = event.sender
    await agentService.ask(request, snapshot.root, (agentEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.agentEvent, agentEvent)
    })
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
  ipcMain.handle(IPC_CHANNELS.getPerformanceMetrics, async () => {
    const processMetrics = app.getAppMetrics()
    const mainMemory = await process.getProcessMemoryInfo()
    let cpuPercent = 0
    let gpuProcessCpuPercent: number | null = null
    let memoryKilobytes = 0
    const memoryByProcessType = new Map<string, number>()

    for (const metric of processMetrics) {
      cpuPercent += metric.cpu.percentCPUUsage
      memoryKilobytes += metric.memory.workingSetSize
      memoryByProcessType.set(
        metric.type,
        (memoryByProcessType.get(metric.type) ?? 0) + metric.memory.workingSetSize / 1_024
      )
      if (metric.type === 'GPU') {
        gpuProcessCpuPercent = (gpuProcessCpuPercent ?? 0) + metric.cpu.percentCPUUsage
      }
    }

    return {
      cpuPercent,
      gpuProcessCpuPercent,
      workingSetMegabytes: memoryKilobytes / 1_024,
      memoryByProcessType: [...memoryByProcessType]
        .map(([type, megabytes]) => ({ type, megabytes }))
        .sort((left, right) => right.megabytes - left.megabytes),
      mainPrivateMegabytes: mainMemory.private / 1_024,
      lastRendererTermination,
      processCount: processMetrics.length,
      production: app.isPackaged,
      sampledAt: Date.now()
    }
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

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })
  applyDevelopmentDockIcon()
  if (startHidden) app.dock?.hide()
  void loadLastRendererTermination()
  registerIpcHandlers()
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  repositoryWatcher.stop()
  terminalService.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => terminalService.killAll())
