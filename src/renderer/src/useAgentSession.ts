import { useCallback, useState } from 'react'

import type { AgentProvider } from '../../shared/contracts'
import {
  agentAttachmentId,
  describeAgentAttachments,
  mergeAgentAttachments,
  type AgentAttachment
} from './agentAttachments'
import { useAgentAnswer, type AgentAnswerApi } from './useAgentAnswer'

interface AgentSessionOptions {
  /** Sent alongside the question so the agent sees the change under review. */
  context: string
}

// Everything the agent panel needs: whether it is docked open, which provider
// answers, and which selections are attached to the next question.
export interface AgentSessionApi {
  answer: AgentAnswerApi
  open: boolean
  provider: AgentProvider
  attachments: readonly AgentAttachment[]
  setProvider(provider: AgentProvider): void
  attach(attachment: AgentAttachment): void
  removeAttachment(id: string): void
  ask(prompt: string): void
  toggle(): void
  close(): void
}

export function useAgentSession({ context }: AgentSessionOptions): AgentSessionApi {
  const answer = useAgentAnswer()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [attachments, setAttachments] = useState<readonly AgentAttachment[]>([])

  const attach = useCallback((attachment: AgentAttachment) => {
    setOpen(true)
    setAttachments((current) => mergeAgentAttachments(current, attachment))
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => agentAttachmentId(attachment) !== id))
  }, [])

  const ask = useCallback((prompt: string) => {
    // The agent reads the repository itself, so the attachment is passed as a
    // file and line reference rather than as a second copy of those lines.
    answer.ask(provider, describeAgentAttachments(attachments, prompt), context, prompt)
    setAttachments([])
  }, [answer, attachments, context, provider])

  const toggle = useCallback(() => setOpen((current) => !current), [])
  const close = useCallback(() => setOpen(false), [])

  return { answer, open, provider, attachments, setProvider, attach, removeAttachment, ask, toggle, close }
}
