import { describe, expect, it } from 'bun:test'

import { parseStoredReviewThreads, reviewThreadStorageKey } from './reviewThreadStorage'

const validThread = {
  id: 'thread-1',
  body: 'Rename this variable.',
  lineNumber: 4,
  range: { start: 4, end: 6 },
  replies: [],
  resolved: false
}

describe('reviewThreadStorageKey', () => {
  it('scopes keys by repository root and review identity', () => {
    expect(reviewThreadStorageKey('/repo', 'working-tree'))
      .toBe('better-code-diff:review-threads:/repo:working-tree')
    expect(reviewThreadStorageKey('/repo', 'github:https://github.com/a/b/pull/1'))
      .not.toBe(reviewThreadStorageKey('/repo', 'working-tree'))
  })
})

describe('parseStoredReviewThreads', () => {
  it('round-trips valid thread maps', () => {
    const stored = JSON.stringify({ 'src/a.ts': [validThread] })
    expect(parseStoredReviewThreads(stored)).toEqual({ 'src/a.ts': [validThread] })
  })

  it('returns an empty map for missing or corrupt payloads', () => {
    expect(parseStoredReviewThreads(null)).toEqual({})
    expect(parseStoredReviewThreads('not json')).toEqual({})
    expect(parseStoredReviewThreads('[1,2]')).toEqual({})
    expect(parseStoredReviewThreads('"text"')).toEqual({})
  })

  it('drops malformed threads while keeping valid ones', () => {
    const stored = JSON.stringify({
      'src/a.ts': [validThread, { id: 42, body: 'missing fields' }],
      'src/b.ts': [{ body: 'no id' }],
      'src/c.ts': 'not an array'
    })
    expect(parseStoredReviewThreads(stored)).toEqual({ 'src/a.ts': [validThread] })
  })
})
