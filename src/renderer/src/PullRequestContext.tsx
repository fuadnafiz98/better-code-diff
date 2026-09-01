import { useId, useState } from 'react'
import { IconBrandGithub, IconChevronSm } from '@pierre/icons'

import type { PullRequestConversation } from '../../shared/contracts'
import { GitHubMarkdownContent } from './GitHubMarkdownContent'
import { formatCommentAge } from './RemoteReviewThreads'
import { useReviewClock } from './reviewClock'

function reviewStateLabel(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ')
}

export function PullRequestContext({ conversation }: {
  conversation: PullRequestConversation | null
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  const now = useReviewClock()
  const body = conversation?.body.trim() ?? ''
  const reviews = conversation?.reviews ?? []
  if (body === '' && reviews.length === 0) return null

  const longBody = body.split('\n').length > 10 || body.length > 1_200
  const description = body === '' ? null : (
    <GitHubMarkdownContent source={body} className="pr-context-markdown" />
  )

  return (
    <section className="pr-context" aria-label="Pull request context">
      <header>
        <button type="button" className="pr-context-toggle" aria-expanded={expanded}
          aria-controls={contentId} onClick={() => setExpanded((current) => !current)}>
          <IconChevronSm className="pr-context-chevron" aria-hidden="true" />
          <IconBrandGithub aria-hidden="true" />
          <strong>Pull request context</strong>
        </button>
      </header>
      {expanded ? (
        <div id={contentId}>
          {longBody ? (
            <details>
              <summary>Show description</summary>
              {description}
            </details>
          ) : description}
          {reviews.length > 0 ? (
            <ol className="pr-context-reviews" aria-label="Submitted reviews">
              {reviews.map((review) => (
                <li className="pr-row compact" key={review.id}>
                  <div className="pr-row-title">
                    <strong>{review.authorLogin}</strong>
                    <em data-review-state={review.state.toLowerCase()}>{reviewStateLabel(review.state)}</em>
                  </div>
                  {review.submittedAt == null ? null : (
                    <div className="pr-row-meta">{formatCommentAge(review.submittedAt, now)}</div>
                  )}
                  {review.body.trim() === '' ? null : (
                    <GitHubMarkdownContent source={review.body} className="pr-context-review-body" />
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
