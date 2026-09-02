import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

import type { FolderCandidate, FolderPickerCatalog } from '../shared/contracts.js'
import { displayUserPath, folderNameFromPath } from '../shared/folderPath.js'

export const DEFAULT_SCAN_ROOT_NAMES = ['Developer', 'Projects', 'src', 'code', 'work', 'repos'] as const

export const SKIPPED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'DerivedData',
  'Pods',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv'
])

const MAX_FOLDERS = 400
const MAX_DEPTH = 4
const CACHE_TTL_MS = 30_000

export function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export async function collectFolderCandidates(
  home: string,
  extraRoots: readonly string[] = []
): Promise<FolderCandidate[]> {
  const resolvedHome = await safeRealpath(home) ?? home
  const found = new Map<string, FolderCandidate>()
  const scanRoots = new Set<string>()

  for (const name of DEFAULT_SCAN_ROOT_NAMES) {
    const root = join(resolvedHome, name)
    if (await isDirectory(root)) scanRoots.add(await safeRealpath(root) ?? root)
  }
  for (const extra of extraRoots) {
    const resolved = await safeRealpath(extra)
    if (resolved == null || !await isDirectory(resolved)) continue
    addCandidate(found, resolved, resolvedHome)
  }

  for (const root of scanRoots) {
    await walk(root, 0, found, resolvedHome)
    if (found.size >= MAX_FOLDERS) break
  }

  return [...found.values()].toSorted((left, right) => left.displayPath.localeCompare(right.displayPath))
}

export async function resolveOpenableFolder(
  value: unknown,
  options: { home: string; approvedRoots: readonly string[] }
): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Folder path must be absolute.')
  }
  const resolved = await realpath(value).catch(() => {
    throw new Error('That folder no longer exists.')
  })
  const info = await stat(resolved).catch(() => {
    throw new Error('That folder no longer exists.')
  })
  if (!info.isDirectory()) throw new Error('Choose a folder, not a file.')

  const home = await safeRealpath(options.home) ?? options.home
  if (resolved === home) throw new Error('Choose a project folder, not your home directory.')
  const approved = await Promise.all(options.approvedRoots.map((root) => safeRealpath(root)))
  const scanRoots = await Promise.all(
    DEFAULT_SCAN_ROOT_NAMES.map((name) => safeRealpath(join(home, name)))
  )
  const allowed = approved.some((root) => root != null && isPathInside(root, resolved))
    || scanRoots.some((root) => root != null && isPathInside(root, resolved))
  if (!allowed) {
    throw new Error('Select this folder with Use Existing… if it lives outside your usual project folders.')
  }
  return resolved
}

export class FolderIndex {
  #folders: FolderCandidate[] | null = null
  #expiresAt = 0
  #inflight: Promise<FolderCandidate[]> | null = null
  #extraRoots: readonly string[] = []

  constructor(readonly home: string) {}

  setExtraRoots(roots: readonly string[]): void {
    if (sameRoots(this.#extraRoots, roots)) return
    this.#extraRoots = [...roots]
    this.#expiresAt = 0
  }

  async list(extraRoots?: readonly string[]): Promise<FolderPickerCatalog> {
    if (extraRoots != null) this.setExtraRoots(extraRoots)
    const folders = await this.#ensure()
    return { home: this.home, folders }
  }

  async #ensure(): Promise<FolderCandidate[]> {
    if (this.#folders != null && Date.now() < this.#expiresAt) return this.#folders
    if (this.#inflight != null) return this.#inflight
    this.#inflight = collectFolderCandidates(this.home, this.#extraRoots)
      .then((folders) => {
        this.#folders = folders
        this.#expiresAt = Date.now() + CACHE_TTL_MS
        return folders
      })
      .finally(() => {
        this.#inflight = null
      })
    return this.#inflight
  }
}

function addCandidate(found: Map<string, FolderCandidate>, path: string, home: string): void {
  if (found.has(path) || found.size >= MAX_FOLDERS) return
  found.set(path, {
    name: folderNameFromPath(path),
    path,
    displayPath: displayUserPath(path, home)
  })
}

async function walk(
  directory: string,
  depth: number,
  found: Map<string, FolderCandidate>,
  home: string
): Promise<void> {
  if (depth >= MAX_DEPTH || found.size >= MAX_FOLDERS) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (found.size >= MAX_FOLDERS) return
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
    const child = join(directory, entry.name)
    const resolved = await safeRealpath(child)
    if (resolved == null) continue
    const git = await isGitDirectory(resolved)
    if (depth < 2 || git) addCandidate(found, resolved, home)
    if (!git) await walk(resolved, depth + 1, found, home)
  }
}

async function isGitDirectory(directory: string): Promise<boolean> {
  return stat(join(directory, '.git')).then(() => true).catch(() => false)
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory()).catch(() => false)
}

async function safeRealpath(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((root, index) => root === right[index])
}
