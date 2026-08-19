// Answering questions about a diff never needs write access. This is both the
// list passed to the agent and the list used to label its activity, so the two
// cannot drift apart.
export const AGENT_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const

export const MAX_AGENT_PROMPT_LENGTH = 200_000
export const MAX_AGENT_CONTEXT_LENGTH = 400_000

export interface AgentAskRequest {
  id: string
  provider: 'claude' | 'codex'
  prompt: string
  context: string
  resumeSessionId?: string
}

type AgentAskDecoder = (value: unknown) => AgentAskRequest | null

// `effect` is the main process's largest dependency and this decode is the only
// thing that needs it, so it loads on the first agent request rather than during
// startup. Measured: importing it eagerly costs 143 ms and 24 MB of heap before
// the window can even be created.
let decoderPromise: Promise<AgentAskDecoder> | null = null

async function loadDecoder(): Promise<AgentAskDecoder> {
  const { Schema } = await import('effect')
  const decode = Schema.decodeUnknownOption(Schema.Struct({
    id: Schema.String,
    provider: Schema.Literals(['claude', 'codex']),
    prompt: Schema.String,
    context: Schema.String,
    resumeSessionId: Schema.optional(Schema.String)
  }))
  return (value) => {
    const decoded = decode(value)
    return decoded._tag === 'None' ? null : { ...decoded.value }
  }
}

// Renderer input reaches the agent runner as `unknown`; a decode failure must
// read as a refusal rather than a malformed subprocess invocation.
export async function parseAgentAskRequest(value: unknown): Promise<AgentAskRequest> {
  decoderPromise ??= loadDecoder()
  const request = (await decoderPromise)(value)
  if (request == null) throw new Error('The agent request was not understood.')
  const prompt = request.prompt.trim()
  if (prompt === '') throw new Error('Ask the agent a question first.')
  if (prompt.length > MAX_AGENT_PROMPT_LENGTH) throw new Error('This question is too long to send.')
  if (request.id.trim() === '' || request.id.length > 128) {
    throw new Error('The agent request could not be identified.')
  }
  if (request.resumeSessionId != null && !/^[A-Za-z0-9-]{1,128}$/.test(request.resumeSessionId)) {
    throw new Error('The agent session could not be identified.')
  }
  return {
    id: request.id,
    provider: request.provider,
    prompt,
    context: request.context.slice(0, MAX_AGENT_CONTEXT_LENGTH),
    ...(request.resumeSessionId == null ? {} : { resumeSessionId: request.resumeSessionId })
  }
}

export interface AgentStreamChunk {
  kind: 'session' | 'text' | 'result' | 'activity'
  text?: string
  sessionId?: string
  failed?: boolean
  /** Where a text chunk came from: an incremental delta or an assembled message. */
  source?: 'delta' | 'message'
}

// A tool call is the agent telling you what it is doing; showing "Read foo.ts" is
// what makes a long pause legible instead of looking stalled.
function describeToolUse(block: Record<string, unknown>): string | null {
  const name = typeof block.name === 'string' ? block.name : null
  if (name == null) return null
  const input = (typeof block.input === 'object' && block.input != null
    ? block.input
    : {}) as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path.split('/').at(-1) : null
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  // The model can still ask for a tool it was not granted; the request is denied,
  // so reporting the bare name would imply something ran that never did.
  if (!(AGENT_READ_ONLY_TOOLS as readonly string[]).includes(name)) return `Blocked ${name} (read-only)`
  if (name === 'Read' && filePath != null) return `Read ${filePath}`
  if (name === 'Grep' && pattern != null) return `Searched for ${pattern}`
  if (name === 'Glob' && pattern != null) return `Listed ${pattern}`
  return name
}

// Claude emits incremental `stream_event` deltas AND, at the end of the turn, the
// fully assembled `assistant` message carrying the same text — so consuming both
// renders every answer twice. Deltas win when they are present; the assembled
// message stays as the fallback for CLI builds that do not support
// --include-partial-messages, and for Codex, which only writes plain text.
export function createAgentTextReader(): (chunk: AgentStreamChunk) => string | null {
  let sawDelta = false
  return (chunk) => {
    if (chunk.kind !== 'text' || chunk.text == null || chunk.text === '') return null
    if (chunk.source === 'delta') {
      sawDelta = true
      return chunk.text
    }
    return chunk.source === 'message' && sawDelta ? null : chunk.text
  }
}

// Codex wraps shell work in `bash -lc "…"`; the inner command is what is worth
// showing, and it can be long enough to need trimming.
function describeCodexCommand(item: Record<string, unknown>): string {
  const raw = typeof item.command === 'string' ? item.command : ''
  const inner = /-lc\s+"([\s\S]*)"\s*$/.exec(raw)?.[1] ?? raw
  const collapsed = inner.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'Ran a command'
  return `Ran ${collapsed.length > 64 ? `${collapsed.slice(0, 64)}…` : collapsed}`
}

// Codex writes a completely different envelope from Claude: a thread/turn
// lifecycle plus per-item events, and no token deltas at all — an agent message
// arrives whole in `item.completed`. Its event names do not collide with Claude's,
// so both shapes are read here.
function interpretCodexLine(envelope: Record<string, unknown>): AgentStreamChunk | null {
  if (envelope.type === 'thread.started') {
    return typeof envelope.thread_id === 'string'
      ? { kind: 'session', sessionId: envelope.thread_id }
      : null
  }
  if (envelope.type === 'turn.failed') {
    const error = envelope.error as { message?: unknown } | undefined
    return { kind: 'result', text: typeof error?.message === 'string' ? error.message : '', failed: true }
  }
  if (envelope.type === 'turn.completed') return { kind: 'result', text: '' }

  if (envelope.type !== 'item.started' && envelope.type !== 'item.completed') return null
  const item = envelope.item as Record<string, unknown> | undefined
  if (item == null) return null
  const completed = envelope.type === 'item.completed'

  if (item.type === 'agent_message') {
    // A turn can hold several messages (a preamble, then the answer), so each one
    // is appended as its own paragraph.
    if (!completed || typeof item.text !== 'string' || item.text === '') return null
    return { kind: 'text', text: `${item.text}\n\n`, source: 'message' }
  }
  // Reported as it starts, because the wait for a command is the pause the user sees.
  if (item.type === 'command_execution') {
    return completed ? null : { kind: 'activity', text: describeCodexCommand(item) }
  }
  if (item.type === 'reasoning') {
    return completed ? { kind: 'activity', text: 'Thought briefly' } : null
  }
  if (item.type === 'file_change' || item.type === 'patch_apply') {
    return completed ? null : { kind: 'activity', text: 'Proposed a file change' }
  }
  return null
}

// Claude streams newline-delimited JSON envelopes; Codex uses its own event shape.
// Only the fields this app renders are read, so unknown envelopes are ignored.
export function interpretAgentLine(line: string): AgentStreamChunk | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (!trimmed.startsWith('{')) return { kind: 'text', text: `${line}\n` }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed == null) return null
  const envelope = parsed as Record<string, unknown>

  if (typeof envelope.type === 'string' && (envelope.type.startsWith('thread.') || envelope.type.startsWith('turn.') || envelope.type.startsWith('item.'))) {
    return interpretCodexLine(envelope)
  }

  if (envelope.type === 'stream_event') {
    const event = envelope.event as { delta?: { text?: unknown } } | undefined
    const text = event?.delta?.text
    return typeof text === 'string' && text !== '' ? { kind: 'text', text, source: 'delta' } : null
  }

  if (envelope.type === 'assistant') {
    const message = envelope.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) return null
    let text = ''
    const activity: string[] = []
    for (const block of message.content) {
      if (typeof block !== 'object' || block == null) continue
      const candidate = block as Record<string, unknown>
      if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
      else if (candidate.type === 'thinking') activity.push('Thought briefly')
      else if (candidate.type === 'tool_use') {
        const described = describeToolUse(candidate)
        if (described != null) activity.push(described)
      }
    }
    // Tool and thinking blocks are reported even when the same message carries
    // text, because the activity is what explains the pause before it.
    if (activity.length > 0) return { kind: 'activity', text: activity.join('\n') }
    return text === '' ? null : { kind: 'text', text, source: 'message' }
  }

  if (envelope.type === 'result') {
    return {
      kind: 'result',
      text: typeof envelope.result === 'string' ? envelope.result : '',
      failed: envelope.is_error === true,
      ...(typeof envelope.session_id === 'string' ? { sessionId: envelope.session_id } : {})
    }
  }

  if (envelope.type === 'system' && typeof envelope.session_id === 'string') {
    return { kind: 'session', sessionId: envelope.session_id }
  }

  return null
}
