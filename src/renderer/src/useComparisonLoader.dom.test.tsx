import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { FileComparison, RepositoryApi, RepositorySnapshot } from '../../shared/contracts'
import { useComparisonLoader } from './useComparisonLoader'
import type { WorkspaceView } from './AppView'

beforeEach(() => {
  window.requestIdleCallback = ((callback: IdleRequestCallback) => {
    callback({ didTimeout: false, timeRemaining: () => 50 })
    return 1
  }) as typeof window.requestIdleCallback
  window.cancelIdleCallback = (() => {}) as typeof window.cancelIdleCallback
})

afterEach(() => {
  cleanup()
  delete window.repository
})

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'head',
  paths: ['a.ts', 'b.ts'],
  statuses: [
    { path: 'a.ts', status: 'modified' },
    { path: 'b.ts', status: 'modified' }
  ]
}

function comparison(path: string): FileComparison {
  return {
    path,
    mode: 'diff',
    status: 'modified',
    oldFile: { name: path, contents: 'before\n', cacheKey: `${path}:old` },
    newFile: { name: path, contents: 'after\n', cacheKey: `${path}:new` },
    binary: false,
    oversized: false
  }
}

test('multi-file mode retains the same file but releases a different selection', async () => {
  const getComparison = mock(async (path: string) => comparison(path))
  window.repository = { getComparison } as unknown as RepositoryApi
  const onError = mock(() => {})
  const { result, rerender } = renderHook(
    ({ selectedPath, workspaceView }: { selectedPath: string; workspaceView: WorkspaceView }) =>
      useComparisonLoader({
        snapshot,
        selectedPath,
        workspaceView,
        repositoryReview: null,
        onError
      }),
    { initialProps: { selectedPath: 'a.ts', workspaceView: 'file' as WorkspaceView } }
  )

  await waitFor(() => expect(result.current.comparison?.path).toBe('a.ts'))
  rerender({ selectedPath: 'a.ts', workspaceView: 'multi' })
  expect(result.current.comparison?.path).toBe('a.ts')

  rerender({ selectedPath: 'b.ts', workspaceView: 'multi' })
  await waitFor(() => expect(result.current.comparison).toBeNull())

  rerender({ selectedPath: 'b.ts', workspaceView: 'file' })
  await waitFor(() => expect(result.current.comparison?.path).toBe('b.ts'))
})
