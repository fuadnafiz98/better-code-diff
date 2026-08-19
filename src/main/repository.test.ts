import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import {
  classifySearchCompletion,
  createNewFilePatch,
  createPullRequestReviewPayload,
  diffFilesFromChurn,
  githubRepoSlugFromRemoteUrl,
  readGitObject,
  isPathWithinApprovedRoots,
  isSameGitHubLogin,
  limitPatchFileSize,
  mapGitStatus,
  normalizePullRequestSelector,
  parseNumstat,
  mergeVisiblePaths,
  parsePullRequestInboxResponse,
  parsePorcelainV2Status,
  parsePullRequestConversation,
  pullRequestTargetsRemotes,
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

async function runGit(repositoryPath: string, ...args: string[]): Promise<void> {
  await executeFile('git', ['-C', repositoryPath, ...args])
}

async function runGitAllowingDifferences(repositoryPath: string, ...args: string[]): Promise<string> {
  try {
    return (await executeFile('git', ['-C', repositoryPath, ...args])).stdout
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

  it('drops excluded paths from both sides', () => {
    const tracked = Buffer.from('src/a.ts\0node_modules/pkg/index.js\0')
    expect(mergeVisiblePaths(tracked, ['node_modules/other/x.js', 'keep.txt'])).toEqual([
      'keep.txt', 'src/a.ts'
    ])
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

describe('RepositoryService', () => {
  it('treats an empty content search as cancellation before a folder is open', async () => {
    const repository = new RepositoryService()
    expect(await repository.searchContent('')).toEqual([])
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
      expect(review.files).toEqual([{ path: 'value.txt', additions: 1, deletions: 0 }])
      expect(review.omittedFiles).toEqual([])
      expect(review.patch).toContain('+feature')
      expect(commitReview.title).toContain('Feature')
      expect(commitReview.patch).toContain('+feature')
      expect(rootCommitReview.baseRefName).toBe('Empty tree')
      expect(rootCommitReview.files).toEqual([{ path: 'value.txt', additions: 1, deletions: 0 }])
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
    expect((entry?.pullRequest as { state?: unknown }).state).toBe('open')
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
