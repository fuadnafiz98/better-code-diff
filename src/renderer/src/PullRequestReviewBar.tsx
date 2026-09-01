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
  orphanedCommentCount: number
  viewerCanSubmitDecision: boolean
  onOpen(): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

export function PullRequestReviewBar({
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  viewerCanSubmitDecision,
  onOpen,
  onSubmit
}: PullRequestReviewBarProps): React.JSX.Element {
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
      <div className="review-bar pr-review-bar compact">
        <span className={message == null ? undefined : 'success'}>
          {message ?? (orphanedCommentCount > 0
            ? `${orphanedCommentCount} orphaned ${orphanedCommentCount === 1 ? 'comment needs' : 'comments need'} attention`
            : inlineCommentCount === 0
            ? 'Review this pull request on GitHub'
            : `${inlineCommentCount} inline ${inlineCommentCount === 1 ? 'comment' : 'comments'} ready`)}
        </span>
        <button className="bar-button" type="button" onClick={() => { onOpen(); setExpanded(true) }}><IconInReview />Submit Review</button>
      </div>
    )
  }

  const hasReviewMessage = body.trim() !== ''
  const hasReviewContent = hasReviewMessage || inlineCommentCount > 0

  return (
    <section className="review-bar pr-review-bar expanded" aria-label="Submit pull request review">
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
      {message == null ? null : <p className="success" role="alert">{message}</p>}
      {inlineCommentCount > 0 ? <p>{inlineCommentCount} unresolved inline {inlineCommentCount === 1 ? 'comment' : 'comments'} will be posted with this review.</p> : null}
      {orphanedCommentCount > 0 ? <p>{orphanedCommentCount} orphaned {orphanedCommentCount === 1 ? 'comment must' : 'comments must'} be reattached or dropped before submission.</p> : null}
      {!viewerCanSubmitDecision ? <p>GitHub only allows comment reviews on your own pull request.</p> : null}
      <div>
        <button className="bar-button" type="button" onClick={() => setExpanded(false)} disabled={submitting}><IconX />Cancel</button>
        <button className="bar-button" type="button" onClick={() => void submit('comment')}
          disabled={submitting || !hasReviewContent || orphanedCommentCount > 0}><IconComment />Comment</button>
        <button
          className="bar-button danger"
          type="button"
          title={viewerCanSubmitDecision ? undefined : 'You cannot request changes on your own pull request.'}
          onClick={() => void submit('request-changes')}
          disabled={submitting || !hasReviewContent || !viewerCanSubmitDecision || orphanedCommentCount > 0}
        ><IconWarningOctogonFill />Request Changes</button>
        <button
          className="bar-button primary"
          type="button"
          title={viewerCanSubmitDecision ? undefined : 'You cannot approve your own pull request.'}
          onClick={() => void submit('approve')}
          disabled={submitting || !viewerCanSubmitDecision || orphanedCommentCount > 0}
        ><IconApproved />Approve</button>
      </div>
    </section>
  )
}
