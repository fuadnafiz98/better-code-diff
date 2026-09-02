import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fileConstants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve, sep } from 'node:path'

import type {
  ContentSearchResult,
  DiffFileContents,
  FileComparison,
  ImagePreviewSide,
  GitCommit,
  GitIntegrationSnapshot,
  GitRemote,
  InboxPullRequest,
  LocalBranch,
  LocalBranchReview,
  OmittedDiffFile,
  PullRequestChecks,
  PullRequestFile,
  PullRequestInboxSection,
  PullRequestInboxSectionKey,
  PullRequestInboxSnapshot,
  PullRequestConversation,
  PullRequestReview,
  PullRequestReviewProgress,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  PullRequestSummary,
  RemoteBranch,
  RemoteReviewComment,
  RemoteReviewSummary,
  RemoteReviewThread,
  RepositoryFileStatus,
  RepositorySnapshot,
  RepositoryStatusEntry,
  WorkingFileSaveRequest,
  WorkingTreePatch
} from '../shared/contracts.js'
import { createImagePreviewSide } from '../shared/imagePreview.js'
import { normalizeGitHubPullRequestUrl } from '../shared/pullRequestUrl.js'
import {
  COMMAND_ABORTED_MESSAGE,
  comparePaths,
  GitObjectReader,
  MAX_DIFF_FILE_BYTES,
  mapWithConcurrency,
  runCommand,
  splitNullDelimited,
  type CommandResult,
  type GitObjectRead
} from './gitCommands.js'
import {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecs,
  createNewFilePatch,
  diffFilesFromChurn,
  filesFromPatch,
  isPullRequestDiffTooLargeError,
  limitPatchFileSize,
  MAX_PULL_REQUEST_FILES,
  parseNumstat,
  PULL_REQUEST_FILES_PAGE_SIZE,
  pullRequestFilePageWave,
  selectOversizedDiffFiles,
  type RawPullRequestFile
} from './patchBuilder.js'

// Re-exported so the process, object-reading and patch primitives keep one import
// site for callers and tests while living in their own modules.
export {
  GitObjectReader,
  readGitObject,
  type GitObjectRead
} from './gitCommands.js'
export {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecs,
  createNewFilePatch,
  diffFilesFromChurn,
  filesFromPatch,
  isPullRequestDiffTooLargeError,
  limitPatchFileSize,
  parseNumstat,
  pullRequestFilePageWave,
  selectOversizedDiffFiles,
  type DiffChurnEntry,
  type RawPullRequestFile
} from './patchBuilder.js'

export function pullRequestReviewReply(
  review: PullRequestReview,
  streamed: boolean
): PullRequestReview {
  return streamed
    ? {
        ...review,
        files: [],
        patch: '',
        omittedFiles: [],
        expectedFileCount: review.files.length
      }
    : review
}

const MAX_SEARCH_RESULTS = 200
// The byte cap is the real guard: at a 2 MB per-entry ceiling 512 typical source
// files cost a few MB, while 16 entries evicted the first file of any review page
// before the reader could scroll back to it.
const MAX_HEAD_CACHE_ENTRIES = 512
const MAX_HEAD_CACHE_BYTES = 64 * 1024 * 1024
const MAX_WORKING_CACHE_ENTRIES = 256
const MAX_WORKING_CACHE_BYTES = 64 * 1024 * 1024
const MAX_PATCH_COMMAND_CONCURRENCY = 4
const MAX_PULL_REQUEST_REVIEW_COMMENTS = 100
const PULL_REQUEST_LIST_LIMIT = 30
// A pull request's diff is immutable for a given head oid, so a reopen — after
// closing the panel, after switching to the working tree and back, after a
// restart — can serve it from disk instead of repeating a download the code's own
// comment measures at nearly two minutes for a 3000-file review. A force-push
// produces a new oid and therefore a new key, so staleness is impossible.
const PULL_REQUEST_CACHE_VERSION = 3
const MAX_PULL_REQUEST_CACHE_ENTRIES = 20
const MAX_PULL_REQUEST_CACHE_BYTES = 200 * 1024 * 1024

export interface CachedPullRequestReview {
  version: number
  headRefOid: string
  files: PullRequestFile[]
  patch: string
  omittedFiles: OmittedDiffFile[]
}

interface CachedPullRequestReviewMetadata {
  version: number
  headRefOid: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
  patchLength: number
}
const MAX_REVIEW_BODY_LENGTH = 65_536
// `gh search prs --json` only exposes these pull request fields; richer fields need `gh pr view`.
const PULL_REQUEST_LIST_FIELDS = 'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,updatedAt,additions,deletions,changedFiles'
const PULL_REQUEST_REVIEW_FIELDS = `${PULL_REQUEST_LIST_FIELDS},baseRefOid,headRefOid,files`
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// Requested separately because older `gh` builds reject the whole command when a field name is unknown.
const PULL_REQUEST_CHECK_FIELDS = 'statusCheckRollup,mergeable'
const PASSING_CHECK_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILING_CHECK_RESULTS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'CANCELED'])
// Listed in precedence order: the first section that claims a pull request keeps it.
const PULL_REQUEST_INBOX_SECTIONS = [
  { key: 'review-requested', title: 'Needs your review', alias: 'reviewRequested', qualifier: 'review-requested' },
  { key: 'assigned', title: 'Assigned to you', alias: 'assigned', qualifier: 'assignee' },
  { key: 'mentioned', title: 'Mentions you', alias: 'mentioned', qualifier: 'mentions' },
  { key: 'authored', title: 'Your open PRs', alias: 'authored', qualifier: 'author' }
] as const satisfies readonly {
  key: PullRequestInboxSectionKey
  title: string
  alias: string
  qualifier: string
}[]

// One aliased search per section in a single request. As four `gh search prs`
// spawns this cost four processes and four calls against the search API's 30/min
// budget on every poll tick; batched it is one of each.
const PULL_REQUEST_INBOX_QUERY = `
  query PullRequestInbox($reviewRequested: String!, $assigned: String!, $mentioned: String!, $authored: String!) {
    reviewRequested: search(type: ISSUE, query: $reviewRequested, first: 50) { nodes { ...InboxPullRequest } }
    assigned: search(type: ISSUE, query: $assigned, first: 50) { nodes { ...InboxPullRequest } }
    mentioned: search(type: ISSUE, query: $mentioned, first: 50) { nodes { ...InboxPullRequest } }
    authored: search(type: ISSUE, query: $authored, first: 50) { nodes { ...InboxPullRequest } }
  }
  fragment InboxPullRequest on PullRequest {
    number
    title
    url
    state
    isDraft
    updatedAt
    author { login }
  }
`

// GraphQL reports PullRequestState as an enum (OPEN), while `gh search prs --json`
// reported it lowercase. The renderer contract keeps the lowercase spelling.
export function parsePullRequestInboxResponse(value: unknown): PullRequestInboxEntry[] {
  const data = (value as { data?: Record<string, unknown> })?.data
  if (typeof data !== 'object' || data == null) return []
  const entries: PullRequestInboxEntry[] = []
  for (const { key, alias } of PULL_REQUEST_INBOX_SECTIONS) {
    const nodes = (data[alias] as { nodes?: unknown })?.nodes
    if (!Array.isArray(nodes)) continue
    for (const node of nodes) {
      if (typeof node !== 'object' || node == null) continue
      const record = node as Record<string, unknown>
      entries.push({
        key,
        pullRequest: {
          ...record,
          state: typeof record.state === 'string' ? record.state.toLowerCase() : record.state
        }
      })
    }
  }
  return entries
}
const SELF_REVIEW_DECISION_ERROR = 'GitHub does not allow you to approve or request changes on your own pull request. Submit the review as a comment instead.'
const ADD_PULL_REQUEST_REVIEW_MUTATION = `
  mutation AddPullRequestReview($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) {
      pullRequestReview { id }
    }
  }
`
const PULL_REQUEST_THREADS_QUERY = `
  query PullRequestThreads($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        body
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            diffSide
            comments(first: 50) {
              nodes { id body author { login } createdAt }
            }
          }
        }
        reviews(first: 50) {
          nodes { id state body submittedAt author { login } }
        }
      }
    }
  }
`
const ADD_REVIEW_THREAD_REPLY_MUTATION = `
  mutation AddReviewThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment { id }
    }
  }
`
const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) { thread { id isResolved } }
  }
`
const UNRESOLVE_REVIEW_THREAD_MUTATION = `
  mutation UnresolveReviewThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) { thread { id isResolved } }
  }
`
const MAX_REMOTE_THREAD_BODY_LENGTH = 65_536
const GH_EXECUTABLE_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const
const SEARCH_CANCELLED_MESSAGE = 'The search was cancelled before it finished.'
const SEARCH_INTERRUPTED_MESSAGE = 'The search stopped before it finished.'
const EXCLUDED_DIRECTORIES = [
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.vite',
  'DerivedData',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target'
] as const
const EXCLUDED_DIRECTORY_SET = new Set<string>(EXCLUDED_DIRECTORIES)
const RIPGREP_EXCLUSION_ARGS = EXCLUDED_DIRECTORIES.flatMap((directory) => [
  '--glob',
  `!${directory}/**`,
  '--glob',
  `!**/${directory}/**`
])

// `file` is the materialized diff side, built once when the version is read.
// Rebuilding it per comparison re-ran a utf8 decode and a sha1 over the whole
// buffer on every navigation, scroll hydration and post-save refetch.
type ReadVersion = {
  file: DiffFileContents | null
  binary: boolean
  oversized: boolean
  image?: ImagePreviewSide | null
}

type WorkingFileRead = ReadVersion & {
  contents: Buffer | null
  revision: string
}

export function isSameGitHubLogin(firstLogin: string, secondLogin: string): boolean {
  return firstLogin.trim().toLowerCase() === secondLogin.trim().toLowerCase()
}

const require = createRequire(import.meta.url)
const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
const RIPGREP_EXECUTABLE = resolvePackagedExecutablePath(rgPath)

export function resolvePackagedExecutablePath(executablePath: string): string {
  return executablePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

let ghExecutablePromise: Promise<string> | null = null

function getGhExecutable(): Promise<string> {
  ghExecutablePromise ??= (async () => {
    for (const candidate of GH_EXECUTABLE_CANDIDATES) {
      try {
        await access(candidate, fileConstants.X_OK)
        return candidate
      } catch {
      }
    }
    return 'gh'
  })()
  return ghExecutablePromise
}


function isTransientGitHubError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP\s+(?:502|503|504)\b|timed?\s*out|timeout|connection reset/i.test(message)
}

async function runGitHubReadCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  const retryDelays = [0, 250, 750] as const
  let lastError: unknown
  for (const retryDelay of retryDelays) {
    if (signal?.aborted === true) throw new Error(COMMAND_ABORTED_MESSAGE)
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay))
    try {
      return await runCommand(executable, args, cwd, [], undefined, signal)
    } catch (error) {
      lastError = error
      if (!isTransientGitHubError(error)) throw error
    }
  }
  throw lastError
}

function gitHubIntegrationErrorMessage(error: unknown): string {
  if (isTransientGitHubError(error)) {
    return 'GitHub timed out while loading the pull request list. Retry, or open a pull request directly by number or URL.'
  }
  return error instanceof Error ? error.message : String(error)
}

export function mapGitStatus(indexStatus: string, workingStatus: string): RepositoryFileStatus {
  if (indexStatus === '?' && workingStatus === '?') return 'untracked'
  // Unmerged combinations from git-status(1): DD, AU, UD, UA, DU, AA, UU.
  if (
    indexStatus === 'U' || workingStatus === 'U' ||
    (indexStatus === 'A' && workingStatus === 'A') ||
    (indexStatus === 'D' && workingStatus === 'D')
  ) return 'conflicted'
  if (indexStatus === 'R' || workingStatus === 'R') return 'renamed'
  if (indexStatus === 'A' || workingStatus === 'A') return 'added'
  if (indexStatus === 'D' || workingStatus === 'D') return 'deleted'
  return 'modified'
}

// A full refresh rebuilds the snapshot from a whole-tree status walk. A save
// touches one file, so the entry for that path is swapped in place instead —
// preserving the order a full refresh would produce (tracked entries in path
// order, then untracked ones) so the two never disagree.
export function replaceStatusEntry(
  statuses: readonly RepositoryStatusEntry[],
  path: string,
  next: RepositoryStatusEntry | null
): RepositoryStatusEntry[] {
  const tracked: RepositoryStatusEntry[] = []
  const untracked: RepositoryStatusEntry[] = []
  for (const entry of statuses) {
    if (entry.path === path) continue
    if (entry.status === 'untracked') untracked.push(entry)
    else tracked.push(entry)
  }
  if (next != null) {
    const target = next.status === 'untracked' ? untracked : tracked
    const index = target.findIndex((entry) => comparePaths(entry.path, path) > 0)
    target.splice(index === -1 ? target.length : index, 0, next)
  }
  return [...tracked, ...untracked]
}

export interface PorcelainV2Status {
  branch: string | null
  head: string | null
  statuses: RepositoryStatusEntry[]
  untrackedPaths: string[]
}

// `--porcelain=v2 --branch` carries the branch name and HEAD oid in its header
// lines and the untracked set in its `?` records, so one call replaces the four
// that `refresh()` used to make (status, branch --show-current, rev-parse HEAD,
// and a second working-tree walk via `ls-files --others`).
export function parsePorcelainV2Status(buffer: Buffer): PorcelainV2Status {
  const fields = splitNullDelimited(buffer)
  const statuses: RepositoryStatusEntry[] = []
  const untrackedPaths: string[] = []
  let branch: string | null = null
  let head: string | null = null

  // v2 spells "unmodified" as '.' where v1 used a space.
  const statusChar = (value: string | undefined): string => (value === '.' ? ' ' : value ?? ' ')

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field == null || field === '') continue

    if (field.startsWith('# branch.head ')) {
      const value = field.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (field.startsWith('# branch.oid ')) {
      const value = field.slice('# branch.oid '.length).trim()
      head = value === '(initial)' ? null : value
      continue
    }
    if (field.startsWith('# ')) continue

    if (field.startsWith('? ')) {
      untrackedPaths.push(field.slice(2))
      continue
    }
    if (field.startsWith('! ')) continue

    const parts = field.split(' ')
    const kind = parts[0]
    // Paths may contain spaces, so the remainder is rejoined rather than indexed.
    if (kind === '1' && parts.length > 8) {
      const xy = parts[1] ?? '..'
      statuses.push({
        path: parts.slice(8).join(' '),
        status: mapGitStatus(statusChar(xy[0]), statusChar(xy[1]))
      })
      continue
    }
    if (kind === '2' && parts.length > 9) {
      const xy = parts[1] ?? '..'
      // A rename record is followed by its original path in the next NUL field.
      const previousPath = fields[index + 1]
      index += 1
      statuses.push({
        path: parts.slice(9).join(' '),
        ...(previousPath == null ? {} : { previousPath }),
        status: mapGitStatus(statusChar(xy[0]), statusChar(xy[1]))
      })
      continue
    }
    if (kind === 'u' && parts.length > 10) {
      const xy = parts[1] ?? '..'
      statuses.push({
        path: parts.slice(10).join(' '),
        status: mapGitStatus(statusChar(xy[0]), statusChar(xy[1]))
      })
    }
  }

  for (const path of untrackedPaths) {
    statuses.push({ path, status: 'untracked' })
  }

  return { branch, head, statuses, untrackedPaths }
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function createCacheKey(...parts: Array<string | Buffer | null>): string {
  const hash = createHash('sha1')
  for (const part of parts) {
    if (part != null) hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isBinary(contents: Buffer): boolean {
  const inspectionLength = Math.min(contents.length, 8_000)
  for (let byteIndex = 0; byteIndex < inspectionLength; byteIndex += 1) {
    if (contents[byteIndex] === 0) return true
  }
  return false
}

// Answered per parent directory rather than per path: on a 100k-path snapshot the
// split-and-scan version cost 67 ms of the 120 ms refresh, and every path under a
// directory shares its answer.
const excludedDirectoryMemo = new Map<string, boolean>()

const MAX_EXCLUDED_DIRECTORY_MEMO_ENTRIES = 100_000

function isExcludedDirectory(directory: string): boolean {
  const memoized = excludedDirectoryMemo.get(directory)
  if (memoized !== undefined) return memoized
  if (excludedDirectoryMemo.size >= MAX_EXCLUDED_DIRECTORY_MEMO_ENTRIES) excludedDirectoryMemo.clear()
  const separator = Math.max(directory.lastIndexOf('/'), directory.lastIndexOf('\\'))
  const segment = separator === -1 ? directory : directory.slice(separator + 1)
  const excluded = EXCLUDED_DIRECTORY_SET.has(segment)
    || (separator > 0 && isExcludedDirectory(directory.slice(0, separator)))
  excludedDirectoryMemo.set(directory, excluded)
  return excluded
}

function isExcludedPath(path: string): boolean {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 && isExcludedDirectory(path.slice(0, separator))
}

function prepareVisiblePaths(buffer: Buffer): string[] {
  const paths: string[] = []
  for (const rawPath of splitNullDelimited(buffer)) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) paths.push(path)
  }
  return paths.sort(comparePaths)
}

// Tracked paths come from `ls-files`, untracked ones from the same status call
// that produced the statuses. A file can appear in both when it is tracked and
// also reported, so the set is deduplicated.
//
// The build-output exclusion applies only to the untracked side. A repository that
// commits its `dist/` is telling git those files matter; hiding them made them
// unreviewable and made commit reviews disagree with their own patch, which never
// carried the exclusion. Anything genuinely generated is already ignored, so git
// never lists it as tracked.
export function mergeVisiblePaths(trackedBuffer: Buffer, untrackedPaths: readonly string[]): string[] {
  const seen = new Set<string>(splitNullDelimited(trackedBuffer))
  for (const rawPath of untrackedPaths) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) seen.add(path)
  }
  return [...seen].sort(comparePaths)
}


export function classifySearchCompletion(outcome: {
  cancelled: boolean
  code: number | null
  signal: string | null
  resultCount: number
  errorOutput: string
}): { kind: 'results' } | { kind: 'error'; message: string } {
  if (outcome.cancelled) return { kind: 'error', message: SEARCH_CANCELLED_MESSAGE }
  if (outcome.resultCount >= MAX_SEARCH_RESULTS) return { kind: 'results' }
  if (outcome.signal != null) return { kind: 'error', message: SEARCH_INTERRUPTED_MESSAGE }
  if (outcome.code != null && outcome.code > 1) {
    return {
      kind: 'error',
      message: outcome.errorOutput.trim() || `Search failed with exit code ${outcome.code}.`
    }
  }
  return { kind: 'results' }
}

export function isPathWithinApprovedRoots(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithinRoot(root, candidate))
}

// The key identifies content, not the read that produced it. Folding the commit
// oid or the file's mtime in here re-keyed every open file after any commit or
// any byte-identical rewrite, which both re-tokenized the whole diff in the
// worker pool and made a pending draft unsavable against its own unchanged file.
function toDiffFile(name: string, contents: Buffer): DiffFileContents {
  return {
    name,
    contents: contents.toString('utf8'),
    cacheKey: createCacheKey(name, contents)
  }
}

function parseJson<T>(result: CommandResult, label: string): T {
  try {
    return JSON.parse(result.stdout.toString('utf8')) as T
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
}

function parseBranches(result: CommandResult): LocalBranch[] {
  return result.stdout.toString('utf8').split('\n').flatMap((line) => {
    if (line === '') return []
    const [head, name, upstream = ''] = line.split('\t')
    if (name == null || name === '') return []
    return [{ name, current: head === '*', upstream: upstream || null }]
  })
}

function parseRemoteBranches(result: CommandResult): RemoteBranch[] {
  return result.stdout.toString('utf8').split('\n').flatMap((name) => {
    if (name === '' || name.endsWith('/HEAD')) return []
    const separatorIndex = name.indexOf('/')
    if (separatorIndex < 1) return []
    return [{ name, remote: name.slice(0, separatorIndex) }]
  })
}

export function parseRemotes(result: CommandResult): GitRemote[] {
  const remotes = new Map<string, GitRemote>()
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/.exec(line)
    if (match == null) continue
    const [, name, url, direction] = match
    if (name == null || url == null || direction == null) continue
    const remote = remotes.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (direction === 'fetch') remote.fetchUrl = url
    else remote.pushUrl = url
    remotes.set(name, remote)
  }
  return [...remotes.values()]
}

function parseCommits(result: CommandResult | null): GitCommit[] {
  if (result == null) return []
  return result.stdout.toString('utf8').split('\x1e').flatMap((record) => {
    const trimmedRecord = record.replace(/^\n+|\n+$/g, '')
    if (trimmedRecord === '') return []
    const [oid, shortOid, parents = '', authorName, authorEmail, authoredAt, subject, decorations = ''] = trimmedRecord.split('\x1f')
    if (oid == null || shortOid == null || authorName == null || authorEmail == null || authoredAt == null || subject == null) return []
    return [{
      oid,
      shortOid,
      parents: parents === '' ? [] : parents.split(' '),
      authorName,
      authorEmail,
      authoredAt,
      subject,
      decorations: decorations === '' ? [] : decorations.split(', ').map((decoration) => decoration.trim())
    }]
  })
}

function parseAheadBehind(result: CommandResult | null): { ahead: number; behind: number } {
  if (result == null) return { ahead: 0, behind: 0 }
  const [aheadText = '0', behindText = '0'] = result.stdout.toString('utf8').trim().split(/\s+/)
  return { ahead: Number(aheadText) || 0, behind: Number(behindText) || 0 }
}

function requirePullRequestNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('Pull request number must be a positive integer.')
  }
}

export function normalizePullRequestSelector(selector: number | string): string {
  if (typeof selector === 'number') {
    requirePullRequestNumber(selector)
    return String(selector)
  }
  const trimmedSelector = selector.trim()
  const numberMatch = /^#?(\d+)$/.exec(trimmedSelector)
  if (numberMatch != null) {
    const pullRequestNumber = Number(numberMatch[1])
    requirePullRequestNumber(pullRequestNumber)
    return String(pullRequestNumber)
  }
  const pullRequestUrl = normalizeGitHubPullRequestUrl(trimmedSelector)
  if (pullRequestUrl != null) return pullRequestUrl
  throw new Error('Pull request selector must be a positive number or a GitHub pull request URL.')
}

export function githubRepoSlugFromRemoteUrl(url: string): string | null {
  // https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), ssh://git@github.com/owner/repo(.git).
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(url.trim())
  if (match == null) return null
  const [, owner, repository] = match
  if (owner == null || repository == null) return null
  return `${owner}/${repository}`.toLowerCase()
}

export interface PullRequestInboxEntry {
  key: PullRequestInboxSectionKey
  pullRequest: unknown
}

type RawPullRequestSummary = Omit<PullRequestSummary, 'checks' | 'mergeable'> & {
  statusCheckRollup?: unknown
  mergeable?: unknown
}

function normalizeCheckToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toUpperCase()
  return token === '' ? null : token
}

// `statusCheckRollup` mixes CheckRun entries (status plus conclusion) with StatusContext entries (state).
export function summarizeCheckRollup(value: unknown): PullRequestChecks | null {
  if (!Array.isArray(value)) return null
  const checks = { passing: 0, failing: 0, pending: 0 }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue
    const { status, conclusion, state } = entry as Record<string, unknown>
    const statusToken = normalizeCheckToken(status)
    const conclusionToken = normalizeCheckToken(conclusion)
    const stateToken = normalizeCheckToken(state)
    if (statusToken == null && conclusionToken == null && stateToken == null) continue
    // A check run carries no verdict until it completes.
    const verdict = statusToken != null && statusToken !== 'COMPLETED' ? null : conclusionToken ?? stateToken
    if (verdict != null && PASSING_CHECK_RESULTS.has(verdict)) checks.passing += 1
    else if (verdict != null && FAILING_CHECK_RESULTS.has(verdict)) checks.failing += 1
    else checks.pending += 1
  }
  return checks
}

function toPullRequestSummary(value: RawPullRequestSummary): PullRequestSummary {
  const { statusCheckRollup, mergeable, ...pullRequest } = value
  return {
    ...pullRequest,
    checks: summarizeCheckRollup(statusCheckRollup),
    mergeable: typeof mergeable === 'string' ? mergeable : null
  }
}

function parsePullRequestSummaries(result: CommandResult): PullRequestSummary[] {
  const summaries: PullRequestSummary[] = []
  for (const value of parseJson<RawPullRequestSummary[]>(result, 'GitHub CLI')) {
    summaries.push(toPullRequestSummary(value))
  }
  return summaries
}

function toInboxPullRequest(value: unknown): InboxPullRequest | null {
  if (typeof value !== 'object' || value == null) return null
  const { number, title, url, state, isDraft, author, updatedAt } = value as Record<string, unknown>
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null
  if (typeof title !== 'string' || typeof state !== 'string' || typeof updatedAt !== 'string') return null
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i.test(url)) return null
  const login = typeof author === 'object' && author != null ? (author as Record<string, unknown>).login : null
  if (typeof login !== 'string' || login === '') return null
  return { number, title, url, state, isDraft: isDraft === true, author: { login }, updatedAt }
}

export function sectionPullRequestInbox(entries: readonly PullRequestInboxEntry[]): PullRequestInboxSection[] {
  const claimedUrls = new Set<string>()
  return PULL_REQUEST_INBOX_SECTIONS.map(({ key, title }) => {
    const pullRequests: InboxPullRequest[] = []
    for (const entry of entries) {
      if (entry.key !== key) continue
      const pullRequest = toInboxPullRequest(entry.pullRequest)
      if (pullRequest == null) continue
      const identity = pullRequest.url.toLowerCase()
      if (claimedUrls.has(identity)) continue
      claimedUrls.add(identity)
      pullRequests.push(pullRequest)
    }
    return { key, title, pullRequests }
  })
}

function readString(value: unknown, maxLength = MAX_REMOTE_THREAD_BODY_LENGTH): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function parseRemoteReviewComments(value: unknown): RemoteReviewComment[] {
  const nodes = (value as { nodes?: unknown })?.nodes
  if (!Array.isArray(nodes)) return []
  const comments: RemoteReviewComment[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node == null) continue
    const { id, body, author, createdAt } = node as Record<string, unknown>
    if (typeof id !== 'string' || id === '') continue
    comments.push({
      id,
      body: readString(body),
      authorLogin: readString((author as { login?: unknown } | null)?.login, 256),
      createdAt: readString(createdAt, 64)
    })
  }
  return comments
}

// GitHub reports a thread's position on the diff side it was left on; anything
// unexpected is treated as a right-side (addition) comment.
export function parsePullRequestConversation(value: unknown): Omit<PullRequestConversation, 'available' | 'message'> {
  const pullRequest = (value as { data?: { repository?: { pullRequest?: unknown } } })?.data?.repository?.pullRequest
  if (typeof pullRequest !== 'object' || pullRequest == null) {
    return { body: '', threads: [], reviews: [] }
  }
  const { body, reviewThreads, reviews } = pullRequest as Record<string, unknown>
  const threadNodes = (reviewThreads as { nodes?: unknown })?.nodes
  const threads: RemoteReviewThread[] = []
  if (Array.isArray(threadNodes)) {
    for (const node of threadNodes) {
      if (typeof node !== 'object' || node == null) continue
      const thread = node as Record<string, unknown>
      const path = readString(thread.path, 4096)
      if (typeof thread.id !== 'string' || thread.id === '' || path === '') continue
      threads.push({
        id: thread.id,
        path,
        line: typeof thread.line === 'number' ? thread.line : null,
        startLine: typeof thread.startLine === 'number' ? thread.startLine : null,
        side: thread.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
        resolved: thread.isResolved === true,
        outdated: thread.isOutdated === true,
        comments: parseRemoteReviewComments(thread.comments)
      })
    }
  }
  const reviewNodes = (reviews as { nodes?: unknown })?.nodes
  const summaries: RemoteReviewSummary[] = []
  if (Array.isArray(reviewNodes)) {
    for (const node of reviewNodes) {
      if (typeof node !== 'object' || node == null) continue
      const review = node as Record<string, unknown>
      if (typeof review.id !== 'string' || review.id === '') continue
      summaries.push({
        id: review.id,
        state: readString(review.state, 64),
        body: readString(review.body),
        authorLogin: readString((review.author as { login?: unknown } | null)?.login, 256),
        submittedAt: typeof review.submittedAt === 'string' ? review.submittedAt.slice(0, 64) : null
      })
    }
  }
  return { body: readString(body), threads, reviews: summaries }
}

export function pullRequestTargetsRemotes(remotes: readonly GitRemote[], pullRequestUrl: string): boolean {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+(?:\/.*)?$/i
    .exec(pullRequestUrl.trim())
  if (match == null) return false
  const [, owner, repository] = match
  if (owner == null || repository == null) return false
  const targetSlug = `${owner}/${repository}`.toLowerCase()
  return remotes.some((remote) => [remote.fetchUrl, remote.pushUrl]
    .some((remoteUrl) => githubRepoSlugFromRemoteUrl(remoteUrl) === targetSlug))
}

function validatePullRequestTarget(url: string, number: number): void {
  requirePullRequestNumber(number)
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/.*)?$/i.exec(url)
  if (match == null || Number(match[3]) !== number) {
    throw new Error('GitHub returned an invalid pull request URL.')
  }
}

function validatePullRequestReviewComments(value: unknown): PullRequestReviewComment[] {
  if (!Array.isArray(value)) throw new Error('Pull request review comments must be a list.')
  if (value.length > MAX_PULL_REQUEST_REVIEW_COMMENTS) {
    throw new Error(`A review can contain at most ${MAX_PULL_REQUEST_REVIEW_COMMENTS} inline comments.`)
  }

  return value.map((comment, index) => {
    if (comment == null || typeof comment !== 'object') {
      throw new Error(`Inline comment ${index + 1} is invalid.`)
    }
    const candidate = comment as Partial<PullRequestReviewComment>
    const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
    const body = typeof candidate.body === 'string' ? candidate.body.trim() : ''
    const safePath = path !== ''
      && !path.startsWith('/')
      && !path.includes('\\')
      && !path.split('/').includes('..')
      && !path.includes('\0')
    if (!safePath) throw new Error(`Inline comment ${index + 1} has an invalid path.`)
    if (body === '' || body.length > MAX_REVIEW_BODY_LENGTH) {
      throw new Error(`Inline comment ${index + 1} has an invalid body.`)
    }
    if (!Number.isSafeInteger(candidate.line) || candidate.line! < 1) {
      throw new Error(`Inline comment ${index + 1} has an invalid line.`)
    }
    if (candidate.side !== 'LEFT' && candidate.side !== 'RIGHT') {
      throw new Error(`Inline comment ${index + 1} has an invalid side.`)
    }
    if (candidate.startLine != null) {
      if (!Number.isSafeInteger(candidate.startLine) || candidate.startLine < 1) {
        throw new Error(`Inline comment ${index + 1} has an invalid start line.`)
      }
      if (candidate.startSide !== 'LEFT' && candidate.startSide !== 'RIGHT') {
        throw new Error(`Inline comment ${index + 1} has an invalid start side.`)
      }
    } else if (candidate.startSide != null) {
      throw new Error(`Inline comment ${index + 1} has a start side without a start line.`)
    }
    return {
      path,
      body,
      line: candidate.line!,
      side: candidate.side,
      ...(candidate.startLine == null
        ? {}
        : { startLine: candidate.startLine, startSide: candidate.startSide })
    }
  })
}

export function createPullRequestReviewPayload(
  commitIdValue: unknown,
  reviewEvent: string,
  bodyValue: unknown,
  commentsValue: unknown
): Record<string, unknown> {
  if (typeof commitIdValue !== 'string' || !/^[0-9a-f]{40}$/i.test(commitIdValue)) {
    throw new Error('The pull request commit ID is invalid.')
  }
  const events: PullRequestReviewEvent[] = ['approve', 'comment', 'request-changes']
  if (!events.includes(reviewEvent as PullRequestReviewEvent)) {
    throw new Error('Unknown pull request review action.')
  }
  if (typeof bodyValue !== 'string') throw new Error('Pull request review body must be text.')
  const body = bodyValue.trim()
  if (body.length > MAX_REVIEW_BODY_LENGTH) throw new Error('Pull request review body is too long.')
  const comments = validatePullRequestReviewComments(commentsValue)
  if (reviewEvent !== 'approve' && body === '' && comments.length === 0) {
    throw new Error('Add a review summary or at least one inline comment for this action.')
  }
  return {
    commitOID: commitIdValue,
    event: reviewEvent === 'request-changes' ? 'REQUEST_CHANGES' : reviewEvent.toUpperCase(),
    ...(body === '' ? {} : { body }),
    threads: comments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side,
      ...(comment.startLine == null
        ? {}
        : { startLine: comment.startLine, startSide: comment.startSide })
    }))
  }
}

export interface ContentSearchMetrics {
  spawned: number
  cancelled: number
  completed: number
  durationsMs: number[]
}

export class PullRequestReviewCache {
  #directory: string
  #pendingPatchWrites = new Map<string, number>()

  constructor(directory: string) {
    this.#directory = directory
  }

  // Hashed rather than composed from the slug: a pull request URL is remote input
  // and must never decide a path segment.
  #entryPaths(url: string, headRefOid: string): { metadata: string; patch: string } {
    const base = resolve(this.#directory, createCacheKey(url, headRefOid))
    return { metadata: `${base}.json`, patch: `${base}.patch` }
  }

  #beginPatchCommit(path: string): void {
    this.#pendingPatchWrites.set(path, (this.#pendingPatchWrites.get(path) ?? 0) + 1)
  }

  #endPatchCommit(path: string): void {
    const remaining = (this.#pendingPatchWrites.get(path) ?? 1) - 1
    if (remaining === 0) this.#pendingPatchWrites.delete(path)
    else this.#pendingPatchWrites.set(path, remaining)
  }

  async read(url: string, headRefOid: string): Promise<CachedPullRequestReview | null> {
    if (headRefOid === '') return null
    try {
      const paths = this.#entryPaths(url, headRefOid)
      const entry = JSON.parse(await readFile(paths.metadata, 'utf8')) as CachedPullRequestReviewMetadata
      if (
        entry.version !== PULL_REQUEST_CACHE_VERSION
        || entry.headRefOid !== headRefOid
        || !Array.isArray(entry.files)
        || !Array.isArray(entry.omittedFiles)
        || !Number.isSafeInteger(entry.patchLength)
        || entry.patchLength < 0
      ) return null
      const patch = await readFile(paths.patch, 'utf8')
      if (patch.length !== entry.patchLength) return null
      return {
        version: entry.version,
        headRefOid: entry.headRefOid,
        files: entry.files,
        patch,
        omittedFiles: entry.omittedFiles
      }
    } catch {
      // A missing, truncated or half-written entry is simply a miss.
      return null
    }
  }

  async write(url: string, headRefOid: string, review: PullRequestReview): Promise<void> {
    if (headRefOid === '' || review.files.length === 0) return
    const entry: CachedPullRequestReviewMetadata = {
      version: PULL_REQUEST_CACHE_VERSION,
      headRefOid,
      files: review.files,
      omittedFiles: review.omittedFiles,
      patchLength: review.patch.length
    }
    const paths = this.#entryPaths(url, headRefOid)
    const writeId = randomUUID()
    const temporaryPatchPath = `${paths.patch}.${writeId}.tmp`
    const temporaryMetadataPath = `${paths.metadata}.${writeId}.tmp`
    let committingPatch = false
    try {
      await mkdir(this.#directory, { recursive: true })
      await writeFile(temporaryPatchPath, review.patch, 'utf8')
      committingPatch = true
      this.#beginPatchCommit(paths.patch)
      await rename(temporaryPatchPath, paths.patch)
      await writeFile(temporaryMetadataPath, JSON.stringify(entry), 'utf8')
      await rename(temporaryMetadataPath, paths.metadata)
      await this.sweep()
    } catch {
      // The cache is an optimisation; failing to write it must never fail a review.
      await Promise.all([
        unlink(temporaryPatchPath).catch(() => {}),
        unlink(temporaryMetadataPath).catch(() => {})
      ])
    } finally {
      if (committingPatch) this.#endPatchCommit(paths.patch)
    }
  }

  async sweep(): Promise<void> {
    const names = await readdir(this.#directory).catch(() => [] as string[])
    const metadataNames = new Set(names.filter((name) => name.endsWith('.json')))
    const entries = await mapWithConcurrency(
      [...metadataNames],
      MAX_PATCH_COMMAND_CONCURRENCY,
      async (name) => {
        const metadataPath = resolve(this.#directory, name)
        const patchPath = resolve(this.#directory, `${name.slice(0, -'.json'.length)}.patch`)
        try {
          const [metadata, patch] = await Promise.all([stat(metadataPath), stat(patchPath)])
          return {
            metadataPath,
            patchPath,
            bytes: metadata.size + patch.size,
            modifiedAt: metadata.mtimeMs
          }
        } catch {
          await Promise.all([
            unlink(metadataPath).catch(() => {}),
            unlink(patchPath).catch(() => {})
          ])
          return null
        }
      }
    )
    const present = entries.filter((entry) => entry != null)
    present.sort((left, right) => right.modifiedAt - left.modifiedAt)
    let bytes = 0
    const expired = present.filter((entry, index) => {
      bytes += entry.bytes
      return index >= MAX_PULL_REQUEST_CACHE_ENTRIES || bytes > MAX_PULL_REQUEST_CACHE_BYTES
    })
    const orphanPatches: string[] = []
    for (const name of names) {
      if (!name.endsWith('.patch')) continue
      if (metadataNames.has(`${name.slice(0, -'.patch'.length)}.json`)) continue
      const path = resolve(this.#directory, name)
      if (!this.#pendingPatchWrites.has(path)) orphanPatches.push(path)
    }
    await Promise.all([
      ...orphanPatches.map((path) => unlink(path).catch(() => {})),
      ...expired.flatMap((entry) => [
        unlink(entry.metadataPath).catch(() => {}),
        unlink(entry.patchPath).catch(() => {})
      ])
    ])
  }
}

export class RepositoryService {
  #root: string | null = null
  #kind: RepositorySnapshot['kind'] = 'folder'
  #snapshot: RepositorySnapshot | null = null
  #snapshotRevision = 0
  #pathSet = new Set<string>()
  #statusByPath = new Map<string, RepositoryStatusEntry>()
  #headFileCache = new Map<string, { promise: Promise<ReadVersion | null>; bytes: number }>()
  #headFileCacheBytes = 0
  #objectReader: GitObjectReader | null = null
  #trackedPathsCache: { buffer: Buffer; untrackedPaths: string[]; paths: string[] } | null = null
  #folderPathsCache: { buffer: Buffer; paths: string[] } | null = null
  #workingFileCache = new Map<string, { read: WorkingFileRead; bytes: number }>()
  #workingFileCacheBytes = 0
  #pendingComparisons = new Map<string, Promise<FileComparison>>()
  #pendingWorkingTreePatches = new Map<string, Promise<WorkingTreePatch>>()
  #workingTreePatchAbort: AbortController | null = null
  #selfWriteObserver: ((path: string) => void) | null = null
  #checkFieldsSupported = true
  #reviewAborts = new Map<string, AbortController>()
  #reviewFlights = new Map<string, Promise<PullRequestReview>>()
  #pullRequestCache: PullRequestReviewCache | null = null
  #activeSearch: { child: ReturnType<typeof spawn>; cancelled: boolean; startedAt: number } | null = null
  #contentSearchMetrics: ContentSearchMetrics = { spawned: 0, cancelled: 0, completed: 0, durationsMs: [] }
  #githubViewerLogin: string | null = null
  // undefined means "not resolved yet"; null means "resolved, no GitHub remote".
  #githubSlug: string | null | undefined = undefined
  #remotes: Promise<GitRemote[]> | undefined
  // A pull request's owner, repository, and number never change, so the identity
  // lookup is resolved once instead of on every conversation poll.
  #pullRequestIdentities = new Map<string, { owner: string; name: string; number: number }>()

  getSessionSnapshot(): RepositorySnapshot | null {
    return this.#snapshot
  }

  // The watcher needs to know a write is ours before it lands, or it refreshes
  // the whole tree for a file the app just wrote and already has the contents of.
  setSelfWriteObserver(observe: ((path: string) => void) | null): void {
    this.#selfWriteObserver = observe
  }

  // Passed in from the main entry point so this module keeps no Electron import.
  setPullRequestCacheDirectory(directory: string | null): void {
    this.#pullRequestCache = directory == null ? null : new PullRequestReviewCache(directory)
  }

  getContentSearchMetricsForTests(): ContentSearchMetrics {
    return {
      ...this.#contentSearchMetrics,
      durationsMs: [...this.#contentSearchMetrics.durationsMs]
    }
  }

  resetContentSearchMetricsForTests(): void {
    this.#contentSearchMetrics = { spawned: 0, cancelled: 0, completed: 0, durationsMs: [] }
  }

  getHeadCacheStatsForTests(): {
    entries: number
    bytes: number
    workingEntries: number
    workingBytes: number
    objectReaderSpawns: number
  } {
    return {
      entries: this.#headFileCache.size,
      bytes: this.#headFileCacheBytes,
      workingEntries: this.#workingFileCache.size,
      workingBytes: this.#workingFileCacheBytes,
      objectReaderSpawns: this.#objectReader?.spawnCountForTests ?? 0
    }
  }

  dispose(): void {
    this.#cancelActiveSearch()
    this.cancelPullRequestReview()
    this.#clearHeadFileCache()
    this.#workingFileCache.clear()
    this.#workingFileCacheBytes = 0
    this.#pendingComparisons.clear()
    this.#workingTreePatchAbort?.abort()
    this.#workingTreePatchAbort = null
    this.#pendingWorkingTreePatches.clear()
    this.#pullRequestIdentities.clear()
    this.#trackedPathsCache = null
    this.#folderPathsCache = null
    this.#githubSlug = undefined
    this.#remotes = undefined
    this.#githubViewerLogin = null
    this.#objectReader?.dispose()
    this.#objectReader = null
    this.#root = null
    this.#kind = 'folder'
    this.#snapshot = null
    this.#snapshotRevision = 0
    this.#pathSet.clear()
    this.#statusByPath.clear()
  }

  trimCaches(floorBytes: number): void {
    const targetBytes = Math.max(0, Math.floor(floorBytes))
    while (this.#headFileCacheBytes > targetBytes) {
      const oldestObject = this.#headFileCache.keys().next().value
      if (oldestObject == null) break
      this.#deleteHeadCacheEntry(oldestObject)
    }
    while (this.#workingFileCacheBytes > targetBytes) {
      const oldestPath = this.#workingFileCache.keys().next().value
      if (oldestPath == null) break
      this.#deleteWorkingCacheEntry(oldestPath)
    }
  }

  async open(folderPath: string): Promise<RepositorySnapshot> {
    const selectedRoot = await realpath(folderPath)
    const rootResult = await runCommand('git', [
      '-C', selectedRoot, 'rev-parse', '--show-toplevel'
    ]).catch(() => null)

    this.dispose()
    this.#kind = rootResult == null ? 'folder' : 'git'
    this.#root = rootResult?.stdout.toString('utf8').trim() || selectedRoot
    return this.refresh()
  }

  async refresh(): Promise<RepositorySnapshot> {
    const root = this.#requireRoot()
    if (this.#kind === 'folder') return this.#refreshFolder(root)

    // Two spawns, not four: `status --porcelain=v2 --branch` reports the branch,
    // the HEAD oid and the untracked set alongside the statuses, so `ls-files`
    // only has to list what is tracked and the working tree is walked once.
    const [trackedResult, statusResult] = await Promise.all([
      this.#git(['ls-files', '--cached', '-z']),
      this.#git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    ])

    const status = parsePorcelainV2Status(statusResult.stdout)
    const head = status.head
    const branch = status.branch || head?.slice(0, 8) || 'No commits'
    const snapshot: RepositorySnapshot = {
      root,
      name: basename(root),
      kind: 'git',
      branch,
      head,
      paths: this.#visiblePaths(trackedResult.stdout, status.untrackedPaths),
      statuses: status.statuses.filter((entry) => entry.status !== 'untracked' || !isExcludedPath(entry.path))
    }

    this.#setSnapshot(snapshot)
    return snapshot
  }

  // Editing a file leaves both lists byte-for-byte identical, which is the
  // common watcher tick. Re-splitting, re-filtering and re-sorting 100k paths for
  // that cost ~120 ms of blocked main process per tick. Cache repositories with
  // untracked files too; otherwise one draft file disabled the fast path.
  #visiblePaths(trackedBuffer: Buffer, untrackedPaths: readonly string[]): string[] {
    const cached = this.#trackedPathsCache
    if (cached != null && cached.buffer.equals(trackedBuffer)
        && cached.untrackedPaths.length === untrackedPaths.length
        && cached.untrackedPaths.every((path, index) => path === untrackedPaths[index])) {
      return cached.paths
    }
    const paths = mergeVisiblePaths(trackedBuffer, untrackedPaths)
    this.#trackedPathsCache = { buffer: trackedBuffer, untrackedPaths: [...untrackedPaths], paths }
    return paths
  }

  async #refreshFolder(root: string): Promise<RepositorySnapshot> {
    const pathsResult = await runCommand(
      RIPGREP_EXECUTABLE,
      [
        '--files',
        '--hidden',
        '--no-require-git',
        '--glob',
        '!.git/**',
        ...RIPGREP_EXCLUSION_ARGS,
        '--null'
      ],
      root,
      [1]
    )
    const cached = this.#folderPathsCache
    const paths = cached != null && cached.buffer.equals(pathsResult.stdout)
      ? cached.paths
      : prepareVisiblePaths(pathsResult.stdout)
    if (paths !== cached?.paths) this.#folderPathsCache = { buffer: pathsResult.stdout, paths }
    const snapshot: RepositorySnapshot = {
      root,
      name: basename(root),
      kind: 'folder',
      branch: null,
      head: null,
      paths,
      statuses: []
    }

    this.#setSnapshot(snapshot)
    return snapshot
  }

  getComparison(path: string): Promise<FileComparison> {
    const pending = this.#pendingComparisons.get(path)
    if (pending != null) return pending
    // App.tsx, the multi-file viewer's scroll hydration and the editor can each
    // ask for the same path in the same tick; without this they each ran the
    // whole read/decode/hash pipeline.
    const comparison = this.#loadComparison(path).finally(() => {
      this.#pendingComparisons.delete(path)
    })
    this.#pendingComparisons.set(path, comparison)
    return comparison
  }

  async #loadComparison(path: string): Promise<FileComparison> {
    const root = this.#requireRoot()
    const snapshot = this.#requireSnapshot()
    if (!this.#pathSet.has(path)) throw new Error('The selected path is not in the repository.')

    const status = this.#statusByPath.get(path)
    const oldPath = status?.previousPath ?? path
    const [oldVersion, workingVersion] = await Promise.all([
      snapshot.kind === 'git' ? this.#readHeadFile(oldPath, snapshot.head) : null,
      this.#readWorkingFile(path, root)
    ])
    const binary = Boolean(oldVersion?.binary || workingVersion?.binary)
    const oversized = Boolean(oldVersion?.oversized || workingVersion?.oversized)
    const oldImage = oldVersion?.image ?? null
    const newImage = workingVersion?.image ?? null

    return {
      path,
      mode: snapshot.kind === 'git' && status != null ? 'diff' : 'file',
      status: status?.status ?? 'unchanged',
      oldFile: binary || oversized ? null : oldVersion?.file ?? null,
      newFile: binary || oversized ? null : workingVersion?.file ?? null,
      binary,
      oversized,
      image: oldImage != null || newImage != null ? { old: oldImage, new: newImage } : null
    }
  }

  async saveWorkingFile(input: unknown): Promise<FileComparison> {
    const request = input as Partial<WorkingFileSaveRequest> | null
    if (
      request == null
      || typeof request.path !== 'string'
      || typeof request.contents !== 'string'
      || typeof request.expectedCacheKey !== 'string'
    ) {
      throw new Error('The file save request is invalid.')
    }

    const { path, contents, expectedCacheKey } = request
    const root = this.#requireRoot()
    if (!this.#pathSet.has(path)) throw new Error('The selected path is not in the repository.')
    if (Buffer.byteLength(contents, 'utf8') > MAX_DIFF_FILE_BYTES) {
      throw new Error('Files larger than 2 MB cannot be edited in Horus.')
    }
    if (contents.includes('\0')) throw new Error('Binary files cannot be edited in Horus.')

    // The conflict check is the one place that must see the disk, not the cache.
    const currentVersion = await this.#readWorkingFile(path, root, true)
    if (
      currentVersion?.file == null
      || currentVersion.binary
      || currentVersion.oversized
    ) {
      throw new Error('This working file is not editable.')
    }
    const currentFile = currentVersion.file
    if (currentFile.cacheKey !== expectedCacheKey) {
      throw new Error('The file changed on disk. Reload it before saving your draft.')
    }
    if (currentFile.contents === contents) return this.getComparison(path)

    const candidate = resolve(root, path)
    if (!isWithinRoot(root, candidate)) throw new Error('The selected path escapes the repository.')
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Symbolic links and non-file paths cannot be edited.')
    }
    const resolvedPath = await realpath(candidate)
    if (!isWithinRoot(root, resolvedPath)) {
      throw new Error('The selected file resolves outside the repository.')
    }

    const temporaryPath = resolve(dirname(resolvedPath), `.horus-save-${randomUUID()}`)
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: metadata.mode })
      this.#selfWriteObserver?.(path)
      await rename(temporaryPath, resolvedPath)
    } finally {
      await unlink(temporaryPath).catch(() => {})
    }

    this.#snapshotRevision += 1
    this.#deleteWorkingCacheEntry(path)
    this.#pendingComparisons.delete(path)
    // A single-file write cannot change the tracked path list, the branch or HEAD,
    // so the whole-tree `ls-files` + `status --untracked-files=all` pair the save
    // used to run is replaced by one status call scoped to the saved path.
    if (!await this.#refreshSavedPathStatus(path)) await this.refresh()
    return this.getComparison(path)
  }

  async #refreshSavedPathStatus(path: string): Promise<boolean> {
    const snapshot = this.#snapshot
    if (snapshot == null || snapshot.kind !== 'git') return false
    let result: CommandResult
    try {
      result = await this.#git([
        'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', `:(literal)${path}`
      ])
    } catch {
      return false
    }
    const entries = parsePorcelainV2Status(result.stdout).statuses
    // A rename record or a report about another path means the narrow view is
    // wrong about what moved; fall back to the whole-tree walk.
    if (entries.length > 1 || entries.some((entry) => entry.path !== path || entry.previousPath != null)) {
      return false
    }
    const next = entries[0] ?? null
    const previous = this.#statusByPath.get(path) ?? null
    if (previous?.status === next?.status && previous?.previousPath === next?.previousPath) return true
    this.#setSnapshot({ ...snapshot, statuses: replaceStatusEntry(snapshot.statuses, path, next) })
    return true
  }

  async getWorkingTreePatch(pathsValue: unknown): Promise<WorkingTreePatch> {
    this.#requireGitRepository()
    if (!Array.isArray(pathsValue) || pathsValue.length > this.#pathSet.size) {
      throw new Error('Working tree patch paths must be a valid list.')
    }
    const paths = pathsValue.map((path) => {
      if (typeof path !== 'string' || !this.#pathSet.has(path)) {
        throw new Error('Working tree patch path is not in the repository.')
      }
      return path
    })
    // A watcher refresh changes the logical working tree even when the visible
    // path list stays the same. Include its revision so a newer edit aborts an
    // older same-path build instead of reusing a stale patch.
    const key = `${this.#snapshotRevision}\0${[...paths].sort().join('\0')}`
    const pending = this.#pendingWorkingTreePatches.get(key)
    if (pending != null) return pending

    this.#workingTreePatchAbort?.abort()
    const abort = new AbortController()
    this.#workingTreePatchAbort = abort
    const patch = this.#loadWorkingTreePatch(paths, abort.signal).finally(() => {
      if (this.#pendingWorkingTreePatches.get(key) === patch) {
        this.#pendingWorkingTreePatches.delete(key)
      }
      if (this.#workingTreePatchAbort === abort) this.#workingTreePatchAbort = null
    })
    this.#pendingWorkingTreePatches.set(key, patch)
    return patch
  }

  async #loadWorkingTreePatch(paths: string[], signal: AbortSignal): Promise<WorkingTreePatch> {
    if (paths.length === 0) return { patch: '', omittedFiles: [] }

    const root = this.#requireRoot()
    const snapshot = this.#requireSnapshot()
    const untrackedPaths = paths.filter((path) => this.#statusByPath.get(path)?.status === 'untracked')
    const trackedPaths = snapshot.head == null
      ? []
      : paths.filter((path) => this.#statusByPath.get(path)?.status !== 'untracked')
    const omittedFiles: OmittedDiffFile[] = []
    const patchParts: string[] = []

    if (trackedPaths.length > 0) {
      const head = snapshot.head!
      const churnChunks = await mapWithConcurrency(
        chunkPathspecs(trackedPaths),
        MAX_PATCH_COMMAND_CONCURRENCY,
        async (chunk) => parseNumstat(
          (await this.#git(['diff', '--numstat', '-z', '--find-renames', head, '--', ...chunk], signal)).stdout
        )
      )
      const oversized = selectOversizedDiffFiles(churnChunks.flat())
      omittedFiles.push(...oversized.omittedFiles)
      const oversizedPaths = new Set(oversized.omittedFiles.map((file) => file.path))
      const includedPaths = trackedPaths.filter((path) => !oversizedPaths.has(path))
      const patchChunks = await mapWithConcurrency(
        chunkPathspecs(includedPaths),
        MAX_PATCH_COMMAND_CONCURRENCY,
        async (chunk) => (
          await this.#git(['diff', '--no-color', '--find-renames', '--unified=3', head, '--', ...chunk], signal)
        ).stdout.toString('utf8')
      )
      for (const patch of patchChunks) {
        if (patch !== '') patchParts.push(patch)
      }
    }

    const newPaths = snapshot.head == null ? paths : untrackedPaths
    const newFilePatches = await mapWithConcurrency(
      newPaths,
      MAX_PATCH_COMMAND_CONCURRENCY,
      (path) => this.#createNewFilePatch(path, root, signal)
    )
    for (const newFilePatch of newFilePatches) {
      if (newFilePatch.patch !== '') patchParts.push(newFilePatch.patch)
      if (newFilePatch.omitted != null) omittedFiles.push(newFilePatch.omitted)
    }

    const limited = limitPatchFileSize(patchParts.join('\n'), MAX_DIFF_FILE_BYTES)
    return { patch: limited.patch, omittedFiles: [...omittedFiles, ...limited.omittedFiles] }
  }

  async #createNewFilePatch(
    path: string,
    root: string,
    signal: AbortSignal
  ): Promise<{ patch: string; omitted: OmittedDiffFile | null }> {
    if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
    const version = await this.#readWorkingFile(path, root)
    if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
    if (version == null) return { patch: '', omitted: null }
    if (version.oversized) {
      return { patch: '', omitted: { path, reason: 'too-large', additions: 0, deletions: 0 } }
    }
    if (version.contents == null) return { patch: '', omitted: null }
    return {
      patch: createNewFilePatch(
        path,
        version.binary ? '' : version.contents.toString('utf8'),
        version.binary
      ),
      omitted: null
    }
  }

  cancelContentSearch(): void {
    this.#cancelActiveSearch()
  }

  async searchContent(query: string): Promise<ContentSearchResult[]> {
    const trimmedQuery = query.trim()
    this.#cancelActiveSearch()
    if (trimmedQuery.length < 2) return []
    const root = this.#requireRoot()

    return new Promise((resolveSearch, rejectSearch) => {
      const child = spawn(
        RIPGREP_EXECUTABLE,
        [
          '--json',
          '--fixed-strings',
          '--smart-case',
          '--hidden',
          '--glob',
          '!.git/**',
          ...RIPGREP_EXCLUSION_ARGS,
          '--max-columns',
          '500',
          '--max-count',
          '20',
          '--',
          trimmedQuery,
          '.'
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const search = { child, cancelled: false, startedAt: performance.now() }
      this.#contentSearchMetrics.spawned += 1
      this.#activeSearch = search
      const results: ContentSearchResult[] = []
      let pending = ''
      let errorOutput = ''

      const processLine = (line: string): void => {
        if (results.length >= MAX_SEARCH_RESULTS || line.length === 0) return
        try {
          const event = JSON.parse(line) as {
            type: string
            data?: {
              path?: { text?: string }
              line_number?: number
              lines?: { text?: string }
              submatches?: Array<{ start: number }>
            }
          }
          if (event.type !== 'match' || event.data?.path?.text == null) return
          const rawPath = event.data.path.text.replace(/^\.\//, '')
          if (isExcludedPath(rawPath)) return
          results.push({
            path: rawPath,
            line: event.data.line_number ?? 1,
            column: (event.data.submatches?.[0]?.start ?? 0) + 1,
            preview: event.data.lines?.text?.trimEnd() ?? ''
          })
        } catch {
          // Ignore incomplete diagnostic records from a terminated search.
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) processLine(line)
        if (results.length >= MAX_SEARCH_RESULTS) child.kill()
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        errorOutput += chunk
      })
      child.on('error', (error) => {
        if (this.#activeSearch === search) this.#activeSearch = null
        rejectSearch(error)
      })
      child.on('close', (code, signal) => {
        if (this.#activeSearch === search) this.#activeSearch = null
        this.#contentSearchMetrics.completed += 1
        if (!search.cancelled) {
          this.#contentSearchMetrics.durationsMs.push(performance.now() - search.startedAt)
          this.#contentSearchMetrics.durationsMs = this.#contentSearchMetrics.durationsMs.slice(-100)
        }
        processLine(pending)
        const completion = classifySearchCompletion({
          cancelled: search.cancelled,
          code,
          signal,
          resultCount: results.length,
          errorOutput
        })
        if (completion.kind === 'error') {
          rejectSearch(new Error(completion.message))
          return
        }
        resolveSearch(results)
      })
    })
  }

  async getPullRequestConversation(selector: number | string): Promise<PullRequestConversation> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    try {
      const { owner, name, number } = await this.#resolvePullRequestIdentity(ghExecutable, normalizedSelector)
      const result = await runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({
          query: PULL_REQUEST_THREADS_QUERY,
          variables: { owner, name, number }
        })
      )
      const conversation = parsePullRequestConversation(JSON.parse(result.stdout.toString('utf8')) as unknown)
      return { available: true, message: null, ...conversation }
    } catch (error) {
      return {
        available: false,
        message: gitHubIntegrationErrorMessage(error),
        body: '',
        threads: [],
        reviews: []
      }
    }
  }

  async #resolvePullRequestIdentity(
    ghExecutable: string,
    selector: string
  ): Promise<{ owner: string; name: string; number: number }> {
    const cached = this.#pullRequestIdentities.get(selector)
    if (cached != null) return cached
    const detailsResult = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'view', selector, '--json', 'number,url'],
      this.#requireRoot()
    )
    const details = parseJson<{ number: number; url: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    const slug = githubRepoSlugFromRemoteUrl(details.url.replace(/\/pull\/\d+.*$/, ''))
    const [owner, name] = slug?.split('/') ?? []
    if (owner == null || name == null) throw new Error('GitHub returned an invalid pull request URL.')
    const identity = { owner, name, number: details.number }
    this.#pullRequestIdentities.set(selector, identity)
    return identity
  }

  async replyToPullRequestThread(threadId: unknown, body: unknown): Promise<void> {
    this.#requireGitRepository()
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 256) {
      throw new Error('The review thread could not be identified.')
    }
    const replyBody = typeof body === 'string' ? body.trim() : ''
    if (replyBody === '') throw new Error('A reply cannot be empty.')
    if (replyBody.length > MAX_REVIEW_BODY_LENGTH) throw new Error('This reply is too long to send.')
    const ghExecutable = await getGhExecutable()
    await runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      this.#requireRoot(),
      [],
      JSON.stringify({
        query: ADD_REVIEW_THREAD_REPLY_MUTATION,
        variables: { input: { pullRequestReviewThreadId: threadId, body: replyBody } }
      })
    )
  }

  async setPullRequestThreadResolved(threadId: unknown, resolved: unknown): Promise<void> {
    this.#requireGitRepository()
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 256) {
      throw new Error('The review thread could not be identified.')
    }
    const ghExecutable = await getGhExecutable()
    await runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      this.#requireRoot(),
      [],
      JSON.stringify({
        query: resolved === true ? RESOLVE_REVIEW_THREAD_MUTATION : UNRESOLVE_REVIEW_THREAD_MUTATION,
        variables: { input: { threadId } }
      })
    )
  }

  async mergePullRequest(selector: number | string, strategy: unknown): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    // Merging is irreversible: an unrecognized strategy is a caller bug, not a
    // reason to pick one.
    if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'squash') {
      throw new Error('Unknown merge strategy.')
    }
    const mergeFlag = strategy === 'merge' ? '--merge' : strategy === 'rebase' ? '--rebase' : '--squash'
    const ghExecutable = await getGhExecutable()
    const [remotes, detailsResult] = await Promise.all([
      this.getRemotes(),
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'number,url'],
        this.#requireRoot()
      )
    ])
    const details = parseJson<{ number: number; url: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    // Merging is irreversible, so it is refused unless the pull request lives in the open repository.
    if (!pullRequestTargetsRemotes(remotes, details.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    await runCommand(ghExecutable, ['pr', 'merge', normalizedSelector, mergeFlag], this.#requireRoot())
  }

  async markPullRequestReady(selector: number | string): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    // Marking ready is a remote write, so it is held to the same rule as merging:
    // a pasted URL must name the repository that is open.
    const [remotes, detailsResult] = await Promise.all([
      this.getRemotes(),
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'number,url'],
        this.#requireRoot()
      )
    ])
    const details = parseJson<{ number: number; url: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    if (!pullRequestTargetsRemotes(remotes, details.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    await runCommand(ghExecutable, ['pr', 'ready', normalizedSelector], this.#requireRoot())
  }

  // The remote slug cannot change while a repository is open, so it is resolved
  // once instead of spawning `git remote -v` on every poll tick.
  async #getGitHubSlug(): Promise<string | null> {
    if (this.#githubSlug !== undefined) return this.#githubSlug
    const remotes = await this.getRemotes()
    let slug: string | null = null
    for (const remote of remotes) {
      slug = githubRepoSlugFromRemoteUrl(remote.fetchUrl) ?? githubRepoSlugFromRemoteUrl(remote.pushUrl)
      if (slug != null) break
    }
    this.#githubSlug = slug
    return slug
  }

  async getPullRequestInbox(): Promise<PullRequestInboxSnapshot> {
    this.#requireGitRepository()
    const slug = await this.#getGitHubSlug()
    if (slug == null) {
      return { available: false, message: 'This repository has no GitHub remote.', sections: [] }
    }
    const ghExecutable = await getGhExecutable()
    try {
      // GraphQL search does not understand `@me`, so the viewer login is
      // substituted in; it is cached for the life of the repository.
      const login = await this.#getGitHubViewerLogin(ghExecutable)
      const base = `repo:${slug} is:pr is:open`
      const variables: Record<string, string> = {}
      for (const { alias, qualifier } of PULL_REQUEST_INBOX_SECTIONS) {
        variables[alias] = `${base} ${qualifier}:${login}`
      }
      const result = await runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({ query: PULL_REQUEST_INBOX_QUERY, variables })
      )
      const entries = parsePullRequestInboxResponse(parseJson<unknown>(result, 'GitHub CLI'))
      return { available: true, message: null, sections: sectionPullRequestInbox(entries) }
    } catch (error) {
      return { available: false, message: gitHubIntegrationErrorMessage(error), sections: [] }
    }
  }

  async getGitIntegration(): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    const ghExecutable = await getGhExecutable()
    const branchesPromise = this.#git([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)',
      'refs/heads'
    ])
    // Open pull requests only, and without `statusCheckRollup`/`mergeable`.
    // Measured against vercel/next.js: 100 PRs with the check fields answered
    // HTTP 504 after 11.3 s (retried three times by runGitHubReadCommand), the
    // same call without them 6.5 s, and `--state open --limit 30` 2.4 s. Nothing
    // in the panel renders check data; the review of a single pull request still
    // asks for it. Closed and merged rows load on demand instead.
    const pullRequestsPromise = runGitHubReadCommand(
      ghExecutable,
      ['pr', 'list', '--state', 'open', '--limit', String(PULL_REQUEST_LIST_LIMIT), '--json', PULL_REQUEST_LIST_FIELDS],
      this.#requireRoot()
    ).then(
      (result) => ({ pullRequests: parsePullRequestSummaries(result), message: null }),
      (error: unknown) => ({
        pullRequests: [] as PullRequestSummary[],
        message: gitHubIntegrationErrorMessage(error)
      })
    )

    const [branchesResult, remoteBranchesResult, remotes, commitsResult, defaultBranchResult, aheadBehindResult, githubResult] = await Promise.all([
      branchesPromise,
      this.#git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']),
      this.getRemotes(),
      this.#gitAllowFailure(['log', '-100', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e']),
      this.#gitAllowFailure(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
      this.#gitAllowFailure(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
      pullRequestsPromise
    ])
    const branches = parseBranches(branchesResult)
    const defaultRemoteBranch = defaultBranchResult?.stdout.toString('utf8').trim() || null
    const defaultBranch = defaultRemoteBranch?.replace(/^[^/]+\//, '')
      ?? (branches.some((branch) => branch.name === 'main') ? 'main' : null)
      ?? (branches.some((branch) => branch.name === 'master') ? 'master' : null)
      ?? branches.find((branch) => branch.current)?.name
      ?? null
    const counts = parseAheadBehind(aheadBehindResult)
    return {
      branches,
      remoteBranches: parseRemoteBranches(remoteBranchesResult),
      remotes,
      commits: parseCommits(commitsResult),
      defaultBranch,
      ahead: counts.ahead,
      behind: counts.behind,
      pullRequests: githubResult.pullRequests,
      githubAvailable: githubResult.message == null,
      githubMessage: githubResult.message
    }
  }

  // Closed and merged pull requests are a deliberate second request: including
  // them in the panel's first paint tripled its latency for rows nobody had asked
  // to see.
  async getClosedPullRequests(): Promise<PullRequestSummary[]> {
    this.#requireGitRepository()
    const ghExecutable = await getGhExecutable()
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'list', '--state', 'closed', '--limit', String(PULL_REQUEST_LIST_LIMIT), '--json', PULL_REQUEST_LIST_FIELDS],
      this.#requireRoot()
    )
    return parsePullRequestSummaries(result)
  }

  async switchBranch(name: string): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const branchesResult = await this.#git([
      'for-each-ref', '--format=%(refname:short)', 'refs/heads'
    ])
    const branches = new Set(branchesResult.stdout.toString('utf8').split('\n').filter(Boolean))
    if (!branches.has(name)) throw new Error('The selected local branch no longer exists.')
    await this.#git(['switch', '--no-guess', name])
    return this.refresh()
  }

  async getLocalBranchReview(baseRef: string, headRef: string): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    const branchResult = await this.#git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    const branches = new Set(branchResult.stdout.toString('utf8').split('\n').filter(Boolean))
    if (!branches.has(baseRef) || !branches.has(headRef)) throw new Error('Both comparison refs must be local branches.')
    if (baseRef === headRef) throw new Error('Select two different branches to compare.')
    const comparison = `${baseRef}...${headRef}`
    const [churnResult, baseResult, headResult] = await Promise.all([
      this.#git(['diff', '--numstat', '-z', '--find-renames', comparison, '--']),
      this.#git(['merge-base', baseRef, headRef]),
      this.#git(['rev-parse', headRef])
    ])
    const baseOid = baseResult.stdout.toString('utf8').trim()
    const headOid = headResult.stdout.toString('utf8').trim()
    const entries = parseNumstat(churnResult.stdout)
    const oversized = selectOversizedDiffFiles(entries)
    const patchResult = await this.#git([
      'diff', '--no-color', '--full-index', '--find-renames', comparison, '--', ...oversized.excludePathspecs
    ])
    const patch = patchResult.stdout.toString('utf8')
    const patchFiles = new Map(filesFromPatch(patch).map((file) => [file.path, file]))
    const files = diffFilesFromChurn(entries).map((file) => ({ ...file, ...patchFiles.get(file.path) }))
    const limited = limitPatchFileSize(patch, MAX_DIFF_FILE_BYTES)
    return {
      kind: 'local',
      id: `${comparison}:${baseOid}:${headOid}`,
      title: `${headRef} compared with ${baseRef}`,
      baseRefName: baseRef,
      headRefName: headRef,
      baseOid,
      headOid,
      files,
      patch: limited.patch,
      omittedFiles: [...oversized.omittedFiles, ...limited.omittedFiles]
    }
  }

  async getCommitReview(oid: string): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    if (!/^[0-9a-f]{7,40}$/i.test(oid)) throw new Error('Commit ID is invalid.')
    await this.#git(['cat-file', '-e', `${oid}^{commit}`])
    const commitResult = await this.#git(['rev-list', '--parents', '-n', '1', oid])
    const [commitOid, firstParent] = commitResult.stdout.toString('utf8').trim().split(' ')
    if (commitOid == null) throw new Error('Commit could not be resolved.')
    const churnArgs = firstParent == null
      ? ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-z', '--find-renames', commitOid, '--']
      : ['diff', '--numstat', '-z', '--find-renames', firstParent, commitOid, '--']
    const patchArgs = firstParent == null
      ? ['show', '--format=', '--no-color', '--full-index', '--find-renames', commitOid, '--']
      : ['diff', '--no-color', '--full-index', '--find-renames', firstParent, commitOid, '--']
    const [churnResult, metadataResult] = await Promise.all([
      this.#git(churnArgs),
      this.#git(['show', '-s', '--format=%h%x1f%s', commitOid])
    ])
    const [shortOid = commitOid.slice(0, 8), subject = 'Commit'] = metadataResult.stdout.toString('utf8').trim().split('\x1f')
    const entries = parseNumstat(churnResult.stdout)
    const oversized = selectOversizedDiffFiles(entries)
    const patchResult = await this.#git([...patchArgs, ...oversized.excludePathspecs])
    const patch = patchResult.stdout.toString('utf8')
    const patchFiles = new Map(filesFromPatch(patch).map((file) => [file.path, file]))
    const files = diffFilesFromChurn(entries).map((file) => ({ ...file, ...patchFiles.get(file.path) }))
    const limited = limitPatchFileSize(patch, MAX_DIFF_FILE_BYTES)
    return {
      kind: 'local',
      id: `commit:${commitOid}`,
      title: `${shortOid} ${subject}`,
      baseRefName: firstParent?.slice(0, 8) ?? 'Empty tree',
      headRefName: shortOid,
      baseOid: firstParent ?? EMPTY_TREE_OID,
      headOid: commitOid,
      files,
      patch: limited.patch,
      omittedFiles: [...oversized.omittedFiles, ...limited.omittedFiles]
    }
  }

  async fetchRemote(): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    await this.#git(['fetch', '--all', '--prune'])
    return this.getGitIntegration()
  }

  async pullCurrentBranch(): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    await this.#git(['pull', '--ff-only'])
    return this.refresh()
  }

  async pushCurrentBranch(): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    const snapshot = this.#requireSnapshot()
    const branch = snapshot.branch
    if (branch == null) throw new Error('The repository is not on a local branch.')
    const upstreamResult = await this.#gitAllowFailure(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (upstreamResult == null) {
      const remotesResult = await this.#git(['remote'])
      const remotes = remotesResult.stdout.toString('utf8').split('\n').filter(Boolean)
      const remote = remotes.includes('origin') ? 'origin' : remotes[0]
      if (remote == null) throw new Error('Add a Git remote before pushing this branch.')
      await this.#git(['push', '--set-upstream', remote, branch])
    } else {
      await this.#git(['push'])
    }
    return this.getGitIntegration()
  }

  // Closing a big review left up to eight `gh api` children per wave running to
  // completion for a patch that was already discarded, and on a rate-limited token
  // that budget is spent invisibly.
  cancelPullRequestReview(requestId?: string): void {
    if (requestId != null) {
      this.#reviewAborts.get(requestId)?.abort()
      this.#reviewAborts.delete(requestId)
      return
    }
    for (const abort of this.#reviewAborts.values()) abort.abort()
    this.#reviewAborts.clear()
  }

  async getPullRequestReview(
    selector: number | string,
    onProgress?: (progress: PullRequestReviewProgress) => void,
    requestId: string = randomUUID()
  ): Promise<PullRequestReview> {
    this.#requireGitRepository()
    const normalized = normalizePullRequestSelector(selector)
    const inFlight = this.#reviewFlights.get(normalized)
    if (inFlight != null) return inFlight

    this.cancelPullRequestReview(requestId)
    const abort = new AbortController()
    this.#reviewAborts.set(requestId, abort)
    const promise = this.#loadPullRequestReview(normalized, abort.signal, onProgress)
      .finally(() => {
        if (this.#reviewFlights.get(normalized) === promise) this.#reviewFlights.delete(normalized)
        if (this.#reviewAborts.get(requestId) === abort) this.#reviewAborts.delete(requestId)
      })
    this.#reviewFlights.set(normalized, promise)
    return promise
  }

  async #loadPullRequestReview(
    normalizedSelector: string,
    signal: AbortSignal,
    onProgress?: (progress: PullRequestReviewProgress) => void
  ): Promise<PullRequestReview> {
    const ghExecutable = await getGhExecutable()
    // Metadata resolves in a second or two while the diff can take minutes, so it
    // is awaited on its own: the review header and file tree can open on it alone.
    const [detailsResult, viewerLogin] = await Promise.all([
      this.#runPullRequestJsonCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector],
        PULL_REQUEST_REVIEW_FIELDS,
        this.#requireRoot(),
        signal
      ),
      this.#getGitHubViewerLogin(ghExecutable)
    ])
    const details = parseJson<RawPullRequestSummary & {
      files: PullRequestReview['files']
      baseRefOid: string
      headRefOid: string
    }>(detailsResult, 'GitHub CLI')
    const { files, baseRefOid, headRefOid, ...rest } = details
    const pullRequest = toPullRequestSummary(rest)
    // The files API stops answering at 3000 files however many GitHub reports, so a
    // review of a bigger pull request is climbing towards the ceiling, not the count.
    const expectedFileCount = Math.min(
      MAX_PULL_REQUEST_FILES,
      Math.max(
        Number.isFinite(pullRequest.changedFiles) ? Number(pullRequest.changedFiles) : 0,
        files?.length ?? 0
      )
    )
    const base: PullRequestReview = {
      kind: 'github',
      selector: normalizedSelector,
      baseOid: baseRefOid,
      headOid: headRefOid,
      commitId: headRefOid,
      viewerCanSubmitDecision: !isSameGitHubLogin(viewerLogin, pullRequest.author.login),
      pullRequest,
      files: [],
      patch: '',
      omittedFiles: [],
      expectedFileCount
    }
    onProgress?.({ kind: 'metadata', selector: normalizedSelector, review: base })

    const cached = await this.#pullRequestCache?.read(pullRequest.url, headRefOid) ?? null
    if (cached != null) {
      // No files event: the whole patch is already in hand, so emitting it here
      // and returning it from the same call would clone up to the entire review
      // over IPC twice in one tick. The renderer adopts the resolved review.
      return {
        ...base,
        files: cached.files,
        patch: cached.patch,
        omittedFiles: cached.omittedFiles,
        expectedFileCount: cached.files.length
      }
    }

    const collectedFiles: PullRequestFile[] = []
    const collectedOmitted: OmittedDiffFile[] = []
    const patchParts: string[] = []
    let emittedPage = false
    const emit = (page: { patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }): void => {
      const limited = limitPatchFileSize(page.patch, MAX_DIFF_FILE_BYTES)
      patchParts.push(limited.patch)
      collectedFiles.push(...page.files)
      collectedOmitted.push(...page.omittedFiles, ...limited.omittedFiles)
      emittedPage = true
      onProgress?.({
        kind: 'files',
        selector: normalizedSelector,
        patch: limited.patch,
        files: page.files,
        omittedFiles: [...page.omittedFiles, ...limited.omittedFiles]
      })
    }

    await this.#collectPullRequestPatch(
      ghExecutable,
      normalizedSelector,
      signal,
      emit
    )
    const review: PullRequestReview = {
      ...base,
      files: collectedFiles,
      patch: patchParts.join(''),
      omittedFiles: collectedOmitted
    }
    const streamed = onProgress != null && emittedPage
    if (streamed) {
      onProgress({ kind: 'done', selector: normalizedSelector, fileCount: collectedFiles.length })
    }
    if (!signal.aborted) await this.#pullRequestCache?.write(pullRequest.url, headRefOid, review)
    return pullRequestReviewReply(review, streamed)
  }

  /**
   * One diff document is the fast path; a pull request too big for GitHub to render
   * as a single diff is rebuilt from the paged files API instead of failing to open.
   */
  async #collectPullRequestPatch(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    emit: (page: { patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }) => void
  ): Promise<void> {
    try {
      const diffResult = await runGitHubReadCommand(
        ghExecutable,
        ['pr', 'diff', selector, '--color', 'never'],
        this.#requireRoot(),
        signal
      )
      const patch = diffResult.stdout.toString('utf8')
      for (const page of chunkPatchByFileCount(patch)) {
        emit({
          patch: page,
          files: filesFromPatch(page),
          omittedFiles: []
        })
      }
      return
    } catch (error) {
      if (signal.aborted) return
      if (!isPullRequestDiffTooLargeError(error)) throw error
    }
    await this.#collectPullRequestPatchFromFilesApi(ghExecutable, selector, signal, emit)
  }

  async #collectPullRequestPatchFromFilesApi(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    emit: (page: { patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }) => void
  ): Promise<void> {
    const { owner, name, number } = await this.#resolvePullRequestIdentity(ghExecutable, selector)
    const readPage = async (page: number): Promise<RawPullRequestFile[]> => {
      const result = await runGitHubReadCommand(
        ghExecutable,
        [
          'api',
          `repos/${owner}/${name}/pulls/${number}/files?per_page=${PULL_REQUEST_FILES_PAGE_SIZE}&page=${page}`
        ],
        this.#requireRoot(),
        signal
      )
      const pageFiles = parseJson<RawPullRequestFile[]>(result, 'GitHub')
      return Array.isArray(pageFiles) ? pageFiles : []
    }

    for (let wave = pullRequestFilePageWave(1); wave.length > 0; wave = pullRequestFilePageWave(wave[wave.length - 1]! + 1)) {
      if (signal.aborted) return
      const pages = await Promise.all(wave.map(readPage))
      if (signal.aborted) return
      let filesInWave = 0
      for (const pageFiles of pages) {
        if (pageFiles.length === 0) continue
        filesInWave += pageFiles.length
        emit(buildPullRequestPatchFromFiles(pageFiles))
      }
      if (filesInWave === 0) return
    }
  }

  async checkoutPullRequest(number: number): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    requirePullRequestNumber(number)
    await runCommand(await getGhExecutable(), ['pr', 'checkout', String(number)], this.#requireRoot())
    return this.refresh()
  }

  async submitPullRequestReview(
    selector: number | string,
    commitIdValue: unknown,
    reviewEvent: string,
    body: string,
    commentsValue: unknown
  ): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const payload = createPullRequestReviewPayload(commitIdValue, reviewEvent, body, commentsValue)
    const ghExecutable = await getGhExecutable()
    const [targetResult, viewerLogin] = await Promise.all([
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'id,number,url,headRefOid,author'],
        this.#requireRoot()
      ),
      this.#getGitHubViewerLogin(ghExecutable)
    ])
    const targetDetails = parseJson<{
      id: string
      number: number
      url: string
      headRefOid: string
      author: { login: string }
    }>(targetResult, 'GitHub CLI')
    if (targetDetails.headRefOid !== commitIdValue) {
      throw new Error('This pull request changed after you opened it. Reload the review before submitting comments.')
    }
    if (typeof targetDetails.id !== 'string' || targetDetails.id === '' || targetDetails.id.length > 256) {
      throw new Error('GitHub returned an invalid pull request ID.')
    }
    validatePullRequestTarget(targetDetails.url, targetDetails.number)
    // A pasted URL would otherwise submit a review to a repository that is not the open one.
    const remotes = await this.getRemotes()
    if (!pullRequestTargetsRemotes(remotes, targetDetails.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    if (reviewEvent !== 'comment' && isSameGitHubLogin(viewerLogin, targetDetails.author.login)) {
      throw new Error(SELF_REVIEW_DECISION_ERROR)
    }
    try {
      await runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({
          query: ADD_PULL_REQUEST_REVIEW_MUTATION,
          variables: {
            input: {
              pullRequestId: targetDetails.id,
              ...payload
            }
          }
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/can not (?:approve|request changes on) your own pull request/i.test(message)) {
        throw new Error(SELF_REVIEW_DECISION_ERROR)
      }
      throw error
    }
  }

  // Check data is optional garnish, so an unsupported field costs the chips instead
  // of the whole response. An older `gh` rejects the check fields and the fallback
  // costs a second spawn, so the answer is remembered — on the service rather than
  // the module, where one degraded call used to degrade every later one in the
  // process, tests included.
  async #runPullRequestJsonCommand(
    executable: string,
    args: readonly string[],
    fields: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    if (!this.#checkFieldsSupported) {
      return runGitHubReadCommand(executable, [...args, '--json', fields], cwd, signal)
    }
    try {
      return await runGitHubReadCommand(
        executable,
        [...args, '--json', `${fields},${PULL_REQUEST_CHECK_FIELDS}`],
        cwd,
        signal
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/unknown json field/i.test(message)) throw error
      this.#checkFieldsSupported = false
      return runGitHubReadCommand(executable, [...args, '--json', fields], cwd, signal)
    }
  }

  async #getGitHubViewerLogin(ghExecutable: string): Promise<string> {
    if (this.#githubViewerLogin != null) return this.#githubViewerLogin
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['api', 'user', '--jq', '.login'],
      this.#requireRoot()
    )
    const login = result.stdout.toString('utf8').trim()
    const containsControlCharacter = [...login].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
    if (login === '' || login.length > 64 || containsControlCharacter) {
      throw new Error('GitHub returned an invalid viewer login.')
    }
    this.#githubViewerLogin = login
    return login
  }

  async #readHeadFile(
    path: string,
    head: string | null
  ): Promise<ReadVersion | null> {
    if (head == null) return null
    const object = `${head}:${path}`
    const cachedEntry = this.#headFileCache.get(object)
    if (cachedEntry != null) {
      this.#headFileCache.delete(object)
      this.#headFileCache.set(object, cachedEntry)
      return cachedEntry.promise
    }

    const entry = { promise: Promise.resolve<ReadVersion | null>(null), bytes: 0 }
    // Concurrent loads must charge their announced size before the content is read,
    // otherwise the byte cap only applies after every in-flight load has resolved.
    const chargeBytes = (bytes: number): void => {
      if (this.#headFileCache.get(object) !== entry) return
      this.#headFileCacheBytes += bytes - entry.bytes
      entry.bytes = bytes
      this.#evictHeadFileCache()
    }
    entry.promise = this.#loadHeadFile(path, object, chargeBytes).then((version) => {
      const fileBytes = version?.file == null ? 0 : Buffer.byteLength(version.file.contents, 'utf8')
      chargeBytes(fileBytes + (version?.image?.byteLength ?? 0))
      return version
    }).catch((error: unknown) => {
      if (this.#headFileCache.get(object) === entry) this.#deleteHeadCacheEntry(object)
      throw error
    })
    this.#headFileCache.set(object, entry)
    this.#evictHeadFileCache()
    return entry.promise
  }

  async #loadHeadFile(
    path: string,
    object: string,
    chargeBytes: (bytes: number) => void
  ): Promise<ReadVersion | null> {
    this.#requireGitRepository()
    let read: GitObjectRead
    try {
      read = await this.#readObject(object)
    } catch {
      // A HEAD side that cannot be read reads as "no previous version", which is
      // what the two-spawn version did when the size probe failed.
      return null
    }
    // A gitlink resolves to the submodule's commit object. Rendering its body as
    // the old side turned every submodule into a deleted file full of plumbing.
    if (read.missing || read.type !== 'blob') return null
    if (read.oversized) return { file: null, binary: false, oversized: true }
    chargeBytes(read.size)

    const contents = read.contents ?? Buffer.alloc(0)
    const looksBinary = isBinary(contents)
    const image = createImagePreviewSide(path, contents, looksBinary)
    const binary = looksBinary || image != null
    return { file: binary ? null : toDiffFile(path, contents), binary, oversized: false, image }
  }

  async #readWorkingFile(
    path: string,
    root: string,
    bypassCache = false
  ): Promise<WorkingFileRead | null> {
    const candidate = resolve(root, path)
    if (!isWithinRoot(root, candidate)) throw new Error('The selected path escapes the repository.')

    let metadata
    try {
      metadata = await lstat(candidate)
    } catch {
      this.#deleteWorkingCacheEntry(path)
      return null
    }

    // Identity as well as timestamps: a same-millisecond rewrite of the same size
    // would otherwise be served from the cache.
    const revision = `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}:${metadata.ino}`
    if (!bypassCache) {
      const cached = this.#workingFileCache.get(path)
      if (cached != null && cached.read.revision === revision) {
        this.#workingFileCache.delete(path)
        this.#workingFileCache.set(path, cached)
        return cached.read
      }
    }

    const read = await this.#loadWorkingFile(path, candidate, root, metadata, revision)
    if (read != null) this.#storeWorkingFile(path, read)
    return read
  }

  async #loadWorkingFile(
    path: string,
    candidate: string,
    root: string,
    metadata: Awaited<ReturnType<typeof lstat>>,
    revision: string
  ): Promise<WorkingFileRead | null> {
    if (metadata.isSymbolicLink()) {
      const linkTarget = Buffer.from(await readlink(candidate), 'utf8')
      return {
        contents: linkTarget,
        file: toDiffFile(path, linkTarget),
        binary: false,
        oversized: false,
        revision
      }
    }
    if (!metadata.isFile()) return null
    if (metadata.size > MAX_DIFF_FILE_BYTES) {
      return { contents: null, file: null, binary: false, oversized: true, revision }
    }

    const resolvedPath = await realpath(candidate)
    if (!isWithinRoot(root, resolvedPath)) throw new Error('The selected file resolves outside the repository.')
    const contents = await readFile(resolvedPath)
    const looksBinary = isBinary(contents)
    const image = createImagePreviewSide(path, contents, looksBinary)
    const binary = looksBinary || image != null
    return {
      contents,
      file: binary ? null : toDiffFile(path, contents),
      binary,
      oversized: false,
      revision,
      image
    }
  }

  #storeWorkingFile(path: string, read: WorkingFileRead): void {
    const bytes = read.contents?.byteLength ?? 0
    this.#deleteWorkingCacheEntry(path)
    this.#workingFileCache.set(path, { read, bytes })
    this.#workingFileCacheBytes += bytes
    while (
      this.#workingFileCache.size > MAX_WORKING_CACHE_ENTRIES
      || this.#workingFileCacheBytes > MAX_WORKING_CACHE_BYTES
    ) {
      const oldest = this.#workingFileCache.keys().next().value
      if (oldest == null || oldest === path) return
      this.#deleteWorkingCacheEntry(oldest)
    }
  }

  #deleteWorkingCacheEntry(path: string): void {
    const entry = this.#workingFileCache.get(path)
    if (entry == null) return
    this.#workingFileCacheBytes -= entry.bytes
    this.#workingFileCache.delete(path)
  }

  #readObject(object: string): Promise<GitObjectRead> {
    const root = this.#requireRoot()
    if (this.#objectReader == null) this.#objectReader = new GitObjectReader(root)
    return this.#objectReader.read(object)
  }

  getRemotes(): Promise<GitRemote[]> {
    this.#requireGitRepository()
    if (this.#remotes === undefined) {
      const request = this.#git(['remote', '-v']).then(parseRemotes)
      this.#remotes = request
      void request.catch(() => {
        if (this.#remotes === request) this.#remotes = undefined
      })
    }
    return this.#remotes
  }

  async #git(args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
    if (this.#kind !== 'git') throw new Error('The open folder is not a Git repository.')
    return runCommand('git', ['-C', this.#requireRoot(), ...args], undefined, [], undefined, signal)
  }

  #requireGitRepository(): void {
    if (this.#kind !== 'git') throw new Error('The open folder is not a Git repository.')
  }

  async #gitAllowFailure(args: readonly string[]): Promise<CommandResult | null> {
    try {
      return await this.#git(args)
    } catch {
      return null
    }
  }

  #setSnapshot(snapshot: RepositorySnapshot): void {
    if (this.#snapshot?.root !== snapshot.root || this.#snapshot?.head !== snapshot.head) {
      this.#clearHeadFileCache()
    }
    // Rebuilding the set costs ~5 ms per refresh at 100k paths, and the watcher's
    // steady-state tick hands back the same array `#visiblePaths` already reused.
    if (this.#snapshot?.paths !== snapshot.paths) this.#pathSet = new Set(snapshot.paths)
    this.#snapshot = snapshot
    this.#snapshotRevision += 1
    this.#statusByPath = new Map(snapshot.statuses.map((status) => [status.path, status]))
  }

  #cancelActiveSearch(): void {
    const search = this.#activeSearch
    if (search == null) return
    search.cancelled = true
    this.#contentSearchMetrics.cancelled += 1
    search.child.kill()
    this.#activeSearch = null
  }

  #deleteHeadCacheEntry(object: string): void {
    const entry = this.#headFileCache.get(object)
    if (entry == null) return
    this.#headFileCacheBytes -= entry.bytes
    this.#headFileCache.delete(object)
  }

  #evictHeadFileCache(): void {
    while (
      this.#headFileCache.size > MAX_HEAD_CACHE_ENTRIES
      || this.#headFileCacheBytes > MAX_HEAD_CACHE_BYTES
    ) {
      const oldestObject = this.#headFileCache.keys().next().value
      if (oldestObject == null) return
      this.#deleteHeadCacheEntry(oldestObject)
    }
  }

  #clearHeadFileCache(): void {
    this.#headFileCache.clear()
    this.#headFileCacheBytes = 0
  }

  #requireRoot(): string {
    if (this.#root == null) throw new Error('Open a folder first.')
    return this.#root
  }

  #requireSnapshot(): RepositorySnapshot {
    if (this.#snapshot == null) throw new Error('Repository data is not ready.')
    return this.#snapshot
  }
}
