import { useState } from 'react'
import {
  IconApproved,
  IconComment,
  IconInReview,
  IconWarningOctogonFill,
  IconX
} from '@pierre/icons'

import type { PullRequestReviewEvent } from '../../shared/contracts'

interface PullRequestReviewBarProps {
  submitting: boolean
  message: string | null
  onSubmit(event: PullRequestReviewEvent, body: string): void
}

export function PullRequestReviewBar({ submitting, message, onSubmit }: PullRequestReviewBarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState('')

  if (!expanded) {
    return (
      <div className="pr-review-bar compact">
        <span className={message == null ? undefined : 'success'}>{message ?? 'Review this pull request on GitHub'}</span>
        <button type="button" onClick={() => setExpanded(true)}><IconInReview />Submit Review</button>
      </div>
    )
  }

  return (
    <section className="pr-review-bar expanded" aria-label="Submit pull request review">
      <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add an optional approval note, or explain requested changes…" autoFocus />
      <div>
        <button type="button" onClick={() => setExpanded(false)} disabled={submitting}><IconX />Cancel</button>
        <button type="button" onClick={() => onSubmit('comment', body)} disabled={submitting || body.trim() === ''}><IconComment />Comment</button>
        <button className="danger" type="button" onClick={() => onSubmit('request-changes', body)} disabled={submitting || body.trim() === ''}><IconWarningOctogonFill />Request Changes</button>
        <button className="primary" type="button" onClick={() => onSubmit('approve', body)} disabled={submitting}><IconApproved />Approve</button>
      </div>
    </section>
  )
}
