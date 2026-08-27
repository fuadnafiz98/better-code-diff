import type { RepositoryReview } from '../../shared/contracts'

const AGENT_CONTEXT_FILE_LIMIT = 80

export function formatAgentReviewContext(review: RepositoryReview | null): string {
  if (review == null) return ''
  const identity = review.kind === 'github'
    ? [
        `GitHub pull request: #${review.pullRequest.number} ${review.pullRequest.title}`,
        `URL: ${review.pullRequest.url}`,
        `Branches: ${review.pullRequest.baseRefName} ← ${review.pullRequest.headRefName}`
      ]
    : [
        `Local review: ${review.title}`,
        `Branches: ${review.baseRefName} ← ${review.headRefName}`
      ]
  const omitted = review.omittedFiles.length === 0
    ? []
    : [`Files omitted from the inline patch: ${review.omittedFiles.map((file) => file.path).join(', ')}`]
  const listedFiles = review.files.slice(0, AGENT_CONTEXT_FILE_LIMIT).map((file) => (
    `${file.path} (+${file.additions}/-${file.deletions})`
  ))
  const overflow = review.files.length > AGENT_CONTEXT_FILE_LIMIT
    ? [`…and ${review.files.length - AGENT_CONTEXT_FILE_LIMIT} more files`]
    : []
  return [...identity, ...omitted, 'Changed files:', ...listedFiles, ...overflow].join('\n')
}
