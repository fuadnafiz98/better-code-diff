import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { RepositoryApi, RepositorySnapshot } from '../../shared/contracts'
import { useRepositorySearch } from './useRepositorySearch'

afterEach(() => {
  cleanup()
  delete window.repository
})

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: null,
  paths: [
    'src/App.tsx',
    'src/fileSearch.ts',
    'docs/notes.md'
  ],
  statuses: []
}

const onError = (): void => {}

test('file search ranks snapshot paths before git status finishes', async () => {
  window.repository = {
    cancelContentSearch: () => {},
    searchContent: async () => []
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError))

  act(() => {
    result.current.changeQuery('file')
  })

  await waitFor(() => {
    expect(result.current.fileResults).toContain('src/fileSearch.ts')
  })
  expect(result.current.fileResults).not.toContain('docs/notes.md')
})
