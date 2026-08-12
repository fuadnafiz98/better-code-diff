import { describe, expect, it } from 'bun:test'

import { formatReviewCommentsForAgent } from './ReviewSummary'

describe('formatReviewCommentsForAgent', () => {
  it('includes file, selected range, body, and replies', () => {
    const prompt = formatReviewCommentsForAgent([{
      path: 'src/app.ts',
      thread: {
        id: 'thread-1',
        body: 'Handle the error explicitly.',
        lineNumber: 8,
        side: 'additions',
        range: { start: 8, end: 10, side: 'additions' },
        replies: [{ id: 'reply-1', body: 'Preserve the original cause.' }],
        resolved: false
      }
    }])

    expect(prompt).toContain('src/app.ts — Lines 8–10 · new')
    expect(prompt).toContain('Handle the error explicitly.')
    expect(prompt).toContain('Reply: Preserve the original cause.')
  })
})
