import { describe, expect, it } from 'bun:test'

import type { RepositorySnapshot } from './contracts.js'
import { sessionWorkspaceStage } from './sessionRestore.js'
import {
  MAX_CACHED_FILE_CHARS,
  MAX_CACHED_PATHS,
  cachedFileTextFromComparison,
  capWorkspaceCache,
  comparisonFromCachedText,
  comparisonWithoutOpenSession,
  idleFileComparison,
  initialWorkspacePaint,
  mergeWorkspaceCache,
  parseWorkspaceCache,
  parseWorkspaceUi
} from './workspaceCache.js'

const snapshot = (paths: string[] = ['src/a.ts', 'src/b.ts']): RepositorySnapshot => ({
  root: '/work/horus',
  name: 'horus',
  kind: 'git',
  branch: 'main',
  head: 'abc123',
  paths,
  statuses: [{ path: 'src/a.ts', status: 'modified' }]
})

const cache = {
  version: 1 as const,
  lastRoot: '/work/horus',
  snapshot: snapshot(),
  selectedPath: 'src/a.ts',
  workspaceView: 'file' as const,
  fileText: { path: 'src/a.ts', text: 'export const a = 1\n' },
  savedAt: 1
}

describe('parseWorkspaceCache', () => {
  it('round-trips a complete cache', () => {
    expect(parseWorkspaceCache(cache)).toEqual(cache)
  })

  it('returns null for corrupt or version-mismatched JSON', () => {
    expect(parseWorkspaceCache(null)).toBeNull()
    expect(parseWorkspaceCache('{"lastRoot":"/work"}')).toBeNull()
    expect(parseWorkspaceCache({ ...cache, version: 2 })).toBeNull()
    expect(parseWorkspaceCache({ ...cache, snapshot: { root: '/work' } })).toBeNull()
  })

  it('drops a selected path that is no longer in the tree', () => {
    expect(parseWorkspaceCache({
      ...cache,
      selectedPath: 'gone.ts',
      fileText: { path: 'gone.ts', text: 'stale' }
    })).toMatchObject({
      selectedPath: null,
      fileText: null
    })
  })
})

describe('capWorkspaceCache', () => {
  it('caps huge path lists and file text', () => {
    const paths = Array.from({ length: MAX_CACHED_PATHS + 50 }, (_unused, index) => `f${index}.ts`)
    const capped = capWorkspaceCache({
      ...cache,
      snapshot: snapshot(paths),
      selectedPath: 'f0.ts',
      fileText: { path: 'f0.ts', text: 'x'.repeat(MAX_CACHED_FILE_CHARS + 20) }
    })
    expect(capped.snapshot.paths).toHaveLength(MAX_CACHED_PATHS)
    expect(capped.fileText?.text).toHaveLength(MAX_CACHED_FILE_CHARS)
    expect(capped.selectedPath).toBe('f0.ts')
  })
})

describe('initialWorkspacePaint', () => {
  it('uses the cached snapshot so first paint is real names, not a skeleton', () => {
    const paint = initialWorkspacePaint(cache)
    expect(paint.snapshot?.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(paint.selectedPath).toBe('src/a.ts')
    expect(paint.workspaceView).toBe('file')
    expect(paint.fileText).toEqual(cache.fileText)
  })

  it('is empty when there is no cache', () => {
    expect(initialWorkspacePaint(null)).toEqual({
      snapshot: null,
      selectedPath: null,
      workspaceView: 'file',
      fileText: null
    })
  })

  it('first paint with a cache is a workspace, not an opening skeleton', () => {
    const paint = initialWorkspacePaint(cache)
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: paint.snapshot,
      restorePending: true,
      pullRequestPending: false
    })).toBe('workspace')
  })
})

describe('cached file text', () => {
  it('rebuilds a file comparison from cached text', () => {
    expect(comparisonFromCachedText({ path: 'src/a.ts', text: 'hello' })).toEqual({
      path: 'src/a.ts',
      mode: 'file',
      status: 'unchanged',
      oldFile: null,
      newFile: {
        name: 'a.ts',
        contents: 'hello',
        cacheKey: 'workspace-cache:src/a.ts'
      },
      binary: false,
      oversized: false
    })
  })

  it('returns cached text instead of throwing when no session is open', () => {
    expect(comparisonWithoutOpenSession('Makefile', { path: 'Makefile', text: 'all:\n' })).toMatchObject({
      path: 'Makefile',
      mode: 'file',
      newFile: { contents: 'all:\n' }
    })
    expect(comparisonWithoutOpenSession('README.md', { path: 'Makefile', text: 'all:\n' })).toEqual(
      idleFileComparison('README.md')
    )
  })

  it('does not persist binary or oversized comparisons', () => {
    expect(cachedFileTextFromComparison({
      path: 'src/a.ts',
      mode: 'file',
      status: 'unchanged',
      oldFile: null,
      newFile: { name: 'a.ts', contents: 'hello', cacheKey: 'k' },
      binary: true,
      oversized: false
    })).toBeNull()
  })
})

describe('mergeWorkspaceCache', () => {
  it('keeps the last UI selection when a live snapshot arrives', () => {
    const merged = mergeWorkspaceCache(snapshot(['src/a.ts', 'src/c.ts']), {
      selectedPath: 'src/a.ts',
      workspaceView: 'file',
      fileText: { path: 'src/a.ts', text: 'kept' }
    }, cache)
    expect(merged.selectedPath).toBe('src/a.ts')
    expect(merged.snapshot.paths).toEqual(['src/a.ts', 'src/c.ts'])
    expect(merged.fileText).toEqual({ path: 'src/a.ts', text: 'kept' })
  })
})

describe('parseWorkspaceUi', () => {
  it('reads a renderer UI update', () => {
    expect(parseWorkspaceUi({
      selectedPath: 'src/b.ts',
      workspaceView: 'multi',
      fileText: { path: 'src/b.ts', text: 'b' }
    })).toEqual({
      selectedPath: 'src/b.ts',
      workspaceView: 'multi',
      fileText: { path: 'src/b.ts', text: 'b' }
    })
  })
})
