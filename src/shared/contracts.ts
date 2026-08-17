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

export interface RepositoryChangeEvent {
  snapshot: RepositorySnapshot
  changedPaths: string[]
  revision: number
}

export interface PerformanceMetrics {
  cpuPercent: number
  gpuProcessCpuPercent: number | null
  workingSetMegabytes: number
  memoryByProcessType: Array<{ type: string; megabytes: number }>
  mainPrivateMegabytes: number
  rendererPrivateMegabytes: number
  rendererHeapUsedMegabytes: number
  rendererHeapTotalMegabytes: number
  rendererBlinkAllocatedMegabytes: number
  rendererBlinkTotalMegabytes: number
  rendererDomNodes: number
  lastRendererTermination: RendererTermination | null
  processCount: number
  production: boolean
  sampledAt: number
}

export interface RendererTermination {
  reason: string
  exitCode: number
  occurredAt: number
}

export interface FindInPageResult {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export interface LocalBranch {
  name: string
  current: boolean
  upstream: string | null
}

export interface RemoteBranch {
  name: string
  remote: string
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface GitCommit {
  oid: string
  shortOid: string
  parents: string[]
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
  decorations: string[]
}

export interface PullRequestAuthor {
  login: string
}

export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: PullRequestAuthor
  headRefName: string
  baseRefName: string
  reviewDecision: string | null
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
}

export interface PullRequestFile {
  path: string
  additions: number
  deletions: number
}

export interface PullRequestReview {
  kind: 'github'
  selector: string
  commitId: string
  viewerCanSubmitDecision: boolean
  pullRequest: PullRequestSummary
  files: PullRequestFile[]
  patch: string
}

export interface LocalBranchReview {
  kind: 'local'
  id: string
  title: string
  baseRefName: string
  headRefName: string
  files: PullRequestFile[]
  patch: string
}

export type RepositoryReview = PullRequestReview | LocalBranchReview

export interface GitIntegrationSnapshot {
  branches: LocalBranch[]
  remoteBranches: RemoteBranch[]
  remotes: GitRemote[]
  commits: GitCommit[]
  defaultBranch: string | null
  ahead: number
  behind: number
  pullRequests: PullRequestSummary[]
  githubAvailable: boolean
  githubMessage: string | null
}

export type PullRequestReviewEvent = 'approve' | 'comment' | 'request-changes'

export interface PullRequestReviewComment {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
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
  getSessionSnapshot(): Promise<RepositorySnapshot | null>
  openFolder(): Promise<RepositorySnapshot | null>
  openPath(path: string): Promise<RepositorySnapshot>
  refresh(): Promise<RepositorySnapshot>
  getComparison(path: string): Promise<FileComparison>
  getWorkingTreePatch(paths: string[]): Promise<string>
  searchContent(query: string): Promise<ContentSearchResult[]>
  getGitIntegration(): Promise<GitIntegrationSnapshot>
  switchBranch(name: string): Promise<RepositorySnapshot>
  getLocalBranchReview(baseRef: string, headRef: string): Promise<LocalBranchReview>
  getCommitReview(oid: string): Promise<LocalBranchReview>
  fetchRemote(): Promise<GitIntegrationSnapshot>
  pullCurrentBranch(): Promise<RepositorySnapshot>
  pushCurrentBranch(): Promise<GitIntegrationSnapshot>
  getPullRequestReview(selector: number | string): Promise<PullRequestReview>
  checkoutPullRequest(number: number): Promise<RepositorySnapshot>
  submitPullRequestReview(
    selector: number | string,
    commitId: string,
    event: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<void>
  getPerformanceMetrics(): Promise<PerformanceMetrics>
  setVisibility(visible: boolean): Promise<void>
  findInPage(query: string, forward: boolean, findNext: boolean): Promise<number>
  stopFindInPage(): Promise<void>
  onFoundInPage(listener: (result: FindInPageResult) => void): () => void
  onDidChange(listener: (event: RepositoryChangeEvent) => void): () => void
}

export const IPC_CHANNELS = {
  getSessionSnapshot: 'repository:get-session-snapshot',
  openFolder: 'repository:open-folder',
  openPath: 'repository:open-path',
  refresh: 'repository:refresh',
  getComparison: 'repository:get-comparison',
  getWorkingTreePatch: 'repository:get-working-tree-patch',
  searchContent: 'repository:search-content',
  getGitIntegration: 'repository:get-git-integration',
  switchBranch: 'repository:switch-branch',
  getLocalBranchReview: 'repository:get-local-branch-review',
  getCommitReview: 'repository:get-commit-review',
  fetchRemote: 'repository:fetch-remote',
  pullCurrentBranch: 'repository:pull-current-branch',
  pushCurrentBranch: 'repository:push-current-branch',
  getPullRequestReview: 'repository:get-pull-request-review',
  checkoutPullRequest: 'repository:checkout-pull-request',
  submitPullRequestReview: 'repository:submit-pull-request-review',
  getPerformanceMetrics: 'app:get-performance-metrics',
  setVisibility: 'app:set-visibility',
  findInPage: 'app:find-in-page',
  stopFindInPage: 'app:stop-find-in-page',
  foundInPage: 'app:found-in-page',
  didChange: 'repository:did-change'
} as const
