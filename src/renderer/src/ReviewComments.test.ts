import { describe, expect, test } from 'bun:test'

import { formatCompactSelectedRange, formatSelectedRange } from './ReviewComments'

describe('review selection range labels', () => {
  test('keeps the full range for accessible context', () => {
    expect(formatSelectedRange({ start: 379, end: 378, side: 'deletions' }))
      .toBe('Lines 378–379 · old')
  })

  test('uses a compact visual range in the action bar', () => {
    expect(formatCompactSelectedRange({ start: 379, end: 378, side: 'deletions' }))
      .toBe('378–379 · old')
    expect(formatCompactSelectedRange({ start: 42, end: 42, side: 'additions' }))
      .toBe('42 · new')
  })
})
