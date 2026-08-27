import { contextBridge, ipcRenderer } from 'electron'

import type {
  AgentStreamEvent,
  FindInPageResult,
  PerformanceMetrics,
  PerformanceMetricsDetail,
  PullRequestReviewProgress,
  RepositoryApi,
  RepositoryChangeEvent,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/contracts.js'
import { IPC_CHANNELS } from '../shared/contracts.js'

// The detail main can supply; the renderer-local half is measured here.
type MainPerformanceDetail = Pick<PerformanceMetricsDetail, 'memoryByProcessType' | 'mainPrivateMegabytes'>

const repositoryApi: RepositoryApi = {
  getSessionSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSessionSnapshot),
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  readClipboardText: (type) => ipcRenderer.invoke(IPC_CHANNELS.readClipboardText, type),
  revealPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.revealPath, path),
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh),
  getComparison: (path) => ipcRenderer.invoke(IPC_CHANNELS.getComparison, path),
  saveWorkingFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveWorkingFile, request),
  getWorkingTreePatch: (paths) => ipcRenderer.invoke(IPC_CHANNELS.getWorkingTreePatch, paths),
  searchContent: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchContent, query),
  cancelContentSearch: () => ipcRenderer.send(IPC_CHANNELS.cancelContentSearch),
  getGitIntegration: () => ipcRenderer.invoke(IPC_CHANNELS.getGitIntegration),
  getPullRequestInbox: () => ipcRenderer.invoke(IPC_CHANNELS.getPullRequestInbox),
  getClosedPullRequests: () => ipcRenderer.invoke(IPC_CHANNELS.getClosedPullRequests),
  getPullRequestConversation: (selector: number | string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getPullRequestConversation, selector),
  replyToPullRequestThread: (threadId: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.replyToPullRequestThread, threadId, body),
  setPullRequestThreadResolved: (threadId: string, resolved: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPullRequestThreadResolved, threadId, resolved),
  mergePullRequest: (selector, strategy) => ipcRenderer.invoke(IPC_CHANNELS.mergePullRequest, selector, strategy),
  markPullRequestReady: (selector) => ipcRenderer.invoke(IPC_CHANNELS.markPullRequestReady, selector),
  switchBranch: (name) => ipcRenderer.invoke(IPC_CHANNELS.switchBranch, name),
  getLocalBranchReview: (baseRef, headRef) => ipcRenderer.invoke(IPC_CHANNELS.getLocalBranchReview, baseRef, headRef),
  getCommitReview: (oid) => ipcRenderer.invoke(IPC_CHANNELS.getCommitReview, oid),
  fetchRemote: () => ipcRenderer.invoke(IPC_CHANNELS.fetchRemote),
  pullCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pullCurrentBranch),
  pushCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pushCurrentBranch),
  getPullRequestReview: (selector) => ipcRenderer.invoke(IPC_CHANNELS.getPullRequestReview, selector),
  cancelPullRequestReview: () => ipcRenderer.send(IPC_CHANNELS.cancelPullRequestReview),
  checkoutPullRequest: (number) => ipcRenderer.invoke(IPC_CHANNELS.checkoutPullRequest, number),
  submitPullRequestReview: (selector, commitId, event, body, comments) => ipcRenderer.invoke(IPC_CHANNELS.submitPullRequestReview, selector, commitId, event, body, comments),
  getAgentModels: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentModels),
  getAgentStatuses: (provider) => ipcRenderer.invoke(IPC_CHANNELS.getAgentStatuses, provider),
  loginAgent: (provider) => ipcRenderer.invoke(IPC_CHANNELS.loginAgent, provider),
  askAgent: (request) => ipcRenderer.invoke(IPC_CHANNELS.askAgent, request),
  cancelAgent: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelAgent, id),
  respondAgentApproval: (requestId, decision) =>
    ipcRenderer.invoke(IPC_CHANNELS.respondAgentApproval, requestId, decision),
  onAgentEvent: (listener) => {
    const handler = (_event: unknown, agentEvent: AgentStreamEvent): void => listener(agentEvent)
    ipcRenderer.on(IPC_CHANNELS.agentEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler)
    }
  },
  createTerminal: (columns, rows) => ipcRenderer.invoke(IPC_CHANNELS.createTerminal, columns, rows),
  readyTerminal: (sessionId) => ipcRenderer.send(IPC_CHANNELS.readyTerminal, sessionId),
  writeTerminal: (sessionId, data) => {
    const chunkSize = 64 * 1_024
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      ipcRenderer.send(IPC_CHANNELS.writeTerminal, sessionId, data.slice(offset, offset + chunkSize))
    }
  },
  resizeTerminal: (sessionId, columns, rows) =>
    ipcRenderer.send(IPC_CHANNELS.resizeTerminal, sessionId, columns, rows),
  clearTerminal: (sessionId) => ipcRenderer.send(IPC_CHANNELS.clearTerminal, sessionId),
  setTerminalVisibility: (sessionId, visible) =>
    ipcRenderer.send(IPC_CHANNELS.setTerminalVisibility, sessionId, visible),
  killTerminal: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.killTerminal, sessionId),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalDataEvent): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on(IPC_CHANNELS.terminalData, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalData, handler)
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalExitEvent): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on(IPC_CHANNELS.terminalExit, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalExit, handler)
  },
  getPerformanceMetrics: async (detailed) => {
    const [mainMetrics, rendererMemory] = await Promise.all([
      ipcRenderer.invoke(IPC_CHANNELS.getPerformanceMetrics, detailed) as Promise<
        Omit<PerformanceMetrics, 'rendererPrivateMegabytes' | 'detail'> & { detail: MainPerformanceDetail | null }>,
      process.getProcessMemoryInfo()
    ])
    const metrics: PerformanceMetrics = {
      ...mainMetrics,
      rendererPrivateMegabytes: rendererMemory.private / 1_024,
      detail: null
    }
    if (!detailed || mainMetrics.detail == null) return metrics
    const heap = process.getHeapStatistics()
    const rendererDocument = (globalThis as unknown as {
      document?: { getElementsByTagName(name: string): { length: number } }
    }).document
    metrics.detail = {
      ...mainMetrics.detail,
      rendererHeapUsedMegabytes: heap.usedHeapSize / 1_024,
      rendererHeapTotalMegabytes: heap.totalHeapSize / 1_024,
      rendererDomNodes: rendererDocument?.getElementsByTagName('*').length ?? 0
    }
    return metrics
  },
  setVisibility: (visible) => ipcRenderer.invoke(IPC_CHANNELS.setVisibility, visible),
  setStartupPreferences: (preferences) => ipcRenderer.invoke(IPC_CHANNELS.setStartupPreferences, preferences),
  findInPage: (query, forward, findNext) => ipcRenderer.invoke(IPC_CHANNELS.findInPage, query, forward, findNext),
  stopFindInPage: () => ipcRenderer.invoke(IPC_CHANNELS.stopFindInPage),
  onFoundInPage: (listener) => {
    const handleResult = (_event: Electron.IpcRendererEvent, result: FindInPageResult): void => listener(result)
    ipcRenderer.on(IPC_CHANNELS.foundInPage, handleResult)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.foundInPage, handleResult)
  },
  onFullscreenChange: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => listener(fullscreen)
    ipcRenderer.on(IPC_CHANNELS.fullscreenChange, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.fullscreenChange, handleChange)
  },
  onDidChange: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, change: RepositoryChangeEvent): void => listener(change)
    ipcRenderer.on(IPC_CHANNELS.didChange, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.didChange, handleChange)
  },
  onPullRequestReviewProgress: (listener) => {
    const handleProgress = (_event: Electron.IpcRendererEvent, progress: PullRequestReviewProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.pullRequestReviewProgress, handleProgress)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pullRequestReviewProgress, handleProgress)
  }
}

contextBridge.exposeInMainWorld('repository', repositoryApi)
