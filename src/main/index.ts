import { isAbsolute, join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { IPC_CHANNELS } from '../shared/contracts.js'
import { RepositoryService } from './repository.js'
import { RepositoryWatcher } from './repositoryWatcher.js'

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
    title: 'Better Code Diff',
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

  window.once('ready-to-show', () => window.show())
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

  if (process.env.ELECTRON_RENDERER_URL != null) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.openFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open folder',
      properties: ['openDirectory']
    })
    const folderPath = result.filePaths[0]
    if (result.canceled || folderPath == null) return null
    repositoryWatcher.stop()
    return repository.open(folderPath).then(startTracking)
  })
  ipcMain.handle(IPC_CHANNELS.openPath, (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) {
      throw new Error('Recent folder path must be absolute.')
    }
    repositoryWatcher.stop()
    return repository.open(folderPath).then(startTracking)
  })
  ipcMain.handle(IPC_CHANNELS.refresh, () => repository.refresh().then(trackSnapshot))
  ipcMain.handle(IPC_CHANNELS.getComparison, (_event, path: string) =>
    repository.getComparison(path)
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
  ipcMain.handle(IPC_CHANNELS.submitPullRequestReview, (_event, selector: number | string, reviewEvent: string, body: string) =>
    repository.submitPullRequestReview(selector, reviewEvent, body)
  )
  ipcMain.handle(IPC_CHANNELS.getPerformanceMetrics, () => {
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
      memoryMegabytes: memoryKilobytes / 1_024,
      processCount: processMetrics.length,
      production: app.isPackaged,
      sampledAt: Date.now()
    }
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
