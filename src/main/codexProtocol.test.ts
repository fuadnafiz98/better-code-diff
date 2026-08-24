import { describe, expect, it } from 'bun:test'

import { createAgentTextReader } from './agentRequest.js'
import {
  CODEX_AGENT_MESSAGE_DELTA,
  describeCodexCommand,
  interpretCodexNotification,
  readCodexRateLimit
} from './codexProtocol.js'
import { getCodexThreadAccess, getCodexTurnSandbox } from './codexAppServer.js'

// Captured from a live `codex app-server` run (codex-cli 0.149.1).
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

  it('tracks a command from start through completion', () => {
    const item = { id: 'command-1', type: 'commandExecution', command: '/opt/homebrew/bin/bash -lc "sed -n \'1,240p\' README.md"' }
    expect(interpretCodexNotification({ method: 'item/started', params: { item } })?.activity)
      .toEqual({ id: 'command-1', kind: 'command', title: 'Run command', detail: "sed -n '1,240p' README.md", status: 'running' })
    expect(interpretCodexNotification({ method: 'item/completed', params: { item } })?.activity)
      .toMatchObject({ id: 'command-1', status: 'completed' })
  })

  it('never echoes the prompt back as answer text', () => {
    expect(interpretCodexNotification({
      method: 'item/completed',
      params: { item: { type: 'userMessage', content: [{ type: 'text', text: 'my question' }] } }
    })).toBeNull()
  })

  it('maps the remaining item kinds to structured activity', () => {
    const activity = (item: Record<string, unknown>, method = 'item/started') =>
      interpretCodexNotification({ method, params: { item } })?.activity
    expect(activity({ id: 'web', type: 'webSearch', query: 'effect schema' }))
      .toMatchObject({ id: 'web', kind: 'search', title: 'Search the web', detail: 'effect schema' })
    expect(activity({ id: 'mcp', type: 'mcpToolCall', tool: 'node_repl' }))
      .toMatchObject({ id: 'mcp', kind: 'tool', title: 'node_repl' })
    expect(activity({ id: 'file', type: 'fileChange', changes: [] }))
      .toMatchObject({ id: 'file', kind: 'file', title: 'Change files' })
    expect(activity({ id: 'thinking', type: 'reasoning', summary: ['Checked callers'] }, 'item/completed'))
      .toMatchObject({ id: 'thinking', kind: 'reasoning', detail: 'Checked callers', status: 'completed' })
    expect(activity({ id: 'plan', type: 'plan', text: 'Inspect, test, report' }, 'item/completed'))
      .toMatchObject({ id: 'plan', kind: 'plan', detail: 'Inspect, test, report', status: 'completed' })
  })

  it('streams reasoning and command output into their activity items', () => {
    expect(interpretCodexNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: 'Inspecting callers' }
    })?.activity).toMatchObject({ id: 'reasoning-1', append: 'detail', detail: 'Inspecting callers' })
    expect(interpretCodexNotification({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'command-1', delta: '12 tests passed' }
    })?.activity).toMatchObject({ id: 'command-1', append: 'output', output: '12 tests passed' })
  })

  it('keeps commentary in the work log instead of the final answer', () => {
    expect(interpretCodexNotification({
      method: CODEX_AGENT_MESSAGE_DELTA,
      params: { itemId: 'commentary-1', delta: 'I will inspect the callers.' }
    }, 'commentary')?.activity).toEqual({
      id: 'commentary-1', kind: 'status', title: 'Update', detail: 'I will inspect the callers.',
      status: 'running', append: 'detail'
    })
  })

  it('reads cumulative token and context usage', () => {
    expect(interpretCodexNotification({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: {
        total: {
          totalTokens: 39351,
          inputTokens: 39204,
          cachedInputTokens: 29184,
          cacheWriteInputTokens: 0,
          outputTokens: 147,
          reasoningOutputTokens: 24
        },
        modelContextWindow: 258400
      } }
    })?.usage).toEqual({
      totalTokens: 39351,
      inputTokens: 39204,
      cachedInputTokens: 29184,
      cacheWriteInputTokens: 0,
      outputTokens: 147,
      reasoningTokens: 24,
      contextWindow: 258400
    })
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
    })).toEqual({ usedPercent: 93, resetsAtSeconds: 1787557914, windowDurationMinutes: 10080 })
  })

  it('ignores unrelated notifications', () => {
    expect(readCodexRateLimit({ method: 'turn/completed', params: {} })).toBeNull()
  })
})

describe('Codex access mapping', () => {
  it('keeps review mode read-only without network access', () => {
    expect(getCodexThreadAccess('review')).toEqual({
      sandbox: 'read-only',
      approvalPolicy: 'never'
    })
    expect(getCodexTurnSandbox('review', '/repo')).toEqual({
      type: 'readOnly',
      networkAccess: false
    })
  })

  it('scopes auto mode writes to the open repository', () => {
    expect(getCodexThreadAccess('auto')).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request'
    })
    expect(getCodexTurnSandbox('auto', '/repo')).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: ['/repo'],
      networkAccess: true
    })
  })

  it('only full access removes the sandbox', () => {
    expect(getCodexThreadAccess('full-access')).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never'
    })
    expect(getCodexTurnSandbox('full-access', '/repo')).toEqual({
      type: 'dangerFullAccess'
    })
  })
})
