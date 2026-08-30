import type { AgentRequestSubject, RepositoryReview } from '../../shared/contracts'
import type { ReviewWorld } from './useReviewWorlds'

const AGENT_CONTEXT_FILE_LIMIT = 80

export function agentSubjectForWorld(world: ReviewWorld | null): AgentRequestSubject | null {
  if (world == null || world.source === 'new') return null
  return {
    tabId: world.worldId,
    repositoryRoot: world.root,
    repositoryName: world.snapshot.name,
    source: world.source === 'desk' ? 'workingTree' : world.source,
    baseOid: world.source === 'desk' ? world.snapshot.head : world.baseOid,
    headOid: world.source === 'desk' ? world.snapshot.head : world.headOid
  }
}

export function formatAgentReviewContext(
  review: RepositoryReview | null,
  subject: AgentRequestSubject | null = null
): string {
  const tabContext = subject == null ? [] : [
    `Review tab: ${subject.tabId}`,
    `Repository: ${subject.repositoryName}`,
    `Repository root: ${subject.repositoryRoot}`,
    `Source: ${subject.source}`,
    `Base revision: ${subject.baseOid ?? 'none'}`,
    `Head revision: ${subject.headOid ?? 'working tree without HEAD'}`
  ]
  if (review == null) return tabContext.join('\n')
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
  return [...tabContext, ...identity, ...omitted, 'Changed files:', ...listedFiles, ...overflow].join('\n')
}
