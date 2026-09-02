import { extractGitHubPullRequestUrl } from './pullRequestUrl.js'

export const HORUS_PROTOCOL = 'horus'
export const HORUS_REVIEW_HOST = 'review'

export type HorusReviewIntent = 'open' | 'warmup'

export interface HorusReviewRequest {
  url: string
  intent: HorusReviewIntent
}

const HORUS_URL_FLAG = '--horus-url'

/**
 * Deep link used by the Raycast extension and `open horus://…`.
 * `intent=open` is omitted so the common case stays short.
 */
export function formatHorusReviewUrl(pullRequestUrl: string, intent: HorusReviewIntent = 'open'): string | null {
  const url = extractGitHubPullRequestUrl(pullRequestUrl)
  if (url == null) return null
  const params = new URLSearchParams({ url })
  if (intent === 'warmup') params.set('intent', 'warmup')
  return `${HORUS_PROTOCOL}://${HORUS_REVIEW_HOST}?${params.toString()}`
}

export function parseHorusReviewUrl(value: string): HorusReviewRequest | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return extractReviewRequest(value)
  }

  if (parsed.protocol !== `${HORUS_PROTOCOL}:` || parsed.username !== '' || parsed.password !== '') {
    return extractReviewRequest(value)
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== HORUS_REVIEW_HOST && host !== '') return null
  if (host === '' && parsed.pathname.replace(/^\//, '').toLowerCase() !== HORUS_REVIEW_HOST) return null

  const url = extractGitHubPullRequestUrl(parsed.searchParams.get('url') ?? '')
  if (url == null) return null
  const rawIntent = parsed.searchParams.get('intent')
  if (rawIntent != null && rawIntent !== 'open' && rawIntent !== 'warmup') return null
  return { url, intent: rawIntent === 'warmup' ? 'warmup' : 'open' }
}

/**
 * Picks a review request out of process argv. `--horus-url` wins, then a
 * `horus://` link, then a GitHub pull-request URL. Electron helper flags and
 * paths are ignored.
 */
export function findHorusReviewRequest(argv: readonly string[]): HorusReviewRequest | null {
  let flagged: HorusReviewRequest | null = null
  let deepLink: HorusReviewRequest | null = null
  let github: HorusReviewRequest | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument == null || argument === '') continue

    if (argument === HORUS_URL_FLAG) {
      const value = argv[index + 1]
      if (value != null) flagged = parseHorusReviewUrl(value) ?? extractReviewRequest(value)
      continue
    }
    if (argument.startsWith(`${HORUS_URL_FLAG}=`)) {
      const value = argument.slice(HORUS_URL_FLAG.length + 1)
      flagged = parseHorusReviewUrl(value) ?? extractReviewRequest(value)
      continue
    }

    const fromDeepLink = parseHorusProtocolArgument(argument)
    if (fromDeepLink != null) {
      deepLink = fromDeepLink
      continue
    }

    const fromGitHub = extractReviewRequest(argument)
    if (fromGitHub != null) github = fromGitHub
  }

  return flagged ?? deepLink ?? github
}

function parseHorusProtocolArgument(value: string): HorusReviewRequest | null {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith(`${HORUS_PROTOCOL}:`)) return null
  return parseHorusReviewUrl(trimmed)
}

function extractReviewRequest(value: string): HorusReviewRequest | null {
  const url = extractGitHubPullRequestUrl(value)
  return url == null ? null : { url, intent: 'open' }
}
