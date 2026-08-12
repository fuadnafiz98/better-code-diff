import { contextBridge, ipcRenderer } from 'electron'

import type { FindInPageResult, RepositoryApi, RepositoryChangeEvent } from '../shared/contracts.js'
import { IPC_CHANNELS } from '../shared/contracts.js'

const repositoryApi: RepositoryApi = {
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh),
  getComparison: (path) => ipcRenderer.invoke(IPC_CHANNELS.getComparison, path),
  searchContent: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchContent, query),
  getGitIntegration: () => ipcRenderer.invoke(IPC_CHANNELS.getGitIntegration),
  switchBranch: (name) => ipcRenderer.invoke(IPC_CHANNELS.switchBranch, name),
  getLocalBranchReview: (baseRef, headRef) => ipcRenderer.invoke(IPC_CHANNELS.getLocalBranchReview, baseRef, headRef),
  getCommitReview: (oid) => ipcRenderer.invoke(IPC_CHANNELS.getCommitReview, oid),
  fetchRemote: () => ipcRenderer.invoke(IPC_CHANNELS.fetchRemote),
  pullCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pullCurrentBranch),
  pushCurrentBranch: () => ipcRenderer.invoke(IPC_CHANNELS.pushCurrentBranch),
  getPullRequestReview: (selector) => ipcRenderer.invoke(IPC_CHANNELS.getPullRequestReview, selector),
  checkoutPullRequest: (number) => ipcRenderer.invoke(IPC_CHANNELS.checkoutPullRequest, number),
  submitPullRequestReview: (selector, event, body) => ipcRenderer.invoke(IPC_CHANNELS.submitPullRequestReview, selector, event, body),
  getPerformanceMetrics: () => ipcRenderer.invoke(IPC_CHANNELS.getPerformanceMetrics),
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
