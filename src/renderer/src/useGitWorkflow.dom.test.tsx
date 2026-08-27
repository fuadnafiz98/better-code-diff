import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { PullRequestReview, RepositoryApi } from '../../shared/contracts'
import { useGitWorkflow } from './useGitWorkflow'

afterEach(() => {
  cleanup()
  delete window.repository
})

function deferred<Value>(): {
  promise: Promise<Value>
  resolve(value: Value): void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => { resolve = settle })
  return { promise, resolve }
}

function review(number: number): PullRequestReview {
  return {
    kind: 'github',
    selector: String(number),
    commitId: `commit-${number}`,
    viewerCanSubmitDecision: true,
    pullRequest: {
      number,
      title: `Review ${number}`,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      author: { login: 'reviewer' },
      baseRefName: 'main',
      headRefName: `feature-${number}`,
      updatedAt: '2026-08-26T00:00:00Z',
      url: `https://github.com/example/repo/pull/${number}`
    },
    files: [{ path: `file-${number}.ts`, additions: 1, deletions: 0 }],
    patch: '',
    omittedFiles: [],
    expectedFileCount: 1
  }
}

test('a superseded pull-request request cannot replace the newer review', async () => {
  const first = deferred<PullRequestReview>()
  const second = deferred<PullRequestReview>()
  const getPullRequestReview = mock((selector: number | string) =>
    selector === 1 ? first.promise : second.promise)
  window.repository = {
    getPullRequestReview,
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow({
    snapshot: null,
    applySnapshot: () => {},
    onError: () => {},
    onSelectPath: () => {},
    onWorkspaceViewChange: () => {},
    confirm: async () => true
  }))

  let firstRequest!: Promise<void>
  let secondRequest!: Promise<void>
  act(() => {
    firstRequest = result.current.openPullRequestReview(1)
    secondRequest = result.current.openPullRequestReview(2)
  })
  await waitFor(() => expect(result.current.actionKey).toBe('review:2'))
  first.resolve(review(1))
  await act(() => firstRequest)
  expect(result.current.repositoryReview).toBeNull()
  expect(result.current.actionKey).toBe('review:2')

  second.resolve(review(2))
  await act(() => secondRequest)
  expect(result.current.repositoryReview?.kind).toBe('github')
  expect(result.current.repositoryReview?.kind === 'github'
    ? result.current.repositoryReview.pullRequest.number
    : null).toBe(2)
  expect(result.current.actionKey).toBeNull()
})
