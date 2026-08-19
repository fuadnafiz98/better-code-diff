export const CONTENT_SEARCH_STABLE_QUERY_MS = 110

export function contentSearchDelay(previousQuery: string, nextQuery: string): number {
  const previousLength = previousQuery.trim().length
  const nextLength = nextQuery.trim().length
  if (nextLength < 2) return 0
  return nextLength - previousLength > 1 ? 0 : CONTENT_SEARCH_STABLE_QUERY_MS
}

interface QueryEvent {
  at: number
  query: string
}

export interface SearchScheduleResult {
  starts: number
  stableQueryDelay: number
}

export function simulateContentSearchSchedule(
  events: readonly QueryEvent[],
  delayForQuery: (previousQuery: string, nextQuery: string) => number
): SearchScheduleResult {
  let previousQuery = ''
  let pendingAt: number | null = null
  let starts = 0
  for (const event of events) {
    if (pendingAt != null && pendingAt <= event.at) starts += 1
    pendingAt = null
    const delay = delayForQuery(previousQuery, event.query)
    previousQuery = event.query
    if (event.query.trim().length >= 2) pendingAt = event.at + delay
  }
  if (pendingAt != null) starts += 1
  const lastEvent = events.at(-1)
  return {
    starts,
    stableQueryDelay: lastEvent == null ? 0 : delayForQuery(
      events.at(-2)?.query ?? '',
      lastEvent.query
    )
  }
}
