import type { FileComparison, RepositorySnapshot, RepositoryStatusEntry } from './contracts.js'

export const WORKSPACE_CACHE_VERSION = 1
export const MAX_CACHED_PATHS = 20_000
export const MAX_CACHED_STATUSES = 4_000
export const MAX_CACHED_FILE_CHARS = 512 * 1024
export const MAX_WORKSPACE_CACHE_BYTES = 2 * 1024 * 1024

export type CachedWorkspaceView = 'file' | 'multi'

export interface CachedFileText {
  path: string
  text: string
}

export interface WorkspaceCache {
  version: typeof WORKSPACE_CACHE_VERSION
  lastRoot: string
  snapshot: RepositorySnapshot
  selectedPath: string | null
  workspaceView: CachedWorkspaceView
  fileText: CachedFileText | null
  savedAt: number
}

export interface WorkspaceUiState {
  selectedPath: string | null
  workspaceView: CachedWorkspaceView
  fileText: CachedFileText | null
}

export interface InitialWorkspacePaint {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: CachedWorkspaceView
  fileText: CachedFileText | null
}

const EMPTY_PAINT: InitialWorkspacePaint = {
  snapshot: null,
  selectedPath: null,
  workspaceView: 'file',
  fileText: null
}

export function parseWorkspaceCache(raw: unknown): WorkspaceCache | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (record.version !== WORKSPACE_CACHE_VERSION) return null
  if (typeof record.lastRoot !== 'string' || record.lastRoot === '') return null
  const snapshot = parseCachedSnapshot(record.snapshot)
  if (snapshot == null) return null
  if (snapshot.root !== record.lastRoot) snapshot.root = record.lastRoot
  const selectedPath = parseSelectedPath(record.selectedPath, snapshot.paths)
  const fileText = parseCachedFileText(record.fileText)
  return capWorkspaceCache({
    version: WORKSPACE_CACHE_VERSION,
    lastRoot: record.lastRoot,
    snapshot,
    selectedPath,
    workspaceView: record.workspaceView === 'multi' ? 'multi' : 'file',
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath
      ? fileText
      : null,
    savedAt: typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0
  })
}

export function parseWorkspaceUi(raw: unknown): WorkspaceUiState | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  const selectedPath = typeof record.selectedPath === 'string' && record.selectedPath !== ''
    ? record.selectedPath
    : null
  return {
    selectedPath,
    workspaceView: record.workspaceView === 'multi' ? 'multi' : 'file',
    fileText: parseCachedFileText(record.fileText)
  }
}

export function capWorkspaceCache(cache: WorkspaceCache): WorkspaceCache {
  let snapshot = capSnapshot(cache.snapshot)
  let fileText = capFileText(cache.fileText)
  let selectedPath = parseSelectedPath(cache.selectedPath, snapshot.paths)
  let next: WorkspaceCache = {
    ...cache,
    version: WORKSPACE_CACHE_VERSION,
    snapshot,
    selectedPath,
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath ? fileText : null
  }
  if (workspaceCacheBytes(next) <= MAX_WORKSPACE_CACHE_BYTES) return next
  next = { ...next, fileText: null }
  if (workspaceCacheBytes(next) <= MAX_WORKSPACE_CACHE_BYTES) return next
  let paths = next.snapshot.paths
  while (paths.length > 0 && workspaceCacheBytes(next) > MAX_WORKSPACE_CACHE_BYTES) {
    paths = paths.slice(0, Math.max(1, Math.floor(paths.length / 2)))
    snapshot = { ...next.snapshot, paths, statuses: next.snapshot.statuses.filter((entry) => paths.includes(entry.path)) }
    selectedPath = parseSelectedPath(next.selectedPath, paths)
    next = { ...next, snapshot, selectedPath }
  }
  return next
}

export function workspaceCacheBytes(cache: WorkspaceCache): number {
  return new TextEncoder().encode(JSON.stringify(cache)).length
}

export function initialWorkspacePaint(cache: WorkspaceCache | null): InitialWorkspacePaint {
  if (cache == null) return EMPTY_PAINT
  const selectedPath = parseSelectedPath(cache.selectedPath, cache.snapshot.paths)
    ?? cache.snapshot.paths[0]
    ?? null
  return {
    snapshot: cache.snapshot,
    selectedPath,
    workspaceView: cache.workspaceView,
    fileText: cache.fileText != null && cache.fileText.path === selectedPath ? cache.fileText : null
  }
}

export function idleFileComparison(path: string): FileComparison {
  return {
    path,
    mode: 'file',
    status: 'unchanged',
    oldFile: null,
    newFile: null,
    binary: false,
    oversized: false
  }
}

export function comparisonFromCachedText(fileText: CachedFileText | null): FileComparison | null {
  if (fileText == null || fileText.text === '') return null
  const name = fileText.path.slice(fileText.path.lastIndexOf('/') + 1) || fileText.path
  return {
    path: fileText.path,
    mode: 'file',
    status: 'unchanged',
    oldFile: null,
    newFile: {
      name,
      contents: fileText.text,
      cacheKey: `workspace-cache:${fileText.path}`
    },
    binary: false,
    oversized: false
  }
}

/** Used when the renderer asks for a file before hydrate/open has a session. */
export function comparisonWithoutOpenSession(
  path: string,
  fileText: CachedFileText | null
): FileComparison {
  if (fileText != null && fileText.path === path) {
    return comparisonFromCachedText(fileText) ?? idleFileComparison(path)
  }
  return idleFileComparison(path)
}

export function cachedFileTextFromComparison(comparison: FileComparison | null): CachedFileText | null {
  const text = comparison?.newFile?.contents
  if (comparison == null || text == null || text === '' || comparison.binary || comparison.oversized) {
    return null
  }
  if (text.length > MAX_CACHED_FILE_CHARS) return null
  return { path: comparison.path, text }
}

export function mergeWorkspaceCache(
  snapshot: RepositorySnapshot,
  ui: WorkspaceUiState | null,
  previous: WorkspaceCache | null
): WorkspaceCache {
  const selectedPath = parseSelectedPath(ui?.selectedPath ?? previous?.selectedPath, snapshot.paths)
  const fileText = ui?.fileText !== undefined
    ? ui.fileText
    : previous?.fileText ?? null
  return capWorkspaceCache({
    version: WORKSPACE_CACHE_VERSION,
    lastRoot: snapshot.root,
    snapshot,
    selectedPath,
    workspaceView: ui?.workspaceView ?? previous?.workspaceView ?? defaultWorkspaceView(snapshot),
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath ? fileText : null,
    savedAt: Date.now()
  })
}

export function defaultWorkspaceView(snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses'>): CachedWorkspaceView {
  return snapshot.kind === 'git' && snapshot.statuses.length > 0 ? 'multi' : 'file'
}

function parseCachedSnapshot(raw: unknown): RepositorySnapshot | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.root !== 'string' || record.root === '') return null
  if (typeof record.name !== 'string' || record.name === '') return null
  if (record.kind !== 'git' && record.kind !== 'folder') return null
  if (!Array.isArray(record.paths)) return null
  const paths = uniqueStrings(record.paths, MAX_CACHED_PATHS)
  return {
    root: record.root,
    name: record.name,
    kind: record.kind,
    branch: typeof record.branch === 'string' && record.branch !== '' ? record.branch : null,
    head: typeof record.head === 'string' && record.head !== '' ? record.head : null,
    paths,
    statuses: parseStatuses(record.statuses, paths)
  }
}

function parseStatuses(raw: unknown, paths: readonly string[]): RepositoryStatusEntry[] {
  if (!Array.isArray(raw)) return []
  const allowed = new Set(paths)
  const statuses: RepositoryStatusEntry[] = []
  for (const entry of raw) {
    if (statuses.length >= MAX_CACHED_STATUSES) break
    if (typeof entry !== 'object' || entry == null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.path !== 'string' || !allowed.has(record.path)) continue
    if (!isStatus(record.status)) continue
    statuses.push({
      path: record.path,
      status: record.status,
      ...(typeof record.previousPath === 'string' && record.previousPath !== ''
        ? { previousPath: record.previousPath }
        : {})
    })
  }
  return statuses
}

function isStatus(value: unknown): value is RepositoryStatusEntry['status'] {
  return value === 'added'
    || value === 'conflicted'
    || value === 'deleted'
    || value === 'modified'
    || value === 'renamed'
    || value === 'untracked'
}

function parseSelectedPath(raw: unknown, paths: readonly string[]): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  return paths.includes(raw) ? raw : null
}

function parseCachedFileText(raw: unknown): CachedFileText | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') return null
  if (typeof record.text !== 'string') return null
  return capFileText({ path: record.path, text: record.text })
}

function capSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  const paths = snapshot.paths.slice(0, MAX_CACHED_PATHS)
  const allowed = new Set(paths)
  return {
    ...snapshot,
    paths,
    statuses: snapshot.statuses.filter((entry) => allowed.has(entry.path)).slice(0, MAX_CACHED_STATUSES)
  }
}

function capFileText(fileText: CachedFileText | null): CachedFileText | null {
  if (fileText == null) return null
  if (fileText.text.length <= MAX_CACHED_FILE_CHARS) return fileText
  return { path: fileText.path, text: fileText.text.slice(0, MAX_CACHED_FILE_CHARS) }
}

function uniqueStrings(values: readonly unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of values) {
    if (paths.length >= limit) break
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    paths.push(value)
  }
  return paths
}
