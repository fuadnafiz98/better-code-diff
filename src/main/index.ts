import { isAbsolute, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type RenderProcessGoneDetails } from 'electron'

import { IPC_CHANNELS, type RendererTermination } from '../shared/contracts.js'
import { RepositoryService } from './repository.js'
import { RepositoryWatcher } from './repositoryWatcher.js'

const PRODUCT_NAME = 'Better Code Diff'
const startHidden = process.env.BETTER_CODE_DIFF_BACKGROUND === '1'

app.setName(PRODUCT_NAME)
process.title = PRODUCT_NAME

const repository = new RepositoryService()
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
    BrowserWindow.fromWebContents(event.sender)?.maximize()
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.openPath, async (event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) {
      throw new Error('Recent folder path must be absolute.')
    }
    repositoryWatcher.stop()
    const snapshot = await repository.open(folderPath).then(startTracking)
    BrowserWindow.fromWebContents(event.sender)?.maximize()
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.refresh, () => repository.refresh().then(trackSnapshot))
  ipcMain.handle(IPC_CHANNELS.getComparison, (_event, path: string) =>
    repository.getComparison(path)
  )
  ipcMain.handle(IPC_CHANNELS.getWorkingTreePatch, (_event, paths: unknown) =>
    repository.getWorkingTreePatch(paths)
  )
  ipcMain.handle(IPC_CHANNELS.searchContent, (_event, query: string) =>
    repository.searchContent(query)
  )
  ipcMain.handle(IPC_CHANNELS.getGitIntegration, () => repository.getGitIntegration())
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
  ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (_event, selector: number | string) =>
    repository.getPullRequestReview(selector)
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

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })
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
  if (process.platform !== 'darwin') app.quit()
})
