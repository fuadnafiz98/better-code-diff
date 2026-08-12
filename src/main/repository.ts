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
  LocalBranch,
  LocalBranchReview,
  PullRequestReview,
  PullRequestReviewEvent,
  PullRequestSummary,
  RemoteBranch,
  RepositoryFileStatus,
  RepositorySnapshot,
  RepositoryStatusEntry
} from '../shared/contracts.js'

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_HEAD_CACHE_ENTRIES = 32
const GH_EXECUTABLE_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const
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

function runCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
  allowedExitCodes: readonly number[] = []
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(stderr)
        }

        const exitCode = error == null ? 0 : Number(error.code)
        if (error && !allowedExitCodes.includes(exitCode)) {
          const message = result.stderr.toString('utf8').trim() || error.message
          rejectCommand(new Error(message))
          return
        }

        resolveCommand(result)
      }
    )
  })
}

function splitNullDelimited(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

export function mapGitStatus(indexStatus: string, workingStatus: string): RepositoryFileStatus {
  if (indexStatus === '?' && workingStatus === '?') return 'untracked'
  if (indexStatus === 'R' || workingStatus === 'R') return 'renamed'
  if (indexStatus === 'A' || workingStatus === 'A') return 'added'
  if (indexStatus === 'D' || workingStatus === 'D') return 'deleted'
  return 'modified'
}

export function parsePorcelainStatus(buffer: Buffer): RepositoryStatusEntry[] {
  const fields = splitNullDelimited(buffer)
  const statuses: RepositoryStatusEntry[] = []

  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex]
    if (field == null || field.length < 4) continue

    const indexStatus = field[0] ?? ' '
    const workingStatus = field[1] ?? ' '
    const path = field.slice(3)
    const status = mapGitStatus(indexStatus, workingStatus)

    if (status === 'renamed') {
      const previousPath = fields[fieldIndex + 1]
      fieldIndex += 1
      statuses.push({ path, previousPath, status })
      continue
    }

    statuses.push({ path, status })
  }

  return statuses
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

function normalizePullRequestSelector(selector: number | string): string {
  if (typeof selector === 'number') {
    requirePullRequestNumber(selector)
    return String(selector)
  }
  const trimmedSelector = selector.trim()
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/i.test(trimmedSelector)) {
    return trimmedSelector
  }
  throw new Error('Pull request selector must be a positive number or a GitHub pull request URL.')
}

export class RepositoryService {
  #root: string | null = null
  #kind: RepositorySnapshot['kind'] = 'folder'
  #snapshot: RepositorySnapshot | null = null
  #pathSet = new Set<string>()
  #statusByPath = new Map<string, RepositoryStatusEntry>()
  #headFileCache = new Map<string, Promise<ReadVersion | null>>()
  #activeSearch: ReturnType<typeof spawn> | null = null

  async open(folderPath: string): Promise<RepositorySnapshot> {
    const selectedRoot = await realpath(folderPath)
    const rootResult = await runCommand('git', [
      '-C', selectedRoot, 'rev-parse', '--show-toplevel'
    ]).catch(() => null)

    this.#kind = rootResult == null ? 'folder' : 'git'
    this.#root = rootResult?.stdout.toString('utf8').trim() || selectedRoot
    this.#headFileCache.clear()
    return this.refresh()
  }

  async refresh(): Promise<RepositorySnapshot> {
    const root = this.#requireRoot()
    this.#cancelActiveSearch()
    if (this.#kind === 'folder') return this.#refreshFolder(root)

    const [pathsResult, statusResult, branchResult, headResult] = await Promise.all([
      this.#git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
      this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.#git(['branch', '--show-current']),
      this.#gitAllowFailure(['rev-parse', '--verify', 'HEAD'])
    ])

    const head = headResult?.stdout.toString('utf8').trim() || null
    const branch = branchResult.stdout.toString('utf8').trim() || head?.slice(0, 8) || 'No commits'
    const snapshot: RepositorySnapshot = {
      root,
      name: basename(root),
      kind: 'git',
      branch,
      head,
      paths: prepareVisiblePaths(pathsResult.stdout),
      statuses: parsePorcelainStatus(statusResult.stdout)
        .filter((status) => !isExcludedPath(status.path))
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

  async searchContent(query: string): Promise<ContentSearchResult[]> {
    const root = this.#requireRoot()
    const trimmedQuery = query.trim()
    this.#cancelActiveSearch()
    if (trimmedQuery.length < 2) return []

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
      this.#activeSearch = child
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
        if (this.#activeSearch === child) this.#activeSearch = null
        rejectSearch(error)
      })
      child.on('close', (code) => {
        if (this.#activeSearch === child) this.#activeSearch = null
        processLine(pending)
        if (code != null && code > 1 && results.length < MAX_SEARCH_RESULTS) {
          rejectSearch(new Error(errorOutput.trim() || `Search failed with exit code ${code}.`))
          return
        }
        resolveSearch(results)
      })
    })
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
    const pullRequestsPromise = runCommand(ghExecutable, [
      'pr',
      'list',
      '--state', 'all',
      '--limit', '100',
      '--json',
      'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,updatedAt,additions,deletions,changedFiles'
    ], this.#requireRoot()).then(
      (result) => ({ pullRequests: parseJson<PullRequestSummary[]>(result, 'GitHub CLI'), message: null }),
      (error: unknown) => ({
        pullRequests: [],
        message: error instanceof Error ? error.message : String(error)
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
    const [pathsResult, patchResult, headResult] = await Promise.all([
      this.#git(['diff', '--name-only', '-z', '--find-renames', comparison, '--']),
      this.#git(['diff', '--no-color', '--find-renames', comparison, '--']),
      this.#git(['rev-parse', headRef])
    ])
    const paths = prepareVisiblePaths(pathsResult.stdout)
    return {
      kind: 'local',
      id: `${comparison}:${headResult.stdout.toString('utf8').trim()}`,
      title: `${headRef} compared with ${baseRef}`,
      baseRefName: baseRef,
      headRefName: headRef,
      files: paths.map((path) => ({ path, additions: 0, deletions: 0 })),
      patch: patchResult.stdout.toString('utf8')
    }
  }

  async getCommitReview(oid: string): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    if (!/^[0-9a-f]{7,40}$/i.test(oid)) throw new Error('Commit ID is invalid.')
    await this.#git(['cat-file', '-e', `${oid}^{commit}`])
    const commitResult = await this.#git(['rev-list', '--parents', '-n', '1', oid])
    const [commitOid, firstParent] = commitResult.stdout.toString('utf8').trim().split(' ')
    if (commitOid == null) throw new Error('Commit could not be resolved.')
    const pathArgs = firstParent == null
      ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', '--find-renames', commitOid, '--']
      : ['diff', '--name-only', '-z', '--find-renames', firstParent, commitOid, '--']
    const patchArgs = firstParent == null
      ? ['show', '--format=', '--no-color', '--find-renames', commitOid, '--']
      : ['diff', '--no-color', '--find-renames', firstParent, commitOid, '--']
    const [pathsResult, patchResult, metadataResult] = await Promise.all([
      this.#git(pathArgs),
      this.#git(patchArgs),
      this.#git(['show', '-s', '--format=%h%x1f%s', commitOid])
    ])
    const [shortOid = commitOid.slice(0, 8), subject = 'Commit'] = metadataResult.stdout.toString('utf8').trim().split('\x1f')
    const paths = prepareVisiblePaths(pathsResult.stdout)
    return {
      kind: 'local',
      id: `commit:${commitOid}`,
      title: `${shortOid} ${subject}`,
      baseRefName: firstParent?.slice(0, 8) ?? 'Empty tree',
      headRefName: shortOid,
      files: paths.map((path) => ({ path, additions: 0, deletions: 0 })),
      patch: patchResult.stdout.toString('utf8')
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

  async getPullRequestReview(selector: number | string): Promise<PullRequestReview> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    const fields = 'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,updatedAt,additions,deletions,changedFiles,files'
    const [detailsResult, diffResult] = await Promise.all([
      runCommand(ghExecutable, ['pr', 'view', normalizedSelector, '--json', fields], this.#requireRoot()),
      runCommand(ghExecutable, ['pr', 'diff', normalizedSelector, '--color', 'never'], this.#requireRoot())
    ])
    const details = parseJson<PullRequestSummary & { files: PullRequestReview['files'] }>(detailsResult, 'GitHub CLI')
    const { files, ...pullRequest } = details
    return {
      kind: 'github',
      selector: normalizedSelector,
      pullRequest,
      files,
      patch: diffResult.stdout.toString('utf8')
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
    reviewEvent: string,
    body: string
  ): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const events: PullRequestReviewEvent[] = ['approve', 'comment', 'request-changes']
    if (!events.includes(reviewEvent as PullRequestReviewEvent)) {
      throw new Error('Unknown pull request review action.')
    }
    if (typeof body !== 'string') throw new Error('Pull request review body must be text.')
    const trimmedBody = body.trim()
    if (reviewEvent !== 'approve' && trimmedBody === '') {
      throw new Error('A review comment is required for this action.')
    }
    const eventFlag = reviewEvent === 'request-changes' ? '--request-changes' : `--${reviewEvent}`
    const args = ['pr', 'review', normalizedSelector, eventFlag]
    if (trimmedBody !== '') args.push('--body', trimmedBody)
    await runCommand(await getGhExecutable(), args, this.#requireRoot())
  }

  async #readHeadFile(
    path: string,
    head: string | null
  ): Promise<ReadVersion | null> {
    if (head == null) return null
    const object = `${head}:${path}`
    const cachedVersion = this.#headFileCache.get(object)
    if (cachedVersion != null) {
      this.#headFileCache.delete(object)
      this.#headFileCache.set(object, cachedVersion)
      return cachedVersion
    }

    const version = this.#loadHeadFile(object)
    if (this.#headFileCache.size >= MAX_HEAD_CACHE_ENTRIES) {
      const oldestObject = this.#headFileCache.keys().next().value
      if (oldestObject != null) this.#headFileCache.delete(oldestObject)
    }
    this.#headFileCache.set(object, version)
    return version
  }

  async #loadHeadFile(object: string): Promise<ReadVersion | null> {
    const sizeResult = await this.#gitAllowFailure(['cat-file', '-s', object])
    if (sizeResult == null) return null
    const size = Number(sizeResult.stdout.toString('utf8').trim())
    if (size > MAX_DIFF_FILE_BYTES) return { contents: null, binary: false, oversized: true }

    const contents = (await this.#git(['cat-file', '-p', object])).stdout
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
      this.#headFileCache.clear()
    }
    this.#snapshot = snapshot
    this.#pathSet = new Set(snapshot.paths)
    this.#statusByPath = new Map(snapshot.statuses.map((status) => [status.path, status]))
  }

  #cancelActiveSearch(): void {
    this.#activeSearch?.kill()
    this.#activeSearch = null
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
