import { describe, expect, test } from 'bun:test'

import type { RepositoryReview } from '../../shared/contracts'
import { formatAgentReviewContext } from './agentReviewContext'

const githubReview = (fileCount: number, patch = 'diff --git a/huge b/huge\n'.repeat(4000)): RepositoryReview => ({
  kind: 'github',
  selector: '1092',
  commitId: 'abc',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 1092,
    title: 'Speed up diffs',
    url: 'https://github.com/example/repo/pull/1092',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'octocat' },
    headRefName: 'perf',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-27T00:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: fileCount
  },
  files: Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${index}.ts`,
    additions: 1,
    deletions: 0
  })),
  patch,
  omittedFiles: [],
  expectedFileCount: fileCount
})

describe('formatAgentReviewContext', () => {
  test('summarizes files instead of copying the patch body', () => {
    const context = formatAgentReviewContext(githubReview(3, 'THIS PATCH MUST NOT APPEAR'))
    expect(context).toContain('#1092 Speed up diffs')
    expect(context).toContain('src/file-0.ts (+1/-0)')
    expect(context).not.toContain('THIS PATCH MUST NOT APPEAR')
  })

  test('caps a large file list so a streamed review cannot rebuild a megabyte string', () => {
    const context = formatAgentReviewContext(githubReview(120))
    expect(context).toContain('src/file-0.ts (+1/-0)')
    expect(context).toContain('…and 40 more files')
    expect(context).not.toContain('src/file-80.ts')
    expect(context.length).toBeLessThan(8_000)
  })
})
