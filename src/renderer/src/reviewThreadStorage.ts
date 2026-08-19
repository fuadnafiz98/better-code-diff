import type { ReviewThread } from './ReviewComments'

const STORAGE_PREFIX = 'better-code-diff:review-threads:'
const MAX_SERIALIZED_BYTES = 512 * 1024

export function reviewThreadStorageKey(root: string, reviewIdentity: string): string {
  return `${STORAGE_PREFIX}${root}:${reviewIdentity}`
}

function isReviewThread(value: unknown): value is ReviewThread {
  if (typeof value !== 'object' || value == null) return false
  const thread = value as Partial<ReviewThread>
  return typeof thread.id === 'string'
    && typeof thread.body === 'string'
    && typeof thread.lineNumber === 'number'
    && typeof thread.resolved === 'boolean'
    && Array.isArray(thread.replies)
    && typeof thread.range === 'object' && thread.range != null
}

export function parseStoredReviewThreads(serialized: string | null): Record<string, ReviewThread[]> {
  if (serialized == null) return {}
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return {}
    const threadsByPath: Record<string, ReviewThread[]> = {}
    for (const [path, threads] of Object.entries(parsed)) {
      if (!Array.isArray(threads)) continue
      const validThreads = threads.filter(isReviewThread)
      if (validThreads.length > 0) threadsByPath[path] = validThreads
    }
    return threadsByPath
  } catch {
    return {}
  }
}

export function loadStoredReviewThreads(key: string): Record<string, ReviewThread[]> {
  try {
    return parseStoredReviewThreads(localStorage.getItem(key))
  } catch {
    return {}
  }
}

export function saveStoredReviewThreads(
  key: string,
  threadsByPath: Readonly<Record<string, ReviewThread[]>>
): void {
  try {
    if (Object.values(threadsByPath).every((threads) => threads.length === 0)) {
      localStorage.removeItem(key)
      return
    }
    const serialized = JSON.stringify(threadsByPath)
    if (serialized.length > MAX_SERIALIZED_BYTES) return
    localStorage.setItem(key, serialized)
  } catch {
    // Persistence is best effort; drafts still live in memory for the session.
  }
}
