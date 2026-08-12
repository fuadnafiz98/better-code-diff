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

export function ReviewSummary({ entries }: { entries: readonly ReviewSummaryEntry[] }): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

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
    <section className={`review-summary ${entries.length === 0 ? 'empty' : ''}`} aria-label="Review comments summary">
      <header>
        <div><IconCodeComments /><strong>Review comments</strong><span>{entries.length}</span></div>
        {entries.length > 0 ? (
          <button type="button" onClick={() => void copyComments()}>
            {copyState === 'copied' ? <IconCheck /> : <IconCopy />}
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy for agent'}
          </button>
        ) : null}
      </header>
      {entries.length === 0 ? (
        <p>Select one or more lines, or use the gutter plus button, to add a comment.</p>
      ) : (
        <ol>
          {entries.map(({ path, thread }) => (
            <li key={thread.id}>
              <div><code>{path}</code><span>{formatSelectedRange(thread.range)}</span>{thread.resolved ? <em>Resolved</em> : null}</div>
              <p>{thread.body}</p>
              {thread.replies.map((reply) => <blockquote key={reply.id}>{reply.body}</blockquote>)}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
