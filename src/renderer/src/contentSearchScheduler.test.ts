import { describe, expect, test } from 'bun:test'

import {
  CONTENT_SEARCH_STABLE_QUERY_MS,
  contentSearchDelay,
  simulateContentSearchSchedule
} from './contentSearchScheduler'

function typingEvents(interval: number): Array<{ at: number; query: string }> {
  const target = 'repository'
  return Array.from(target, (_, index) => ({
    at: index * interval,
    query: target.slice(0, index + 1)
  }))
}

describe('content search scheduling', () => {
  test('coalesces normal typing into one native search', () => {
    const previous = simulateContentSearchSchedule(typingEvents(90), () => 50)
    const optimized = simulateContentSearchSchedule(typingEvents(90), contentSearchDelay)
    expect(previous.starts).toBeGreaterThan(5)
    expect(optimized.starts).toBe(1)
    expect(optimized.stableQueryDelay).toBe(CONTENT_SEARCH_STABLE_QUERY_MS)
    expect(optimized.stableQueryDelay).toBeLessThan(200)
  })

  test('keeps fast typing coalesced and paste immediate', () => {
    expect(simulateContentSearchSchedule(typingEvents(35), contentSearchDelay).starts).toBe(1)
    expect(contentSearchDelay('', 'pasted query')).toBe(0)
  })

  test('does not schedule short or cleared queries', () => {
    const result = simulateContentSearchSchedule([
      { at: 0, query: 'a' },
      { at: 20, query: '' }
    ], contentSearchDelay)
    expect(result.starts).toBe(0)
  })
})
