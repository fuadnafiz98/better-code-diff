import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconCodeComments, IconCopy, IconRefresh, IconTrash, IconX } from '@pierre/icons'

import { formatSelectedRange, type ReviewThread } from './ReviewComments'

export interface ReviewSummaryEntry {
  path: string
  thread: ReviewThread
}

export function formatReviewCommentsForAgent(entries: readonly ReviewSummaryEntry[]): string {
  const comments = entries.map(({ path, thread }, index) => {
    const replies = thread.replies.map((reply) => `   Reply: ${reply.body}`).join('\n')
    const status = thread.orphaned ? ' [Orphaned — verify location]' : ''
    return `${index + 1}. ${path} — ${formatSelectedRange(thread.range)}${status}\n   ${thread.body}${replies === '' ? '' : `\n${replies}`}`
  })
  return `Please address these code review comments:\n\n${comments.join('\n\n')}`
}

const COPY_STATE_MS = { copied: 1_600, failed: 2_400 } as const

interface ReviewSummaryProps {
  entries: readonly ReviewSummaryEntry[]
  reattachingThreadId: string | null
  onBeginReattach(entry: ReviewSummaryEntry): void
  onCancelReattach(): void
  onDrop(entry: ReviewSummaryEntry): void
}

export function ReviewSummary({
  entries,
  reattachingThreadId,
  onBeginReattach,
  onCancelReattach,
  onDrop
}: ReviewSummaryProps): React.JSX.Element | null {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimerRef = useRef(0)

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  if (entries.length === 0) return null

  // Failure needs the same lifecycle as success: a terminal error state is a dead
  // end, with no signal that retrying is even possible.
  const settle = (state: 'copied' | 'failed'): void => {
    window.clearTimeout(resetTimerRef.current)
    setCopyState(state)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), COPY_STATE_MS[state])
  }

  const copyComments = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatReviewCommentsForAgent(entries))
      settle('copied')
    } catch {
      settle('failed')
    }
  }

  return (
    <section className="review-summary" aria-label="Review comments summary">
      <header>
        <div><IconCodeComments /><strong>Review notes</strong><span>{entries.length}</span></div>
        <button type="button" data-copy-state={copyState} onClick={() => void copyComments()}>
          <span className="icon-swap" data-state={copyState === 'copied' ? 'alt' : 'base'}>
            <IconCopy /><IconCheck />
          </span>
          <span className="review-copy-label">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy for agent'}
          </span>
        </button>
      </header>
      <ol>
        {entries.map((entry) => {
          const { path, thread } = entry
          const reattaching = reattachingThreadId === thread.id
          return (
            <li key={thread.id}>
              <div className="review-summary-line"><code>{path}</code><span>{formatSelectedRange(thread.range)}</span>
                {thread.orphaned ? <em data-state="orphaned">Orphaned</em> : thread.resolved ? <em>Resolved</em> : null}
              </div>
              <p>{thread.body}</p>
              {thread.replies.map((reply) => <blockquote key={reply.id}>{reply.body}</blockquote>)}
              {thread.orphaned ? (
                <div className="review-orphan-actions">
                  <span>{reattaching ? 'Select replacement lines in any file.' : 'The original lines no longer have one safe match.'}</span>
                  {reattaching ? (
                    <button type="button" onClick={onCancelReattach}><IconX />Cancel</button>
                  ) : (
                    <button type="button" onClick={() => onBeginReattach(entry)}><IconRefresh />Reattach</button>
                  )}
                  <button type="button" onClick={() => onDrop(entry)}><IconTrash />Drop</button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
