import { expect, test } from 'bun:test'

import type { PullRequestReview, RepositorySnapshot } from '../../shared/contracts'
import {
  boundInactivePatchPayloads,
  createNewWorld,
  createPatchWorld,
  createSinceWorld,
  findCollisionPaths,
  reduceWorldRegistry
} from './useReviewWorlds'

const snapshot = (head = 'desk-1'): RepositorySnapshot => ({
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head,
  paths: ['src/a.ts', 'src/b.ts'],
  statuses: [{ path: 'src/a.ts', status: 'modified' }]
})

const review = (number = 7): PullRequestReview => ({
  kind: 'github',
  selector: String(number),
  baseOid: `base-${number}`,
  headOid: `head-${number}`,
  commitId: `head-${number}`,
  viewerCanSubmitDecision: true,
  pullRequest: {
    number,
    title: `Review ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'author' },
    headRefName: `feature-${number}`,
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-28T00:00:00Z',
    additions: 2,
    deletions: 1,
    changedFiles: 2
  },
  files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 2
})

test('a working-tree tab stays live while an immutable Patch tab remains open', () => {
  const deskState = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-desk', snapshot: snapshot() }
  )
  const patch = createPatchWorld(snapshot(), review(), 1, 'ready')
  const patchState = reduceWorldRegistry(deskState, {
    type: 'open-patch', world: patch, originWorldId: deskState.activeWorldId
  })
  const refreshed = reduceWorldRegistry(patchState, { type: 'sync-repository', snapshot: snapshot('desk-2') })

  expect(refreshed.worlds).toHaveLength(2)
  expect(refreshed.activeWorldId).toBe(patch.worldId)
  expect(refreshed.worlds[0]?.source === 'desk' ? refreshed.worlds[0].baselineOid : null).toBe('desk-2')
  expect(refreshed.worlds[1]?.source === 'patch' ? refreshed.worlds[1].review : null).toEqual(patch.review)
  expect(refreshed.worlds[1]?.source === 'patch' ? refreshed.worlds[1].snapshot.head : null).toBe('desk-2')
})

test('a patch page only updates its matching world generation', () => {
  const patch = createPatchWorld(snapshot(), { ...review(), files: [] }, 2, 'loading')
  const state = { worlds: [patch], activeWorldId: patch.worldId }
  const progress = {
    kind: 'files' as const,
    selector: '7',
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'page',
    omittedFiles: []
  }
  const stale = reduceWorldRegistry(state, {
    type: 'append-patch-page',
    worldId: patch.worldId,
    generation: 1,
    progress
  })
  const current = reduceWorldRegistry(state, {
    type: 'append-patch-page',
    worldId: patch.worldId,
    generation: 2,
    progress
  })

  expect(stale).toBe(state)
  expect(current.worlds[0]?.source === 'patch' ? current.worlds[0].review.files : []).toHaveLength(1)
})

test('collision radar reports exact dirty-path intersections only', () => {
  const collisions = findCollisionPaths([
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/other.ts', status: 'untracked' }
  ], {
    ...review(),
    files: [
      { path: 'src/a.ts', additions: 1, deletions: 0 },
      { path: 'src/b.ts', additions: 1, deletions: 0 }
    ]
  })

  expect([...collisions]).toEqual(['src/a.ts'])
})

test('Since opens as a child tab without replacing its Patch snapshot', () => {
  const patch = createPatchWorld(snapshot(), review(), 1, 'ready')
  const checkpoint = {
    version: 1 as const,
    pullRequestUrl: review().pullRequest.url,
    baseOid: '1'.repeat(40),
    headOid: '2'.repeat(40),
    createdAt: '2026-08-28T10:00:00Z',
    manifest: []
  }
  const since = createSinceWorld(snapshot(), patch.worldId, {
    review: { ...review(), files: [{ path: 'src/b.ts', additions: 1, deletions: 0 }] },
    removedPaths: ['src/old.ts'],
    uncertainPaths: []
  }, checkpoint)
  const state = reduceWorldRegistry(
    { worlds: [patch], activeWorldId: patch.worldId },
    { type: 'open-since', world: since }
  )

  expect(state.worlds).toEqual([patch, since])
  expect(state.activeWorldId).toBe(since.worldId)
  expect(since.parentWorldId).toBe(patch.worldId)
})

test('a background cross-project load replaces its New tab without stealing focus', () => {
  const firstSnapshot = snapshot()
  const secondSnapshot = {
    ...snapshot('desk-b'),
    root: '/other/repo-b',
    name: 'repo-b'
  }
  const firstPatch = createPatchWorld(firstSnapshot, review(221), 1, 'ready')
  const secondPatch = createPatchWorld(secondSnapshot, {
    ...review(42),
    pullRequest: {
      ...review(42).pullRequest,
      url: 'https://github.com/other/repo-b/pull/42'
    }
  }, 2, 'ready')
  const newWorld = createNewWorld()
  const loadingState = {
    worlds: [firstPatch, newWorld],
    activeWorldId: firstPatch.worldId
  }
  const completedState = reduceWorldRegistry(loadingState, {
    type: 'open-patch',
    world: secondPatch,
    originWorldId: newWorld.worldId
  })

  expect(completedState.activeWorldId).toBe(firstPatch.worldId)
  expect(completedState.worlds).toEqual([firstPatch, secondPatch])
  expect(completedState.worlds.map((world) => world.source === 'new' ? null : world.root))
    .toEqual(['/repo', '/other/repo-b'])
})

test('inactive GitHub patch payloads are released when they exceed the memory budget', () => {
  const first = createPatchWorld(snapshot(), { ...review(1), patch: 'a'.repeat(100) }, 1, 'ready')
  const second = createPatchWorld(snapshot(), { ...review(2), patch: 'b'.repeat(100) }, 2, 'ready')
  const state = boundInactivePatchPayloads({
    worlds: [first, second],
    activeWorldId: second.worldId
  }, 100)

  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].loadStatus : null).toBe('released')
  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].review.patch : null).toBe('')
  expect(state.worlds[1]).toBe(second)
})
