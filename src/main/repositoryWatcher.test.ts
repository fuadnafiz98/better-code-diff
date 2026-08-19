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

// A recursive fs.watch is armed asynchronously on macOS (it is backed by an
// FSEvents stream), so a write issued right after start() can land before the
// stream is listening and is then never reported at all. Waiting longer cannot
// recover a missed event, so these tests rewrite until one is observed instead.
const WATCH_SETTLE_MS = 150
const WATCH_ATTEMPTS = 30
const WATCH_TEST_TIMEOUT_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt += 1) {
    if (satisfied()) return true
    await sleep(WATCH_SETTLE_MS)
  }
  return satisfied()
}

async function rewriteUntil(file: string, satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt += 1) {
    await writeFile(file, `revision ${attempt}\n`, 'utf8')
    // Each write restarts the watcher's debounce, so settling has to outlast it
    // or the flush never gets a chance to run.
    await sleep(WATCH_SETTLE_MS)
    if (satisfied()) return true
  }
  return satisfied()
}

// Publishes triggered by the arming writes may still be in flight, and one
// landing later would corrupt whatever the test asserts next.
async function waitForQuiet(count: () => number): Promise<void> {
  let previous = -1
  while (previous !== count()) {
    previous = count()
    await sleep(WATCH_SETTLE_MS)
  }
}

describe('RepositoryWatcher', () => {
  it('publishes a targeted event after an existing file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'better-code-diff-watcher-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    const events: RepositoryChangeEvent[] = []
    const errors: unknown[] = []
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => events.push(event),
      (error) => errors.push(error)
    )
    const targeted = (): RepositoryChangeEvent | undefined =>
      events.find((event) => event.changedPaths.includes('src/existing.ts'))

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      const file = join(sourceDirectory, 'existing.ts')
      await writeFile(file, 'first\n', 'utf8')
      watcher.start(current)

      expect(await rewriteUntil(file, () => targeted() != null)).toBe(true)
      expect(errors).toEqual([])
      expect(targeted()?.changedPaths).toEqual(['src/existing.ts'])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)

  it('coalesces file changes while suspended and publishes after resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'better-code-diff-watcher-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    const events: RepositoryChangeEvent[] = []
    const errors: unknown[] = []
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => events.push(event),
      (error) => errors.push(error)
    )

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      const file = join(sourceDirectory, 'existing.ts')
      await writeFile(file, 'first\n', 'utf8')
      watcher.start(current)

      // Suspending a watcher that was never armed would make the assertions
      // below pass for the wrong reason, so prove it is live first.
      expect(await rewriteUntil(file, () => events.length > 0)).toBe(true)
      await waitForQuiet(() => events.length)

      watcher.setSuspended(true)
      events.length = 0
      await writeFile(file, 'while suspended\n', 'utf8')
      await sleep(WATCH_SETTLE_MS * 2)
      expect(events).toEqual([])

      watcher.setSuspended(false)
      expect(await waitFor(() => events.length > 0)).toBe(true)
      expect(events[0]?.changedPaths).toEqual(['src/existing.ts'])
      expect(errors).toEqual([])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)
})
