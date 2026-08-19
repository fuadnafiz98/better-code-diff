import { contextBridge, ipcRenderer } from 'electron'

import type {
  AgentStreamEvent,
  FindInPageResult,
  PerformanceMetrics,
  RepositoryApi,
  RepositoryChangeEvent
} from '../shared/contracts.js'
import { IPC_CHANNELS } from '../shared/contracts.js'

const repositoryApi: RepositoryApi = {
  getSessionSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSessionSnapshot),
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh),
  getComparison: (path) => ipcRenderer.invoke(IPC_CHANNELS.getComparison, path),
  getWorkingTreePatch: (paths) => ipcRenderer.invoke(IPC_CHANNELS.getWorkingTreePatch, paths),
  searchContent: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchContent, query),
  cancelContentSearch: () => ipcRenderer.send(IPC_CHANNELS.cancelContentSearch),
  getGitIntegration: () => ipcRenderer.invoke(IPC_CHANNELS.getGitIntegration),
  getPullRequestInbox: () => ipcRenderer.invoke(IPC_CHANNELS.getPullRequestInbox),
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
  checkoutPullRequest: (number) => ipcRenderer.invoke(IPC_CHANNELS.checkoutPullRequest, number),
  submitPullRequestReview: (selector, commitId, event, body, comments) => ipcRenderer.invoke(IPC_CHANNELS.submitPullRequestReview, selector, commitId, event, body, comments),
  askAgent: (request) => ipcRenderer.invoke(IPC_CHANNELS.askAgent, request),
  cancelAgent: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelAgent, id),
  onAgentEvent: (listener) => {
    const handler = (_event: unknown, agentEvent: AgentStreamEvent): void => listener(agentEvent)
    ipcRenderer.on(IPC_CHANNELS.agentEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler)
    }
  },
  getPerformanceMetrics: async () => {
    const [mainMetrics, rendererMemory] = await Promise.all([
      ipcRenderer.invoke(IPC_CHANNELS.getPerformanceMetrics) as Promise<Omit<PerformanceMetrics,
        | 'rendererPrivateMegabytes'
        | 'rendererHeapUsedMegabytes'
        | 'rendererHeapTotalMegabytes'
        | 'rendererBlinkAllocatedMegabytes'
        | 'rendererBlinkTotalMegabytes'
        | 'rendererDomNodes'>>,
      process.getProcessMemoryInfo()
    ])
    const heap = process.getHeapStatistics()
    const blink = process.getBlinkMemoryInfo()
    const rendererDocument = (globalThis as unknown as {
      document?: { getElementsByTagName(name: string): { length: number } }
    }).document
    return {
      ...mainMetrics,
      rendererPrivateMegabytes: rendererMemory.private / 1_024,
      rendererHeapUsedMegabytes: heap.usedHeapSize / 1_024,
      rendererHeapTotalMegabytes: heap.totalHeapSize / 1_024,
      rendererBlinkAllocatedMegabytes: blink.allocated / 1_024,
      rendererBlinkTotalMegabytes: blink.total / 1_024,
      rendererDomNodes: rendererDocument?.getElementsByTagName('*').length ?? 0
    }
  },
  setVisibility: (visible) => ipcRenderer.invoke(IPC_CHANNELS.setVisibility, visible),
  findInPage: (query, forward, findNext) => ipcRenderer.invoke(IPC_CHANNELS.findInPage, query, forward, findNext),
  stopFindInPage: () => ipcRenderer.invoke(IPC_CHANNELS.stopFindInPage),
  onFoundInPage: (listener) => {
    const handleResult = (_event: Electron.IpcRendererEvent, result: FindInPageResult): void => listener(result)
    ipcRenderer.on(IPC_CHANNELS.foundInPage, handleResult)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.foundInPage, handleResult)
  },
  onDidChange: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, change: RepositoryChangeEvent): void => listener(change)
    ipcRenderer.on(IPC_CHANNELS.didChange, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.didChange, handleChange)
  }
}

contextBridge.exposeInMainWorld('repository', repositoryApi)
