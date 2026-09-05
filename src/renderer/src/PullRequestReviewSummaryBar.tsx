import { IconInReview } from '@pierre/icons'

import { reviewBarSummary } from './pullRequestReviewBarModel'

export interface PullRequestReviewSummaryBarProps {
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  onSubmitReview(): void
}

/** The collapsed toolbar bar: one line of status and the way into the composer. */
export function PullRequestReviewSummaryBar({
  message,
  inlineCommentCount,
  orphanedCommentCount,
  onSubmitReview
}: PullRequestReviewSummaryBarProps): React.JSX.Element {
  return (
    <div className="review-bar pr-review-bar compact">
      <span className={message == null ? undefined : 'success'}>
        {reviewBarSummary(message, inlineCommentCount, orphanedCommentCount)}
      </span>
      <button className="bar-button" type="button" onClick={onSubmitReview}><IconInReview />Submit Review</button>
    </div>
  )
}
