import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import type { PullRequestReview } from '../shared/contracts.js'
import { COMMAND_ABORTED_MESSAGE } from './gitCommands.js'

import {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecs,
  classifySearchCompletion,
  createNewFilePatch,
  createPullRequestReviewPayload,
  diffFilesFromChurn,
  filesFromPatch,
  GitObjectReader,
  githubRepoSlugFromRemoteUrl,
  readGitObject,
  isPathWithinApprovedRoots,
  isPullRequestDiffTooLargeError,
  isSameGitHubLogin,
  limitPatchFileSize,
  mapGitStatus,
  normalizePullRequestSelector,
  parseNumstat,
  mergeVisiblePaths,
  parsePullRequestInboxResponse,
  parsePorcelainV2Status,
  parsePullRequestConversation,
  PullRequestReviewCache,
  pullRequestReviewReply,
  pullRequestFilePageWave,
  pullRequestTargetsRemotes,
  replaceStatusEntry,
  RepositoryService,
  resolvePackagedExecutablePath,
  sectionPullRequestInbox,
  selectOversizedDiffFiles,
  summarizeCheckRollup
} from './repository.js'

const inboxPullRequest = (number: number): Record<string, unknown> => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  isDraft: false,
  author: { login: 'reviewer' },
  updatedAt: '2026-08-17T00:00:00Z'
})

describe('sectionPullRequestInbox', () => {
  it('returns every section in precedence order', () => {
    const sections = sectionPullRequestInbox([])
    expect(sections.map((section) => section.key))
      .toEqual(['review-requested', 'assigned', 'mentioned', 'authored'])
    expect(sections.every((section) => section.pullRequests.length === 0)).toBe(true)
  })

  it('keeps a pull request only in its highest-precedence section', () => {
    const sections = sectionPullRequestInbox([
      { key: 'authored', pullRequest: inboxPullRequest(7) },
      { key: 'review-requested', pullRequest: inboxPullRequest(7) },
      { key: 'assigned', pullRequest: inboxPullRequest(7) },
      { key: 'assigned', pullRequest: inboxPullRequest(9) }
    ])
    expect(sections.find((section) => section.key === 'review-requested')?.pullRequests.map((entry) => entry.number)).toEqual([7])
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests.map((entry) => entry.number)).toEqual([9])
    expect(sections.find((section) => section.key === 'authored')?.pullRequests).toEqual([])
  })

  it('drops malformed entries instead of failing', () => {
    const sections = sectionPullRequestInbox([
      { key: 'assigned', pullRequest: null },
      { key: 'assigned', pullRequest: { number: 'not-a-number' } },
      { key: 'assigned', pullRequest: { ...inboxPullRequest(3), url: 'https://evil.example/pull/3' } },
      { key: 'assigned', pullRequest: { ...inboxPullRequest(4), author: {} } },
      { key: 'assigned', pullRequest: inboxPullRequest(5) }
    ])
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests.map((entry) => entry.number)).toEqual([5])
  })
})

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

// Without this every git test reads the developer's global configuration, so a
// machine with commit signing, a hooks path, a global excludes file or an unusual
// init.defaultBranch produces different results from CI for reasons unrelated to
// the change under test.
function gitEnvironment(repositoryPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: repositoryPath
  }
}

async function runGit(repositoryPath: string, ...args: string[]): Promise<void> {
  await executeFile('git', ['-C', repositoryPath, ...args], { env: gitEnvironment(repositoryPath) })
}

async function initRepository(repositoryPath: string): Promise<void> {
  await runGit(repositoryPath, '-c', 'init.defaultBranch=main', 'init', '--quiet')
}

async function commitAll(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, 'add', '--all')
  await commitIndex(repositoryPath, message)
}

async function commitIndex(repositoryPath: string, message: string): Promise<void> {
  await runGit(
    repositoryPath,
    '-c', 'user.name=Better Code Diff Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message
  )
}

async function runGitAllowingDifferences(repositoryPath: string, ...args: string[]): Promise<string> {
  try {
    return (await executeFile('git', ['-C', repositoryPath, ...args], { env: gitEnvironment(repositoryPath) })).stdout
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? ''
  }
}

describe('mapGitStatus', () => {
  it('maps index and working tree states to explorer states', () => {
    expect(mapGitStatus('?', '?')).toBe('untracked')
    expect(mapGitStatus('R', ' ')).toBe('renamed')
    expect(mapGitStatus(' ', 'D')).toBe('deleted')
    expect(mapGitStatus('M', 'M')).toBe('modified')
  })

  it('maps unmerged combinations to conflicted', () => {
    expect(mapGitStatus('U', 'U')).toBe('conflicted')
    expect(mapGitStatus('A', 'A')).toBe('conflicted')
    expect(mapGitStatus('D', 'D')).toBe('conflicted')
    expect(mapGitStatus('A', 'U')).toBe('conflicted')
    expect(mapGitStatus('U', 'D')).toBe('conflicted')
    expect(mapGitStatus('U', 'A')).toBe('conflicted')
    expect(mapGitStatus('D', 'U')).toBe('conflicted')
  })

  it('keeps staged combinations that only look unmerged', () => {
    expect(mapGitStatus('A', 'M')).toBe('added')
    expect(mapGitStatus('M', 'D')).toBe('deleted')
    expect(mapGitStatus('A', ' ')).toBe('added')
    expect(mapGitStatus('D', ' ')).toBe('deleted')
    expect(mapGitStatus('R', 'M')).toBe('renamed')
  })
})

describe('parsePorcelainV2Status', () => {
  it('reads the branch, head, statuses, and untracked set from one call', () => {
    const output = Buffer.from([
      '# branch.oid 1a2b3c4d5e6f',
      '# branch.head main',
      '# branch.ab +1 -0',
      '1 .M N... 100644 100644 100644 aaa bbb src/value.ts',
      '1 A. N... 000000 100644 100644 000 ccc src/added.ts',
      '1 .D N... 100644 100644 000000 ddd ddd src/gone.ts',
      '? notes.txt'
    ].join('\0') + '\0')

    const status = parsePorcelainV2Status(output)
    expect(status.branch).toBe('main')
    expect(status.head).toBe('1a2b3c4d5e6f')
    expect(status.untrackedPaths).toEqual(['notes.txt'])
    expect(status.statuses).toEqual([
      { path: 'src/value.ts', status: 'modified' },
      { path: 'src/added.ts', status: 'added' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'notes.txt', status: 'untracked' }
    ])
  })

  it('pairs a rename with the original path that follows it', () => {
    const output = Buffer.from([
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      '1 .M N... 100644 100644 100644 ccc ddd src/after.ts'
    ].join('\0') + '\0')

    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' },
      { path: 'src/after.ts', status: 'modified' }
    ])
  })

  it('reports unmerged records as conflicted', () => {
    const output = Buffer.from([
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/both.ts',
      'u AA N... 100644 100644 100644 100644 aaa bbb ccc src/added.ts'
    ].join('\0') + '\0')

    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/both.ts', status: 'conflicted' },
      { path: 'src/added.ts', status: 'conflicted' }
    ])
  })

  it('keeps paths that contain spaces intact', () => {
    const output = Buffer.from('1 .M N... 100644 100644 100644 aaa bbb src/my file.ts\0')
    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/my file.ts', status: 'modified' }
    ])
  })

  it('reports a detached head and an empty repository as having no branch or oid', () => {
    const detached = parsePorcelainV2Status(Buffer.from('# branch.oid abc\0# branch.head (detached)\0'))
    expect(detached.branch).toBeNull()
    expect(detached.head).toBe('abc')

    const initial = parsePorcelainV2Status(Buffer.from('# branch.oid (initial)\0# branch.head main\0'))
    expect(initial.head).toBeNull()
    expect(initial.branch).toBe('main')
  })
})

describe('mergeVisiblePaths', () => {
  it('merges tracked and untracked paths without duplicates, sorted', () => {
    const tracked = Buffer.from('src/b.ts\0src/a.ts\0')
    expect(mergeVisiblePaths(tracked, ['notes.txt', 'src/a.ts'])).toEqual([
      'notes.txt', 'src/a.ts', 'src/b.ts'
    ])
  })

  it('drops excluded untracked paths but keeps tracked build output', () => {
    const tracked = Buffer.from('src/a.ts\0dist/app.js\0')
    expect(mergeVisiblePaths(tracked, ['node_modules/other/x.js', 'keep.txt'])).toEqual([
      'dist/app.js', 'keep.txt', 'src/a.ts'
    ])
  })

  it('keeps a file whose own name matches an excluded directory', () => {
    expect(mergeVisiblePaths(Buffer.alloc(0), ['dist', 'src/out'])).toEqual(['dist', 'src/out'])
  })
})

describe('githubRepoSlugFromRemoteUrl', () => {
  it('extracts the slug from every GitHub remote form', () => {
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre/better-code-diff')).toBe('pierre/better-code-diff')
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre/better-code-diff.git')).toBe('pierre/better-code-diff')
    expect(githubRepoSlugFromRemoteUrl('git@github.com:pierre/better-code-diff.git')).toBe('pierre/better-code-diff')
    expect(githubRepoSlugFromRemoteUrl('ssh://git@github.com/pierre/better-code-diff.git')).toBe('pierre/better-code-diff')
  })

  it('lowercases the slug and ignores surrounding space and trailing slashes', () => {
    expect(githubRepoSlugFromRemoteUrl('  https://github.com/Pierre/Better-Code-Diff/  ')).toBe('pierre/better-code-diff')
  })

  it('returns null for remotes that are not GitHub repositories', () => {
    expect(githubRepoSlugFromRemoteUrl('https://gitlab.com/pierre/better-code-diff.git')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('git@github.example.com:pierre/better-code-diff.git')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('')).toBeNull()
  })
})

describe('pullRequestTargetsRemotes', () => {
  const remotes = [
    { name: 'origin', fetchUrl: 'git@github.com:Pierre/Better-Code-Diff.git', pushUrl: 'git@github.com:Pierre/Better-Code-Diff.git' },
    { name: 'fork', fetchUrl: 'https://github.com/contributor/better-code-diff.git', pushUrl: '' }
  ]

  it('accepts a pull request hosted by one of the remotes', () => {
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/better-code-diff/pull/12')).toBe(true)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/Contributor/Better-Code-Diff/pull/12/files')).toBe(true)
  })

  it('rejects a pull request from another repository', () => {
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/attacker/better-code-diff/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/other-repository/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes([], 'https://github.com/pierre/better-code-diff/pull/12')).toBe(false)
  })

  it('rejects non-GitHub remotes and malformed pull request URLs', () => {
    const otherHost = [{ name: 'origin', fetchUrl: 'git@gitlab.com:pierre/better-code-diff.git', pushUrl: '' }]

    expect(pullRequestTargetsRemotes(otherHost, 'https://github.com/pierre/better-code-diff/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/better-code-diff/issues/12')).toBe(false)
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

  it('canonicalizes a copied GitHub URL before passing it to gh', () => {
    expect(normalizePullRequestSelector(
      'https://github.com/pierrecomputer/pierre/pull/123/files?notification_referrer_id=abc#discussion_r1'
    )).toBe('https://github.com/pierrecomputer/pierre/pull/123')
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

describe('parseNumstat', () => {
  it('parses churn, rename origins, and binary markers', () => {
    const output = Buffer.from(
      '-\t-\tassets/logo.png\x0012\t3\tsrc/value.ts\x004\t0\t\x00src/old.ts\x00src/new.ts\x00'
    )

    expect(parseNumstat(output)).toEqual([
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
      { path: 'src/value.ts', additions: 12, deletions: 3, binary: false },
      { path: 'src/new.ts', previousPath: 'src/old.ts', additions: 4, deletions: 0, binary: false }
    ])
  })
})

describe('selectOversizedDiffFiles', () => {
  it('omits high-churn files and excludes them from the diff command', () => {
    const selection = selectOversizedDiffFiles([
      { path: 'bun.lock', additions: 40_000, deletions: 30_000, binary: false },
      { path: 'src/value.ts', additions: 20, deletions: 4, binary: false },
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
      { path: 'src/new.ts', previousPath: 'src/old.ts', additions: 30_000, deletions: 0, binary: false }
    ])

    expect(selection.omittedFiles).toEqual([
      { path: 'bun.lock', reason: 'too-large', additions: 40_000, deletions: 30_000 },
      { path: 'src/new.ts', reason: 'too-large', additions: 30_000, deletions: 0 }
    ])
    expect(selection.excludePathspecs).toEqual([
      ':(exclude,literal)bun.lock',
      ':(exclude,literal)src/new.ts',
      ':(exclude,literal)src/old.ts'
    ])
  })

  it('keeps files at the churn limit and binary files of any size', () => {
    expect(selectOversizedDiffFiles([
      { path: 'generated.ts', additions: 20_000, deletions: 0, binary: false },
      { path: 'assets/movie.mov', additions: 0, deletions: 0, binary: true }
    ])).toEqual({ omittedFiles: [], excludePathspecs: [] })
  })
})

describe('diffFilesFromChurn', () => {
  it('sorts review files by path and carries their churn', () => {
    expect(diffFilesFromChurn([
      { path: 'src/value.ts', additions: 2, deletions: 1, binary: false },
      { path: 'README.md', additions: 4, deletions: 0, binary: false }
    ])).toEqual([
      { path: 'README.md', additions: 4, deletions: 0 },
      { path: 'src/value.ts', additions: 2, deletions: 1 }
    ])
  })
})

describe('pullRequestFilePageWave', () => {
  it('reads a wave of pages at a time', () => {
    expect(pullRequestFilePageWave(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(pullRequestFilePageWave(9)).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
  })

  it('stops at the ceiling the files API answers', () => {
    expect(pullRequestFilePageWave(25)).toEqual([25, 26, 27, 28, 29, 30])
    expect(pullRequestFilePageWave(31)).toEqual([])
  })

  it('treats a nonsense start page as the first one', () => {
    expect(pullRequestFilePageWave(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('isPullRequestDiffTooLargeError', () => {
  it('recognises the 406 GitHub returns for pull requests it will not diff', () => {
    expect(isPullRequestDiffTooLargeError(new Error(
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). "
      + '(https://api.github.com/repos/microsoft/TypeScript/pulls/63763) PullRequest.diff too_large'
    ))).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isPullRequestDiffTooLargeError(new Error('HTTP 404: Not Found'))).toBe(false)
    expect(isPullRequestDiffTooLargeError(new Error('gh: command not found'))).toBe(false)
  })
})

describe('buildPullRequestPatchFromFiles', () => {
  it('adds the git headers the files API leaves out', () => {
    const built = buildPullRequestPatchFromFiles([{
      filename: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-old\n+new'
    }])
    expect(built.patch).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n'
      + '--- a/src/app.ts\n'
      + '+++ b/src/app.ts\n'
      + '@@ -1 +1 @@\n-old\n+new\n'
    )
    expect(built.files).toHaveLength(1)
    expect(built.files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 })
    expect(built.files[0]?.patchHash).toMatch(/^[0-9a-f]{64}$/)
    expect(built.omittedFiles).toEqual([])
  })

  it('marks added, removed and renamed files the way git does', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'added.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+one\n' },
      { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-one\n' },
      {
        filename: 'new-name.ts',
        previous_filename: 'old-name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new\n'
      }
    ])
    expect(built.patch).toContain('diff --git a/added.ts b/added.ts\nnew file mode 100644\n--- /dev/null\n+++ b/added.ts\n')
    expect(built.patch).toContain('diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n')
    expect(built.patch).toContain(
      'diff --git a/old-name.ts b/new-name.ts\n'
      + 'rename from old-name.ts\nrename to new-name.ts\n'
      + '--- a/old-name.ts\n+++ b/new-name.ts\n'
    )
  })

  it('reports files GitHub sent without a patch instead of dropping them', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 },
      { filename: 'huge.json', status: 'modified', additions: 900, deletions: 5, patch: '' }
    ])
    expect(built.patch).toBe('')
    expect(built.files.map((file) => file.path)).toEqual(['logo.png', 'huge.json'])
    expect(built.omittedFiles).toEqual([
      { path: 'logo.png', reason: 'too-large', additions: 0, deletions: 0 },
      { path: 'huge.json', reason: 'too-large', additions: 900, deletions: 5 }
    ])
  })

  it('keeps every file GitHub listed so files and patch agree', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'dist/app.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' }
    ])
    expect(built.files.map((file) => file.path)).toEqual(['dist/app.js', 'src/app.ts'])
    expect(built.patch).toContain('dist/app.js')
  })
})

describe('streamed pull request payloads', () => {
  const review = (): PullRequestReview => ({
    kind: 'github',
    selector: '7',
    baseOid: 'base',
    headOid: 'head',
    commitId: 'head',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7,
      title: 'Large review',
      url: 'https://github.com/acme/repo/pull/7',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-30T00:00:00Z',
      additions: 60,
      deletions: 0,
      changedFiles: 60
    },
    files: Array.from({ length: 60 }, (_unused, index) => ({
      path: `src/file-${index}.ts`, additions: 1, deletions: 0
    })),
    patch: 'large patch',
    omittedFiles: [{ path: 'large.bin', reason: 'too-large', additions: 0, deletions: 0 }],
    expectedFileCount: 60
  })

  it('the streamed reply omits bytes the pages already delivered', () => {
    expect(pullRequestReviewReply(review(), true)).toMatchObject({
      files: [], patch: '', omittedFiles: [], expectedFileCount: 60
    })
  })

  it('a non-streamed cached reply keeps the full review', () => {
    const cached = review()
    expect(pullRequestReviewReply(cached, false)).toBe(cached)
  })

  it('the fast path emits multiple pages for a 60-file diff', () => {
    const patch = Array.from({ length: 60 }, (_unused, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      '@@ -0,0 +1 @@',
      `+${index}`,
      ''
    ].join('\n')).join('')
    const pages = chunkPatchByFileCount(patch)

    expect(pages).toHaveLength(3)
    expect(pages.map((page) => filesFromPatch(page).length)).toEqual([25, 25, 10])
    expect(pages.join('')).toBe(patch)
  })
})

describe('filesFromPatch', () => {
  it('recovers every file GitHub truncated out of its own list', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n',
      'diff --git a/old/name.ts b/new/name.ts\nrename from old/name.ts\nrename to new/name.ts\n--- a/old/name.ts\n+++ b/new/name.ts\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-only\n'
    ].join('')
    const files = filesFromPatch(patch)
    expect(files.map(({ path, previousPath, additions, deletions }) => ({
      path, previousPath, additions, deletions
    }))).toEqual([
      { path: 'src/a.ts', previousPath: undefined, additions: 1, deletions: 1 },
      { path: 'new/name.ts', previousPath: 'old/name.ts', additions: 1, deletions: 1 },
      { path: 'gone.ts', previousPath: undefined, additions: 0, deletions: 1 }
    ])
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.patchHash ?? ''))).toBe(true)
  })

  it('unescapes a quoted path and reports a binary section as no churn', () => {
    const patch = 'diff --git "a/dir/a\\"b-\\303\\251.ts" "b/dir/a\\"b-\\303\\251.ts"\nBinary files differ\n'
    expect(filesFromPatch(patch)[0]).toMatchObject({ path: 'dir/a"b-é.ts', additions: 0, deletions: 0 })
  })

  it('returns nothing for an empty patch', () => {
    expect(filesFromPatch('')).toEqual([])
  })
})

describe('limitPatchFileSize', () => {
  const smallSection = 'diff --git a/small.ts b/small.ts\n--- a/small.ts\n+++ b/small.ts\n@@ -1 +1 @@\n-old\n+new\n'
  const largeSection = `diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1,2 +1,3 @@\n-removed\n${
    Array.from({ length: 40 }, (_, index) => `+line ${index}`).join('\n')}\n`

  it('returns the original patch when every file fits', () => {
    const patch = `${smallSection}${largeSection}`

    expect(limitPatchFileSize(patch, 4_096)).toEqual({ patch, omittedFiles: [] })
  })

  it('drops oversized file sections and reports their churn', () => {
    const result = limitPatchFileSize(`${smallSection}${largeSection}${smallSection}`, 200)

    expect(result.patch).toBe(`${smallSection}${smallSection}`)
    expect(result.omittedFiles).toEqual([
      { path: 'large.ts', reason: 'too-large', additions: 40, deletions: 1 }
    ])
  })

  it('keeps patch metadata that precedes the first file', () => {
    const result = limitPatchFileSize(`commit metadata\n\n${largeSection}${smallSection}`, 200)

    expect(result.patch).toBe(`commit metadata\n\n${smallSection}`)
    expect(result.omittedFiles.map((file) => file.path)).toEqual(['large.ts'])
  })
})

describe('createNewFilePatch', () => {
  it('creates a unified new-file patch', () => {
    expect(createNewFilePatch('src/value.ts', 'first\nsecond\n')).toBe(
      'diff --git a/src/value.ts b/src/value.ts\n'
      + 'new file mode 100644\n'
      + '--- /dev/null\n'
      + '+++ b/src/value.ts\n'
      + '@@ -0,0 +1,2 @@\n'
      + '+first\n'
      + '+second\n'
    )
  })

  it('marks a missing trailing newline', () => {
    expect(createNewFilePatch('notes.txt', 'only line')).toBe(
      'diff --git a/notes.txt b/notes.txt\n'
      + 'new file mode 100644\n'
      + '--- /dev/null\n'
      + '+++ b/notes.txt\n'
      + '@@ -0,0 +1 @@\n'
      + '+only line\n'
      + '\\ No newline at end of file\n'
    )
  })

  it('keeps carriage returns inside the added lines', () => {
    expect(createNewFilePatch('notes.txt', 'first\r\nsecond\r\n')).toContain('+first\r\n+second\r\n')
  })

  it('emits header-only output for an empty file', () => {
    expect(createNewFilePatch('empty.txt', '')).toBe(
      'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n'
    )
  })

  it('marks binary files instead of embedding their contents', () => {
    expect(createNewFilePatch('assets/logo.png', '', true)).toBe(
      'diff --git a/assets/logo.png b/assets/logo.png\n'
      + 'new file mode 100644\n'
      + 'Binary files /dev/null and b/assets/logo.png differ\n'
    )
  })

  it('quotes paths that Git would quote', () => {
    expect(createNewFilePatch('we"ird.txt', 'value\n')).toContain(
      'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"\n'
    )
  })
})

describe('classifySearchCompletion', () => {
  const completion = {
    cancelled: false,
    code: 0,
    signal: null,
    resultCount: 4,
    errorOutput: ''
  }

  it('reports partial results from a cancelled search as an error', () => {
    expect(classifySearchCompletion({ ...completion, cancelled: true, code: null, signal: 'SIGTERM' }))
      .toEqual({ kind: 'error', message: 'The search was cancelled before it finished.' })
  })

  it('reports an externally killed search as an error', () => {
    expect(classifySearchCompletion({ ...completion, code: null, signal: 'SIGKILL' }))
      .toEqual({ kind: 'error', message: 'The search stopped before it finished.' })
  })

  it('keeps results when the search was stopped at the result cap', () => {
    expect(classifySearchCompletion({ ...completion, code: null, signal: 'SIGTERM', resultCount: 200 }))
      .toEqual({ kind: 'results' })
  })

  it('surfaces ripgrep failures', () => {
    expect(classifySearchCompletion({ ...completion, code: 2, errorOutput: 'regex parse error\n' }))
      .toEqual({ kind: 'error', message: 'regex parse error' })
  })

  it('keeps results for a clean exit and for no matches', () => {
    expect(classifySearchCompletion(completion)).toEqual({ kind: 'results' })
    expect(classifySearchCompletion({ ...completion, code: 1, resultCount: 0 })).toEqual({ kind: 'results' })
  })
})

describe('isPathWithinApprovedRoots', () => {
  const roots = ['/Users/dev/repository', '/Users/dev/other']

  it('accepts approved roots and paths inside them', () => {
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository')).toBe(true)
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository/packages/app')).toBe(true)
  })

  it('rejects unapproved roots and sibling prefixes', () => {
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository-secrets')).toBe(false)
    expect(isPathWithinApprovedRoots(roots, '/Users/dev')).toBe(false)
    expect(isPathWithinApprovedRoots([], '/Users/dev/repository')).toBe(false)
  })
})

describe('summarizeCheckRollup', () => {
  it('classifies check run entries by status and conclusion', () => {
    expect(summarizeCheckRollup([
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { __typename: 'CheckRun', name: 'perf', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'audit', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'bench', status: 'QUEUED', conclusion: null }
    ])).toEqual({ passing: 3, failing: 4, pending: 2 })
  })

  it('ignores a conclusion the check run has not reached yet', () => {
    expect(summarizeCheckRollup([
      { status: 'IN_PROGRESS', conclusion: 'SUCCESS' }
    ])).toEqual({ passing: 0, failing: 0, pending: 1 })
  })

  it('classifies status context entries by state', () => {
    expect(summarizeCheckRollup([
      { __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/test', state: 'FAILURE' },
      { __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/lint', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/docs', state: 'EXPECTED' }
    ])).toEqual({ passing: 1, failing: 2, pending: 2 })
  })

  it('summarizes a mixed rollup', () => {
    expect(summarizeCheckRollup([
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'PENDING' },
      { __typename: 'StatusContext', state: 'FAILURE' },
      { __typename: 'CheckRun', status: 'QUEUED' }
    ])).toEqual({ passing: 1, failing: 1, pending: 2 })
  })

  it('treats unknown result tokens as pending', () => {
    expect(summarizeCheckRollup([{ state: 'STALE' }, { status: 'COMPLETED' }])).toEqual({
      passing: 0,
      failing: 0,
      pending: 2
    })
  })

  it('matches result tokens case insensitively', () => {
    expect(summarizeCheckRollup([
      { status: 'completed', conclusion: 'success' },
      { state: ' failure ' },
      { status: 'in_progress' }
    ])).toEqual({ passing: 1, failing: 1, pending: 1 })
  })

  it('returns zero counts for an empty rollup', () => {
    expect(summarizeCheckRollup([])).toEqual({ passing: 0, failing: 0, pending: 0 })
  })

  it('ignores malformed entries', () => {
    expect(summarizeCheckRollup([
      null,
      'SUCCESS',
      7,
      {},
      { status: '', conclusion: '   ' },
      { name: 'build' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' }
    ])).toEqual({ passing: 1, failing: 0, pending: 0 })
  })

  it('returns null when the rollup is absent or not an array', () => {
    expect(summarizeCheckRollup(null)).toBeNull()
    expect(summarizeCheckRollup(undefined)).toBeNull()
    expect(summarizeCheckRollup('SUCCESS')).toBeNull()
    expect(summarizeCheckRollup({ nodes: [] })).toBeNull()
  })
})

describe('chunkPathspecs', () => {
  it('keeps a small list in one chunk and preserves order across chunks', () => {
    expect(chunkPathspecs(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']])
    expect(chunkPathspecs(['aaa', 'bbb', 'ccc'], 8)).toEqual([['aaa', 'bbb'], ['ccc']])
  })

  it('never drops a path that is longer than the budget on its own', () => {
    expect(chunkPathspecs(['short', 'a-very-long-path'], 8)).toEqual([['short'], ['a-very-long-path']])
  })

  it('stays under the argv budget that E2BIG was measured at', () => {
    const paths = Array.from({ length: 20_000 }, (_unused, index) => `src/generated/module-${index}/index.ts`)
    const chunks = chunkPathspecs(paths)
    expect(chunks.flat()).toEqual(paths)
    for (const chunk of chunks) {
      expect(chunk.reduce((total, path) => total + path.length + 1, 0)).toBeLessThanOrEqual(128 * 1024)
    }
  })
})

describe('replaceStatusEntry', () => {
  const tracked = (path: string): { path: string; status: 'modified' } => ({ path, status: 'modified' })
  const untracked = (path: string): { path: string; status: 'untracked' } => ({ path, status: 'untracked' })

  it('inserts a tracked entry in path order ahead of the untracked section', () => {
    const statuses = [tracked('a.ts'), tracked('c.ts'), untracked('new.ts')]
    expect(replaceStatusEntry(statuses, 'b.ts', tracked('b.ts'))).toEqual([
      tracked('a.ts'), tracked('b.ts'), tracked('c.ts'), untracked('new.ts')
    ])
  })

  it('replaces an existing entry in place and removes it when the file goes clean', () => {
    const statuses = [tracked('a.ts'), tracked('b.ts')]
    expect(replaceStatusEntry(statuses, 'a.ts', { path: 'a.ts', status: 'added' })).toEqual([
      { path: 'a.ts', status: 'added' }, tracked('b.ts')
    ])
    expect(replaceStatusEntry(statuses, 'a.ts', null)).toEqual([tracked('b.ts')])
  })

  it('keeps untracked entries after the tracked ones', () => {
    const statuses = [tracked('a.ts'), untracked('z.ts')]
    expect(replaceStatusEntry(statuses, 'b.ts', untracked('b.ts'))).toEqual([
      tracked('a.ts'), untracked('b.ts'), untracked('z.ts')
    ])
  })
})

describe('GitObjectReader', () => {
  it('serves many reads from a single git process and reports blob type', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-reader-'))
    try {
      await initRepository(repositoryPath)
      for (let index = 0; index < 40; index += 1) {
        await writeFile(join(repositoryPath, `file-${index}.txt`), `value ${index}\n`, 'utf8')
      }
      await commitAll(repositoryPath, 'Initial commit')

      const reader = new GitObjectReader(repositoryPath)
      try {
        const reads = await Promise.all(
          Array.from({ length: 40 }, (_unused, index) => reader.read(`HEAD:file-${index}.txt`))
        )
        for (const [index, read] of reads.entries()) {
          expect(read.missing).toBe(false)
          expect(read.type).toBe('blob')
          expect(read.oid).toMatch(/^[0-9a-f]{40}$/)
          expect(read.contents?.toString('utf8')).toBe(`value ${index}\n`)
        }
        expect(reader.spawnCountForTests).toBe(1)
      } finally {
        reader.dispose()
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps the stream aligned when an oversized object is skipped', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-reader-big-'))
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'small.txt'), 'small\n', 'utf8')
      await writeFile(join(repositoryPath, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 0x61))
      await commitAll(repositoryPath, 'Initial commit')

      const reader = new GitObjectReader(repositoryPath)
      try {
        const [big, small, absent] = await Promise.all([
          reader.read('HEAD:big.bin'),
          reader.read('HEAD:small.txt'),
          reader.read('HEAD:absent.txt')
        ])
        expect(big?.oversized).toBe(true)
        expect(big?.contents).toBeNull()
        // The record after an oversized one must still be the file that was asked for.
        expect(small?.contents?.toString('utf8')).toBe('small\n')
        expect(absent?.missing).toBe(true)
        expect(reader.spawnCountForTests).toBe(1)
      } finally {
        reader.dispose()
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('PullRequestReviewCache', () => {
  const review = (overrides: Record<string, unknown> = {}): PullRequestReview => ({
    kind: 'github',
    selector: '7',
    baseOid: 'base-oid-1',
    headOid: 'oid-1',
    commitId: 'oid-1',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7,
      title: 'Add a thing',
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-17T00:00:00Z',
      additions: 1,
      deletions: 0,
      changedFiles: 1
    },
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'diff --git a/src/a.ts b/src/a.ts\n',
    omittedFiles: [],
    expectedFileCount: 1,
    ...overrides
  })

  it('round-trips a review and misses on a different head oid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-code-diff-pr-cache-'))
    try {
      const cache = new PullRequestReviewCache(join(directory, 'pr-cache'))
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())

      const hit = await cache.read(url, 'oid-1')
      expect(hit?.patch).toBe('diff --git a/src/a.ts b/src/a.ts\n')
      expect(hit?.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0 }])
      const names = await readdir(join(directory, 'pr-cache'))
      expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(1)
      expect(names.filter((name) => name.endsWith('.patch'))).toHaveLength(1)
      const metadataName = names.find((name) => name.endsWith('.json'))
      const metadata = JSON.parse(await readFile(join(directory, 'pr-cache', metadataName ?? ''), 'utf8'))
      expect(metadata.patch).toBeUndefined()
      expect(metadata.patchLength).toBe(review().patch.length)
      // A force-push moves the head oid, which is the key, so the old entry can
      // never be served for the new diff.
      expect(await cache.read(url, 'oid-2')).toBeNull()
      expect(await cache.read('https://github.com/acme/other/pull/7', 'oid-1')).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats a corrupt entry as a miss and never writes an empty review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-code-diff-pr-cache-bad-'))
    try {
      const cacheDirectory = join(directory, 'pr-cache')
      const cache = new PullRequestReviewCache(cacheDirectory)
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())
      const names = await readdir(cacheDirectory)
      const entryName = names.find((name) => name.endsWith('.json'))
      const patchName = names.find((name) => name.endsWith('.patch'))
      await writeFile(join(cacheDirectory, patchName ?? ''), 'truncated', 'utf8')
      expect(await cache.read(url, 'oid-1')).toBeNull()

      await writeFile(join(cacheDirectory, entryName ?? ''), '{ not json', 'utf8')
      expect(await cache.read(url, 'oid-1')).toBeNull()

      await cache.write(url, 'oid-3', review({ files: [] }))
      expect(await cache.read(url, 'oid-3')).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sweeps the oldest entries past the entry cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-code-diff-pr-cache-sweep-'))
    try {
      const cacheDirectory = join(directory, 'pr-cache')
      const cache = new PullRequestReviewCache(cacheDirectory)
      for (let index = 0; index < 24; index += 1) {
        await cache.write(`https://github.com/acme/app/pull/${index}`, `oid-${index}`, review())
      }
      await writeFile(join(cacheDirectory, 'orphan.patch'), 'orphan', 'utf8')
      await cache.sweep()
      const names = await readdir(cacheDirectory)
      const metadataCount = names.filter((name) => name.endsWith('.json')).length
      const patchCount = names.filter((name) => name.endsWith('.patch')).length
      expect(metadataCount).toBeLessThanOrEqual(20)
      expect(patchCount).toBe(metadataCount)
      expect(names).not.toContain('orphan.patch')
      // The most recent write always survives its own sweep.
      expect(await cache.read('https://github.com/acme/app/pull/23', 'oid-23')).not.toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('RepositoryService', () => {
  it('treats an empty content search as cancellation before a folder is open', async () => {
    const repository = new RepositoryService()
    expect(await repository.searchContent('')).toEqual([])
  })

  it('trims caches and fully releases repository state on dispose', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-dispose-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 2\n', 'utf8')

      await repository.open(repositoryPath)
      await repository.getComparison('value.ts')
      expect(repository.getHeadCacheStatsForTests()).toMatchObject({
        entries: 1,
        workingEntries: 1,
        objectReaderSpawns: 1
      })

      repository.trimCaches(0)
      expect(repository.getHeadCacheStatsForTests()).toMatchObject({
        entries: 0,
        bytes: 0,
        workingEntries: 0,
        workingBytes: 0,
        objectReaderSpawns: 1
      })

      await repository.getComparison('value.ts')
      repository.dispose()
      expect(repository.getSessionSnapshot()).toBeNull()
      expect(repository.getHeadCacheStatsForTests()).toEqual({
        entries: 0,
        bytes: 0,
        workingEntries: 0,
        workingBytes: 0,
        objectReaderSpawns: 0
      })

      expect((await repository.open(repositoryPath)).root).toBe(await realpath(repositoryPath))
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('deduplicates overlapping working-tree patches regardless of path order', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-patch-dedupe-'))
    const repository = new RepositoryService()
    const tracePath = join(repositoryPath, 'git-trace.json')
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)

      process.env.GIT_TRACE2_EVENT = tracePath
      const [first, second] = await Promise.all([
        repository.getWorkingTreePatch(['a.ts', 'b.ts']),
        repository.getWorkingTreePatch(['b.ts', 'a.ts'])
      ])
      expect(second).toEqual(first)

      const events = (await readFile(tracePath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
      const diffStarts = events.filter((event) =>
        event.event === 'start' && event.argv?.includes('diff') === true
      )
      expect(diffStarts).toHaveLength(2)
    } finally {
      if (previousTrace == null) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('aborts a working-tree patch superseded by a different path set', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-patch-abort-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)

      const superseded = repository.getWorkingTreePatch(['a.ts'])
      const current = repository.getWorkingTreePatch(['b.ts'])
      await expect(superseded).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
      expect((await current).patch).toContain('export const b = 2')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('shares one remotes request for the life of an open repository', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-remotes-cache-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'remote', 'add', 'origin', 'git@github.com:acme/example.git')
      await repository.open(repositoryPath)

      const [first, second] = await Promise.all([repository.getRemotes(), repository.getRemotes()])
      expect(second).toBe(first)
      expect(first).toEqual([{
        name: 'origin',
        fetchUrl: 'git@github.com:acme/example.git',
        pushUrl: 'git@github.com:acme/example.git'
      }])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

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
      const refreshed = await repository.refresh()
      const comparison = await repository.getComparison('tracked.txt')
      const workingTreePatch = await repository.getWorkingTreePatch(['tracked.txt', 'untracked.txt'])
      const searchResults = await repository.searchContent('searchable')

      expect(snapshot.kind).toBe('git')
      expect(snapshot.paths).toEqual(['tracked.txt', 'untracked.txt'])
      expect(refreshed.paths).toBe(snapshot.paths)
      expect(snapshot.statuses).toEqual([
        { path: 'tracked.txt', status: 'modified' },
        { path: 'untracked.txt', status: 'untracked' }
      ])
      expect(comparison.oldFile?.contents).toBe('original value\n')
      expect(comparison.newFile?.contents).toBe('updated searchable value\n')
      expect(comparison.mode).toBe('diff')
      expect(workingTreePatch.patch).toContain('-original value')
      expect(workingTreePatch.patch).toContain('+updated searchable value')
      expect(workingTreePatch.omittedFiles).toEqual([])
      expect(workingTreePatch.patch).toContain(createNewFilePatch('untracked.txt', 'another searchable value\n'))
      expect(searchResults.map((result) => result.path).sort()).toEqual([
        'tracked.txt',
        'untracked.txt'
      ])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('renders a submodule as absent instead of a deleted commit object', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-submodule-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'tracked.txt'), 'value\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      const head = (await runGitAllowingDifferences(repositoryPath, 'rev-parse', 'HEAD')).trim()
      await runGit(repositoryPath, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`)
      await commitIndex(repositoryPath, 'Add gitlink')

      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.paths).toContain('sub')
      const comparison = await repository.getComparison('sub')
      expect(comparison.oldFile).toBeNull()
      expect(comparison.newFile).toBeNull()
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('opens an unchanged tracked file as a file preview', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-clean-preview-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'README.md'), 'clean repository\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')

      const snapshot = await repository.open(repositoryPath)
      const comparison = await repository.getComparison('README.md')

      expect(snapshot.statuses).toEqual([])
      expect(comparison.mode).toBe('file')
      expect(comparison.status).toBe('unchanged')
      expect(comparison.newFile?.contents).toBe('clean repository\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('attaches a png preview instead of an empty binary comparison', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-image-preview-'))
    const repository = new RepositoryService()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'icon.png'), png)
      await repository.open(repositoryPath)
      const comparison = await repository.getComparison('icon.png')

      expect(comparison.binary).toBe(true)
      expect(comparison.newFile).toBeNull()
      expect(comparison.image?.new?.mimeType).toBe('image/png')
      expect(comparison.image?.new?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(comparison.image?.old).toBeNull()
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps tracked build output visible and consistent between a commit review files and patch', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-tracked-dist-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'seed.txt'), 'seed\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await mkdir(join(repositoryPath, 'dist'))
      await writeFile(join(repositoryPath, 'dist', 'app.js'), 'console.log(1)\n', 'utf8')
      await commitAll(repositoryPath, 'Ship build output')
      const head = (await runGitAllowingDifferences(repositoryPath, 'rev-parse', 'HEAD')).trim()

      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.paths).toContain('dist/app.js')
      const review = await repository.getCommitReview(head)
      expect(review.files.map((file) => file.path)).toEqual(['dist/app.js'])
      expect(review.patch).toContain('dist/app.js')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps a cache key stable across an unrelated commit and a byte-identical rewrite', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-cachekey-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'stable.ts'), 'export const value = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'other.ts'), 'export const other = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')

      await repository.open(repositoryPath)
      const before = await repository.getComparison('stable.ts')

      await writeFile(join(repositoryPath, 'other.ts'), 'export const other = 2\n', 'utf8')
      await commitAll(repositoryPath, 'Touch an unrelated file')
      await repository.refresh()
      const afterCommit = await repository.getComparison('stable.ts')
      expect(afterCommit.oldFile?.cacheKey).toBe(before.oldFile?.cacheKey ?? '')

      // A formatter that rewrites identical bytes must not invalidate a draft.
      await writeFile(join(repositoryPath, 'stable.ts'), 'export const value = 1\n', 'utf8')
      await repository.refresh()
      const afterTouch = await repository.getComparison('stable.ts')
      expect(afterTouch.newFile?.cacheKey).toBe(before.newFile?.cacheKey ?? '')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('saves an already-modified file without rebuilding the whole snapshot', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-save-refresh-'))
    const repository = new RepositoryService()
    const selfWrites: string[] = []
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 2\n', 'utf8')

      await repository.open(repositoryPath)
      repository.setSelfWriteObserver((path) => selfWrites.push(path))
      const before = repository.getSessionSnapshot()
      const comparison = await repository.getComparison('value.ts')

      const saved = await repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 3\n',
        expectedCacheKey: comparison.newFile?.cacheKey ?? ''
      })

      expect(saved.newFile?.contents).toBe('export const value = 3\n')
      expect(selfWrites).toEqual(['value.ts'])
      // The file was already modified, so the status did not move and no
      // whole-tree refresh was needed: the snapshot is the very same object.
      expect(repository.getSessionSnapshot()).toBe(before)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('updates the status in place when a clean file becomes modified', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-save-status-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')

      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.statuses).toEqual([{ path: 'b.ts', status: 'modified' }])
      const comparison = await repository.getComparison('a.ts')
      await repository.saveWorkingFile({
        path: 'a.ts',
        contents: 'export const a = 2\n',
        expectedCacheKey: comparison.newFile?.cacheKey ?? ''
      })

      expect(repository.getSessionSnapshot()?.statuses).toEqual([
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'modified' }
      ])
      expect(repository.getSessionSnapshot()?.paths).toEqual(['a.ts', 'b.ts'])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('saves an editable file and rejects a stale draft without overwriting disk changes', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'better-code-diff-save-test-'))
    const filePath = join(folderPath, 'value.ts')

    try {
      await writeFile(filePath, 'export const value = 1\n', 'utf8')
      const repository = new RepositoryService()
      await repository.open(folderPath)
      const firstComparison = await repository.getComparison('value.ts')

      const savedComparison = await repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 2\n',
        expectedCacheKey: firstComparison.newFile!.cacheKey
      })

      expect(await readFile(filePath, 'utf8')).toBe('export const value = 2\n')
      expect(savedComparison.newFile?.contents).toBe('export const value = 2\n')
      expect(savedComparison.newFile?.cacheKey).not.toBe(firstComparison.newFile?.cacheKey)

      await writeFile(filePath, 'export const value = 3\n', 'utf8')
      await expect(repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 4\n',
        expectedCacheKey: savedComparison.newFile!.cacheKey
      })).rejects.toThrow('The file changed on disk')
      expect(await readFile(filePath, 'utf8')).toBe('export const value = 3\n')
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('omits oversized files from the working tree patch and matches Git for new files', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-cap-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'generated.txt'), 'first\n', 'utf8')
      await runGit(repositoryPath, 'add', 'generated.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Base')
      await writeFile(
        join(repositoryPath, 'generated.txt'),
        `${Array.from({ length: 25_000 }, (_, index) => `line ${index}`).join('\n')}\n`,
        'utf8'
      )
      await writeFile(join(repositoryPath, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8')
      await writeFile(join(repositoryPath, 'new.txt'), 'added line\n', 'utf8')

      const repository = new RepositoryService()
      await repository.open(repositoryPath)
      const workingTreePatch = await repository.getWorkingTreePatch(['generated.txt', 'huge.txt', 'new.txt'])
      const gitNewFilePatch = await runGitAllowingDifferences(
        repositoryPath,
        'diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', 'new.txt'
      )

      expect(workingTreePatch.omittedFiles).toEqual([
        { path: 'generated.txt', reason: 'too-large', additions: 25_000, deletions: 1 },
        { path: 'huge.txt', reason: 'too-large', additions: 0, deletions: 0 }
      ])
      expect(workingTreePatch.patch).not.toContain('generated.txt')
      expect(workingTreePatch.patch).not.toContain('huge.txt')
      expect(createNewFilePatch('new.txt', 'added line\n')).toBe(
        gitNewFilePatch.split('\n').filter((line) => !line.startsWith('index ')).join('\n')
      )
      expect(workingTreePatch.patch).toContain(createNewFilePatch('new.txt', 'added line\n'))
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
      const refreshed = await repository.refresh()
      const comparison = await repository.getComparison('src/value.ts')
      const searchResults = await repository.searchContent('searchable')

      expect(snapshot.kind).toBe('folder')
      expect(snapshot.branch).toBeNull()
      expect(snapshot.paths).toEqual(['README.md', 'src/value.ts'])
      expect(refreshed.paths).toBe(snapshot.paths)
      expect(snapshot.statuses).toEqual([])
      expect(comparison.mode).toBe('file')
      expect(comparison.oldFile).toBeNull()
      expect(comparison.newFile?.contents).toBe('export const searchable = true\n')
      expect(searchResults).toMatchObject([{ path: 'src/value.ts', line: 1 }])

      repository.resetContentSearchMetricsForTests()
      const interrupted = repository.searchContent('searchable')
      const replacement = repository.searchContent('ordinary')
      await Promise.allSettled([interrupted, replacement])
      const metrics = repository.getContentSearchMetricsForTests()
      expect(metrics.spawned).toBe(2)
      expect(metrics.cancelled).toBe(1)
      expect(metrics.completed).toBe(2)
      expect(metrics.durationsMs).toHaveLength(1)
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
      expect(review.baseOid).toBe(integration.commits[1]!.oid)
      expect(review.headOid).toBe(integration.commits[0]!.oid)
      expect(review.files).toHaveLength(1)
      expect(review.files[0]).toMatchObject({ path: 'value.txt', additions: 1, deletions: 0 })
      expect(review.files[0]?.baseBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(review.files[0]?.headBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(review.omittedFiles).toEqual([])
      expect(review.patch).toContain('+feature')
      expect(commitReview.title).toContain('Feature')
      expect(commitReview.baseOid).toBe(integration.commits[1]!.oid)
      expect(commitReview.headOid).toBe(integration.commits[0]!.oid)
      expect(commitReview.patch).toContain('+feature')
      expect(rootCommitReview.baseRefName).toBe('Empty tree')
      expect(rootCommitReview.baseOid).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
      expect(rootCommitReview.headOid).toBe(integration.commits[1]!.oid)
      expect(rootCommitReview.files).toHaveLength(1)
      expect(rootCommitReview.files[0]).toMatchObject({ path: 'value.txt', additions: 1, deletions: 0 })
      expect(rootCommitReview.files[0]?.headBlobOid).toMatch(/^[0-9a-f]{40}$/)
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

describe('parsePullRequestConversation', () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          body: 'Adds the review inbox.',
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                isOutdated: false,
                path: 'src/app.ts',
                line: 12,
                startLine: 10,
                diffSide: 'RIGHT',
                comments: {
                  nodes: [
                    { id: 'comment-1', body: 'Rename this.', author: { login: 'Reviewer' }, createdAt: '2026-08-17T10:00:00Z' }
                  ]
                }
              },
              {
                id: 'thread-2',
                isResolved: true,
                isOutdated: true,
                path: 'src/old.ts',
                line: null,
                startLine: null,
                diffSide: 'LEFT',
                comments: { nodes: [] }
              }
            ]
          },
          reviews: {
            nodes: [
              { id: 'review-1', state: 'CHANGES_REQUESTED', body: 'Almost.', author: { login: 'Reviewer' }, submittedAt: '2026-08-17T10:05:00Z' }
            ]
          }
        }
      }
    }
  }

  it('reads the description, threads, and submitted reviews', () => {
    const conversation = parsePullRequestConversation(payload)
    expect(conversation.body).toBe('Adds the review inbox.')
    expect(conversation.threads).toEqual([
      {
        id: 'thread-1',
        path: 'src/app.ts',
        line: 12,
        startLine: 10,
        side: 'RIGHT',
        resolved: false,
        outdated: false,
        comments: [
          { id: 'comment-1', body: 'Rename this.', authorLogin: 'Reviewer', createdAt: '2026-08-17T10:00:00Z' }
        ]
      },
      {
        id: 'thread-2',
        path: 'src/old.ts',
        line: null,
        startLine: null,
        side: 'LEFT',
        resolved: true,
        outdated: true,
        comments: []
      }
    ])
    expect(conversation.reviews).toEqual([
      { id: 'review-1', state: 'CHANGES_REQUESTED', body: 'Almost.', authorLogin: 'Reviewer', submittedAt: '2026-08-17T10:05:00Z' }
    ])
  })

  it('returns empty results for absent or malformed payloads', () => {
    expect(parsePullRequestConversation(null)).toEqual({ body: '', threads: [], reviews: [] })
    expect(parsePullRequestConversation({ data: {} })).toEqual({ body: '', threads: [], reviews: [] })
    expect(parsePullRequestConversation({ data: { repository: { pullRequest: {} } } }))
      .toEqual({ body: '', threads: [], reviews: [] })
  })

  it('drops threads and comments that cannot be addressed', () => {
    const conversation = parsePullRequestConversation({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: '', path: 'src/a.ts', comments: { nodes: [] } },
                { id: 'thread-3', path: '', comments: { nodes: [] } },
                null,
                {
                  id: 'thread-4',
                  path: 'src/a.ts',
                  diffSide: 'UNKNOWN',
                  comments: { nodes: [{ id: '', body: 'dropped' }, { id: 'comment-2', body: 'kept' }] }
                }
              ]
            }
          }
        }
      }
    })
    expect(conversation.threads).toHaveLength(1)
    expect(conversation.threads[0]?.id).toBe('thread-4')
    expect(conversation.threads[0]?.side).toBe('RIGHT')
    expect(conversation.threads[0]?.comments.map((comment) => comment.id)).toEqual(['comment-2'])
  })
})

describe('readGitObject', () => {
  async function commitFile(repositoryPath: string, name: string, contents: string | Buffer): Promise<void> {
    await writeFile(join(repositoryPath, name), contents)
    await runGit(repositoryPath, 'add', name)
    await runGit(
      repositoryPath,
      '-c', 'user.name=Better Code Diff Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', `add ${name}`
    )
  }

  it('returns a committed blob in a single git invocation', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'tracked.txt', 'first line\nsecond line\n')

      const read = await readGitObject(repositoryPath, 'HEAD:tracked.txt')
      expect(read.missing).toBe(false)
      expect(read.oversized).toBe(false)
      expect(read.contents?.toString('utf8')).toBe('first line\nsecond line\n')
      expect(read.size).toBe(23)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reports a path that is absent from the commit as missing', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'tracked.txt', 'value\n')

      const read = await readGitObject(repositoryPath, 'HEAD:absent.txt')
      expect(read.missing).toBe(true)
      expect(read.contents).toBeNull()
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('abandons a blob larger than the diff cap without reading its contents', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      // Comfortably past the 2 MB cap, and incompressible enough that git stores it as is.
      await commitFile(repositoryPath, 'big.bin', Buffer.alloc(3 * 1024 * 1024, 'abcdefgh'))

      const read = await readGitObject(repositoryPath, 'HEAD:big.bin')
      expect(read.oversized).toBe(true)
      expect(read.missing).toBe(false)
      expect(read.contents).toBeNull()
      expect(read.size).toBe(3 * 1024 * 1024)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reads an empty blob as empty rather than missing', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'empty.txt', '')

      const read = await readGitObject(repositoryPath, 'HEAD:empty.txt')
      expect(read.missing).toBe(false)
      expect(read.size).toBe(0)
      expect(read.contents?.length).toBe(0)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('parsePorcelainV2Status against real git output', () => {
  it('reads every status kind, the branch, and the untracked set from one call', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-v2-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      const commit = (message: string): Promise<void> => runGit(
        repositoryPath,
        '-c', 'user.name=Better Code Diff Test',
        '-c', 'user.email=test@example.invalid',
        'commit', '--quiet', '-m', message
      )
      await writeFile(join(repositoryPath, 'mod.ts'), 'first\n', 'utf8')
      await writeFile(join(repositoryPath, 'del.ts'), 'gone\n', 'utf8')
      await writeFile(join(repositoryPath, 'ren-old.ts'), 'moved\n', 'utf8')
      await writeFile(join(repositoryPath, 'with space.ts'), 'kept\n', 'utf8')
      await runGit(repositoryPath, 'add', '-A')
      await commit('init')

      await writeFile(join(repositoryPath, 'mod.ts'), 'second\n', 'utf8')
      await rm(join(repositoryPath, 'del.ts'))
      await runGit(repositoryPath, 'mv', 'ren-old.ts', 'ren-new.ts')
      await writeFile(join(repositoryPath, 'untracked.ts'), 'new\n', 'utf8')
      await writeFile(join(repositoryPath, 'staged.ts'), 'staged\n', 'utf8')
      await runGit(repositoryPath, 'add', 'staged.ts')

      const raw = (await executeFile(
        'git',
        ['-C', repositoryPath, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        { encoding: 'buffer' }
      )).stdout as unknown as Buffer
      const status = parsePorcelainV2Status(raw)

      expect(status.branch).not.toBeNull()
      expect(status.head).toMatch(/^[0-9a-f]{40}$/)
      expect(status.untrackedPaths).toEqual(['untracked.ts'])

      const byPath = new Map(status.statuses.map((entry) => [entry.path, entry]))
      expect(byPath.get('mod.ts')?.status).toBe('modified')
      expect(byPath.get('del.ts')?.status).toBe('deleted')
      expect(byPath.get('staged.ts')?.status).toBe('added')
      expect(byPath.get('untracked.ts')?.status).toBe('untracked')
      expect(byPath.get('ren-new.ts')).toEqual({
        path: 'ren-new.ts',
        previousPath: 'ren-old.ts',
        status: 'renamed'
      })
      // An unchanged tracked file must not be reported at all.
      expect(byPath.has('with space.ts')).toBe(false)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reports a conflicted file as conflicted', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'better-code-diff-v2-conflict-'))
    try {
      const git = (...args: string[]): Promise<void> => runGit(
        repositoryPath,
        '-c', 'user.name=Better Code Diff Test',
        '-c', 'user.email=test@example.invalid',
        ...args
      )
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'both.ts'), 'base\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'base')

      await runGit(repositoryPath, 'checkout', '--quiet', '-b', 'other')
      await writeFile(join(repositoryPath, 'both.ts'), 'other side\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'other')

      await runGitAllowingDifferences(repositoryPath, 'checkout', '--quiet', '-')
      await writeFile(join(repositoryPath, 'both.ts'), 'first side\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'first')
      await runGitAllowingDifferences(repositoryPath, 'merge', 'other')

      const raw = (await executeFile(
        'git',
        ['-C', repositoryPath, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        { encoding: 'buffer' }
      )).stdout as unknown as Buffer
      const status = parsePorcelainV2Status(raw)
      expect(status.statuses.find((entry) => entry.path === 'both.ts')?.status).toBe('conflicted')
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('parsePullRequestInboxResponse', () => {
  const node = (number: number, login = 'octocat'): Record<string, unknown> => ({
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-08-18T00:00:00Z',
    author: { login }
  })

  it('reads every aliased search into its section', () => {
    const entries = parsePullRequestInboxResponse({
      data: {
        reviewRequested: { nodes: [node(1)] },
        assigned: { nodes: [node(2)] },
        mentioned: { nodes: [node(3)] },
        authored: { nodes: [node(4)] }
      }
    })
    expect(entries.map((entry) => entry.key)).toEqual([
      'review-requested', 'assigned', 'mentioned', 'authored'
    ])
  })

  // GraphQL returns the enum spelling; the renderer contract is lowercase.
  it('lowercases the state so the contract matches the old search output', () => {
    const [entry] = parsePullRequestInboxResponse({ data: { assigned: { nodes: [node(7)] } } })
    expect((entry?.pullRequest as { state?: unknown } | undefined)?.state).toBe('open')
  })

  it('survives missing sections, non-array nodes, and non-object entries', () => {
    expect(parsePullRequestInboxResponse({ data: { assigned: { nodes: 'nope' } } })).toEqual([])
    expect(parsePullRequestInboxResponse({ data: { assigned: { nodes: [null, 3] } } })).toEqual([])
    expect(parsePullRequestInboxResponse({})).toEqual([])
    expect(parsePullRequestInboxResponse(null)).toEqual([])
  })

  it('feeds sectionPullRequestInbox so a pull request lands in one section only', () => {
    const sections = sectionPullRequestInbox(parsePullRequestInboxResponse({
      data: {
        reviewRequested: { nodes: [node(9)] },
        assigned: { nodes: [node(9)] }
      }
    }))
    expect(sections.find((section) => section.key === 'review-requested')?.pullRequests).toHaveLength(1)
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests).toHaveLength(0)
  })
})
