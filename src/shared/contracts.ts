export type RepositoryFileStatus =
  | 'added'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked'

export interface RepositoryStatusEntry {
  path: string
  status: RepositoryFileStatus
  previousPath?: string
}

export interface RepositorySnapshot {
  root: string
  name: string
  kind: 'git' | 'folder'
  branch: string | null
  head: string | null
  paths: string[]
  statuses: RepositoryStatusEntry[]
}

export interface DiffFileContents {
  name: string
  contents: string
  cacheKey: string
}

export interface FileComparison {
  path: string
  mode: 'diff' | 'file'
  status: RepositoryFileStatus | 'unchanged'
  oldFile: DiffFileContents | null
  newFile: DiffFileContents | null
  binary: boolean
  oversized: boolean
}

export interface ContentSearchResult {
  path: string
  line: number
  column: number
  preview: string
}

export interface RepositoryApi {
  openFolder(): Promise<RepositorySnapshot | null>
  openPath(path: string): Promise<RepositorySnapshot>
  refresh(): Promise<RepositorySnapshot>
  getComparison(path: string): Promise<FileComparison>
  searchContent(query: string): Promise<ContentSearchResult[]>
}

export const IPC_CHANNELS = {
  openFolder: 'repository:open-folder',
  openPath: 'repository:open-path',
  refresh: 'repository:refresh',
  getComparison: 'repository:get-comparison',
  searchContent: 'repository:search-content'
} as const
