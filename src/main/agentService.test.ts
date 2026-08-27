import { describe, expect, test } from 'bun:test'

import type { AgentStreamEvent } from '../shared/contracts.js'
import { coalesceAgentTextEvents, getClaudeAccessConfig } from './agentService.js'

describe('getClaudeAccessConfig', () => {
  test('allows Bash in a write-blocked review sandbox', () => {
    const config = getClaudeAccessConfig('review', '/work/repository')

    expect(config.permissionMode).toBe('dontAsk')
    expect(config.tools).toContain('Read')
    expect(config.tools).toContain('Bash')
    expect(config.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/work/repository'] }
    })
  })

  test('lets auto mode use the Claude Code tools with provider checks', () => {
    const config = getClaudeAccessConfig('auto')

    expect(config.permissionMode).toBe('auto')
    expect(config.tools).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(config.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('makes full access explicit', () => {
    const config = getClaudeAccessConfig('full-access')

    expect(config.permissionMode).toBe('bypassPermissions')
    expect(config.allowDangerouslySkipPermissions).toBe(true)
  })
})

describe('coalesceAgentTextEvents', () => {
  test('sends one message per frame instead of one per token delta', async () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    for (const text of ['He', 'llo', ' world']) stream.emit({ id: 'r', kind: 'text', text })
    expect(sent).toHaveLength(0)

    await Bun.sleep(40)
    expect(sent).toEqual([{ id: 'r', kind: 'text', text: 'Hello world' }])
  })

  test('flushes pending text before any other event so order survives', () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit({ id: 'r', kind: 'text', text: 'before' })
    stream.emit({ id: 'r', kind: 'activity', activity: { id: 'a', kind: 'file', title: 'Read file', status: 'running' } })
    stream.emit({ id: 'r', kind: 'text', text: 'after' })
    stream.emit({ id: 'r', kind: 'done' })

    expect(sent.map((event) => event.kind)).toEqual(['text', 'activity', 'text', 'done'])
    expect(sent[0]).toEqual({ id: 'r', kind: 'text', text: 'before' })
    expect(sent[2]).toEqual({ id: 'r', kind: 'text', text: 'after' })
  })

  test('never merges text across requests, and flush drains what is buffered', () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit({ id: 'first', kind: 'text', text: 'one' })
    stream.emit({ id: 'second', kind: 'text', text: 'two' })
    stream.flush()

    expect(sent).toEqual([
      { id: 'first', kind: 'text', text: 'one' },
      { id: 'second', kind: 'text', text: 'two' }
    ])
  })
})
