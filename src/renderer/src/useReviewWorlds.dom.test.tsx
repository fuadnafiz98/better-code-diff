import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'

import type { PullRequestReview, RepositorySnapshot } from '../../shared/contracts'
import type { WorkspaceView } from './AppView'
import { useReviewWorlds } from './useReviewWorlds'

afterEach(cleanup)

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'desk-head',
  paths: ['desk.ts', 'patch.ts'],
  statuses: []
}

const review: PullRequestReview = {
  kind: 'github',
  selector: '9',
  baseOid: 'base-9',
  headOid: 'head-9',
  commitId: 'head-9',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 9,
    title: 'Patch navigation',
    url: 'https://github.com/acme/repo/pull/9',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'author' },
    headRefName: 'feature',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-28T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1
  },
  files: [{ path: 'patch.ts', additions: 1, deletions: 0 }],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 1
}

test('switching worlds restores path, view, and review scroll without keeping a viewer mounted', async () => {
  const { result } = renderHook(() => {
    const [selectedPath, setSelectedPath] = useState<string | null>('desk.ts')
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('file')
    const worlds = useReviewWorlds({
      snapshot,
      selectedPath,
      workspaceView,
      onActivateSnapshot: () => {},
      onActivateRepository: async () => snapshot,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: setSelectedPath,
      onWorkspaceViewChange: setWorkspaceView
    })
    return { selectedPath, setSelectedPath, workspaceView, worlds }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  let patchWorldId!: string
  act(() => {
    patchWorldId = result.current.worlds.openPatchWorld(snapshot, review, 1, false)!
  })
  expect(result.current.selectedPath).toBe('patch.ts')
  expect(result.current.workspaceView).toBe('multi')

  act(() => {
    result.current.setSelectedPath('patch-notes.ts')
    result.current.worlds.rememberReviewScroll(420)
  })
  const deskWorldId = result.current.worlds.worlds.find((world) => world.source === 'desk')!.worldId
  await act(() => result.current.worlds.focusWorld(deskWorldId))
  expect(result.current.selectedPath).toBe('desk.ts')
  expect(result.current.workspaceView).toBe('file')

  await act(() => result.current.worlds.focusWorld(patchWorldId))
  expect(result.current.selectedPath).toBe('patch-notes.ts')
  expect(result.current.workspaceView).toBe('multi')
  expect(result.current.worlds.initialReviewScrollTop).toBe(420)
})

test('closing the final tab for a root releases its repository session', async () => {
  const releasedRoots: string[] = []
  const { result } = renderHook(() => useReviewWorlds({
    snapshot,
    selectedPath: null,
    workspaceView: 'multi',
    onActivateSnapshot: () => {},
    onActivateRepository: async () => snapshot,
    onReleaseRepository: async (root) => { releasedRoots.push(root) },
    onActivationError: () => {},
    onSelectPath: () => {},
    onWorkspaceViewChange: () => {}
  }))

  await waitFor(() => expect(result.current.worlds).toHaveLength(1))
  let patchWorldId!: string
  act(() => {
    patchWorldId = result.current.openPatchWorld(snapshot, review, 1, false)
  })
  await act(() => result.current.closeWorld(patchWorldId))
  expect(releasedRoots).toEqual([])

  const deskWorld = result.current.worlds.find((world) => world.source === 'desk')
  if (deskWorld == null) throw new Error('Expected a working-tree tab.')
  await act(() => result.current.closeWorld(deskWorld.worldId))

  expect(releasedRoots).toEqual(['/repo'])
  expect(result.current.worlds).toHaveLength(1)
  expect(result.current.worlds[0]?.source).toBe('new')
})

test('refreshes working-tree tab state when status changes without a new commit', async () => {
  const { result } = renderHook(() => {
    const [liveSnapshot, setLiveSnapshot] = useState(snapshot)
    const worlds = useReviewWorlds({
      snapshot: liveSnapshot,
      selectedPath: null,
      workspaceView: 'multi',
      onActivateSnapshot: () => {},
      onActivateRepository: async () => liveSnapshot,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: () => {},
      onWorkspaceViewChange: () => {}
    })
    return { worlds, setLiveSnapshot }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  act(() => {
    result.current.setLiveSnapshot({
      ...snapshot,
      statuses: [{ path: 'desk.ts', status: 'modified' }]
    })
  })

  await waitFor(() => {
    const world = result.current.worlds.worlds[0]
    expect(world?.source === 'desk' ? world.snapshot.statuses : []).toEqual([
      { path: 'desk.ts', status: 'modified' }
    ])
  })
})
