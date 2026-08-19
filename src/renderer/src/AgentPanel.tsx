import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { IconArrow, IconChevronSm, IconCommentAdd, IconSparkles, IconX } from '@pierre/icons'

import type { AgentProvider } from '../../shared/contracts'
import {
  agentAttachmentId,
  formatAgentAttachment,
  type AgentAttachment
} from './agentAttachments'
import { keyForBlock, keyForInline, type MarkdownBlock, type MarkdownInline } from './markdown'

interface AgentPanelProps {
  blocks: MarkdownBlock[]
  streaming: boolean
  error: string | null
  question: string
  activity: readonly string[]
  provider: AgentProvider
  attachments: readonly AgentAttachment[]
  contextLabel: string
  onProviderChange(provider: AgentProvider): void
  onRemoveAttachment(id: string): void
  onAsk(prompt: string): void
  onCancel(): void
  onReset(): void
  onClose(): void
}

const QUICK_PROMPTS = [
  { label: 'Explain', prompt: 'Explain what this change does and why, in a few short paragraphs.' },
  { label: 'Risks', prompt: 'Review this change for bugs, edge cases, and risky behaviour. Be specific and cite file names.' },
  { label: 'Tests', prompt: 'What tests would meaningfully cover this change? List concrete cases.' }
] as const

function InlineRun({ inline }: { inline: MarkdownInline }): React.JSX.Element {
  if (inline.kind === 'code') return <code>{inline.text}</code>
  if (inline.kind === 'strong') return <strong>{inline.text}</strong>
  if (inline.kind === 'emphasis') return <em>{inline.text}</em>
  return <>{inline.text}</>
}

function InlineContent({ content }: { content: MarkdownInline[] }): React.JSX.Element {
  const seen = new Map<string, number>()
  return <>{content.map((inline) => <InlineRun key={keyForInline(inline, seen)} inline={inline} />)}</>
}

const AnswerMarkdown = memo(function AnswerMarkdown({ blocks }: { blocks: MarkdownBlock[] }): React.JSX.Element {
  const keyed = useMemo(() => {
    const seen = new Map<string, number>()
    return blocks.map((block) => ({ block, key: keyForBlock(block, seen) }))
  }, [blocks])
  return (
    <div className="agent-answer">
      {keyed.map(({ block, key }) => {
        if (block.kind === 'code') {
          return (
            <pre key={key}>
              {block.language == null ? null : <span className="agent-code-language">{block.language}</span>}
              <code>{block.text}</code>
            </pre>
          )
        }
        if (block.kind === 'heading') {
          const Heading = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
          return <Heading key={key}><InlineContent content={block.content} /></Heading>
        }
        if (block.kind === 'quote') {
          return <blockquote key={key}><InlineContent content={block.content} /></blockquote>
        }
        if (block.kind === 'list') {
          const itemKeys = new Map<string, number>()
          return block.ordered
            ? <ol key={key}>{block.items.map((item) => <li key={keyForInline(item[0] ?? { kind: 'text', text: '' }, itemKeys)}><InlineContent content={item} /></li>)}</ol>
            : <ul key={key}>{block.items.map((item) => <li key={keyForInline(item[0] ?? { kind: 'text', text: '' }, itemKeys)}><InlineContent content={item} /></li>)}</ul>
        }
        return <p key={key}><InlineContent content={block.content} /></p>
      })}
    </div>
  )
})

export const AgentPanel = memo(function AgentPanel({
  blocks,
  streaming,
  error,
  question,
  activity,
  provider,
  attachments,
  contextLabel,
  onProviderChange,
  onRemoveAttachment,
  onAsk,
  onCancel,
  onReset,
  onClose
}: AgentPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const started = question !== '' || blocks.length > 0 || error != null

  // Attaching a selection is a request to type about it, so focus lands in the
  // composer instead of leaving the user to click into it.
  const latestAttachment = attachments.at(-1)
  const latestAttachmentId = latestAttachment == null ? null : agentAttachmentId(latestAttachment)
  useEffect(() => {
    if (latestAttachmentId != null) composerRef.current?.focus()
  }, [latestAttachmentId])

  // Follow the tail while an answer streams, but never fight a user who has
  // scrolled up to read something earlier.
  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript == null || !streaming) return
    const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
    if (distanceFromBottom < 120) transcript.scrollTop = transcript.scrollHeight
  }, [activity, blocks, streaming])

  const send = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (trimmed === '' || streaming) return
    onAsk(trimmed)
    setDraft('')
  }

  return (
    <aside className="agent-dock" aria-label="Agent">
      <header className="agent-dock-header">
        <span className="agent-dock-title">
          <IconSparkles aria-hidden="true" />
          Ask about this review
        </span>
        <div className="agent-dock-header-actions">
          {started ? (
            <button type="button" onClick={onReset} aria-label="New conversation" title="New conversation">
              <IconCommentAdd />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close agent panel" title="Close">
            <IconX />
          </button>
        </div>
      </header>

      <div className="agent-dock-transcript" ref={transcriptRef}>
        {/* The question stays on screen as the first message; showing it only in
            the header meant the turn you sent disappeared once it was answered. */}
        {question === '' ? null : <p className="agent-question">{question}</p>}

        {started ? null : (
          <div className="agent-dock-empty">
            <p>Ask anything about {contextLabel}, or select lines in the diff and press <kbd>⌘I</kbd>.</p>
            <div className="agent-quick-prompts">
              {QUICK_PROMPTS.map((quick) => (
                <button key={quick.label} type="button" disabled={streaming}
                  onClick={() => onAsk(quick.prompt)}>{quick.label}</button>
              ))}
            </div>
            <span>Runs on this machine. Your diff goes to the agent you pick, only when you ask.</span>
          </div>
        )}

        {activity.length > 0 ? (
          <ol className="agent-activity" aria-label="What the agent did">
            {activity.map((line, index) => <li key={`${line}#${index}`}>{line}</li>)}
          </ol>
        ) : null}

        {error != null ? <div className="agent-dock-error" role="alert">{error}</div> : null}
        {blocks.length > 0 ? <AnswerMarkdown blocks={blocks} /> : null}
        {streaming && blocks.length === 0 && activity.length === 0 ? (
          <div className="agent-streaming" role="status"><span /><span /><span /></div>
        ) : null}
      </div>

      <div className="agent-composer">
        <form onSubmit={(event) => {
          event.preventDefault()
          send(draft)
        }}>
          {attachments.length > 0 ? (
            <div className="agent-attachments" aria-label="Attached selections">
              {attachments.map((attachment) => {
                const id = agentAttachmentId(attachment)
                return (
                  <span className="agent-attachment" key={id} title={id}>
                    <code>{formatAgentAttachment(attachment)}</code>
                    <button type="button" onClick={() => onRemoveAttachment(id)}
                      aria-label={`Remove ${id}`}><IconX /></button>
                  </span>
                )
              })}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            value={draft}
            name="agent-question"
            rows={1}
            placeholder={started ? 'Send follow up…' : 'Ask about this diff…'}
            aria-label={started ? 'Send a follow up' : 'Ask about this diff'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              send(draft)
            }}
          />
          <div className="agent-composer-actions">
            <span className="agent-provider select-control">
              <select name="agent-provider" aria-label="Agent" value={provider}
                onChange={(event) => onProviderChange(event.target.value as AgentProvider)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              <IconChevronSm aria-hidden="true" />
            </span>
            {streaming ? (
              <button type="button" className="agent-send stopping" onClick={onCancel}
                aria-label="Stop the answer" title="Stop"><IconX /></button>
            ) : (
              <button type="submit" className="agent-send" disabled={draft.trim() === ''}
                aria-label="Send message" title="Send message"><IconArrow /></button>
            )}
          </div>
        </form>

      </div>
    </aside>
  )
})
