import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { flushWorkspaceCache, loadWorkspaceCache, saveWorkspaceCache } from './workspaceCacheStore.js'

const cache = {
  version: 1 as const,
  lastRoot: '/work/horus',
  snapshot: {
    root: '/work/horus',
    name: 'horus',
    kind: 'git' as const,
    branch: 'main',
    head: 'abc',
    paths: ['src/a.ts'],
    statuses: [{ path: 'src/a.ts', status: 'modified' as const }]
  },
  selectedPath: 'src/a.ts',
  workspaceView: 'file' as const,
  fileText: { path: 'src/a.ts', text: 'export const a = 1\n' },
  savedAt: 10
}

describe('workspaceCacheStore', () => {
  it('round-trips a cache through disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horus-workspace-cache-'))
    try {
      expect(loadWorkspaceCache(directory)).toBeNull()
      await saveWorkspaceCache(directory, cache)
      await flushWorkspaceCache()
      expect(loadWorkspaceCache(directory)).toEqual(cache)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns null for corrupt JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horus-workspace-corrupt-'))
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'last-workspace.json'), '{not-json', 'utf8')
      expect(loadWorkspaceCache(directory)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
