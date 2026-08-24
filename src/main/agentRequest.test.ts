import { describe, expect, it } from 'bun:test'

import { createAgentTextReader, interpretAgentLine, parseAgentAskRequest } from './agentRequest.js'

function readAll(lines: readonly string[]): string {
  const read = createAgentTextReader()
  let answer = ''
  for (const line of lines) {
    const chunk = interpretAgentLine(line)
    if (chunk == null) continue
    const text = read(chunk)
    if (text != null) answer += text
  }
  return answer
}

const delta = (text: string): string =>
  JSON.stringify({ type: 'stream_event', event: { delta: { text } } })
const assembled = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('createAgentTextReader', () => {
  // Observed live: the answer rendered as "OKOK" because Claude sends incremental
  // deltas and then the assembled message carrying the same text.
  it('ignores the assembled message when deltas already delivered the text', () => {
    expect(readAll([delta('O'), delta('K'), assembled('OK')])).toBe('OK')
  })

  it('falls back to the assembled message when no deltas arrive', () => {
    expect(readAll([assembled('Only the full message.')])).toBe('Only the full message.')
  })

  it('keeps plain non-JSON output, which is how Codex writes', () => {
    expect(readAll(['plain line'])).toBe('plain line\n')
  })

  it('ignores the result envelope so a summary is not appended twice', () => {
    const lines = [delta('done'), JSON.stringify({ type: 'result', result: 'done', is_error: false })]
    expect(readAll(lines)).toBe('done')
  })
})

describe('interpretAgentLine', () => {
  it('labels where text came from', () => {
    expect(interpretAgentLine(delta('a'))).toEqual({ kind: 'text', text: 'a', source: 'delta' })
    expect(interpretAgentLine(assembled('a'))).toEqual({ kind: 'text', text: 'a', source: 'message' })
  })

  it('reads the session id from the system envelope', () => {
    expect(interpretAgentLine(JSON.stringify({ type: 'system', session_id: 'abc' })))
      .toEqual({ kind: 'session', sessionId: 'abc' })
  })

  it('ignores blank lines and unparseable JSON', () => {
    expect(interpretAgentLine('   ')).toBeNull()
    expect(interpretAgentLine('{not json')).toBeNull()
  })
})

describe('parseAgentAskRequest', () => {
  const valid = {
    id: 'req-1',
    provider: 'claude' as const,
    model: 'sonnet',
    effort: 'high',
    accessMode: 'auto' as const,
    prompt: 'Explain',
    context: 'diff'
  }

  it('accepts a well-formed request', async () => {
    expect(await parseAgentAskRequest(valid)).toEqual(valid)
  })

  it('rejects an unknown provider', async () => {
    await expect(parseAgentAskRequest({ ...valid, provider: 'other' })).rejects.toThrow()
  })

  it('rejects an empty prompt', async () => {
    await expect(parseAgentAskRequest({ ...valid, prompt: '   ' })).rejects.toThrow()
  })

  it('rejects a session id that is not an opaque token', async () => {
    await expect(parseAgentAskRequest({ ...valid, resumeSessionId: '../etc/passwd' })).rejects.toThrow()
  })

  it('rejects a model value that can be parsed as another CLI option', async () => {
    await expect(parseAgentAskRequest({
      ...valid,
      model: '--dangerously-skip-permissions'
    })).rejects.toThrow('selected agent model')
  })
})

describe('activity reporting', () => {
  const toolUse = (name: string, input: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${name}`, name, input }] } })

  const activities = (line: string) => interpretAgentLine(line)?.activities

  it('names the file a read touched', () => {
    expect(activities(toolUse('Read', { file_path: '/repo/src/markdown.ts' })))
      .toEqual([{ id: 'tool-Read', kind: 'file', title: 'Read file', detail: '/repo/src/markdown.ts', status: 'running' }])
  })

  it('names the pattern a search used', () => {
    expect(activities(toolUse('Grep', { pattern: 'parseMarkdown' })))
      .toEqual([{ id: 'tool-Grep', kind: 'search', title: 'Search code', detail: 'parseMarkdown', status: 'running' }])
  })

  // The model can request a tool it was never granted; the request is denied, so
  // the activity line must not read as though it ran.
  it('allows sandboxed Bash for repository inspection but blocks write tools', () => {
    expect(activities(toolUse('Bash', { command: 'git diff --stat' })))
      .toEqual([{ id: 'tool-Bash', kind: 'command', title: 'Run command', detail: 'git diff --stat', status: 'running' }])
    expect(activities(toolUse('Write', { file_path: '/repo/a.ts' })))
      .toEqual([{ id: 'tool-Write', kind: 'tool', title: 'Write blocked', detail: 'Review mode is read-only.', status: 'blocked' }])
  })

  it('reads Claude result usage and cost', () => {
    const chunk = interpretAgentLine(JSON.stringify({
      type: 'result',
      result: 'done',
      is_error: false,
      duration_ms: 1200,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: { output_tokens_details: { thinking_tokens: 12 } },
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 10,
          costUSD: 0.0123,
          contextWindow: 200000
        }
      }
    }))
    expect(chunk?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 10,
      reasoningTokens: 12,
      totalTokens: 210,
      contextWindow: 200000,
      costUsd: 0.0123,
      durationMs: 1200,
      turns: 2,
      model: 'claude-sonnet-5'
    })
  })

  it('reports thinking as its own activity line', () => {
    expect(interpretAgentLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] }
    }))?.activities).toEqual([{
      id: 'claude-reasoning-0', kind: 'reasoning', title: 'Reasoning', detail: 'hmm', status: 'completed'
    }])
  })

  it('reports activity even when the same message also carries text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }, { type: 'text', text: 'hi' }] }
    })
    expect(interpretAgentLine(line)?.activities?.[0]).toMatchObject({
      kind: 'file', title: 'Read file', detail: 'a.ts', status: 'running'
    })
  })
})

// Captured from codex-cli 0.147.0: `codex exec --json --skip-git-repo-check -s read-only -`.
describe('Codex event stream', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"01a01423-3342-7402-a920-afbee94dbbd3"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will read the README."}}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/opt/homebrew/bin/bash -lc \\"sed -n \'1,240p\' README.md\\"","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/opt/homebrew/bin/bash -lc \\"sed -n \'1,240p\' README.md\\"","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"A local-first macOS diff app."}}',
    '{"type":"turn.completed","usage":{"input_tokens":37363,"output_tokens":115}}'
  ]

  it('reads the thread id as the resumable session', () => {
    expect(interpretAgentLine(lines[0]!))
      .toEqual({ kind: 'session', sessionId: '01a01423-3342-7402-a920-afbee94dbbd3' })
  })

  // Before this was handled, every Codex line parsed as JSON, matched no Claude
  // envelope, and returned null — the panel stayed completely empty.
  it('collects every agent message in the turn, in order', () => {
    const read = createAgentTextReader()
    let answer = ''
    for (const line of lines) {
      const chunk = interpretAgentLine(line)
      if (chunk == null) continue
      const text = read(chunk)
      if (text != null) answer += text
    }
    expect(answer).toBe('I will read the README.\n\nA local-first macOS diff app.\n\n')
  })

  it('reports a command as it starts, unwrapping the bash -lc shell', () => {
    expect(interpretAgentLine(lines[3]!)?.activity).toEqual({
      id: 'item_1', kind: 'command', title: 'Run command',
      detail: "sed -n '1,240p' README.md", status: 'running'
    })
  })

  it('marks the same command completed', () => {
    expect(interpretAgentLine(lines[4]!)?.activity).toMatchObject({ id: 'item_1', status: 'completed' })
  })

  it('ends the turn on turn.completed', () => {
    expect(interpretAgentLine(lines[6]!)).toEqual({ kind: 'result', text: '' })
  })

  it('surfaces a failed turn as a failure', () => {
    expect(interpretAgentLine('{"type":"turn.failed","error":{"message":"sandbox denied"}}'))
      .toEqual({ kind: 'result', text: 'sandbox denied', failed: true })
  })

  it('truncates a very long command instead of flooding the activity list', () => {
    const long = 'x'.repeat(200)
    const chunk = interpretAgentLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: long, status: 'in_progress' }
    }))
    expect(chunk?.activity?.detail?.length).toBeLessThan(80)
    expect(chunk?.activity?.detail?.endsWith('…')).toBe(true)
  })
})
