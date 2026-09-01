import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
})
