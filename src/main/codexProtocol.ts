import type { AgentStreamChunk } from './agentRequest.js'
import type {
  AgentActivityStatus,
  AgentActivityUpdate,
  AgentUsageUpdate
} from '../shared/contracts.js'

// Method names as `codex app-server` (codex-cli 0.149.1) actually emits them,
// captured from a live run. Note the `item/` prefix on the delta notification:
// the generated bindings publish it as `agentMessage/delta`, but the wire name
// carries the prefix, and matching the wrong one silently yields no text at all.
export const CODEX_METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list'
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

function itemStatus(item: Record<string, unknown>, started: boolean): AgentActivityStatus {
  if (started) return 'running'
  if (item.status === 'failed') return 'failed'
  if (item.status === 'declined') return 'blocked'
  return 'completed'
}

function activity(item: Record<string, unknown>, started: boolean): AgentActivityUpdate | null {
  const id = readString(item.id) ?? `codex-${String(item.type)}`
  const status = itemStatus(item, started)
  switch (item.type) {
    case 'reasoning':
      return {
        id,
        kind: 'reasoning',
        title: 'Reasoning',
        status,
        detail: [...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : [])]
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
      }
    case 'commandExecution': {
      const command = readString(item.command)
      const output = readString(item.aggregatedOutput)
      return {
        id,
        kind: 'command',
        title: 'Run command',
        status,
        detail: command == null ? '' : describeCodexCommand(command).replace(/^Ran /, ''),
        ...(output == null ? {} : { output: output.slice(-12_000) })
      }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes.flatMap((change) => {
        if (typeof change !== 'object' || change == null) return []
        const path = readString((change as Record<string, unknown>).path)
        return path == null ? [] : [path]
      })
      return { id, kind: 'file', title: 'Change files', status, detail: paths.join('\n') }
    }
    case 'webSearch': {
      const query = readString(item.query)
      return { id, kind: 'search', title: 'Search the web', status, detail: query ?? '' }
    }
    case 'plan':
      return { id, kind: 'plan', title: 'Plan', status, detail: readString(item.text) ?? '' }
    case 'contextCompaction':
      return { id, kind: 'status', title: 'Compact conversation', status }
    case 'mcpToolCall': {
      const tool = readString(item.tool) ?? readString(item.name)
      const args = item.arguments == null ? '' : JSON.stringify(item.arguments)
      return { id, kind: 'tool', title: tool ?? 'MCP tool', status, detail: args.slice(0, 2_000) }
    }
    case 'dynamicToolCall': {
      const tool = readString(item.tool) ?? 'Tool call'
      const namespace = readString(item.namespace)
      const args = item.arguments == null ? '' : JSON.stringify(item.arguments)
      return {
        id,
        kind: 'tool',
        title: namespace == null ? tool : `${namespace} · ${tool}`,
        status,
        detail: args.slice(0, 2_000)
      }
    }
    case 'collabAgentToolCall': {
      const tool = readString(item.tool) ?? 'Agent task'
      return {
        id,
        kind: 'tool',
        title: tool.replace(/([a-z])([A-Z])/g, '$1 $2'),
        status,
        detail: readString(item.prompt) ?? ''
      }
    }
    case 'subAgentActivity':
      return {
        id,
        kind: 'tool',
        title: `Agent ${readString(item.kind) ?? 'activity'}`,
        status,
        detail: readString(item.agentPath) ?? ''
      }
    case 'imageView':
      return { id, kind: 'tool', title: 'View image', status, detail: readString(item.path) ?? '' }
    case 'imageGeneration':
      return { id, kind: 'tool', title: 'Generate image', status }
    case 'sleep':
      return { id, kind: 'status', title: 'Wait', status }
    case 'enteredReviewMode':
      return { id, kind: 'status', title: 'Enter review mode', status, detail: readString(item.review) ?? '' }
    case 'exitedReviewMode':
      return { id, kind: 'status', title: 'Exit review mode', status, detail: readString(item.review) ?? '' }
    // A user message is the prompt this app just sent; echoing it back would
    // duplicate what the panel already shows.
    case 'userMessage':
    default:
      return null
  }
}

// Maps one app-server notification onto the same chunk shape the Claude reader
// produces, so the renderer sees a single stream contract for both providers.
export function interpretCodexNotification(
  notification: CodexNotification,
  agentMessagePhase?: string
): AgentStreamChunk | null {
  const params = (typeof notification.params === 'object' && notification.params != null
    ? notification.params
    : {}) as Record<string, unknown>

  if (notification.method === CODEX_AGENT_MESSAGE_DELTA) {
    const delta = readString(params.delta)
    if (delta == null) return null
    if (agentMessagePhase === 'commentary') {
      return {
        kind: 'activity',
        activity: {
          id: readString(params.itemId) ?? 'codex-commentary',
          kind: 'status',
          title: 'Update',
          detail: delta,
          status: 'running',
          append: 'detail'
        }
      }
    }
    return { kind: 'text', text: delta, source: 'delta' }
  }

  if (notification.method === 'thread/tokenUsage/updated') {
    const tokenUsage = typeof params.tokenUsage === 'object' && params.tokenUsage != null
      ? params.tokenUsage as Record<string, unknown>
      : {}
    const total = typeof tokenUsage.total === 'object' && tokenUsage.total != null
      ? tokenUsage.total as Record<string, unknown>
      : {}
    const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
    const usage: AgentUsageUpdate = {
      totalTokens: number(total.totalTokens),
      inputTokens: number(total.inputTokens),
      cachedInputTokens: number(total.cachedInputTokens),
      cacheWriteInputTokens: number(total.cacheWriteInputTokens),
      outputTokens: number(total.outputTokens),
      reasoningTokens: number(total.reasoningOutputTokens)
    }
    const contextWindow = number(tokenUsage.modelContextWindow)
    if (contextWindow > 0) usage.contextWindow = contextWindow
    return { kind: 'usage', usage }
  }

  if (notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/textDelta') {
    const delta = readString(params.delta)
    const itemId = readString(params.itemId)
    return delta == null || itemId == null ? null : {
      kind: 'activity',
      activity: {
        id: itemId,
        kind: 'reasoning',
        title: 'Reasoning',
        status: 'running',
        detail: delta,
        append: 'detail'
      }
    }
  }

  if (notification.method === 'item/plan/delta') {
    const delta = readString(params.delta)
    const itemId = readString(params.itemId)
    return delta == null || itemId == null ? null : {
      kind: 'activity',
      activity: { id: itemId, kind: 'plan', title: 'Plan', status: 'running', detail: delta, append: 'detail' }
    }
  }

  if (notification.method === 'turn/plan/updated') {
    const plan = Array.isArray(params.plan) ? params.plan : []
    const explanation = readString(params.explanation)
    const activities = plan.flatMap((candidate, index): AgentActivityUpdate[] => {
      if (typeof candidate !== 'object' || candidate == null) return []
      const step = candidate as Record<string, unknown>
      const title = readString(step.step)
      if (title == null) return []
      const rawStatus = readString(step.status)
      const status: AgentActivityStatus = rawStatus === 'completed'
        ? 'completed'
        : rawStatus === 'inProgress' ? 'running' : 'waiting'
      return [{
        id: `codex-plan-step-${index}`,
        kind: 'plan',
        title,
        status,
        ...(index === 0 && explanation != null ? { detail: explanation } : {})
      }]
    })
    return activities.length === 0 ? null : { kind: 'activity', activities }
  }

  if (notification.method === 'item/commandExecution/outputDelta') {
    const delta = readString(params.delta)
    const itemId = readString(params.itemId)
    return delta == null || itemId == null ? null : {
      kind: 'activity',
      activity: { id: itemId, kind: 'command', title: 'Run command', status: 'running', output: delta, append: 'output' }
    }
  }

  if (notification.method === 'item/mcpToolCall/progress') {
    const message = readString(params.message)
    const itemId = readString(params.itemId)
    return message == null || itemId == null ? null : {
      kind: 'activity',
      activity: { id: itemId, kind: 'tool', title: 'MCP tool', status: 'running', output: message, append: 'output' }
    }
  }

  if (notification.method === 'thread/started') {
    const thread = params.thread as Record<string, unknown> | undefined
    const id = readString(thread?.id) ?? readString(params.threadId)
    return id == null ? null : { kind: 'session', sessionId: id }
  }

  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined
    if (item == null) return null
    if (item.type === 'agentMessage') {
      const phase = readString(item.phase) ?? agentMessagePhase
      if (phase === 'commentary') {
        return {
          kind: 'activity',
          activity: {
            id: readString(item.id) ?? 'codex-commentary',
            kind: 'status',
            title: 'Update',
            status: notification.method === 'item/started' ? 'running' : 'completed',
            ...(notification.method === 'item/completed' && readString(item.text) != null
              ? { detail: readString(item.text) ?? '' }
              : {})
          }
        }
      }
      if (notification.method === 'item/started') return null
      const text = readString(item.text)
      return text == null ? null : { kind: 'text', text, source: 'message' }
    }
    const update = activity(item, notification.method === 'item/started')
    return update == null ? null : { kind: 'activity', activity: update }
  }

  if (notification.method === 'turn/failed') {
    const error = params.error as { message?: unknown } | undefined
    return { kind: 'result', text: readString(error?.message) ?? '', failed: true }
  }

  if (notification.method === 'turn/completed') {
    const turn = typeof params.turn === 'object' && params.turn != null
      ? params.turn as Record<string, unknown>
      : {}
    const durationMs = typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs)
      ? turn.durationMs
      : null
    return durationMs == null
      ? { kind: 'result', text: '' }
      : { kind: 'result', text: '', usage: { durationMs } }
  }

  return null
}

export interface CodexRateLimit {
  usedPercent: number
  resetsAtSeconds: number | null
  windowDurationMinutes: number | null
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
    resetsAtSeconds: typeof primary.resetsAt === 'number' ? primary.resetsAt : null,
    windowDurationMinutes: typeof primary.windowDurationMins === 'number'
      ? primary.windowDurationMins
      : null
  }
}
