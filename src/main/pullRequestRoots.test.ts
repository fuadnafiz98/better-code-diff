import { describe, expect, test } from 'bun:test'

import type { GitRemote } from '../shared/contracts.js'

import {
  findMatchingPullRequestRoot,
  folderLooksLikePullRequestRepo,
  MISSING_CHECKOUT_TTL_MS,
  PullRequestRootResolver,
  REMOTES_CACHE_TTL_MS,
  ROOT_RESOLUTION_TTL_MS,
  type PullRequestRootSources
} from './pullRequestRoots.js'

const origin = (slug: string): GitRemote => ({
  name: 'origin',
  fetchUrl: `git@github.com:${slug}.git`,
  pushUrl: `git@github.com:${slug}.git`
})

const REMOTES_BY_ROOT: Record<string, GitRemote[]> = {
  '/work/other': [origin('acme/other')],
  '/work/app': [origin('acme/app')],
  '/work/fork': [origin('contributor/app')],
  '/Users/me/Developer/app': [origin('acme/app')]
}

const APP_PULL_REQUEST = 'https://github.com/acme/app/pull/7'

interface Harness {
  resolver: PullRequestRootResolver
  probed: string[]
  catalogCalls: number
  advance(milliseconds: number): void
}

function harness(overrides: Partial<PullRequestRootSources> = {}): Harness {
  const probed: string[] = []
  let clock = 1_000
  const state = { catalogCalls: 0 }
  const sources: PullRequestRootSources = {
    rememberedRoot: () => null,
    openRoots: () => [],
    approvedRoots: () => [],
    catalogRoots: async () => {
      state.catalogCalls += 1
      return ['/Users/me/Developer/notes', '/Users/me/Developer/app']
    },
    remotesFor: async (root) => {
      probed.push(root)
      return REMOTES_BY_ROOT[root] ?? []
    },
    ...overrides
  }
  const resolver = new PullRequestRootResolver(sources, () => clock)
  return {
    resolver,
    probed,
    get catalogCalls() {
      return state.catalogCalls
    },
    advance: (milliseconds) => {
      clock += milliseconds
    }
  }
}

describe('folderLooksLikePullRequestRepo', () => {
  test('matches the repository name or owner-repository folder', () => {
    expect(folderLooksLikePullRequestRepo('/Users/me/Developer/app', APP_PULL_REQUEST)).toBe(true)
    expect(folderLooksLikePullRequestRepo('/Users/me/Developer/acme-app', APP_PULL_REQUEST)).toBe(true)
    expect(folderLooksLikePullRequestRepo('/Users/me/Developer/other', APP_PULL_REQUEST)).toBe(false)
  })
})

describe('findMatchingPullRequestRoot', () => {
  const remotesFor = async (root: string): Promise<GitRemote[]> => REMOTES_BY_ROOT[root] ?? []

  test('finds a checkout in the folder catalog', async () => {
    expect(await findMatchingPullRequestRoot(APP_PULL_REQUEST, {
      candidateRoots: ['/Users/me/Developer/notes', '/Users/me/Developer/app'],
      remotesFor
    })).toBe('/Users/me/Developer/app')
  })

  test('accepts a fork remote that hosts the same repository slug', async () => {
    expect(await findMatchingPullRequestRoot('https://github.com/contributor/app/pull/3', {
      candidateRoots: ['/work/fork'],
      remotesFor
    })).toBe('/work/fork')
  })

  test('returns null when no candidate hosts the pull request', async () => {
    expect(await findMatchingPullRequestRoot('https://github.com/missing/repo/pull/1', {
      candidateRoots: ['/Users/me/Developer/app'],
      remotesFor
    })).toBeNull()
  })
})

describe('PullRequestRootResolver', () => {
  test('answers from the remembered folder without probing anything else', async () => {
    const scope = harness({
      rememberedRoot: () => '/work/app',
      openRoots: () => ['/work/other'],
      approvedRoots: () => ['/work/fork']
    })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/app'])
    expect(scope.catalogCalls).toBe(0)
  })

  test('quick stage falls through remembered, open and approved roots', async () => {
    const scope = harness({
      rememberedRoot: () => '/work/other',
      openRoots: () => ['/work/fork'],
      approvedRoots: () => ['/work/app']
    })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/other', '/work/fork', '/work/app'])
  })

  test('quick stage never walks the folder catalog', async () => {
    const scope = harness()
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBeNull()
    expect(scope.catalogCalls).toBe(0)
  })

  test('full stage walks the catalog only after the quick stage misses', async () => {
    const scope = harness({ openRoots: () => ['/work/other'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/Users/me/Developer/app')
    expect(scope.catalogCalls).toBe(1)
    expect(scope.probed).toEqual(['/work/other', '/Users/me/Developer/app'])
  })

  test('the catalog stage skips roots the quick stage already probed', async () => {
    const scope = harness({ approvedRoots: () => ['/Users/me/Developer/notes'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/Users/me/Developer/app')
    expect(scope.probed).toEqual(['/Users/me/Developer/notes', '/Users/me/Developer/app'])
  })

  test('concurrent callers share one resolution', async () => {
    const scope = harness({ openRoots: () => ['/work/app'] })
    const [first, second, third] = await Promise.all([
      scope.resolver.resolve(APP_PULL_REQUEST, 'quick'),
      scope.resolver.resolve(APP_PULL_REQUEST),
      scope.resolver.resolve(APP_PULL_REQUEST, 'quick')
    ])
    expect([first, second, third]).toEqual(['/work/app', '/work/app', '/work/app'])
    expect(scope.probed).toEqual(['/work/app'])
  })

  test('a full resolution reuses a settled quick miss instead of re-probing it', async () => {
    const scope = harness({ openRoots: () => ['/work/other'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBeNull()
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/Users/me/Developer/app')
    expect(scope.probed).toEqual(['/work/other', '/Users/me/Developer/app'])
  })

  test('a resolution is reused inside its window and dropped after it', async () => {
    const scope = harness({ openRoots: () => ['/work/app'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/work/app')
    scope.advance(ROOT_RESOLUTION_TTL_MS - 1)
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/app'])
    scope.advance(REMOTES_CACHE_TTL_MS)
    expect(await scope.resolver.resolve(APP_PULL_REQUEST)).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/app', '/work/app'])
  })

  test('remotes are cached across resolutions of different pull requests', async () => {
    const scope = harness({ openRoots: () => ['/work/other', '/work/app'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
    scope.advance(ROOT_RESOLUTION_TTL_MS + 1)
    expect(await scope.resolver.resolve('https://github.com/acme/app/pull/9', 'quick')).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/other', '/work/app'])
  })

  test('a slug with no local checkout is not re-walked until the negative cache expires', async () => {
    const scope = harness()
    const missing = 'https://github.com/missing/repo/pull/1'
    expect(await scope.resolver.resolve(missing)).toBeNull()
    scope.advance(ROOT_RESOLUTION_TTL_MS + 1)
    expect(await scope.resolver.resolve(missing)).toBeNull()
    expect(scope.catalogCalls).toBe(1)
    scope.advance(MISSING_CHECKOUT_TTL_MS)
    expect(await scope.resolver.resolve(missing)).toBeNull()
    expect(scope.catalogCalls).toBe(2)
  })

  test('pending answers an in-flight resolution and starts none of its own', async () => {
    const scope = harness({ openRoots: () => ['/work/app'] })
    expect(scope.resolver.pending(APP_PULL_REQUEST)).toBeNull()
    const inFlight = scope.resolver.resolve(APP_PULL_REQUEST, 'quick')
    expect(await scope.resolver.pending(APP_PULL_REQUEST)).toBe('/work/app')
    expect(await inFlight).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/app'])
  })

  test('forgetRoot re-probes a checkout whose remotes may have changed', async () => {
    const scope = harness({ openRoots: () => ['/work/app'] })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
    scope.resolver.forgetRoot('/work/app')
    scope.advance(ROOT_RESOLUTION_TTL_MS + 1)
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
    expect(scope.probed).toEqual(['/work/app', '/work/app'])
  })

  test('a failed probe does not poison the cached resolution', async () => {
    let failing = true
    const scope = harness({
      openRoots: () => ['/work/app'],
      remotesFor: async (root) => {
        if (failing) throw new Error('git is not on PATH')
        return REMOTES_BY_ROOT[root] ?? []
      }
    })
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBeNull()
    failing = false
    scope.advance(REMOTES_CACHE_TTL_MS + 1)
    expect(await scope.resolver.resolve(APP_PULL_REQUEST, 'quick')).toBe('/work/app')
  })
})
