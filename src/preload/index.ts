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
type MainPerformanceDetail = Pick<
  PerformanceMetricsDetail,
  'mainStartup' | 'memoryByProcessType' | 'mainPrivateMegabytes'
>

const MAX_COUNTED_RENDERER_DOM_NODES = 500_000

interface RendererElement {
  shadowRoot?: RendererQueryRoot | null
}

interface RendererQueryRoot {
  querySelectorAll(selector: string): ArrayLike<RendererElement>
}

function countRendererDomNodes(root: RendererQueryRoot | undefined): number {
  if (root == null) return 0
  const roots: RendererQueryRoot[] = [root]
  let count = 0

  while (roots.length > 0 && count < MAX_COUNTED_RENDERER_DOM_NODES) {
    const current = roots.pop()
    if (current == null) continue
    const elements = current.querySelectorAll('*')
    count = Math.min(MAX_COUNTED_RENDERER_DOM_NODES, count + elements.length)
    for (let index = 0; index < elements.length && count < MAX_COUNTED_RENDERER_DOM_NODES; index += 1) {
      const shadowRoot = elements[index]?.shadowRoot
      if (shadowRoot != null) roots.push(shadowRoot)
    }
  }

  return count
}

const repositoryApi: RepositoryApi = {
  getSessionSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSessionSnapshot),
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  activateRepository: (root) => ipcRenderer.invoke(IPC_CHANNELS.activateRepository, root),
  releaseRepository: (root) => ipcRenderer.invoke(IPC_CHANNELS.releaseRepository, root),
  resolvePullRequestRepository: (pullRequestUrl) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolvePullRequestRepository, pullRequestUrl),
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
  getPullRequestConversation: (root: string, selector: number | string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getPullRequestConversation, root, selector),
  replyToPullRequestThread: (root: string, threadId: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.replyToPullRequestThread, root, threadId, body),
  setPullRequestThreadResolved: (root: string, threadId: string, resolved: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPullRequestThreadResolved, root, threadId, resolved),
  mergePullRequest: (root, selector, strategy) => ipcRenderer.invoke(IPC_CHANNELS.mergePullRequest, root, selector, strategy),
  markPullRequestReady: (root, selector) => ipcRenderer.invoke(IPC_CHANNELS.markPullRequestReady, root, selector),
  switchBranch: (name) => ipcRenderer.invoke(IPC_CHANNELS.switchBranch, name),
  getLocalBranchReview: (baseRef, headRef) => ipcRenderer.invoke(IPC_CHANNELS.getLocalBranchReview, baseRef, headRef),
  getCommitReview: (oid) => ipcRenderer.invoke(IPC_CHANNELS.getCommitReview, oid),
  fetchRemote: () => ipcRenderer.invoke(IPC_CHANNELS.fetchRemote),
  pullCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pullCurrentBranch),
  pushCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pushCurrentBranch),
  getPullRequestReview: (root, selector, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getPullRequestReview, root, selector, requestId),
  cancelPullRequestReview: (root, requestId) =>
    ipcRenderer.send(IPC_CHANNELS.cancelPullRequestReview, root, requestId),
  checkoutPullRequest: (number) => ipcRenderer.invoke(IPC_CHANNELS.checkoutPullRequest, number),
  submitPullRequestReview: (root, selector, commitId, event, body, comments) => ipcRenderer.invoke(IPC_CHANNELS.submitPullRequestReview, root, selector, commitId, event, body, comments),
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
    const rendererDocument = (globalThis as unknown as { document?: RendererQueryRoot }).document
    metrics.detail = {
      ...mainMetrics.detail,
      rendererHeapUsedMegabytes: heap.usedHeapSize / 1_024,
      rendererHeapTotalMegabytes: heap.totalHeapSize / 1_024,
      rendererDomNodes: countRendererDomNodes(rendererDocument)
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
