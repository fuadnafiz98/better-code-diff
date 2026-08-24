import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fileConstants } from 'node:fs'
import { access, lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, relative, resolve, sep } from 'node:path'

import type {
  ContentSearchResult,
  DiffFileContents,
  FileComparison,
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
  WorkingTreePatch
} from '../shared/contracts.js'

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_FILE_CHURN_LINES = 20_000
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_HEAD_CACHE_ENTRIES = 16
const MAX_HEAD_CACHE_BYTES = 16 * 1024 * 1024
const MAX_PATCH_COMMAND_CONCURRENCY = 4
const MAX_PULL_REQUEST_REVIEW_COMMENTS = 100
const MAX_PULL_REQUEST_INBOX_RESULTS = 30
// `gh pr diff` asks GitHub for one diff document, and GitHub refuses past 300
// files. The files API pages instead, up to its own ceiling of 3000.
const PULL_REQUEST_FILES_PAGE_SIZE = 100
const MAX_PULL_REQUEST_FILES = 3_000
// Each page is one `gh` process and one GitHub round trip, ~5s for a large pull
// request. Fetched one after another a 3000-file review took nearly two minutes.
const PULL_REQUEST_FILES_PAGE_CONCURRENCY = 8
const MAX_REVIEW_BODY_LENGTH = 65_536
// `gh search prs --json` only exposes these pull request fields; richer fields need `gh pr view`.
const PULL_REQUEST_LIST_FIELDS = 'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,updatedAt,additions,deletions,changedFiles'
const PULL_REQUEST_REVIEW_FIELDS = `${PULL_REQUEST_LIST_FIELDS},headRefOid,files`
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
const GIT_DIFF_SECTION_PREFIX = 'diff --git '
const DIFF_HEADER_PATHS = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/
const PATCH_PATH_QUOTE_PATTERN = /["\\\x00-\x1f\x7f]/
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

type ReadVersion = {
  contents: Buffer | null
  binary: boolean
  oversized: boolean
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

interface CommandResult {
  stdout: Buffer
  stderr: Buffer
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

export interface GitObjectRead {
  contents: Buffer | null
  size: number
  missing: boolean
  oversized: boolean
}

const MAX_CAT_FILE_HEADER_BYTES = 4_096

// Reading a HEAD blob used to cost two git spawns per file: `cat-file -s` for the
// size guard, then `cat-file -p` for the contents. `cat-file --batch` emits
// "<oid> <type> <size>\n<contents>\n", so one spawn carries both — and because the
// size arrives before the body, an oversized blob is abandoned by killing the
// child rather than being read into memory first.
export function readGitObject(root: string, object: string): Promise<GitObjectRead> {
  return new Promise((resolveRead, rejectRead) => {
    const child = spawn('git', ['-C', root, 'cat-file', '--batch'], { windowsHide: true })
    let header: Buffer = Buffer.alloc(0)
    let expected: number | null = null
    const body: Buffer[] = []
    let bodyBytes = 0
    let stderr = ''
    let settled = false

    const settle = (value: GitObjectRead): void => {
      if (settled) return
      settled = true
      child.kill()
      resolveRead(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      rejectRead(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      if (expected == null) {
        header = header.length === 0 ? chunk : Buffer.concat([header, chunk])
        const newline = header.indexOf(0x0a)
        if (newline === -1) {
          if (header.length > MAX_CAT_FILE_HEADER_BYTES) fail(new Error('git cat-file returned no header.'))
          return
        }
        const fields = header.subarray(0, newline).toString('utf8').split(' ')
        if (fields[1] === 'missing' || fields.length < 3) {
          settle({ contents: null, size: 0, missing: true, oversized: false })
          return
        }
        const size = Number(fields[2])
        if (!Number.isFinite(size) || size < 0) {
          fail(new Error('git cat-file returned an unreadable size.'))
          return
        }
        if (size > MAX_DIFF_FILE_BYTES) {
          settle({ contents: null, size, missing: false, oversized: true })
          return
        }
        expected = size
        const rest = header.subarray(newline + 1)
        header = Buffer.alloc(0)
        if (rest.length > 0) {
          body.push(rest)
          bodyBytes += rest.length
        }
      } else {
        body.push(chunk)
        bodyBytes += chunk.length
      }
      if (expected != null && bodyBytes >= expected) {
        settle({
          contents: Buffer.concat(body).subarray(0, expected),
          size: expected,
          missing: false,
          oversized: false
        })
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_048)
    })
    child.on('error', fail)
    child.on('close', () => {
      fail(new Error(stderr.trim() || 'git cat-file did not return the object.'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(`${object}\n`)
  })
}

function runCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
  allowedExitCodes: readonly number[] = [],
  input?: string
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const result = { stdout, stderr }

        const exitCode = error == null ? 0 : Number(error.code)
        if (error && !allowedExitCodes.includes(exitCode)) {
          const message = result.stderr.toString('utf8').trim() || error.message
          rejectCommand(new Error(message))
          return
        }

        resolveCommand(result)
      }
    )
    if (input != null) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

async function mapWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  transform: (value: Value) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(values.length)
  let nextIndex = 0
  const runNext = async (): Promise<void> => {
    const index = nextIndex
    nextIndex += 1
    if (index >= values.length) return
    const value = values[index]!
    results[index] = await transform(value)
    return runNext()
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runNext())
  )
  return results
}

function isTransientGitHubError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP\s+(?:502|503|504)\b|timed?\s*out|timeout|connection reset/i.test(message)
}

async function runGitHubReadCommand(
  executable: string,
  args: readonly string[],
  cwd: string
): Promise<CommandResult> {
  const retryDelays = [0, 250, 750] as const
  let lastError: unknown
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay))
    try {
      return await runCommand(executable, args, cwd)
    } catch (error) {
      lastError = error
      if (!isTransientGitHubError(error)) throw error
    }
  }
  throw lastError
}

// Check data is optional garnish, so an unsupported field costs the chips instead of the whole response.
// An older `gh` rejects the check fields, and the fallback costs a second spawn.
// Whether they are supported is a property of the installed binary, so the answer
// is remembered instead of being rediscovered on every poll.
let pullRequestCheckFieldsSupported = true

async function runPullRequestJsonCommand(
  executable: string,
  args: readonly string[],
  fields: string,
  cwd: string
): Promise<CommandResult> {
  if (!pullRequestCheckFieldsSupported) {
    return runGitHubReadCommand(executable, [...args, '--json', fields], cwd)
  }
  try {
    return await runGitHubReadCommand(executable, [...args, '--json', `${fields},${PULL_REQUEST_CHECK_FIELDS}`], cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/unknown json field/i.test(message)) throw error
    pullRequestCheckFieldsSupported = false
    return runGitHubReadCommand(executable, [...args, '--json', fields], cwd)
  }
}

function gitHubIntegrationErrorMessage(error: unknown): string {
  if (isTransientGitHubError(error)) {
    return 'GitHub timed out while loading the pull request list. Retry, or open a pull request directly by number or URL.'
  }
  return error instanceof Error ? error.message : String(error)
}

function splitNullDelimited(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
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

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isExcludedPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/')
  return segments.some((segment) => EXCLUDED_DIRECTORY_SET.has(segment))
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
export function mergeVisiblePaths(trackedBuffer: Buffer, untrackedPaths: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const rawPath of splitNullDelimited(trackedBuffer)) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) seen.add(path)
  }
  for (const rawPath of untrackedPaths) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) seen.add(path)
  }
  return [...seen].sort(comparePaths)
}

export interface DiffChurnEntry {
  path: string
  previousPath?: string
  additions: number
  deletions: number
  binary: boolean
}

export function parseNumstat(buffer: Buffer): DiffChurnEntry[] {
  const fields = splitNullDelimited(buffer)
  const entries: DiffChurnEntry[] = []

  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex]
    if (field == null) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 1 || secondTab < 0) continue

    const additionsText = field.slice(0, firstTab)
    const deletionsText = field.slice(firstTab + 1, secondTab)
    const binary = additionsText === '-' || deletionsText === '-'
    const churn = {
      additions: binary ? 0 : Number(additionsText) || 0,
      deletions: binary ? 0 : Number(deletionsText) || 0,
      binary
    }
    const inlinePath = field.slice(secondTab + 1)
    if (inlinePath !== '') {
      entries.push({ path: inlinePath, ...churn })
      continue
    }

    const previousPath = fields[fieldIndex + 1]
    const path = fields[fieldIndex + 2]
    fieldIndex += 2
    if (previousPath == null || path == null) continue
    entries.push({ path, previousPath, ...churn })
  }

  return entries
}

export function diffFilesFromChurn(entries: readonly DiffChurnEntry[]): PullRequestFile[] {
  return entries
    .map((entry) => ({ path: entry.path, additions: entry.additions, deletions: entry.deletions }))
    .sort((left, right) => comparePaths(left.path, right.path))
}

export function selectOversizedDiffFiles(entries: readonly DiffChurnEntry[]): {
  omittedFiles: OmittedDiffFile[]
  excludePathspecs: string[]
} {
  const omittedFiles: OmittedDiffFile[] = []
  const excludePathspecs: string[] = []

  for (const entry of entries) {
    if (entry.binary || entry.additions + entry.deletions <= MAX_DIFF_FILE_CHURN_LINES) continue
    omittedFiles.push({
      path: entry.path,
      reason: 'too-large',
      additions: entry.additions,
      deletions: entry.deletions
    })
    excludePathspecs.push(`:(exclude,literal)${entry.path}`)
    if (entry.previousPath != null) excludePathspecs.push(`:(exclude,literal)${entry.previousPath}`)
  }

  return { omittedFiles, excludePathspecs }
}

function formatPatchPath(side: 'a' | 'b', path: string): string {
  const sidedPath = `${side}/${path}`
  if (!PATCH_PATH_QUOTE_PATTERN.test(path)) return sidedPath
  const escapedPath = sidedPath
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escapedPath}"`
}

export function createNewFilePatch(path: string, contents: string, binary = false): string {
  const header = `diff --git ${formatPatchPath('a', path)} ${formatPatchPath('b', path)}\nnew file mode 100644\n`
  if (binary) return `${header}Binary files /dev/null and ${formatPatchPath('b', path)} differ\n`
  // Git emits no hunk, and no file headers, for an empty new file.
  if (contents === '') return header

  const endsWithNewline = contents.endsWith('\n')
  const lines = (endsWithNewline ? contents.slice(0, -1) : contents).split('\n')
  const hunkHeader = lines.length === 1 ? '@@ -0,0 +1 @@' : `@@ -0,0 +1,${lines.length} @@`
  const body = lines.map((line) => `+${line}`).join('\n')
  const incompleteLastLine = endsWithNewline ? '' : '\\ No newline at end of file\n'
  return `${header}--- /dev/null\n+++ ${formatPatchPath('b', path)}\n${hunkHeader}\n${body}\n${incompleteLastLine}`
}

/**
 * One wave of file pages to request together. GitHub gives no reliable total —
 * its own file count can exceed what the API serves, and a page carrying large
 * patches comes back short without meaning the end — so pages are read in waves
 * until a whole wave comes back empty, capped at the 3000 files the API answers.
 */
export function pullRequestFilePageWave(startPage: number): number[] {
  const maxPages = MAX_PULL_REQUEST_FILES / PULL_REQUEST_FILES_PAGE_SIZE
  const first = Math.max(1, Math.floor(startPage))
  const last = Math.min(maxPages, first + PULL_REQUEST_FILES_PAGE_CONCURRENCY - 1)
  if (first > maxPages) return []
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index)
}

export interface RawPullRequestFile {
  filename: string
  previous_filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
}

/**
 * GitHub answers `gh pr diff` with HTTP 406 once a pull request touches more than
 * 300 files, and `gh` surfaces that verbatim. Recognising it lets the review fall
 * back to the paged files API instead of failing to open at all.
 */
export function isPullRequestDiffTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 406|too_large|exceeded the maximum number of files/i.test(message)
}

/**
 * Rebuilds a git-style patch from the files API, which returns each file's hunks
 * without the `diff --git` headers the diff parser keys on. Files GitHub declines
 * to diff (binary, or too large for its own limit) arrive without a patch and are
 * reported as omitted rather than dropped silently.
 */
export function buildPullRequestPatchFromFiles(rawFiles: readonly RawPullRequestFile[]): {
  patch: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
} {
  const sections: string[] = []
  const files: PullRequestFile[] = []
  const omittedFiles: OmittedDiffFile[] = []
  for (const rawFile of rawFiles) {
    const path = typeof rawFile.filename === 'string' ? rawFile.filename : ''
    if (path === '' || isExcludedPath(path)) continue
    const additions = Number.isFinite(rawFile.additions) ? Number(rawFile.additions) : 0
    const deletions = Number.isFinite(rawFile.deletions) ? Number(rawFile.deletions) : 0
    files.push({ path, additions, deletions })
    if (typeof rawFile.patch !== 'string' || rawFile.patch === '') {
      omittedFiles.push({ path, reason: 'too-large', additions, deletions })
      continue
    }

    const previousPath = typeof rawFile.previous_filename === 'string' && rawFile.previous_filename !== ''
      ? rawFile.previous_filename
      : path
    const header = [`${GIT_DIFF_SECTION_PREFIX}${formatPatchPath('a', previousPath)} ${formatPatchPath('b', path)}`]
    if (rawFile.status === 'added') header.push('new file mode 100644')
    if (rawFile.status === 'removed') header.push('deleted file mode 100644')
    if (rawFile.status === 'renamed' && previousPath !== path) {
      header.push(`rename from ${previousPath}`, `rename to ${path}`)
    }
    header.push(
      rawFile.status === 'added' ? '--- /dev/null' : `--- ${formatPatchPath('a', previousPath)}`,
      rawFile.status === 'removed' ? '+++ /dev/null' : `+++ ${formatPatchPath('b', path)}`
    )
    const body = rawFile.patch.endsWith('\n') ? rawFile.patch : `${rawFile.patch}\n`
    sections.push(`${header.join('\n')}\n${body}`)
  }
  return { patch: sections.join(''), files, omittedFiles }
}

function findPatchSectionStarts(patch: string): number[] {
  const starts: number[] = []
  if (patch.startsWith(GIT_DIFF_SECTION_PREFIX)) starts.push(0)
  let boundaryIndex = patch.indexOf(`\n${GIT_DIFF_SECTION_PREFIX}`)
  while (boundaryIndex !== -1) {
    starts.push(boundaryIndex + 1)
    boundaryIndex = patch.indexOf(`\n${GIT_DIFF_SECTION_PREFIX}`, boundaryIndex + 1)
  }
  return starts
}

function patchSectionPath(patch: string, start: number, end: number): string {
  const newlineIndex = patch.indexOf('\n', start)
  const headerEnd = newlineIndex === -1 || newlineIndex > end ? end : newlineIndex
  const header = patch.slice(start, headerEnd)
  const match = DIFF_HEADER_PATHS.exec(header)
  const plainPath = match?.[4]
  if (plainPath != null) return plainPath
  const quotedPath = match?.[3]
  if (quotedPath != null) return quotedPath.replace(/\\(.)/g, '$1')
  return header.slice(GIT_DIFF_SECTION_PREFIX.length)
}

function countPatchSectionChurn(
  patch: string,
  start: number,
  end: number
): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let lineStart = start

  while (lineStart < end) {
    const newlineIndex = patch.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 || newlineIndex > end ? end : newlineIndex
    const marker = patch[lineStart]
    if (marker === '+' && !patch.startsWith('+++ ', lineStart)) additions += 1
    else if (marker === '-' && !patch.startsWith('--- ', lineStart)) deletions += 1
    lineStart = lineEnd + 1
  }

  return { additions, deletions }
}

export function limitPatchFileSize(
  patch: string,
  maxBytes: number
): { patch: string; omittedFiles: OmittedDiffFile[] } {
  const sectionStarts = findPatchSectionStarts(patch)
  const sectionEnd = (index: number): number => sectionStarts[index + 1] ?? patch.length
  const oversizedSections = new Set<number>()
  for (let index = 0; index < sectionStarts.length; index += 1) {
    if (sectionEnd(index) - sectionStarts[index]! > maxBytes) oversizedSections.add(index)
  }
  if (oversizedSections.size === 0) return { patch, omittedFiles: [] }

  const omittedFiles: OmittedDiffFile[] = []
  const keptParts: string[] = []
  const firstStart = sectionStarts[0]!
  if (firstStart > 0) keptParts.push(patch.slice(0, firstStart))

  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index]!
    const end = sectionEnd(index)
    if (!oversizedSections.has(index)) {
      keptParts.push(patch.slice(start, end))
      continue
    }
    omittedFiles.push({
      path: patchSectionPath(patch, start, end),
      reason: 'too-large',
      ...countPatchSectionChurn(patch, start, end)
    })
  }

  return { patch: keptParts.join(''), omittedFiles }
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

function toDiffFile(name: string, contents: Buffer, revision: string): DiffFileContents {
  return {
    name,
    contents: contents.toString('utf8'),
    cacheKey: createCacheKey(revision, name, contents)
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

function parseRemotes(result: CommandResult): GitRemote[] {
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
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/i.test(trimmedSelector)) {
    return trimmedSelector
  }
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

export class RepositoryService {
  #root: string | null = null
  #kind: RepositorySnapshot['kind'] = 'folder'
  #snapshot: RepositorySnapshot | null = null
  #pathSet = new Set<string>()
  #statusByPath = new Map<string, RepositoryStatusEntry>()
  #headFileCache = new Map<string, { promise: Promise<ReadVersion | null>; bytes: number }>()
  #headFileCacheBytes = 0
  #activeSearch: { child: ReturnType<typeof spawn>; cancelled: boolean; startedAt: number } | null = null
  #contentSearchMetrics: ContentSearchMetrics = { spawned: 0, cancelled: 0, completed: 0, durationsMs: [] }
  #githubViewerLogin: string | null = null
  // undefined means "not resolved yet"; null means "resolved, no GitHub remote".
  #githubSlug: string | null | undefined = undefined
  // A pull request's owner, repository, and number never change, so the identity
  // lookup is resolved once instead of on every conversation poll.
  #pullRequestIdentities = new Map<string, { owner: string; name: string; number: number }>()

  getSessionSnapshot(): RepositorySnapshot | null {
    return this.#snapshot
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

  async open(folderPath: string): Promise<RepositorySnapshot> {
    const selectedRoot = await realpath(folderPath)
    const rootResult = await runCommand('git', [
      '-C', selectedRoot, 'rev-parse', '--show-toplevel'
    ]).catch(() => null)

    this.#kind = rootResult == null ? 'folder' : 'git'
    this.#root = rootResult?.stdout.toString('utf8').trim() || selectedRoot
    this.#githubViewerLogin = null
    this.#githubSlug = undefined
    this.#pullRequestIdentities.clear()
    this.#cancelActiveSearch()
    this.#clearHeadFileCache()
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
      paths: mergeVisiblePaths(trackedResult.stdout, status.untrackedPaths),
      statuses: status.statuses.filter((entry) => !isExcludedPath(entry.path))
    }

    this.#setSnapshot(snapshot)
    return snapshot
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
    const paths = prepareVisiblePaths(pathsResult.stdout)
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

  async getComparison(path: string): Promise<FileComparison> {
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

    return {
      path,
      mode: snapshot.kind === 'git' ? 'diff' : 'file',
      status: status?.status ?? 'unchanged',
      oldFile:
        oldVersion?.contents != null && !binary && !oversized
          ? toDiffFile(oldPath, oldVersion.contents, snapshot.head ?? 'empty-head')
          : null,
      newFile:
        workingVersion?.contents != null && !binary && !oversized
          ? toDiffFile(path, workingVersion.contents, workingVersion.revision)
          : null,
      binary,
      oversized
    }
  }

  async getWorkingTreePatch(pathsValue: unknown): Promise<WorkingTreePatch> {
    this.#requireGitRepository()
    const root = this.#requireRoot()
    if (!Array.isArray(pathsValue) || pathsValue.length > this.#pathSet.size) {
      throw new Error('Working tree patch paths must be a valid list.')
    }
    const paths = pathsValue.map((path) => {
      if (typeof path !== 'string' || !this.#pathSet.has(path)) {
        throw new Error('Working tree patch path is not in the repository.')
      }
      return path
    })
    if (paths.length === 0) return { patch: '', omittedFiles: [] }

    const snapshot = this.#requireSnapshot()
    const untrackedPaths = paths.filter((path) => this.#statusByPath.get(path)?.status === 'untracked')
    const trackedPaths = snapshot.head == null
      ? []
      : paths.filter((path) => this.#statusByPath.get(path)?.status !== 'untracked')
    const omittedFiles: OmittedDiffFile[] = []
    const patchParts: string[] = []

    if (trackedPaths.length > 0) {
      const churnResult = await this.#git([
        'diff', '--numstat', '-z', '--find-renames', snapshot.head!, '--', ...trackedPaths
      ])
      const oversized = selectOversizedDiffFiles(parseNumstat(churnResult.stdout))
      omittedFiles.push(...oversized.omittedFiles)
      const oversizedPaths = new Set(oversized.omittedFiles.map((file) => file.path))
      const includedPaths = trackedPaths.filter((path) => !oversizedPaths.has(path))
      if (includedPaths.length > 0) {
        const result = await this.#git([
          'diff', '--no-color', '--find-renames', '--unified=3', snapshot.head!, '--', ...includedPaths
        ])
        const patch = result.stdout.toString('utf8')
        if (patch !== '') patchParts.push(patch)
      }
    }

    const newPaths = snapshot.head == null ? paths : untrackedPaths
    const newFilePatches = await mapWithConcurrency(
      newPaths,
      MAX_PATCH_COMMAND_CONCURRENCY,
      (path) => this.#createNewFilePatch(path, root)
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
    root: string
  ): Promise<{ patch: string; omitted: OmittedDiffFile | null }> {
    const version = await this.#readWorkingFile(path, root)
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
    const mergeFlag = strategy === 'merge' ? '--merge' : strategy === 'rebase' ? '--rebase' : '--squash'
    const ghExecutable = await getGhExecutable()
    const remotes = parseRemotes(await this.#git(['remote', '-v']))
    const detailsResult = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'view', normalizedSelector, '--json', 'number,url'],
      this.#requireRoot()
    )
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
    await runCommand(ghExecutable, ['pr', 'ready', normalizedSelector], this.#requireRoot())
  }

  // The remote slug cannot change while a repository is open, so it is resolved
  // once instead of spawning `git remote -v` on every poll tick.
  async #getGitHubSlug(): Promise<string | null> {
    if (this.#githubSlug !== undefined) return this.#githubSlug
    const remotes = parseRemotes(await this.#git(['remote', '-v']))
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
    const pullRequestsPromise = runPullRequestJsonCommand(
      ghExecutable,
      ['pr', 'list', '--state', 'all', '--limit', '100'],
      PULL_REQUEST_LIST_FIELDS,
      this.#requireRoot()
    ).then(
      (result) => ({ pullRequests: parsePullRequestSummaries(result), message: null }),
      (error: unknown) => ({
        pullRequests: [] as PullRequestSummary[],
        message: gitHubIntegrationErrorMessage(error)
      })
    )

    const [branchesResult, remoteBranchesResult, remotesResult, commitsResult, defaultBranchResult, aheadBehindResult, githubResult] = await Promise.all([
      branchesPromise,
      this.#git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']),
      this.#git(['remote', '-v']),
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
      remotes: parseRemotes(remotesResult),
      commits: parseCommits(commitsResult),
      defaultBranch,
      ahead: counts.ahead,
      behind: counts.behind,
      pullRequests: githubResult.pullRequests,
      githubAvailable: githubResult.message == null,
      githubMessage: githubResult.message
    }
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
    const [churnResult, headResult] = await Promise.all([
      this.#git(['diff', '--numstat', '-z', '--find-renames', comparison, '--']),
      this.#git(['rev-parse', headRef])
    ])
    const entries = parseNumstat(churnResult.stdout).filter((entry) => !isExcludedPath(entry.path))
    const oversized = selectOversizedDiffFiles(entries)
    const patchResult = await this.#git([
      'diff', '--no-color', '--find-renames', comparison, '--', ...oversized.excludePathspecs
    ])
    const limited = limitPatchFileSize(patchResult.stdout.toString('utf8'), MAX_DIFF_FILE_BYTES)
    return {
      kind: 'local',
      id: `${comparison}:${headResult.stdout.toString('utf8').trim()}`,
      title: `${headRef} compared with ${baseRef}`,
      baseRefName: baseRef,
      headRefName: headRef,
      files: diffFilesFromChurn(entries),
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
      ? ['show', '--format=', '--no-color', '--find-renames', commitOid, '--']
      : ['diff', '--no-color', '--find-renames', firstParent, commitOid, '--']
    const [churnResult, metadataResult] = await Promise.all([
      this.#git(churnArgs),
      this.#git(['show', '-s', '--format=%h%x1f%s', commitOid])
    ])
    const [shortOid = commitOid.slice(0, 8), subject = 'Commit'] = metadataResult.stdout.toString('utf8').trim().split('\x1f')
    const entries = parseNumstat(churnResult.stdout).filter((entry) => !isExcludedPath(entry.path))
    const oversized = selectOversizedDiffFiles(entries)
    const patchResult = await this.#git([...patchArgs, ...oversized.excludePathspecs])
    const limited = limitPatchFileSize(patchResult.stdout.toString('utf8'), MAX_DIFF_FILE_BYTES)
    return {
      kind: 'local',
      id: `commit:${commitOid}`,
      title: `${shortOid} ${subject}`,
      baseRefName: firstParent?.slice(0, 8) ?? 'Empty tree',
      headRefName: shortOid,
      files: diffFilesFromChurn(entries),
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

  async getPullRequestReview(
    selector: number | string,
    onProgress?: (progress: PullRequestReviewProgress) => void
  ): Promise<PullRequestReview> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    // Metadata resolves in a second or two while the diff can take minutes, so it
    // is awaited on its own: the review header and file tree can open on it alone.
    const [detailsResult, viewerLogin] = await Promise.all([
      runPullRequestJsonCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector],
        PULL_REQUEST_REVIEW_FIELDS,
        this.#requireRoot()
      ),
      this.#getGitHubViewerLogin(ghExecutable)
    ])
    const details = parseJson<RawPullRequestSummary & { files: PullRequestReview['files']; headRefOid: string }>(detailsResult, 'GitHub CLI')
    const { files, headRefOid, ...rest } = details
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
      commitId: headRefOid,
      viewerCanSubmitDecision: !isSameGitHubLogin(viewerLogin, pullRequest.author.login),
      pullRequest,
      files: [],
      patch: '',
      omittedFiles: [],
      expectedFileCount
    }
    onProgress?.({ kind: 'metadata', selector: normalizedSelector, review: base })

    const collectedFiles: PullRequestFile[] = []
    const collectedOmitted: OmittedDiffFile[] = []
    const patchParts: string[] = []
    const emit = (page: { patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }): void => {
      const limited = limitPatchFileSize(page.patch, MAX_DIFF_FILE_BYTES)
      patchParts.push(limited.patch)
      collectedFiles.push(...page.files)
      collectedOmitted.push(...page.omittedFiles, ...limited.omittedFiles)
      onProgress?.({
        kind: 'files',
        selector: normalizedSelector,
        patch: limited.patch,
        files: page.files,
        omittedFiles: [...page.omittedFiles, ...limited.omittedFiles]
      })
    }

    await this.#collectPullRequestPatch(ghExecutable, normalizedSelector, files ?? [], emit)
    return {
      ...base,
      files: collectedFiles,
      patch: patchParts.join(''),
      omittedFiles: collectedOmitted
    }
  }

  /**
   * One diff document is the fast path; a pull request too big for GitHub to render
   * as a single diff is rebuilt from the paged files API instead of failing to open.
   */
  async #collectPullRequestPatch(
    ghExecutable: string,
    selector: string,
    detailFiles: readonly PullRequestFile[],
    emit: (page: { patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }) => void
  ): Promise<void> {
    try {
      const diffResult = await runGitHubReadCommand(
        ghExecutable,
        ['pr', 'diff', selector, '--color', 'never'],
        this.#requireRoot()
      )
      emit({
        patch: diffResult.stdout.toString('utf8'),
        files: [...detailFiles],
        omittedFiles: []
      })
      return
    } catch (error) {
      if (!isPullRequestDiffTooLargeError(error)) throw error
    }
    await this.#collectPullRequestPatchFromFilesApi(ghExecutable, selector, emit)
  }

  async #collectPullRequestPatchFromFilesApi(
    ghExecutable: string,
    selector: string,
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
        this.#requireRoot()
      )
      const pageFiles = parseJson<RawPullRequestFile[]>(result, 'GitHub')
      return Array.isArray(pageFiles) ? pageFiles : []
    }

    for (let wave = pullRequestFilePageWave(1); wave.length > 0; wave = pullRequestFilePageWave(wave[wave.length - 1]! + 1)) {
      const pages = await Promise.all(wave.map(readPage))
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
    const remotes = parseRemotes(await this.#git(['remote', '-v']))
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

  async #getGitHubViewerLogin(ghExecutable: string): Promise<string> {
    if (this.#githubViewerLogin != null) return this.#githubViewerLogin
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['api', 'user', '--jq', '.login'],
      this.#requireRoot()
    )
    const login = result.stdout.toString('utf8').trim()
    if (login === '' || login.length > 64 || /[\x00-\x1f\x7f]/.test(login)) {
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
    entry.promise = this.#loadHeadFile(object, chargeBytes).then((version) => {
      chargeBytes(version?.contents?.byteLength ?? 0)
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
    object: string,
    chargeBytes: (bytes: number) => void
  ): Promise<ReadVersion | null> {
    this.#requireGitRepository()
    let read: GitObjectRead
    try {
      read = await readGitObject(this.#requireRoot(), object)
    } catch {
      // A HEAD side that cannot be read reads as "no previous version", which is
      // what the two-spawn version did when the size probe failed.
      return null
    }
    if (read.missing) return null
    if (read.oversized) return { contents: null, binary: false, oversized: true }
    chargeBytes(read.size)

    const contents = read.contents ?? Buffer.alloc(0)
    return { contents, binary: isBinary(contents), oversized: false }
  }

  async #readWorkingFile(
    path: string,
    root: string
  ): Promise<
    { contents: Buffer | null; binary: boolean; oversized: boolean; revision: string } | null
  > {
    const candidate = resolve(root, path)
    if (!isWithinRoot(root, candidate)) throw new Error('The selected path escapes the repository.')

    let metadata
    try {
      metadata = await lstat(candidate)
    } catch {
      return null
    }

    if (metadata.isSymbolicLink()) {
      const linkTarget = Buffer.from(await readlink(candidate), 'utf8')
      return {
        contents: linkTarget,
        binary: false,
        oversized: false,
        revision: `${metadata.mtimeMs}:${metadata.size}`
      }
    }
    if (!metadata.isFile()) return null
    if (metadata.size > MAX_DIFF_FILE_BYTES) {
      return {
        contents: null,
        binary: false,
        oversized: true,
        revision: `${metadata.mtimeMs}:${metadata.size}`
      }
    }

    const resolvedPath = await realpath(candidate)
    if (!isWithinRoot(root, resolvedPath)) throw new Error('The selected file resolves outside the repository.')
    const contents = await readFile(resolvedPath)
    return {
      contents,
      binary: isBinary(contents),
      oversized: false,
      revision: `${metadata.mtimeMs}:${metadata.size}`
    }
  }

  async #git(args: readonly string[]): Promise<CommandResult> {
    if (this.#kind !== 'git') throw new Error('The open folder is not a Git repository.')
    return runCommand('git', ['-C', this.#requireRoot(), ...args])
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
    this.#snapshot = snapshot
    this.#pathSet = new Set(snapshot.paths)
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
