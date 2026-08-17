import { useEffect, useRef, useState } from 'react'
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
  inlineCommentCount: number
  viewerCanSubmitDecision: boolean
  onOpen(): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

export function PullRequestReviewBar({ submitting, message, inlineCommentCount, viewerCanSubmitDecision, onOpen, onSubmit }: PullRequestReviewBarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (expanded) bodyRef.current?.focus()
  }, [expanded])

  const submit = async (event: PullRequestReviewEvent): Promise<void> => {
    if (!await onSubmit(event, body)) return
    setBody('')
    setExpanded(false)
  }

  if (!expanded) {
    return (
      <div className="pr-review-bar compact">
        <span className={message == null ? undefined : 'success'}>
          {message ?? (inlineCommentCount === 0
            ? 'Review this pull request on GitHub'
            : `${inlineCommentCount} inline ${inlineCommentCount === 1 ? 'comment' : 'comments'} ready`)}
        </span>
        <button type="button" onClick={() => { onOpen(); setExpanded(true) }}><IconInReview />Submit Review</button>
      </div>
    )
  }

  const hasReviewMessage = body.trim() !== ''
  const hasReviewContent = hasReviewMessage || inlineCommentCount > 0

  return (
    <section className="pr-review-bar expanded" aria-label="Submit pull request review">
      <label className="sr-only" htmlFor="pull-request-review-body">Review summary</label>
      <textarea
        ref={bodyRef}
        id="pull-request-review-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={viewerCanSubmitDecision
          ? 'Add an optional approval note, or explain requested changes…'
          : 'Add a review comment…'}
      />
      {inlineCommentCount > 0 ? <p>{inlineCommentCount} unresolved inline {inlineCommentCount === 1 ? 'comment' : 'comments'} will be posted with this review.</p> : null}
      {!viewerCanSubmitDecision ? <p>GitHub only allows comment reviews on your own pull request.</p> : null}
      <div>
        <button type="button" onClick={() => setExpanded(false)} disabled={submitting}><IconX />Cancel</button>
        <button type="button" onClick={() => void submit('comment')} disabled={submitting || !hasReviewContent}><IconComment />Comment</button>
        <button
          className="danger"
          type="button"
          title={viewerCanSubmitDecision ? undefined : 'You cannot request changes on your own pull request.'}
          onClick={() => void submit('request-changes')}
          disabled={submitting || !hasReviewContent || !viewerCanSubmitDecision}
        ><IconWarningOctogonFill />Request Changes</button>
        <button
          className="primary"
          type="button"
          title={viewerCanSubmitDecision ? undefined : 'You cannot approve your own pull request.'}
          onClick={() => void submit('approve')}
          disabled={submitting || !viewerCanSubmitDecision}
        ><IconApproved />Approve</button>
      </div>
    </section>
  )
}
