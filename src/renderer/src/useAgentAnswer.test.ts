import { describe, expect, it } from 'bun:test'

import { mergeActivity } from './useAgentAnswer'

describe('mergeActivity', () => {
  it('keeps one item while its lifecycle and output stream update', () => {
    const started = mergeActivity([], {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      detail: 'bun test',
      status: 'running'
    })
    const withOutput = mergeActivity(started, {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      output: '12 tests passed',
      status: 'running',
      append: 'output'
    })
    const completed = mergeActivity(withOutput, {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      status: 'completed'
    })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      detail: 'bun test',
      output: '12 tests passed',
      status: 'completed'
    })
    expect(completed[0]?.startedAt).toBeNumber()
    expect(completed[0]?.completedAt).toBeNumber()
  })

  it('appends streamed reasoning summaries', () => {
    const first = mergeActivity([], {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Reasoning',
      detail: 'Inspecting ',
      status: 'running',
      append: 'detail'
    })
    const second = mergeActivity(first, {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Reasoning',
      detail: 'callers',
      status: 'running',
      append: 'detail'
    })

    expect(second[0]?.detail).toBe('Inspecting callers')
  })

  it('preserves a useful tool title when a result update has none', () => {
    const result = mergeActivity([{
      id: 'tool-1',
      kind: 'file',
      title: 'Read file',
      detail: 'src/App.tsx',
      status: 'running'
    }], {
      id: 'tool-1',
      kind: 'tool',
      title: '',
      output: 'ok',
      status: 'completed'
    })

    expect(result[0]).toMatchObject({
      kind: 'file', title: 'Read file', detail: 'src/App.tsx', status: 'completed'
    })
  })
})
