import { useEffect, useRef, useState } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import {
  IconApproved,
  IconCheck,
  IconComment,
  IconCommentAdd,
  IconPencil,
  IconReply,
  IconTrash,
  IconX
} from '@pierre/icons'

export interface ReviewReply {
  id: string
  body: string
}

export interface ReviewThread {
  id: string
  body: string
  lineNumber: number
  side?: 'additions' | 'deletions'
  range: SelectedLineRange
  replies: ReviewReply[]
  resolved: boolean
}

export type ReviewAnnotationMetadata =
  | { kind: 'draft'; range: SelectedLineRange }
  | { kind: 'thread'; thread: ReviewThread }

interface DraftCommentProps {
  range: SelectedLineRange
  onCancel(): void
  onSave(body: string): void
}

export function formatSelectedRange(range: SelectedLineRange): string {
  const side = range.side === 'deletions' ? 'old' : range.side === 'additions' ? 'new' : null
  const lines = range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`
  return side == null ? lines : `${lines} · ${side}`
}

export function DraftComment({ range, onCancel, onSave }: DraftCommentProps): React.JSX.Element {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const save = (): void => {
    const nextBody = body.trim()
    if (nextBody !== '') onSave(nextBody)
  }

  return (
    <div className="review-card review-draft">
      <div className="review-card-heading">
        <strong><IconCommentAdd />New comment</strong>
        <span>{formatSelectedRange(range)}</span>
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
        }}
        placeholder="Leave a review comment…"
        aria-label="Review comment"
        rows={3}
      />
      <div className="review-card-actions">
        <span>⌘ Enter to save</span>
        <button type="button" onClick={onCancel}><IconX />Cancel</button>
        <button className="primary" type="button" onClick={save} disabled={body.trim() === ''}><IconComment />Comment</button>
      </div>
    </div>
  )
}

interface ReviewThreadCardProps {
  thread: ReviewThread
  onDelete(): void
  onEdit(body: string): void
  onReply(body: string): void
  onToggleResolved(): void
}

export function ReviewThreadCard({
  thread,
  onDelete,
  onEdit,
  onReply,
  onToggleResolved
}: ReviewThreadCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(thread.body)
  const [replying, setReplying] = useState(false)
  const [replyBody, setReplyBody] = useState('')

  const saveEdit = (): void => {
    const body = editBody.trim()
    if (body === '') return
    onEdit(body)
    setEditing(false)
  }

  const saveReply = (): void => {
    const body = replyBody.trim()
    if (body === '') return
    onReply(body)
    setReplyBody('')
    setReplying(false)
  }

  return (
    <article className={`review-card review-thread ${thread.resolved ? 'resolved' : ''}`}>
      <header className="review-thread-header">
        <span className="review-avatar" aria-hidden="true">Y</span>
        <strong>You</strong>
        <span>now</span>
        {thread.resolved ? <span className="review-resolved-label">Resolved</span> : null}
      </header>

      {editing ? (
        <div className="review-edit-area">
          <textarea aria-label="Edit review comment" value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={3} />
          <div className="review-card-actions">
            <button type="button" onClick={() => { setEditBody(thread.body); setEditing(false) }}><IconX />Cancel</button>
            <button className="primary" type="button" onClick={saveEdit}><IconCheck />Save</button>
          </div>
        </div>
      ) : (
        <p>{thread.body}</p>
      )}

      {thread.replies.map((reply) => (
        <div className="review-reply" key={reply.id}>
          <span className="review-avatar" aria-hidden="true">Y</span>
          <div><strong>You</strong><p>{reply.body}</p></div>
        </div>
      ))}

      {replying ? (
        <div className="review-reply-composer">
          <textarea
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setReplying(false)
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveReply()
            }}
            placeholder="Reply…"
            aria-label="Reply to review comment"
            rows={2}
            autoFocus
          />
          <div className="review-card-actions">
            <button type="button" onClick={() => setReplying(false)}><IconX />Cancel</button>
            <button className="primary" type="button" onClick={saveReply} disabled={replyBody.trim() === ''}><IconReply />Reply</button>
          </div>
        </div>
      ) : null}

      <footer className="review-thread-actions">
        <button type="button" onClick={() => setReplying(true)}><IconReply />Reply</button>
        <button type="button" onClick={() => setEditing(true)}><IconPencil />Edit</button>
        <button type="button" onClick={onToggleResolved}><IconApproved />{thread.resolved ? 'Reopen' : 'Resolve'}</button>
        <button className="danger" type="button" onClick={onDelete}><IconTrash />Delete</button>
      </footer>
    </article>
  )
}
