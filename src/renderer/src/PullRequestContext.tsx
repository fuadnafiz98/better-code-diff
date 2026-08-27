import { useMemo } from 'react'
import { IconBrandGithub } from '@pierre/icons'

import type { PullRequestConversation } from '../../shared/contracts'
import { MarkdownContent } from './MarkdownContent'
import { parseMarkdown } from './markdown'
import { formatCommentAge } from './RemoteReviewThreads'

function reviewStateLabel(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ')
}

export function PullRequestContext({ conversation }: {
  conversation: PullRequestConversation | null
}): React.JSX.Element | null {
  const body = conversation?.body.trim() ?? ''
  const reviews = conversation?.reviews ?? []
  const blocks = useMemo(() => parseMarkdown(body), [body])
  if (body === '' && reviews.length === 0) return null

  const longBody = body.split('\n').length > 10 || body.length > 1_200
  const description = body === '' ? null : (
    <MarkdownContent blocks={blocks} className="pr-context-markdown" />
  )

  return (
    <section className="pr-context" aria-label="Pull request context">
      <header><IconBrandGithub aria-hidden="true" /><strong>Pull request context</strong></header>
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
                <div className="pr-row-meta">{formatCommentAge(review.submittedAt, Date.now())}</div>
              )}
              {review.body.trim() === '' ? null : (
                <MarkdownContent blocks={parseMarkdown(review.body)} className="pr-context-review-body" />
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
