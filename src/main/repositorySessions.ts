import { realpath } from 'node:fs/promises'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { RepositoryService } from './repository.js'
import { RepositoryWatcher } from './repositoryWatcher.js'

interface RepositorySession {
  repository: RepositoryService
  watcher: RepositoryWatcher
}

export class RepositorySessionRegistry {
  #activeRoot: string | null = null
  #cacheDirectory: string | null = null
  #sessions = new Map<string, RepositorySession>()
  #suspended = false

  constructor(
    private readonly publish: (change: RepositoryChangeEvent) => void,
    private readonly reportError: (error: unknown) => void
  ) {}

  setPullRequestCacheDirectory(directory: string | null): void {
    this.#cacheDirectory = directory
    for (const { repository } of this.#sessions.values()) {
      repository.setPullRequestCacheDirectory(directory)
    }
  }

  get activeRoot(): string | null {
    return this.#activeRoot
  }

  get roots(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  getActiveSnapshot(): RepositorySnapshot | null {
    return this.#activeRoot == null
      ? null
      : this.#sessions.get(this.#activeRoot)?.repository.getSessionSnapshot() ?? null
  }

  requireActive(): RepositoryService {
    if (this.#activeRoot == null) throw new Error('Open a repository before using this action.')
    return this.require(this.#activeRoot)
  }

  cancelActiveContentSearch(): void {
    if (this.#activeRoot == null) return
    this.#sessions.get(this.#activeRoot)?.repository.cancelContentSearch()
  }

  require(root: string): RepositoryService {
    const session = this.#sessions.get(root)
    if (session == null) throw new Error('The repository tab is no longer open.')
    return session.repository
  }

  activate(root: string): RepositorySnapshot {
    const repository = this.require(root)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('Repository data is not ready.')
    this.#activeRoot = root
    return snapshot
  }

  async open(folderPath: string, activate = true): Promise<RepositorySnapshot> {
    const selectedRoot = await realpath(folderPath)
    const known = this.#sessions.get(selectedRoot)
    if (known != null) {
      if (activate) this.#activeRoot = selectedRoot
      return known.repository.getSessionSnapshot() ?? known.repository.refresh()
    }

    const repository = new RepositoryService()
    repository.setPullRequestCacheDirectory(this.#cacheDirectory)
    const snapshot = await repository.open(selectedRoot)
    const existing = this.#sessions.get(snapshot.root)
    if (existing != null) {
      if (activate) this.#activeRoot = snapshot.root
      return existing.repository.getSessionSnapshot() ?? existing.repository.refresh()
    }

    const watcher = new RepositoryWatcher(
      () => repository.refresh(),
      this.publish,
      this.reportError
    )
    repository.setSelfWriteObserver((path) => watcher.expectSelfWrite(path))
    watcher.setSuspended(this.#suspended)
    watcher.start(snapshot)
    this.#sessions.set(snapshot.root, { repository, watcher })
    if (activate) this.#activeRoot = snapshot.root
    return snapshot
  }

  sync(snapshot: RepositorySnapshot): RepositorySnapshot {
    this.#sessions.get(snapshot.root)?.watcher.sync(snapshot)
    return snapshot
  }

  release(root: string): void {
    const session = this.#sessions.get(root)
    if (session == null) return
    this.#stopSession(session)
    this.#sessions.delete(root)
    if (this.#activeRoot === root) this.#activeRoot = null
  }

  setSuspended(suspended: boolean): void {
    this.#suspended = suspended
    for (const { watcher } of this.#sessions.values()) watcher.setSuspended(suspended)
  }

  stopAll(): void {
    for (const session of this.#sessions.values()) this.#stopSession(session)
    this.#sessions.clear()
    this.#activeRoot = null
  }

  #stopSession({ repository, watcher }: RepositorySession): void {
    watcher.stop()
    repository.cancelContentSearch()
    repository.cancelPullRequestReview()
    repository.setSelfWriteObserver(null)
  }
}
