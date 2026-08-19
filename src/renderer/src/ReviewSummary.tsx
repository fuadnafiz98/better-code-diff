import { useState } from 'react'
import { IconCheck, IconCodeComments, IconCopy } from '@pierre/icons'

import { formatSelectedRange, type ReviewThread } from './ReviewComments'

export interface ReviewSummaryEntry {
  path: string
  thread: ReviewThread
}

export function formatReviewCommentsForAgent(entries: readonly ReviewSummaryEntry[]): string {
  const comments = entries.map(({ path, thread }, index) => {
    const replies = thread.replies.map((reply) => `   Reply: ${reply.body}`).join('\n')
    return `${index + 1}. ${path} — ${formatSelectedRange(thread.range)}\n   ${thread.body}${replies === '' ? '' : `\n${replies}`}`
  })
  return `Please address these code review comments:\n\n${comments.join('\n\n')}`
}

export function ReviewSummary({ entries }: { entries: readonly ReviewSummaryEntry[] }): React.JSX.Element | null {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  if (entries.length === 0) return null

  const copyComments = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatReviewCommentsForAgent(entries))
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_600)
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section className="review-summary" aria-label="Review comments summary">
      <header>
        <div><IconCodeComments /><strong>Review notes</strong><span>{entries.length}</span></div>
        <button type="button" onClick={() => void copyComments()}>
          <span className="icon-swap copy-icon-swap" data-state={copyState === 'copied' ? 'alt' : 'base'}>
            <IconCopy /><IconCheck />
          </span>
          <span className="review-copy-label">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy for agent'}
          </span>
        </button>
      </header>
      <ol>
        {entries.map(({ path, thread }) => (
          <li key={thread.id}>
            <div><code>{path}</code><span>{formatSelectedRange(thread.range)}</span>{thread.resolved ? <em>Resolved</em> : null}</div>
            <p>{thread.body}</p>
            {thread.replies.map((reply) => <blockquote key={reply.id}>{reply.body}</blockquote>)}
          </li>
        ))}
      </ol>
    </section>
  )
}
