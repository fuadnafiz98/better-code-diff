import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { detectRepositoryKind, listRootSnapshot, resolveExistingRoot, rootsMatch } from './workspaceListing.js'

describe('workspaceListing', () => {
  it('lists root files and one directory of children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-listing-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'README.md'), '# hi\n', 'utf8')
      await writeFile(join(root, 'src', 'a.ts'), 'export {}\n', 'utf8')
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n', 'utf8')

      const snapshot = listRootSnapshot(root)
      expect(snapshot.name).toBe(basename(root))
      expect(snapshot.kind).toBe('folder')
      expect(new Set(snapshot.paths)).toEqual(new Set(['README.md', 'src/a.ts']))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a missing folder as unusable', () => {
    expect(resolveExistingRoot('/definitely-missing-horus-folder')).toBeNull()
    expect(rootsMatch('/a', '/b')).toBe(false)
  })

  it('upgrades a cached folder listing to git when .git is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-listing-git-'))
    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'Makefile'), 'all:\n', 'utf8')
      expect(detectRepositoryKind(root)).toBe('git')
      expect(listRootSnapshot(root).kind).toBe('git')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
