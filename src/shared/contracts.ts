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
  // Watcher ticks normally keep the same path list. Omitting it avoids cloning
  // and serializing every path for a one-file content change.
  snapshot: Omit<RepositorySnapshot, 'paths'> & { paths?: string[] }
  changedPaths: string[]
  revision: number
}

export interface MainStartupMetrics {
  appReady: number | null
  windowCreated: number | null
  restoreSettled: number | null
}

export interface RendererStartupMetrics {
  rendererLoaded: number | null
  reactCommitted: number | null
  snapshotReady: number | null
  explorerCommitted: number | null
  viewerCommitted: number | null
}

// Split from PerformanceMetrics because collecting it costs a full document
// traversal in the preload and a per-process map/sort in main. Only gathered
// while the diagnostics disclosure that renders it is open.
export interface PerformanceMetricsDetail {
  mainStartup: MainStartupMetrics
  memoryByProcessType: Array<{ type: string; megabytes: number }>
  mainPrivateMegabytes: number
  rendererHeapUsedMegabytes: number
  rendererHeapTotalMegabytes: number
  rendererDomNodes: number
}

export interface PerformanceMetrics {
  cpuPercent: number
  gpuProcessCpuPercent: number | null
  workingSetMegabytes: number
  rendererPrivateMegabytes: number
  lastRendererTermination: RendererTermination | null
  processCount: number
  production: boolean
  sampledAt: number
  detail: PerformanceMetricsDetail | null
}

// What main needs from the renderer's preferences before the next launch: the
// window background colour it paints before first paint, and whether to reopen
// the last folder while the renderer is still booting.
export interface StartupPreferences {
  themeType: 'dark' | 'light'
  restoreLastFolder: boolean
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
  previousPath?: string
  additions: number
  deletions: number
  /** Full blob IDs are preferred for checkpoint and viewed-state identity. */
  baseBlobOid?: string
  headBlobOid?: string
  /** Hash of the complete patch section when a full blob ID is unavailable. */
  patchHash?: string
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
  /** Immutable comparison snapshot. `baseOid` is the PR base commit. */
  baseOid: string
  /** Immutable comparison snapshot. Also used when submitting a review. */
  headOid: string
  commitId: string
  viewerCanSubmitDecision: boolean
  pullRequest: PullRequestSummary
  files: PullRequestFile[]
  patch: string
  /** Renderer-only streamed storage. IPC replies leave this field undefined. */
  patchPages?: readonly string[]
  /** Sum of the streamed page lengths without joining them. */
  patchLength?: number
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
  | {
      kind: 'metadata'
      selector: string
      review: PullRequestReview
      root?: string
      requestId?: string
    }
  | {
      kind: 'files'
      selector: string
      patch: string
      files: PullRequestFile[]
      omittedFiles: OmittedDiffFile[]
      root?: string
      requestId?: string
    }
  | {
      kind: 'done'
      selector: string
      fileCount: number
      root?: string
      requestId?: string
    }

export interface LocalBranchReview {
  kind: 'local'
  id: string
  title: string
  baseRefName: string
  headRefName: string
  /** Resolved comparison base. For `A...B`, this is the merge base. */
  baseOid: string
  /** Resolved comparison head. */
  headOid: string
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

export interface WorkingFileSaveRequest {
  path: string
  contents: string
  expectedCacheKey: string
}

export interface ContentSearchResult {
  path: string
  line: number
  column: number
  preview: string
}

export type AgentProvider = 'claude' | 'codex'

export type AgentAccessMode = 'review' | 'auto' | 'full-access'

export interface AgentModelOption {
  id: string
  label: string
  description: string
  efforts: string[]
  defaultEffort: string
  default?: boolean
}

export type AgentModelCatalog = Record<AgentProvider, AgentModelOption[]>

export interface AgentProviderStatus {
  provider: AgentProvider
  installed: boolean
  authenticated: boolean
  label: string
  detail: string
  version?: string
}

export type AgentProviderStatuses = Record<AgentProvider, AgentProviderStatus>

export interface AgentRateLimitWindow {
  label: string
  usedPercent: number
  resetsAt: number | null
}

export interface AgentUsageUpdate {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  contextWindow?: number
  costUsd?: number
  durationMs?: number
  turns?: number
  model?: string
  rateLimits?: AgentRateLimitWindow[]
}

export type AgentActivityKind =
  | 'reasoning'
  | 'command'
  | 'file'
  | 'search'
  | 'tool'
  | 'plan'
  | 'status'

export type AgentActivityStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'waiting'

export interface AgentActivityUpdate {
  id: string
  kind: AgentActivityKind
  title: string
  status: AgentActivityStatus
  detail?: string
  output?: string
  /** Append streamed text to the existing detail or output instead of replacing it. */
  append?: 'detail' | 'output'
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

export interface AgentApprovalRequest {
  requestId: string
  itemId: string
  type: 'command' | 'file-change' | 'permissions'
  title: string
  detail: string
}

export type AgentApprovalDecision = 'accept' | 'acceptForSession' | 'decline'

export type AgentSubjectSource = 'workingTree' | 'patch' | 'since'

export interface AgentRequestSubject {
  tabId: string
  repositoryRoot: string
  repositoryName: string
  source: AgentSubjectSource
  baseOid: string | null
  headOid: string | null
}

export interface AgentRequestSelection {
  path: string
  startLine: number
  endLine: number
  side: 'additions' | 'deletions'
  selectedText: string
  blobOid: string | null
}

export interface AgentAskInput {
  id: string
  provider: AgentProvider
  model: string
  effort: string
  accessMode: AgentAccessMode
  prompt: string
  context: string
  subject: AgentRequestSubject
  selections: AgentRequestSelection[]
  resumeSessionId?: string
}

export interface AgentStreamEvent {
  id: string
  kind: 'text' | 'session' | 'done' | 'error' | 'activity' | 'approval' | 'usage'
  text?: string
  sessionId?: string
  activity?: AgentActivityUpdate
  approval?: AgentApprovalRequest
  usage?: AgentUsageUpdate
}

export interface TerminalSession {
  id: string
  cwd: string
  shell: string
  pid: number
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

export interface RepositoryApi {
  getSessionSnapshot(): Promise<RepositorySnapshot | null>
  openFolder(): Promise<RepositorySnapshot | null>
  openPath(path: string): Promise<RepositorySnapshot>
  activateRepository(root: string): Promise<RepositorySnapshot>
  releaseRepository(root: string): Promise<void>
  resolvePullRequestRepository(pullRequestUrl: string): Promise<RepositorySnapshot | null>
  readClipboardText(type?: string): Promise<string>
  revealPath(path: string): Promise<void>
  refresh(): Promise<RepositorySnapshot>
  getComparison(path: string): Promise<FileComparison>
  saveWorkingFile(request: WorkingFileSaveRequest): Promise<FileComparison>
  getWorkingTreePatch(paths: string[]): Promise<WorkingTreePatch>
  searchContent(query: string): Promise<ContentSearchResult[]>
  cancelContentSearch(): void
  getGitIntegration(): Promise<GitIntegrationSnapshot>
  getPullRequestInbox(): Promise<PullRequestInboxSnapshot>
  getClosedPullRequests(): Promise<PullRequestSummary[]>
  switchBranch(name: string): Promise<RepositorySnapshot>
  getLocalBranchReview(baseRef: string, headRef: string): Promise<LocalBranchReview>
  getCommitReview(oid: string): Promise<LocalBranchReview>
  fetchRemote(): Promise<GitIntegrationSnapshot>
  pullCurrentBranch(): Promise<RepositorySnapshot>
  pushCurrentBranch(): Promise<GitIntegrationSnapshot>
  getPullRequestReview(root: string, selector: number | string, requestId: string): Promise<PullRequestReview>
  cancelPullRequestReview(root: string, requestId: string): void
  getPullRequestConversation(root: string, selector: number | string): Promise<PullRequestConversation>
  replyToPullRequestThread(root: string, threadId: string, body: string): Promise<void>
  setPullRequestThreadResolved(root: string, threadId: string, resolved: boolean): Promise<void>
  mergePullRequest(root: string, selector: number | string, strategy: PullRequestMergeStrategy): Promise<void>
  markPullRequestReady(root: string, selector: number | string): Promise<void>
  checkoutPullRequest(number: number): Promise<RepositorySnapshot>
  submitPullRequestReview(
    root: string,
    selector: number | string,
    commitId: string,
    event: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<void>
  getAgentModels(): Promise<AgentModelCatalog>
  /** Naming a provider re-probes only that one; the other keeps its cached status. */
  getAgentStatuses(provider?: AgentProvider): Promise<AgentProviderStatuses>
  loginAgent(provider: AgentProvider): Promise<void>
  askAgent(request: AgentAskInput): Promise<void>
  cancelAgent(id: string): Promise<void>
  respondAgentApproval(requestId: string, decision: AgentApprovalDecision): Promise<void>
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void
  createTerminal(columns: number, rows: number): Promise<TerminalSession>
  readyTerminal(sessionId: string): void
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, columns: number, rows: number): void
  clearTerminal(sessionId: string): void
  setTerminalVisibility(sessionId: string, visible: boolean): void
  killTerminal(sessionId: string): Promise<void>
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void
  getPerformanceMetrics(detailed: boolean): Promise<PerformanceMetrics>
  setVisibility(visible: boolean): Promise<void>
  setStartupPreferences(preferences: StartupPreferences): Promise<void>
  findInPage(query: string, forward: boolean, findNext: boolean): Promise<number>
  stopFindInPage(): Promise<void>
  onFoundInPage(listener: (result: FindInPageResult) => void): () => void
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void
  onDidChange(listener: (event: RepositoryChangeEvent) => void): () => void
  onPullRequestReviewProgress(listener: (progress: PullRequestReviewProgress) => void): () => void
}

export const IPC_CHANNELS = {
  getSessionSnapshot: 'repository:get-session-snapshot',
  openFolder: 'repository:open-folder',
  openPath: 'repository:open-path',
  activateRepository: 'repository:activate',
  releaseRepository: 'repository:release',
  resolvePullRequestRepository: 'repository:resolve-pull-request',
  readClipboardText: 'app:clipboard-read-text',
  revealPath: 'app:reveal-path',
  refresh: 'repository:refresh',
  getComparison: 'repository:get-comparison',
  saveWorkingFile: 'repository:save-working-file',
  getWorkingTreePatch: 'repository:get-working-tree-patch',
  searchContent: 'repository:search-content',
  cancelContentSearch: 'repository:cancel-content-search',
  getGitIntegration: 'repository:get-git-integration',
  getPullRequestInbox: 'repository:get-pull-request-inbox',
  getClosedPullRequests: 'repository:get-closed-pull-requests',
  switchBranch: 'repository:switch-branch',
  getLocalBranchReview: 'repository:get-local-branch-review',
  getCommitReview: 'repository:get-commit-review',
  fetchRemote: 'repository:fetch-remote',
  pullCurrentBranch: 'repository:pull-current-branch',
  pushCurrentBranch: 'repository:push-current-branch',
  getPullRequestReview: 'repository:get-pull-request-review',
  cancelPullRequestReview: 'repository:cancel-pull-request-review',
  getPullRequestConversation: 'repository:get-pull-request-conversation',
  replyToPullRequestThread: 'repository:reply-to-pull-request-thread',
  setPullRequestThreadResolved: 'repository:set-pull-request-thread-resolved',
  mergePullRequest: 'repository:merge-pull-request',
  markPullRequestReady: 'repository:mark-pull-request-ready',
  checkoutPullRequest: 'repository:checkout-pull-request',
  submitPullRequestReview: 'repository:submit-pull-request-review',
  getAgentModels: 'agent:get-models',
  getAgentStatuses: 'agent:get-statuses',
  loginAgent: 'agent:login',
  askAgent: 'agent:ask',
  cancelAgent: 'agent:cancel',
  respondAgentApproval: 'agent:respond-approval',
  agentEvent: 'agent:event',
  createTerminal: 'terminal:create',
  readyTerminal: 'terminal:ready',
  writeTerminal: 'terminal:write',
  resizeTerminal: 'terminal:resize',
  clearTerminal: 'terminal:clear',
  setTerminalVisibility: 'terminal:visibility',
  killTerminal: 'terminal:kill',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  getPerformanceMetrics: 'app:get-performance-metrics',
  setVisibility: 'app:set-visibility',
  setStartupPreferences: 'app:set-startup-preferences',
  findInPage: 'app:find-in-page',
  stopFindInPage: 'app:stop-find-in-page',
  foundInPage: 'app:found-in-page',
  fullscreenChange: 'app:fullscreen-change',
  didChange: 'repository:did-change',
  pullRequestReviewProgress: 'repository:pull-request-review-progress'
} as const
