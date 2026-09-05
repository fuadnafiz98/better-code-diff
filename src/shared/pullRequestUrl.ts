const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const GITHUB_SLUG_PART = /^[A-Za-z0-9_.-]+$/
const EMBEDDED_PULL_REQUEST_URL =
  /https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/i

export interface GitHubPullRequestRef {
  owner: string
  repository: string
  number: number
  url: string
}

/**
 * Returns the stable URL accepted by `gh pr view`, or null when the input is not
 * an HTTPS GitHub pull-request URL. Query parameters, fragments, and view suffixes
 * are navigation details and are deliberately removed from the selector.
 */
export function normalizeGitHubPullRequestUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }

  if (
    url.protocol !== 'https:'
    || !GITHUB_HOSTS.has(url.hostname.toLowerCase())
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
  ) return null

  const parts = url.pathname.split('/').filter(Boolean)
  const [owner, repository, pullSegment, rawNumber] = parts
  if (
    owner == null
    || repository == null
    || pullSegment?.toLowerCase() !== 'pull'
    || rawNumber == null
    || !GITHUB_SLUG_PART.test(owner)
    || !GITHUB_SLUG_PART.test(repository)
    || !/^\d+$/.test(rawNumber)
  ) return null

  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number < 1) return null
  return `https://github.com/${owner}/${repository}/pull/${number}`
}

/**
 * Accepts a bare pull-request URL or a larger copied blob (Slack, mail, markdown)
 * that contains one.
 */
export function extractGitHubPullRequestUrl(value: string): string | null {
  const direct = normalizeGitHubPullRequestUrl(value)
  if (direct != null) return direct
  const match = EMBEDDED_PULL_REQUEST_URL.exec(value)
  return match == null ? null : normalizeGitHubPullRequestUrl(match[0])
}

export function describeGitHubPullRequest(value: string): GitHubPullRequestRef | null {
  const url = extractGitHubPullRequestUrl(value)
  if (url == null) return null
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  const [owner, repository, , rawNumber] = parts
  if (owner == null || repository == null || rawNumber == null) return null
  return { owner, repository, number: Number(rawNumber), url }
}

export function githubRepoSlugFromPullRequestUrl(value: string): string | null {
  const ref = describeGitHubPullRequest(value)
  if (ref == null) return null
  return `${ref.owner}/${ref.repository}`.toLowerCase()
}
