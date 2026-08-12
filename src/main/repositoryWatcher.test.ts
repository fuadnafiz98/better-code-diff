import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { collectChangedPaths, RepositoryWatcher } from './repositoryWatcher.js'

function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    root: '/repo',
    name: 'repo',
    kind: 'git',
    branch: 'main',
    head: 'abc',
    paths: ['src/existing.ts'],
    statuses: [{ path: 'src/existing.ts', status: 'modified' }],
    ...overrides
  }
}

describe('collectChangedPaths', () => {
  it('keeps a direct content edit targeted to its file', () => {
    const current = snapshot()
    expect(collectChangedPaths(current, current, new Set(['src/existing.ts'])))
      .toEqual(['src/existing.ts'])
  })

  it('detects new files and Git status changes', () => {
    const previous = snapshot({ paths: [], statuses: [] })
    const next = snapshot({
      paths: ['src/new.ts'],
      statuses: [{ path: 'src/new.ts', status: 'untracked' }]
    })
    expect(collectChangedPaths(previous, next, new Set(['src/new.ts'])))
      .toEqual(['src/new.ts'])
  })

  it('invalidates changed files when HEAD moves', () => {
    const previous = snapshot()
    const next = snapshot({ head: 'def' })
    expect(collectChangedPaths(previous, next, new Set(['.git/HEAD'])))
      .toEqual(['src/existing.ts'])
  })
})

describe('RepositoryWatcher', () => {
  it('publishes a targeted event after an existing file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'better-code-diff-watcher-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    let resolveEvent!: (event: RepositoryChangeEvent) => void
    let rejectEvent!: (error: unknown) => void
    const watcherEvents = new Promise<RepositoryChangeEvent>((resolve, reject) => {
      resolveEvent = resolve
      rejectEvent = reject
    })
    const timeout = setTimeout(() => rejectEvent(new Error('Watcher event timed out.')), 2_000)
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => {
        if (!event.changedPaths.includes('src/existing.ts')) return
        clearTimeout(timeout)
        resolveEvent(event)
      },
      rejectEvent
    )

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      await writeFile(join(sourceDirectory, 'existing.ts'), 'first\n', 'utf8')
      watcher.start(current)
      await writeFile(join(sourceDirectory, 'existing.ts'), 'second\n', 'utf8')
      expect((await watcherEvents).changedPaths).toEqual(['src/existing.ts'])
    } finally {
      clearTimeout(timeout)
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
