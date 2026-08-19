import { useState } from 'react'
import { IconApproved, IconBrandGithub, IconCheck, IconRefresh, IconReply } from '@pierre/icons'

import type { RemoteReviewThread } from '../../shared/contracts'

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatCommentAge(value: string, now: number): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsedMinutes = Math.round((timestamp - now) / 60_000)
  if (Math.abs(elapsedMinutes) < 60) return RELATIVE_TIME_FORMATTER.format(elapsedMinutes, 'minute')
  const elapsedHours = Math.round(elapsedMinutes / 60)
  if (Math.abs(elapsedHours) < 24) return RELATIVE_TIME_FORMATTER.format(elapsedHours, 'hour')
  return RELATIVE_TIME_FORMATTER.format(Math.round(elapsedHours / 24), 'day')
}

interface RemoteReviewThreadCardProps {
  thread: RemoteReviewThread
  pending: boolean
  onReply(threadId: string, body: string): void
  onToggleResolved(threadId: string, resolved: boolean): void
}

export function RemoteReviewThreadCard({
  thread,
  pending,
  onReply,
  onToggleResolved
}: RemoteReviewThreadCardProps): React.JSX.Element {
  const [replyBody, setReplyBody] = useState('')
  const [composing, setComposing] = useState(false)
  const now = Date.now()

  return (
    <article className={`review-card review-thread review-remote-thread ${thread.resolved ? 'resolved' : ''}`}>
      <header>
        <IconBrandGithub aria-hidden="true" />
        <strong>{thread.comments[0]?.authorLogin ?? 'GitHub'}</strong>
        {thread.outdated ? <em>Outdated</em> : null}
        {thread.resolved ? <em>Resolved</em> : null}
        <button type="button" disabled={pending}
          title={thread.resolved ? 'Reopen thread on GitHub' : 'Resolve thread on GitHub'}
          aria-label={thread.resolved ? 'Reopen thread on GitHub' : 'Resolve thread on GitHub'}
          onClick={() => onToggleResolved(thread.id, !thread.resolved)}>
          {pending ? <IconRefresh className="spin" /> : thread.resolved ? <IconCheck /> : <IconApproved />}
        </button>
      </header>
      {thread.comments.map((comment) => (
        <div className="review-remote-comment" key={comment.id}>
          <span><strong>{comment.authorLogin}</strong>{formatCommentAge(comment.createdAt, now)}</span>
          <p>{comment.body}</p>
        </div>
      ))}
      {composing ? (
        <div className="review-reply-composer">
          <textarea value={replyBody} rows={2} autoFocus
            aria-label={`Reply to ${thread.comments[0]?.authorLogin ?? 'GitHub'}`}
            placeholder="Reply on GitHub…" onChange={(event) => setReplyBody(event.target.value)} />
          <div>
            <button type="button" onClick={() => { setComposing(false); setReplyBody('') }}>Cancel</button>
            <button className="primary" type="button" disabled={replyBody.trim() === '' || pending}
              onClick={() => {
                onReply(thread.id, replyBody.trim())
                setComposing(false)
                setReplyBody('')
              }}>
              {pending ? <IconRefresh className="spin" /> : <IconReply />}Reply
            </button>
          </div>
        </div>
      ) : (
        <button className="review-remote-reply" type="button" disabled={pending} onClick={() => setComposing(true)}>
          <IconReply />Reply on GitHub
        </button>
      )}
    </article>
  )
}
