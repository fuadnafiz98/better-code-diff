import { watch, type FSWatcher } from 'node:fs'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'

const CHANGE_DEBOUNCE_MS = 80
const EXCLUDED_SEGMENTS = new Set([
  '.cache', '.next', '.nuxt', '.output', '.parcel-cache', '.svelte-kit', '.turbo',
  '.vercel', '.vite', 'DerivedData', 'build', 'coverage', 'dist', 'node_modules',
  'out', 'target'
])

function normalizeChangedPath(filename: string | Buffer | null): string | null {
  if (filename == null) return '*'
  const path = filename.toString().replaceAll('\\', '/').replace(/^\.\//, '')
  if (path === '') return null
  const segments = path.split('/')
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return null
  if (segments[0] !== '.git') return path
  return path === '.git/HEAD' || path === '.git/index' || path.startsWith('.git/refs/')
    ? path
    : null
}

function statusSignature(snapshot: RepositorySnapshot): Map<string, string> {
  return new Map(snapshot.statuses.map((status) => [
    status.path,
    `${status.status}\0${status.previousPath ?? ''}`
  ]))
}

function snapshotsMatch(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  if (left.root !== right.root || left.kind !== right.kind || left.branch !== right.branch || left.head !== right.head) return false
  if (left.paths.length !== right.paths.length || left.statuses.length !== right.statuses.length) return false
  if (left.paths.some((path, index) => path !== right.paths[index])) return false
  return left.statuses.every((status, index) => {
    const other = right.statuses[index]
    return other != null
      && status.path === other.path
      && status.status === other.status
      && status.previousPath === other.previousPath
  })
}

export function collectChangedPaths(
  previous: RepositorySnapshot,
  next: RepositorySnapshot,
  filesystemPaths: ReadonlySet<string>
): string[] {
  const previousPaths = new Set(previous.paths)
  const nextPaths = new Set(next.paths)
  const previousStatuses = statusSignature(previous)
  const nextStatuses = statusSignature(next)
  const changedPaths = new Set<string>()

  for (const path of filesystemPaths) {
    if (path === '*') {
      const paths = previous.kind === 'git'
        ? new Set([...previousStatuses.keys(), ...nextStatuses.keys()])
        : new Set([...previousPaths, ...nextPaths])
      for (const visiblePath of paths) changedPaths.add(visiblePath)
    } else if (!path.startsWith('.git/') && (previousPaths.has(path) || nextPaths.has(path))) {
      changedPaths.add(path)
    } else if (!path.startsWith('.git/')) {
      const directoryPrefix = `${path.replace(/\/$/, '')}/`
      for (const visiblePath of new Set([...previousPaths, ...nextPaths])) {
        if (visiblePath.startsWith(directoryPrefix)) changedPaths.add(visiblePath)
      }
    }
  }
  for (const path of previousPaths) {
    if (!nextPaths.has(path)) changedPaths.add(path)
  }
  for (const path of nextPaths) {
    if (!previousPaths.has(path)) changedPaths.add(path)
  }
  for (const path of new Set([...previousStatuses.keys(), ...nextStatuses.keys()])) {
    if (previousStatuses.get(path) !== nextStatuses.get(path)) changedPaths.add(path)
  }
  if (previous.head !== next.head || previous.branch !== next.branch) {
    for (const path of new Set([...previousStatuses.keys(), ...nextStatuses.keys()])) {
      changedPaths.add(path)
    }
  }

  return [...changedPaths].sort()
}

export class RepositoryWatcher {
  #watcher: FSWatcher | null = null
  #snapshot: RepositorySnapshot | null = null
  #pendingPaths = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #refreshing = false
  #suspended = false
  #generation = 0
  #revision = 0

  constructor(
    private readonly refresh: () => Promise<RepositorySnapshot>,
    private readonly publish: (event: RepositoryChangeEvent) => void,
    private readonly reportError: (error: unknown) => void
  ) {}

  start(snapshot: RepositorySnapshot): void {
    this.stop()
    this.#snapshot = snapshot
    const generation = this.#generation
    try {
      this.#watcher = watch(snapshot.root, { recursive: true }, (_eventType, filename) => {
        if (generation !== this.#generation) return
        const path = normalizeChangedPath(filename)
        if (path == null) return
        this.#pendingPaths.add(path)
        this.#schedule(generation)
      })
      this.#watcher.on('error', this.reportError)
    } catch (error) {
      this.reportError(error)
    }
  }

  sync(snapshot: RepositorySnapshot): void {
    if (this.#snapshot?.root === snapshot.root) this.#snapshot = snapshot
  }

  setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) return
    this.#suspended = suspended
    if (suspended) {
      if (this.#timer != null) clearTimeout(this.#timer)
      this.#timer = null
    } else if (this.#pendingPaths.size > 0) {
      this.#schedule(this.#generation)
    }
  }

  stop(): void {
    this.#generation += 1
    this.#watcher?.close()
    this.#watcher = null
    this.#snapshot = null
    this.#pendingPaths.clear()
    if (this.#timer != null) clearTimeout(this.#timer)
    this.#timer = null
  }

  #schedule(generation: number): void {
    if (this.#suspended) return
    if (this.#timer != null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#flush(generation)
    }, CHANGE_DEBOUNCE_MS)
  }

  async #flush(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#snapshot == null || this.#suspended) return
    if (this.#refreshing) {
      this.#schedule(generation)
      return
    }

    const previous = this.#snapshot
    const filesystemPaths = new Set(this.#pendingPaths)
    const previousPathSet = new Set(previous.paths)
    this.#pendingPaths.clear()
    this.#refreshing = true
    try {
      const knownContentPaths = [...filesystemPaths].filter((path) =>
        path !== '*' && !path.startsWith('.git/') && previousPathSet.has(path)
      )
      const knownContentPathSet = new Set(knownContentPaths)
      if (knownContentPaths.length > 0) this.#publish(previous, knownContentPaths)

      const snapshot = await this.refresh()
      if (generation !== this.#generation) return
      this.#snapshot = snapshot
      const previousStatus = statusSignature(previous)
      const nextStatus = statusSignature(snapshot)
      const metadataPaths = collectChangedPaths(previous, snapshot, filesystemPaths)
        .filter((path) =>
          !knownContentPathSet.has(path) || previousStatus.get(path) !== nextStatus.get(path)
        )
      if (!snapshotsMatch(previous, snapshot) || metadataPaths.length > 0) {
        this.#publish(snapshot, metadataPaths)
      }
    } catch (error) {
      if (generation === this.#generation) this.reportError(error)
    } finally {
      this.#refreshing = false
      if (generation === this.#generation && this.#pendingPaths.size > 0) this.#schedule(generation)
    }
  }

  #publish(snapshot: RepositorySnapshot, changedPaths: string[]): void {
    this.#revision += 1
    this.publish({ snapshot, changedPaths, revision: this.#revision })
  }
}
