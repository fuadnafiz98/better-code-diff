import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import {
  createPullRequestReviewPayload,
  isSameGitHubLogin,
  mapGitStatus,
  normalizePullRequestSelector,
  parsePorcelainStatus,
  RepositoryService,
  resolvePackagedExecutablePath
} from './repository.js'

describe('isSameGitHubLogin', () => {
  it('compares GitHub logins without case sensitivity', () => {
    expect(isSameGitHubLogin('PierreComputer', 'pierrecomputer')).toBe(true)
    expect(isSameGitHubLogin('reviewer', 'author')).toBe(false)
  })
})

describe('resolvePackagedExecutablePath', () => {
  it('moves packaged executables outside the asar archive', () => {
    expect(resolvePackagedExecutablePath('/Applications/App.app/Contents/Resources/app.asar/node_modules/rg'))
      .toBe('/Applications/App.app/Contents/Resources/app.asar.unpacked/node_modules/rg')
    expect(resolvePackagedExecutablePath('/workspace/node_modules/rg')).toBe('/workspace/node_modules/rg')
  })
})

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

describe('normalizePullRequestSelector', () => {
  it('accepts a selector that was normalized while opening the review', () => {
    const storedSelector = normalizePullRequestSelector(123)

    expect(storedSelector).toBe('123')
    expect(normalizePullRequestSelector(storedSelector)).toBe('123')
  })

  it('normalizes hash-prefixed PR numbers', () => {
    expect(normalizePullRequestSelector(' #123 ')).toBe('123')
  })

  it('rejects invalid numeric selectors', () => {
    expect(() => normalizePullRequestSelector('0')).toThrow('positive integer')
  })
})

describe('createPullRequestReviewPayload', () => {
  it('creates a GitHub review with an inline range comment', () => {
    expect(createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'request-changes', 'Please update this.', [{
      path: 'src/value.ts',
      body: 'This range needs a guard.',
      line: 14,
      side: 'RIGHT',
      startLine: 11,
      startSide: 'RIGHT'
    }])).toEqual({
      commitOID: '0123456789abcdef0123456789abcdef01234567',
      event: 'REQUEST_CHANGES',
      body: 'Please update this.',
      threads: [{
        path: 'src/value.ts',
        body: 'This range needs a guard.',
        line: 14,
        side: 'RIGHT',
        startLine: 11,
        startSide: 'RIGHT'
      }]
    })
  })

  it('allows requested changes without a summary when an inline comment exists', () => {
    expect(createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'request-changes', '', [{
      path: 'src/value.ts',
      body: 'Please guard this branch.',
      line: 14,
      side: 'RIGHT'
    }])).toEqual({
      commitOID: '0123456789abcdef0123456789abcdef01234567',
      event: 'REQUEST_CHANGES',
      threads: [{
        path: 'src/value.ts',
        body: 'Please guard this branch.',
        line: 14,
        side: 'RIGHT'
      }]
    })
  })

  it('rejects an empty requested-changes review', () => {
    expect(() => createPullRequestReviewPayload(
      '0123456789abcdef0123456789abcdef01234567',
      'request-changes',
      '',
      []
    )).toThrow('summary or at least one inline comment')
  })

  it('rejects unsafe inline paths', () => {
    expect(() => createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'approve', '', [{
      path: '../secret.txt',
      body: 'Do not expose this.',
      line: 1,
      side: 'RIGHT'
    }])).toThrow('invalid path')
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
      const workingTreePatch = await repository.getWorkingTreePatch(['tracked.txt', 'untracked.txt'])
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
      expect(workingTreePatch).toContain('-original value')
      expect(workingTreePatch).toContain('+updated searchable value')
      expect(workingTreePatch).toContain('+another searchable value')
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

  it('loads local Git history and compares branches without checkout', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-branch-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'value.txt'), 'base\n', 'utf8')
      await runGit(repositoryPath, 'add', 'value.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'value.txt'), 'base\nfeature\n', 'utf8')
      await runGit(repositoryPath, 'add', 'value.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Feature')

      const repository = new RepositoryService()
      await repository.open(repositoryPath)
      const integration = await repository.getGitIntegration()
      const review = await repository.getLocalBranchReview('main', 'feature')
      const commitReview = await repository.getCommitReview(integration.commits[0]!.oid)
      const rootCommitReview = await repository.getCommitReview(integration.commits[1]!.oid)

      expect(integration.defaultBranch).toBe('main')
      expect(integration.commits.map((commit) => commit.subject)).toEqual(['Feature', 'Base'])
      expect(review.kind).toBe('local')
      expect(review.files.map((file) => file.path)).toEqual(['value.txt'])
      expect(review.patch).toContain('+feature')
      expect(commitReview.title).toContain('Feature')
      expect(commitReview.patch).toContain('+feature')
      expect(rootCommitReview.baseRefName).toBe('Empty tree')
      expect(rootCommitReview.patch).toContain('+base')
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
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
