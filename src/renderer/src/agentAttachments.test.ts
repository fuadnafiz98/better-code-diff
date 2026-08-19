import { describe, expect, it } from 'bun:test'

import {
  agentAttachmentId,
  describeAgentAttachments,
  formatAgentAttachment,
  mergeAgentAttachments,
  type AgentAttachment
} from './agentAttachments'

const at = (path: string, startLine: number, endLine: number): AgentAttachment =>
  ({ path, startLine, endLine })

describe('formatAgentAttachment', () => {
  it('shows just the file name and the line range', () => {
    expect(formatAgentAttachment(at('src/renderer/src/markdown.ts', 108, 118)))
      .toBe('markdown.ts:108-118')
  })

  it('collapses a single-line range', () => {
    expect(formatAgentAttachment(at('src/a.ts', 42, 42))).toBe('a.ts:42')
  })
})

describe('mergeAgentAttachments', () => {
  it('keeps selections from different files side by side', () => {
    const merged = mergeAgentAttachments([at('a.ts', 1, 5)], at('b.ts', 2, 3))
    expect(merged.map(agentAttachmentId)).toEqual(['a.ts:1-5', 'b.ts:2-3'])
  })

  it('absorbs an overlapping range in the same file instead of stacking', () => {
    const merged = mergeAgentAttachments([at('a.ts', 10, 20)], at('a.ts', 15, 30))
    expect(merged.map(agentAttachmentId)).toEqual(['a.ts:10-30'])
  })

  it('is idempotent when the same selection is attached twice', () => {
    const once = mergeAgentAttachments([], at('a.ts', 3, 9))
    expect(mergeAgentAttachments(once, at('a.ts', 3, 9)).map(agentAttachmentId)).toEqual(['a.ts:3-9'])
  })

  it('keeps a non-overlapping range in the same file separate', () => {
    const merged = mergeAgentAttachments([at('a.ts', 1, 4)], at('a.ts', 40, 44))
    expect(merged.map(agentAttachmentId)).toEqual(['a.ts:1-4', 'a.ts:40-44'])
  })
})

describe('describeAgentAttachments', () => {
  it('returns the prompt untouched when nothing is attached', () => {
    expect(describeAgentAttachments([], 'why?')).toBe('why?')
  })

  it('names the full path and range so the agent can read exactly that region', () => {
    const described = describeAgentAttachments([at('src/a.ts', 108, 118)], 'walk me through this')
    expect(described).toContain('src/a.ts lines 108-118')
    expect(described.endsWith('walk me through this')).toBe(true)
  })

  it('writes a single-line selection as one line', () => {
    expect(describeAgentAttachments([at('src/a.ts', 7, 7)], 'why?')).toContain('src/a.ts line 7')
  })
})
