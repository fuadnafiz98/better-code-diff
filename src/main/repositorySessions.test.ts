import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { runCommand } from './gitCommands.js'
import { RepositoryService } from './repository.js'
import { RepositorySessionRegistry } from './repositorySessions.js'

const directories: string[] = []
const registries: RepositorySessionRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.stopAll()
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('RepositorySessionRegistry', () => {
  it('ignores content-search cancellation until a repository is active', () => {
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)

    expect(() => registry.cancelActiveContentSearch()).not.toThrow()
    expect(registry.tryGetActive()).toBeNull()
    expect(() => registry.requireActive()).toThrow('Open a repository before using this action.')
  })

  it('cancels content search for the active repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-repository-cancel-search-'))
    directories.push(root)
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    await registry.open(root)
    const cancelContentSearch = spyOn(registry.requireActive(), 'cancelContentSearch')

    registry.cancelActiveContentSearch()

    expect(cancelContentSearch).toHaveBeenCalledTimes(1)
  })

  it('keeps independent repository sessions and changes only the requested active root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'horus-repository-sessions-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot, false)

    expect(registry.roots).toEqual([first.root, second.root])
    expect(registry.activeRoot).toBe(first.root)
    expect(registry.require(first.root)).not.toBe(registry.require(second.root))

    const activated = registry.activate(second.root)
    expect(activated.root).toBe(second.root)
    expect(registry.activeRoot).toBe(second.root)
  })

  it('reuses a registered root without changing focus for a background open', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'horus-repository-reuse-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot)
    const reopened = await registry.open(firstRoot, false)

    expect(reopened.root).toBe(first.root)
    expect(registry.activeRoot).toBe(second.root)
    expect(registry.require(reopened.root)).toBe(registry.require(first.root))
  })

  it('releases an unused repository session without disturbing another root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'horus-repository-release-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot)
    const firstRepository = registry.require(first.root)
    const dispose = spyOn(firstRepository, 'dispose')
    registry.release(first.root)

    expect(registry.roots).toEqual([second.root])
    expect(registry.activeRoot).toBe(second.root)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(registry.tryGet(first.root)).toBeNull()
    expect(() => registry.require(first.root)).toThrow('The repository tab is no longer open.')
    expect(registry.require(second.root).getSessionSnapshot()?.root).toBe(second.root)
  })

  it('trims the caches of repositories that become inactive', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'horus-repository-trim-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    const contents = Buffer.alloc(1_500_000, 97)
    const paths = Array.from({ length: 6 }, (_unused, index) => `large-${index}.txt`)
    await Promise.all(paths.map((path) => writeFile(join(firstRoot, path), contents)))

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot, false)
    const firstRepository = registry.require(first.root)
    for (const path of paths) await firstRepository.getComparison(path)

    expect(firstRepository.getHeadCacheStatsForTests().workingBytes).toBeGreaterThan(8 * 1024 * 1024)
    registry.activate(second.root)

    expect(firstRepository.getHeadCacheStatsForTests().workingBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('returns a snapshot before git status finishes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'horus-open-instant-')))
    directories.push(root)
    await writeFile(join(root, 'readme.md'), 'hello\n', 'utf8')
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)

    let release!: (snapshot: RepositorySnapshot) => void
    const hung = new Promise<RepositorySnapshot>((resolve) => {
      release = resolve
    })
    const refresh = spyOn(RepositoryService.prototype, 'refresh').mockImplementation(() => hung)

    try {
      const started = Date.now()
      const snapshot = await registry.open(root)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(snapshot.paths).toContain('readme.md')
      expect(snapshot.statuses).toEqual([])
      expect(refresh).toHaveBeenCalled()
      release(snapshot)
    } finally {
      refresh.mockRestore()
    }
  })

  it('rejects a missing folder without walking git', async () => {
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const missing = join(tmpdir(), 'horus-missing-folder-does-not-exist')
    await expect(registry.open(missing)).rejects.toThrow()
  })

  it('publishes dirty paths when the first live refresh finishes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'horus-refresh-dirty-')))
    directories.push(root)
    await runCommand('git', ['-C', root, '-c', 'init.defaultBranch=main', 'init', '--quiet'])
    await writeFile(join(root, 'clean.ts'), 'export const clean = 1\n', 'utf8')
    await writeFile(join(root, 'dirty.ts'), 'export const dirty = 1\n', 'utf8')
    await runCommand('git', ['-C', root, 'add', '--all'])
    await runCommand('git', [
      '-C', root,
      '-c', 'user.name=Horus Test',
      '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'init'
    ])
    await writeFile(join(root, 'dirty.ts'), 'export const dirty = 2\n', 'utf8')

    const events: RepositoryChangeEvent[] = []
    const registry = new RepositorySessionRegistry((event) => events.push(event), () => {})
    registries.push(registry)
    await registry.open(root)
    await registry.refreshActive()

    const published = events.filter((event) => event.changedPaths.includes('dirty.ts'))
    expect(published.length).toBeGreaterThan(0)
    expect(published.at(-1)?.changedPaths).not.toContain('clean.ts')
  })

  it('hydrates a cached snapshot so the tree is available before git refresh', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'horus-session-hydrate-')))
    directories.push(root)
    await writeFile(join(root, 'app.ts'), 'export {}\n', 'utf8')
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const cached = {
      root,
      name: 'hydrated',
      kind: 'folder' as const,
      branch: null,
      head: null,
      paths: ['app.ts'],
      statuses: []
    }

    expect(registry.hydrate(cached)).toEqual(cached)
    expect(registry.getActiveSnapshot()).toEqual(cached)
    expect(await registry.requireActive().getComparison('app.ts')).toMatchObject({
      path: 'app.ts'
    })

    const reopened = await registry.open(root)
    expect(reopened.paths).toContain('app.ts')
    expect(registry.getActiveSnapshot()?.root).toBe(reopened.root)
  })
})
