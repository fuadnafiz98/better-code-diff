import type { GitRemote } from '../shared/contracts.js'
import { folderNameFromPath } from '../shared/folderPath.js'
import { describeGitHubPullRequest, githubRepoSlugFromPullRequestUrl } from '../shared/pullRequestUrl.js'

import { pullRequestTargetsRemotes } from './repository.js'

const REMOTE_PROBE_CONCURRENCY = 8
// Cmd+H asks three times — the warmup, the folder chip and the resolve — within a
// few hundred milliseconds. One entry serves all three; the window only has to
// outlive that burst, not the session.
export const ROOT_RESOLUTION_TTL_MS = 5_000
// A checkout's remotes change when someone edits `.git/config`, which is rare
// enough that a minute of staleness costs nothing and saves a spawn per probe.
export const REMOTES_CACHE_TTL_MS = 60_000
// A pull request whose repository is nowhere on this machine must not re-walk the
// folder catalog every time its URL touches the clipboard.
export const MISSING_CHECKOUT_TTL_MS = 60_000

export type PullRequestRootStage = 'quick' | 'full'

export interface PullRequestRootSources {
  /** The folder this slug was last reviewed in, if any. */
  rememberedRoot(slug: string): string | null
  /** Roots with a live repository session. */
  openRoots(): readonly string[]
  /** Roots the user has already approved for this app. */
  approvedRoots(): readonly string[]
  /** The folder catalog. Only consulted by the full stage. */
  catalogRoots(): Promise<readonly string[]>
  remotesFor(root: string): Promise<readonly GitRemote[]>
}

interface RootResolution {
  stage: PullRequestRootStage
  promise: Promise<string | null>
  settledAt: number | null
}

/**
 * Resolves the local checkout for a pull request URL at most once per burst.
 *
 * The quick stage probes what is already known — the remembered folder, then the
 * open sessions, then the approved roots — and spawns nothing else. The full
 * stage adds the folder catalog and is reserved for a user-initiated open; a slug
 * with no local checkout is remembered as missing so the catalog is not walked
 * again on the next clipboard change.
 */
export class PullRequestRootResolver {
  #sources: PullRequestRootSources
  #now: () => number
  #resolutions = new Map<string, RootResolution>()
  #remotes = new Map<string, { promise: Promise<readonly GitRemote[]>; expiresAt: number }>()
  #missingUntil = new Map<string, number>()

  constructor(sources: PullRequestRootSources, now: () => number = Date.now) {
    this.#sources = sources
    this.#now = now
  }

  resolve(pullRequestUrl: string, stage: PullRequestRootStage = 'full'): Promise<string | null> {
    const live = this.#liveResolution(pullRequestUrl)
    if (live != null && (stage === 'quick' || live.stage === 'full')) return live.promise
    const quick = live?.promise ?? this.#resolveQuick(pullRequestUrl)
    if (stage === 'quick') return this.#remember(pullRequestUrl, 'quick', quick)
    const full = quick.then((root) => root ?? this.#resolveCatalog(pullRequestUrl))
    return this.#remember(pullRequestUrl, 'full', full)
  }

  /**
   * The answer a resolution already in flight (or just settled) will give, without
   * starting one. Callers that only decorate the UI must not pay for a probe.
   */
  pending(pullRequestUrl: string): Promise<string | null> | null {
    return this.#liveResolution(pullRequestUrl)?.promise ?? null
  }

  /** Called when a checkout's remotes may have changed. */
  forgetRoot(root: string): void {
    this.#remotes.delete(root)
  }

  #liveResolution(pullRequestUrl: string): RootResolution | null {
    const entry = this.#resolutions.get(pullRequestUrl)
    if (entry == null) return null
    if (entry.settledAt != null && this.#now() - entry.settledAt >= ROOT_RESOLUTION_TTL_MS) {
      this.#resolutions.delete(pullRequestUrl)
      return null
    }
    return entry
  }

  #remember(
    pullRequestUrl: string,
    stage: PullRequestRootStage,
    promise: Promise<string | null>
  ): Promise<string | null> {
    const entry: RootResolution = { stage, promise, settledAt: null }
    this.#resolutions.set(pullRequestUrl, entry)
    void promise.then(
      () => {
        entry.settledAt = this.#now()
      },
      () => {
        if (this.#resolutions.get(pullRequestUrl) === entry) this.#resolutions.delete(pullRequestUrl)
      }
    )
    return promise
  }

  async #resolveQuick(pullRequestUrl: string): Promise<string | null> {
    const slug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
    const remembered = slug == null ? null : this.#sources.rememberedRoot(slug)
    return firstMatchingRootInTiers(
      [
        remembered == null ? [] : [remembered],
        this.#sources.openRoots(),
        this.#sources.approvedRoots()
      ],
      pullRequestUrl,
      (root) => this.#remotesFor(root)
    )
  }

  async #resolveCatalog(pullRequestUrl: string): Promise<string | null> {
    const slug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
    const missingUntil = slug == null ? null : this.#missingUntil.get(slug)
    if (missingUntil != null && missingUntil > this.#now()) return null
    const probed = new Set([
      ...(slug == null ? [] : [this.#sources.rememberedRoot(slug) ?? '']),
      ...this.#sources.openRoots(),
      ...this.#sources.approvedRoots()
    ])
    const catalog = await this.#sources.catalogRoots()
    const match = await findMatchingPullRequestRoot(pullRequestUrl, {
      candidateRoots: catalog.filter((root) => !probed.has(root)),
      remotesFor: (root) => this.#remotesFor(root)
    })
    if (slug == null) return match
    if (match == null) this.#missingUntil.set(slug, this.#now() + MISSING_CHECKOUT_TTL_MS)
    else this.#missingUntil.delete(slug)
    return match
  }

  #remotesFor(root: string): Promise<readonly GitRemote[]> {
    const cached = this.#remotes.get(root)
    if (cached != null && cached.expiresAt > this.#now()) return cached.promise
    const promise = this.#sources.remotesFor(root).catch(() => [] as readonly GitRemote[])
    this.#remotes.set(root, { promise, expiresAt: this.#now() + REMOTES_CACHE_TTL_MS })
    return promise
  }
}

export async function findMatchingPullRequestRoot(
  pullRequestUrl: string,
  options: {
    candidateRoots: readonly string[]
    remotesFor(root: string): Promise<readonly GitRemote[]>
  }
): Promise<string | null> {
  const candidates = uniqueRoots(options.candidateRoots)
  const named = candidates.filter((root) => folderLooksLikePullRequestRepo(root, pullRequestUrl))
  const namedSet = new Set(named)
  return firstMatchingRootInTiers(
    [named, candidates.filter((root) => !namedSet.has(root))],
    pullRequestUrl,
    options.remotesFor
  )
}

/**
 * Probes tier by tier and only inside a tier concurrently, so a remembered folder
 * costs one `git remote -v` instead of a whole wave of them.
 */
export async function firstMatchingRootInTiers(
  tiers: readonly (readonly string[])[],
  pullRequestUrl: string,
  remotesFor: (root: string) => Promise<readonly GitRemote[]>
): Promise<string | null> {
  const seen = new Set<string>()
  for (const tier of tiers) {
    const roots = uniqueRoots(tier).filter((root) => !seen.has(root))
    for (const root of roots) seen.add(root)
    const match = await firstMatchingRoot(roots, pullRequestUrl, remotesFor)
    if (match != null) return match
  }
  return null
}

export function folderLooksLikePullRequestRepo(path: string, pullRequestUrl: string): boolean {
  const ref = describeGitHubPullRequest(pullRequestUrl)
  if (ref == null) return false
  const folder = folderNameFromPath(path).toLowerCase()
  const repository = ref.repository.toLowerCase()
  const owner = ref.owner.toLowerCase()
  return folder === repository || folder === `${owner}-${repository}`
}

async function firstMatchingRoot(
  roots: readonly string[],
  pullRequestUrl: string,
  remotesFor: (root: string) => Promise<readonly GitRemote[]>
): Promise<string | null> {
  for (let index = 0; index < roots.length; index += REMOTE_PROBE_CONCURRENCY) {
    const wave = roots.slice(index, index + REMOTE_PROBE_CONCURRENCY)
    const matches = await Promise.all(wave.map(async (root) => {
      const remotes = await remotesFor(root)
      return pullRequestTargetsRemotes(remotes, pullRequestUrl) ? root : null
    }))
    const match = matches.find((root) => root != null)
    if (match != null) return match
  }
  return null
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.filter((root) => root !== ''))]
}
