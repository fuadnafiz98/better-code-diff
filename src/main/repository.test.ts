import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import { mapGitStatus, parsePorcelainStatus, RepositoryService } from './repository.js'

const executeFile = promisify(execFile)

async function runGit(repositoryPath: string, ...args: string[]): Promise<void> {
  await executeFile('git', ['-C', repositoryPath, ...args])
}

describe('mapGitStatus', () => {
  it('maps index and working tree states to explorer states', () => {
    expect(mapGitStatus('?', '?')).toBe('untracked')
    expect(mapGitStatus('R', ' ')).toBe('renamed')
    expect(mapGitStatus(' ', 'D')).toBe('deleted')
    expect(mapGitStatus('M', 'M')).toBe('modified')
  })
})

describe('parsePorcelainStatus', () => {
  it('parses NUL-delimited paths and rename origins', () => {
    const output = Buffer.from(' M src/value.ts\0?? notes.txt\0R  src/new.ts\0src/old.ts\0')

    expect(parsePorcelainStatus(output)).toEqual([
      { path: 'src/value.ts', status: 'modified' },
      { path: 'notes.txt', status: 'untracked' },
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' }
    ])
  })
})

describe('RepositoryService', () => {
  it('loads status, file comparisons, and ripgrep content results', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'tracked.txt'), 'original value\n', 'utf8')
      await runGit(repositoryPath, 'add', 'tracked.txt')
      await runGit(
        repositoryPath,
        '-c',
        'user.name=Better Code Diff Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Initial commit'
      )
      await writeFile(join(repositoryPath, 'tracked.txt'), 'updated searchable value\n', 'utf8')
      await writeFile(join(repositoryPath, 'untracked.txt'), 'another searchable value\n', 'utf8')
      await mkdir(join(repositoryPath, '.next'))
      await writeFile(join(repositoryPath, '.next', 'generated.js'), 'generated searchable value\n', 'utf8')

      const repository = new RepositoryService()
      const snapshot = await repository.open(repositoryPath)
      const comparison = await repository.getComparison('tracked.txt')
      const searchResults = await repository.searchContent('searchable')

      expect(snapshot.kind).toBe('git')
      expect(snapshot.paths).toEqual(['tracked.txt', 'untracked.txt'])
      expect(snapshot.statuses).toEqual([
        { path: 'tracked.txt', status: 'modified' },
        { path: 'untracked.txt', status: 'untracked' }
      ])
      expect(comparison.oldFile?.contents).toBe('original value\n')
      expect(comparison.newFile?.contents).toBe('updated searchable value\n')
      expect(comparison.mode).toBe('diff')
      expect(searchResults.map((result) => result.path).sort()).toEqual([
        'tracked.txt',
        'untracked.txt'
      ])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('opens and searches an ordinary folder without Git metadata', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'better-code-diff-folder-test-'))

    try {
      await mkdir(join(folderPath, 'src'))
      await mkdir(join(folderPath, 'node_modules'))
      await mkdir(join(folderPath, 'dist'))
      await writeFile(join(folderPath, 'README.md'), 'ordinary folder\n', 'utf8')
      await writeFile(join(folderPath, 'src', 'value.ts'), 'export const searchable = true\n', 'utf8')
      await writeFile(join(folderPath, 'node_modules', 'dependency.js'), 'dependency searchable\n', 'utf8')
      await writeFile(join(folderPath, 'dist', 'bundle.js'), 'bundle searchable\n', 'utf8')

      const repository = new RepositoryService()
      const snapshot = await repository.open(folderPath)
      const comparison = await repository.getComparison('src/value.ts')
      const searchResults = await repository.searchContent('searchable')

      expect(snapshot.kind).toBe('folder')
      expect(snapshot.branch).toBeNull()
      expect(snapshot.paths).toEqual(['README.md', 'src/value.ts'])
      expect(snapshot.statuses).toEqual([])
      expect(comparison.mode).toBe('file')
      expect(comparison.oldFile).toBeNull()
      expect(comparison.newFile?.contents).toBe('export const searchable = true\n')
      expect(searchResults).toMatchObject([{ path: 'src/value.ts', line: 1 }])
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('opens an empty ordinary folder', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'better-code-diff-empty-folder-test-'))

    try {
      const repository = new RepositoryService()
      const snapshot = await repository.open(folderPath)

      expect(snapshot.kind).toBe('folder')
      expect(snapshot.paths).toEqual([])
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })
})
