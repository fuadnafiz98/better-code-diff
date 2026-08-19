import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentProvider } from '../../shared/contracts'
import { getErrorMessage } from './repositoryApi'
import {
  advanceStreamingMarkdown,
  EMPTY_STREAMING_MARKDOWN,
  type MarkdownBlock,
  type StreamingMarkdown
} from './markdown'
import { markAgentStreamEvent } from './reviewMetrics'

const MAX_ANSWER_LENGTH = 200_000

interface AgentAnswerState {
  answer: string
  streaming: boolean
  error: string | null
  sessionId: string | null
  /** Echoed above the answer so a long stream still shows what was asked. */
  question: string
  /** What the agent did on the way to the answer: tool calls, thinking. */
  activity: readonly string[]
  // Parsing lives here rather than in the panel's render so each chunk only
  // parses the tail it added, and so no ref is written during render.
  parsed: StreamingMarkdown
}

export interface AgentAnswerApi extends AgentAnswerState {
  blocks: MarkdownBlock[]
  ask(provider: AgentProvider, prompt: string, context: string, question?: string): void
  cancel(): void
  reset(): void
}

const MAX_ACTIVITY_LINES = 40

const EMPTY_ANSWER: AgentAnswerState = {
  answer: '',
  streaming: false,
  error: null,
  sessionId: null,
  question: '',
  activity: [],
  parsed: EMPTY_STREAMING_MARKDOWN
}

export function useAgentAnswer(): AgentAnswerApi {
  const [state, setState] = useState<AgentAnswerState>(EMPTY_ANSWER)
  const requestIdRef = useRef<string | null>(null)

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    return repository.onAgentEvent((event) => {
      if (event.id !== requestIdRef.current) return
      markAgentStreamEvent()
      setState((current) => {
        if (event.kind === 'session') {
          return { ...current, sessionId: event.sessionId ?? current.sessionId }
        }
        if (event.kind === 'text') {
          // A long answer is truncated from the front so the panel cannot grow
          // without bound during a very long stream.
          const next = `${current.answer}${event.text ?? ''}`
          const answer = next.length > MAX_ANSWER_LENGTH ? next.slice(-MAX_ANSWER_LENGTH) : next
          return { ...current, answer, parsed: advanceStreamingMarkdown(current.parsed, answer) }
        }
        if (event.kind === 'activity') {
          const lines = (event.text ?? '').split('\n').filter((line) => line !== '')
          if (lines.length === 0) return current
          // Consecutive duplicates read as noise; the tail is capped so a long
          // run of tool calls cannot grow without bound.
          const activity = [...current.activity]
          for (const line of lines) {
            if (activity.at(-1) !== line) activity.push(line)
          }
          return { ...current, activity: activity.slice(-MAX_ACTIVITY_LINES) }
        }
        if (event.kind === 'error') {
          return { ...current, streaming: false, error: event.text ?? 'The agent failed to answer.' }
        }
        return { ...current, streaming: false }
      })
      if (event.kind === 'done' || event.kind === 'error') requestIdRef.current = null
    })
  }, [])

  const ask = useCallback((provider: AgentProvider, prompt: string, context: string, question?: string) => {
    const repository = window.repository
    if (repository == null) return
    const id = crypto.randomUUID()
    requestIdRef.current = id
    setState((current) => ({
      ...EMPTY_ANSWER,
      streaming: true,
      sessionId: current.sessionId,
      question: question ?? prompt
    }))
    void repository
      .askAgent({
        id,
        provider,
        prompt,
        context,
        ...(state.sessionId == null ? {} : { resumeSessionId: state.sessionId })
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== id) return
        requestIdRef.current = null
        setState((current) => ({ ...current, streaming: false, error: getErrorMessage(error) }))
      })
  }, [state.sessionId])

  const cancel = useCallback(() => {
    const id = requestIdRef.current
    if (id == null) return
    requestIdRef.current = null
    void window.repository?.cancelAgent(id)
    setState((current) => ({ ...current, streaming: false }))
  }, [])

  const reset = useCallback(() => {
    requestIdRef.current = null
    setState(EMPTY_ANSWER)
  }, [])

  return { ...state, blocks: state.parsed.blocks, ask, cancel, reset }
}
