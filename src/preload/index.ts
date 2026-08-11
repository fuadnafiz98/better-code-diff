import { contextBridge, ipcRenderer } from 'electron'

import type { RepositoryApi } from '../shared/contracts.js'
import { IPC_CHANNELS } from '../shared/contracts.js'

const repositoryApi: RepositoryApi = {
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh),
  getComparison: (path) => ipcRenderer.invoke(IPC_CHANNELS.getComparison, path),
  searchContent: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchContent, query)
}

contextBridge.exposeInMainWorld('repository', repositoryApi)
