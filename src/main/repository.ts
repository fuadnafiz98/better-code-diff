import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, relative, resolve, sep } from 'node:path'

import type {
  ContentSearchResult,
  DiffFileContents,
  FileComparison,
  RepositoryFileStatus,
  RepositorySnapshot,
  RepositoryStatusEntry
} from '../shared/contracts.js'

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_HEAD_CACHE_ENTRIES = 32
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

interface CommandResult {
  stdout: Buffer
  stderr: Buffer
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
      rgPath,
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
        rgPath,
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
