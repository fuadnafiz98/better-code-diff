import type { AgentStreamChunk } from './agentRequest.js'

// Method names as `codex app-server` (codex-cli 0.147.0) actually emits them,
// captured from a live run. Note the `item/` prefix on the delta notification:
// the generated bindings publish it as `agentMessage/delta`, but the wire name
// carries the prefix, and matching the wrong one silently yields no text at all.
export const CODEX_METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt'
} as const

export const CODEX_AGENT_MESSAGE_DELTA = 'item/agentMessage/delta'

interface CodexNotification {
  method: string
  params?: unknown
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

// Codex wraps shell work in `bash -lc "…"`; the inner command is the useful part.
export function describeCodexCommand(command: string): string {
  const inner = /-lc\s+"([\s\S]*)"\s*$/.exec(command)?.[1] ?? command
  const collapsed = inner.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'Ran a command'
  return `Ran ${collapsed.length > 64 ? `${collapsed.slice(0, 64)}…` : collapsed}`
}

function describeItem(item: Record<string, unknown>, started: boolean): AgentStreamChunk | null {
  switch (item.type) {
    case 'agentMessage':
      // The completed item repeats the whole message that the deltas already
      // delivered, so it is only a fallback and is filtered downstream.
      return started
        ? null
        : (() => {
            const text = readString(item.text)
            return text == null ? null : { kind: 'text', text, source: 'message' }
          })()
    case 'reasoning':
      return started ? null : { kind: 'activity', text: 'Thought briefly' }
    case 'commandExecution': {
      if (!started) return null
      const command = readString(item.command)
      return { kind: 'activity', text: command == null ? 'Ran a command' : describeCodexCommand(command) }
    }
    case 'fileChange':
      return started ? { kind: 'activity', text: 'Proposed a file change' } : null
    case 'webSearch': {
      if (!started) return null
      const query = readString(item.query)
      return { kind: 'activity', text: query == null ? 'Searched the web' : `Searched the web for ${query}` }
    }
    case 'plan':
      return started ? null : { kind: 'activity', text: 'Updated its plan' }
    case 'contextCompaction':
      return started ? { kind: 'activity', text: 'Compacted the conversation' } : null
    case 'mcpToolCall': {
      if (!started) return null
      const tool = readString(item.tool) ?? readString(item.name)
      return { kind: 'activity', text: tool == null ? 'Called a tool' : `Called ${tool}` }
    }
    // A user message is the prompt this app just sent; echoing it back would
    // duplicate what the panel already shows.
    case 'userMessage':
    default:
      return null
  }
}

// Maps one app-server notification onto the same chunk shape the Claude reader
// produces, so the renderer sees a single stream contract for both providers.
export function interpretCodexNotification(notification: CodexNotification): AgentStreamChunk | null {
  const params = (typeof notification.params === 'object' && notification.params != null
    ? notification.params
    : {}) as Record<string, unknown>

  if (notification.method === CODEX_AGENT_MESSAGE_DELTA) {
    const delta = readString(params.delta)
    return delta == null ? null : { kind: 'text', text: delta, source: 'delta' }
  }

  if (notification.method === 'thread/started') {
    const thread = params.thread as Record<string, unknown> | undefined
    const id = readString(thread?.id) ?? readString(params.threadId)
    return id == null ? null : { kind: 'session', sessionId: id }
  }

  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined
    if (item == null) return null
    return describeItem(item, notification.method === 'item/started')
  }

  if (notification.method === 'turn/failed') {
    const error = params.error as { message?: unknown } | undefined
    return { kind: 'result', text: readString(error?.message) ?? '', failed: true }
  }

  if (notification.method === 'turn/completed') return { kind: 'result', text: '' }

  return null
}

export interface CodexRateLimit {
  usedPercent: number
  resetsAtSeconds: number | null
}

// Codex reports how much of the plan window is spent. Surfacing it explains a
// slow or refused turn far better than a generic failure would.
export function readCodexRateLimit(notification: CodexNotification): CodexRateLimit | null {
  if (notification.method !== 'account/rateLimits/updated') return null
  const params = (typeof notification.params === 'object' && notification.params != null
    ? notification.params
    : {}) as Record<string, unknown>
  const primary = (params.rateLimits as { primary?: unknown } | undefined)?.primary as
    | Record<string, unknown>
    | undefined
  if (primary == null || typeof primary.usedPercent !== 'number') return null
  return {
    usedPercent: primary.usedPercent,
    resetsAtSeconds: typeof primary.resetsAt === 'number' ? primary.resetsAt : null
  }
}
