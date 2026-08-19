import { describe, expect, it } from 'bun:test'

import { createAgentTextReader } from './agentRequest.js'
import {
  CODEX_AGENT_MESSAGE_DELTA,
  describeCodexCommand,
  interpretCodexNotification,
  readCodexRateLimit
} from './codexProtocol.js'

// Captured from a live `codex app-server` run (codex-cli 0.147.0).
const THREAD_ID = '01a01429-0b08-7c10-aada-3aa7f978487a'
const TURN_ID = '01a01429-0b80-7ee2-9c96-7cfd0aeeaa67'

describe('interpretCodexNotification', () => {
  // The wire name carries an `item/` prefix. Matching the generated
  // `agentMessage/delta` name instead yields no text at all, which is exactly how
  // Codex came to look broken.
  it('reads a token delta from the prefixed method name', () => {
    expect(interpretCodexNotification({
      method: CODEX_AGENT_MESSAGE_DELTA,
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'msg_1', delta: 'STREAM' }
    })).toEqual({ kind: 'text', text: 'STREAM', source: 'delta' })
  })

  it('ignores the unprefixed name so a rename cannot silently half-work', () => {
    expect(interpretCodexNotification({
      method: 'agentMessage/delta',
      params: { delta: 'STREAM' }
    })).toBeNull()
  })

  it('reads the thread id from result.thread.id shape', () => {
    expect(interpretCodexNotification({
      method: 'thread/started',
      params: { thread: { id: THREAD_ID, sessionId: THREAD_ID } }
    })).toEqual({ kind: 'session', sessionId: THREAD_ID })
  })

  it('prefers deltas and drops the completed message that repeats them', () => {
    const read = createAgentTextReader()
    let answer = ''
    const notifications = [
      { method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg_1', text: '' } } },
      { method: CODEX_AGENT_MESSAGE_DELTA, params: { delta: 'STREAM' } },
      { method: CODEX_AGENT_MESSAGE_DELTA, params: { delta: 'OK' } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg_1', text: 'STREAMOK' } } }
    ]
    for (const notification of notifications) {
      const chunk = interpretCodexNotification(notification)
      if (chunk == null) continue
      const text = read(chunk)
      if (text != null) answer += text
    }
    expect(answer).toBe('STREAMOK')
  })

  it('falls back to the completed message when no deltas arrived', () => {
    const read = createAgentTextReader()
    const chunk = interpretCodexNotification({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'whole answer' } }
    })
    expect(read(chunk!)).toBe('whole answer')
  })

  it('reports a command as it starts and not again when it finishes', () => {
    const item = { type: 'commandExecution', command: '/opt/homebrew/bin/bash -lc "sed -n \'1,240p\' README.md"' }
    expect(interpretCodexNotification({ method: 'item/started', params: { item } }))
      .toEqual({ kind: 'activity', text: "Ran sed -n '1,240p' README.md" })
    expect(interpretCodexNotification({ method: 'item/completed', params: { item } })).toBeNull()
  })

  it('never echoes the prompt back as answer text', () => {
    expect(interpretCodexNotification({
      method: 'item/completed',
      params: { item: { type: 'userMessage', content: [{ type: 'text', text: 'my question' }] } }
    })).toBeNull()
  })

  it('maps the remaining item kinds to activity lines', () => {
    const activity = (item: Record<string, unknown>, method = 'item/started'): string | undefined =>
      interpretCodexNotification({ method, params: { item } })?.text
    expect(activity({ type: 'webSearch', query: 'effect schema' })).toBe('Searched the web for effect schema')
    expect(activity({ type: 'mcpToolCall', tool: 'node_repl' })).toBe('Called node_repl')
    expect(activity({ type: 'fileChange' })).toBe('Proposed a file change')
    expect(activity({ type: 'reasoning' }, 'item/completed')).toBe('Thought briefly')
    expect(activity({ type: 'plan' }, 'item/completed')).toBe('Updated its plan')
  })

  it('ends and fails a turn', () => {
    expect(interpretCodexNotification({ method: 'turn/completed', params: { threadId: THREAD_ID } }))
      .toEqual({ kind: 'result', text: '' })
    expect(interpretCodexNotification({ method: 'turn/failed', params: { error: { message: 'sandbox denied' } } }))
      .toEqual({ kind: 'result', text: 'sandbox denied', failed: true })
  })

  it('ignores the lifecycle chatter that is not worth showing', () => {
    for (const method of [
      'thread/status/changed',
      'hook/started',
      'hook/completed',
      'mcpServer/startupStatus/updated',
      'thread/tokenUsage/updated',
      'remoteControl/status/changed'
    ]) {
      expect(interpretCodexNotification({ method, params: {} })).toBeNull()
    }
  })
})

describe('describeCodexCommand', () => {
  it('unwraps the login shell Codex runs commands through', () => {
    expect(describeCodexCommand('/bin/bash -lc "git status --short"')).toBe('Ran git status --short')
  })

  it('collapses newlines and truncates a long command', () => {
    const described = describeCodexCommand('bash -lc "echo one\n  echo two"')
    expect(described).toBe('Ran echo one echo two')
    expect(describeCodexCommand('x'.repeat(300)).length).toBeLessThan(80)
  })

  it('survives a command it cannot unwrap', () => {
    expect(describeCodexCommand('')).toBe('Ran a command')
  })
})

describe('readCodexRateLimit', () => {
  // Observed at 93% on a real account — the usual explanation for a slow turn.
  it('reads the primary window usage', () => {
    expect(readCodexRateLimit({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { primary: { usedPercent: 93, windowDurationMins: 10080, resetsAt: 1787557914 } } }
    })).toEqual({ usedPercent: 93, resetsAtSeconds: 1787557914 })
  })

  it('ignores unrelated notifications', () => {
    expect(readCodexRateLimit({ method: 'turn/completed', params: {} })).toBeNull()
  })
})
