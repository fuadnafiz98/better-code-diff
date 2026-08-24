import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentAccessMode,
  AgentActivityUpdate,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentProvider,
  AgentUsageUpdate
} from '../../shared/contracts'
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
  activity: readonly AgentActivityUpdate[]
  approvals: readonly AgentApprovalRequest[]
  sessionKey: string | null
  usage: AgentUsageUpdate | null
  history: readonly AgentTurnRecord[]
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  startedAt: number | null
  completedAt: number | null
  // Parsing lives here rather than in the panel's render so each chunk only
  // parses the tail it added, and so no ref is written during render.
  parsed: StreamingMarkdown
}

export interface AgentAnswerApi extends AgentAnswerState {
  blocks: MarkdownBlock[]
  ask(options: {
    provider: AgentProvider
    model: string
    effort: string
    accessMode: AgentAccessMode
    prompt: string
    context: string
    question?: string
  }): void
  respondToApproval(requestId: string, decision: AgentApprovalDecision): void
  cancel(): void
  reset(): void
}

export interface AgentTurnRecord {
  id: string
  question: string
  answer: string
  blocks: MarkdownBlock[]
  activity: readonly AgentActivityUpdate[]
  error: string | null
  usage: AgentUsageUpdate | null
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  startedAt: number | null
  completedAt: number | null
}

const MAX_ACTIVITY_ITEMS = 80
const MAX_ACTIVITY_DETAIL_LENGTH = 20_000
const MAX_ACTIVITY_OUTPUT_LENGTH = 12_000

const EMPTY_ANSWER: AgentAnswerState = {
  answer: '',
  streaming: false,
  error: null,
  sessionId: null,
  question: '',
  activity: [],
  approvals: [],
  sessionKey: null,
  usage: null,
  history: [],
  provider: null,
  model: '',
  effort: '',
  accessMode: null,
  startedAt: null,
  completedAt: null,
  parsed: EMPTY_STREAMING_MARKDOWN
}

function archiveTurn(state: AgentAnswerState): AgentTurnRecord | null {
  if (state.question === '' && state.answer === '' && state.activity.length === 0 && state.error == null) return null
  return {
    id: `${state.startedAt ?? Date.now()}-${state.question.slice(0, 24)}`,
    question: state.question,
    answer: state.answer,
    blocks: state.parsed.blocks,
    activity: state.activity,
    error: state.error,
    usage: state.usage,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    accessMode: state.accessMode,
    startedAt: state.startedAt,
    completedAt: state.completedAt
  }
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
          if (event.activity == null) return current
          return { ...current, activity: mergeActivity(current.activity, event.activity) }
        }
        if (event.kind === 'usage') {
          if (event.usage == null) return current
          return { ...current, usage: mergeUsage(current.usage, event.usage) }
        }
        if (event.kind === 'approval') {
          if (event.approval == null) return current
          return {
            ...current,
            approvals: [...current.approvals.filter((approval) =>
              approval.requestId !== event.approval?.requestId), event.approval]
          }
        }
        if (event.kind === 'error') {
          return {
            ...current,
            streaming: false,
            approvals: [],
            error: event.text ?? 'The agent failed to answer.',
            completedAt: Date.now()
          }
        }
        return { ...current, streaming: false, approvals: [], completedAt: Date.now() }
      })
      if (event.kind === 'done' || event.kind === 'error') requestIdRef.current = null
    })
  }, [])

  const ask = useCallback((options: {
    provider: AgentProvider
    model: string
    effort: string
    accessMode: AgentAccessMode
    prompt: string
    context: string
    question?: string
  }) => {
    const repository = window.repository
    if (repository == null) return
    const id = crypto.randomUUID()
    const sessionKey = `${options.provider}:${options.model}:${options.accessMode}`
    const resumeSessionId = state.sessionKey === sessionKey ? state.sessionId : null
    requestIdRef.current = id
    setState((current) => {
      const archived = archiveTurn(current)
      return {
        ...EMPTY_ANSWER,
        history: archived == null ? current.history : [...current.history, archived].slice(-20),
        streaming: true,
        sessionId: resumeSessionId,
        sessionKey,
        question: options.question ?? options.prompt,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        accessMode: options.accessMode,
        startedAt: Date.now()
      }
    })
    void repository
      .askAgent({
        id,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        accessMode: options.accessMode,
        prompt: options.prompt,
        context: options.context,
        ...(resumeSessionId == null ? {} : { resumeSessionId })
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== id) return
        requestIdRef.current = null
        setState((current) => ({
          ...current,
          streaming: false,
          error: getErrorMessage(error),
          completedAt: Date.now()
        }))
      })
  }, [state.sessionId, state.sessionKey])

  const respondToApproval = useCallback((requestId: string, decision: AgentApprovalDecision) => {
    const approval = state.approvals.find((candidate) => candidate.requestId === requestId)
    if (approval == null) return
    setState((current) => ({
      ...current,
      approvals: current.approvals.filter((candidate) => candidate.requestId !== requestId),
      activity: current.activity.map((item) => item.id === approval.itemId
        ? { ...item, status: decision === 'decline' ? 'blocked' : 'running' }
        : item)
    }))
    void window.repository?.respondAgentApproval(requestId, decision).catch((error: unknown) => {
      setState((current) => ({ ...current, error: getErrorMessage(error) }))
    })
  }, [state.approvals])

  const cancel = useCallback(() => {
    const id = requestIdRef.current
    if (id == null) return
    requestIdRef.current = null
    void window.repository?.cancelAgent(id)
    setState((current) => ({
      ...current,
      streaming: false,
      approvals: [],
      completedAt: Date.now(),
      activity: current.activity.map((item) => item.status === 'running' || item.status === 'waiting'
        ? { ...item, status: 'blocked', completedAt: Date.now() }
        : item)
    }))
  }, [])

  const reset = useCallback(() => {
    requestIdRef.current = null
    setState(EMPTY_ANSWER)
  }, [])

  return { ...state, blocks: state.parsed.blocks, ask, respondToApproval, cancel, reset }
}

function appendBounded(current: string | undefined, addition: string | undefined, limit: number): string {
  const next = `${current ?? ''}${addition ?? ''}`
  return next.length > limit ? next.slice(-limit) : next
}

export function mergeActivity(
  current: readonly AgentActivityUpdate[],
  update: AgentActivityUpdate
): AgentActivityUpdate[] {
  const existingIndex = current.findIndex((item) => item.id === update.id)
  const now = Date.now()
  if (existingIndex === -1) {
    const added = {
      ...update,
      startedAt: update.startedAt ?? now,
      ...(update.status === 'running' || update.status === 'waiting'
        ? {}
        : { completedAt: update.completedAt ?? now, durationMs: update.durationMs ?? 0 })
    }
    return [...current, added].slice(-MAX_ACTIVITY_ITEMS)
  }
  const existing = current[existingIndex]!
  const merged: AgentActivityUpdate = {
    ...existing,
    ...update,
    title: update.title || existing.title,
    kind: update.title === '' ? existing.kind : update.kind,
    detail: update.append === 'detail'
      ? appendBounded(existing.detail, update.detail, MAX_ACTIVITY_DETAIL_LENGTH)
      : update.detail ?? existing.detail,
    output: update.append === 'output'
      ? appendBounded(existing.output, update.output, MAX_ACTIVITY_OUTPUT_LENGTH)
      : update.output ?? existing.output,
    startedAt: existing.startedAt ?? update.startedAt ?? now
  }
  if (update.status !== 'running' && update.status !== 'waiting') {
    merged.completedAt = update.completedAt ?? existing.completedAt ?? now
    merged.durationMs = update.durationMs ?? existing.durationMs ??
      Math.max(0, merged.completedAt - (merged.startedAt ?? merged.completedAt))
  }
  delete merged.append
  const next = [...current]
  next[existingIndex] = merged
  return next
}

export function mergeUsage(
  current: AgentUsageUpdate | null,
  update: AgentUsageUpdate
): AgentUsageUpdate {
  const rateLimits = update.rateLimits == null
    ? current?.rateLimits
    : [
        ...(current?.rateLimits ?? []).filter((window) =>
          !update.rateLimits?.some((candidate) => candidate.label === window.label)),
        ...update.rateLimits
      ]
  return {
    ...(current ?? {}),
    ...update,
    ...(rateLimits == null ? {} : { rateLimits })
  }
}
