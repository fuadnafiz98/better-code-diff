export type RepositoryFileStatus =
  | 'added'
  | 'conflicted'
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

export interface PullRequestChecks {
  passing: number
  failing: number
  pending: number
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
  checks?: PullRequestChecks | null
  mergeable?: string | null
}

export type InboxPullRequest = Pick<
  PullRequestSummary,
  'number' | 'title' | 'url' | 'state' | 'isDraft' | 'author' | 'updatedAt'
>

export type PullRequestInboxSectionKey = 'review-requested' | 'assigned' | 'mentioned' | 'authored'

export interface PullRequestInboxSection {
  key: PullRequestInboxSectionKey
  title: string
  pullRequests: InboxPullRequest[]
}

export interface PullRequestInboxSnapshot {
  available: boolean
  message: string | null
  sections: PullRequestInboxSection[]
}

export interface PullRequestFile {
  path: string
  additions: number
  deletions: number
}

export interface RemoteReviewComment {
  id: string
  body: string
  authorLogin: string
  createdAt: string
}

export interface RemoteReviewThread {
  id: string
  path: string
  line: number | null
  startLine: number | null
  side: 'LEFT' | 'RIGHT'
  resolved: boolean
  outdated: boolean
  comments: RemoteReviewComment[]
}

export interface RemoteReviewSummary {
  id: string
  state: string
  body: string
  authorLogin: string
  submittedAt: string | null
}

export interface PullRequestConversation {
  available: boolean
  message: string | null
  body: string
  threads: RemoteReviewThread[]
  reviews: RemoteReviewSummary[]
}

export interface OmittedDiffFile {
  path: string
  reason: 'too-large'
  additions: number
  deletions: number
}

export interface WorkingTreePatch {
  patch: string
  omittedFiles: OmittedDiffFile[]
}

export interface PullRequestReview {
  kind: 'github'
  selector: string
  commitId: string
  viewerCanSubmitDecision: boolean
  pullRequest: PullRequestSummary
  files: PullRequestFile[]
  patch: string
  omittedFiles: OmittedDiffFile[]
  // What GitHub says the pull request touches. A streamed review arrives a page at
  // a time, so `files` climbs towards this rather than matching it immediately.
  expectedFileCount: number
}

/**
 * A pull request big enough to need the paged files API takes minutes to fetch in
 * full, so the review is streamed: metadata first, then one event per page of
 * files, each carrying only its own slice of the patch.
 */
export type PullRequestReviewProgress =
  | { kind: 'metadata'; selector: string; review: PullRequestReview }
  | {
      kind: 'files'
      selector: string
      patch: string
      files: PullRequestFile[]
      omittedFiles: OmittedDiffFile[]
    }

export interface LocalBranchReview {
  kind: 'local'
  id: string
  title: string
  baseRefName: string
  headRefName: string
  files: PullRequestFile[]
  patch: string
  omittedFiles: OmittedDiffFile[]
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

export type PullRequestMergeStrategy = 'squash' | 'merge' | 'rebase'

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

export type AgentProvider = 'claude' | 'codex'

export interface AgentAskInput {
  id: string
  provider: AgentProvider
  prompt: string
  context: string
  resumeSessionId?: string
}

export interface AgentStreamEvent {
  id: string
  /** `activity` reports what the agent is doing (a tool call, thinking). */
  kind: 'text' | 'session' | 'done' | 'error' | 'activity'
  text?: string
  sessionId?: string
}

export interface RepositoryApi {
  getSessionSnapshot(): Promise<RepositorySnapshot | null>
  openFolder(): Promise<RepositorySnapshot | null>
  openPath(path: string): Promise<RepositorySnapshot>
  refresh(): Promise<RepositorySnapshot>
  getComparison(path: string): Promise<FileComparison>
  getWorkingTreePatch(paths: string[]): Promise<WorkingTreePatch>
  searchContent(query: string): Promise<ContentSearchResult[]>
  cancelContentSearch(): void
  getGitIntegration(): Promise<GitIntegrationSnapshot>
  getPullRequestInbox(): Promise<PullRequestInboxSnapshot>
  switchBranch(name: string): Promise<RepositorySnapshot>
  getLocalBranchReview(baseRef: string, headRef: string): Promise<LocalBranchReview>
  getCommitReview(oid: string): Promise<LocalBranchReview>
  fetchRemote(): Promise<GitIntegrationSnapshot>
  pullCurrentBranch(): Promise<RepositorySnapshot>
  pushCurrentBranch(): Promise<GitIntegrationSnapshot>
  getPullRequestReview(selector: number | string): Promise<PullRequestReview>
  getPullRequestConversation(selector: number | string): Promise<PullRequestConversation>
  replyToPullRequestThread(threadId: string, body: string): Promise<void>
  setPullRequestThreadResolved(threadId: string, resolved: boolean): Promise<void>
  mergePullRequest(selector: number | string, strategy: PullRequestMergeStrategy): Promise<void>
  markPullRequestReady(selector: number | string): Promise<void>
  checkoutPullRequest(number: number): Promise<RepositorySnapshot>
  submitPullRequestReview(
    selector: number | string,
    commitId: string,
    event: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<void>
  askAgent(request: AgentAskInput): Promise<void>
  cancelAgent(id: string): Promise<void>
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void
  getPerformanceMetrics(): Promise<PerformanceMetrics>
  setVisibility(visible: boolean): Promise<void>
  findInPage(query: string, forward: boolean, findNext: boolean): Promise<number>
  stopFindInPage(): Promise<void>
  onFoundInPage(listener: (result: FindInPageResult) => void): () => void
  onDidChange(listener: (event: RepositoryChangeEvent) => void): () => void
  onPullRequestReviewProgress(listener: (progress: PullRequestReviewProgress) => void): () => void
}

export const IPC_CHANNELS = {
  getSessionSnapshot: 'repository:get-session-snapshot',
  openFolder: 'repository:open-folder',
  openPath: 'repository:open-path',
  refresh: 'repository:refresh',
  getComparison: 'repository:get-comparison',
  getWorkingTreePatch: 'repository:get-working-tree-patch',
  searchContent: 'repository:search-content',
  cancelContentSearch: 'repository:cancel-content-search',
  getGitIntegration: 'repository:get-git-integration',
  getPullRequestInbox: 'repository:get-pull-request-inbox',
  switchBranch: 'repository:switch-branch',
  getLocalBranchReview: 'repository:get-local-branch-review',
  getCommitReview: 'repository:get-commit-review',
  fetchRemote: 'repository:fetch-remote',
  pullCurrentBranch: 'repository:pull-current-branch',
  pushCurrentBranch: 'repository:push-current-branch',
  getPullRequestReview: 'repository:get-pull-request-review',
  getPullRequestConversation: 'repository:get-pull-request-conversation',
  replyToPullRequestThread: 'repository:reply-to-pull-request-thread',
  setPullRequestThreadResolved: 'repository:set-pull-request-thread-resolved',
  mergePullRequest: 'repository:merge-pull-request',
  markPullRequestReady: 'repository:mark-pull-request-ready',
  checkoutPullRequest: 'repository:checkout-pull-request',
  submitPullRequestReview: 'repository:submit-pull-request-review',
  askAgent: 'agent:ask',
  cancelAgent: 'agent:cancel',
  agentEvent: 'agent:event',
  getPerformanceMetrics: 'app:get-performance-metrics',
  setVisibility: 'app:set-visibility',
  findInPage: 'app:find-in-page',
  stopFindInPage: 'app:stop-find-in-page',
  foundInPage: 'app:found-in-page',
  didChange: 'repository:did-change',
  pullRequestReviewProgress: 'repository:pull-request-review-progress'
} as const
