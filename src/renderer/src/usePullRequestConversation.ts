import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PullRequestConversation, RemoteReviewThread, RepositoryReview } from '../../shared/contracts'
import { getErrorMessage } from './repositoryApi'

const CONVERSATION_POLL_INTERVAL_MS = 15_000

interface PullRequestConversationApi {
  conversation: PullRequestConversation | null
  threadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingThreadId: string | null
  reply(threadId: string, body: string): void
  setResolved(threadId: string, resolved: boolean): void
  refresh(): void
}

export function sameConversation(
  current: PullRequestConversation | null,
  next: PullRequestConversation
): boolean {
  if (current == null) return false
  if (current.available !== next.available || current.message !== next.message) return false
  if (current.body !== next.body) return false
  if (current.threads.length !== next.threads.length) return false
  if (current.reviews.length !== next.reviews.length) return false
  for (let index = 0; index < current.threads.length; index += 1) {
    const currentThread = current.threads[index]!
    const nextThread = next.threads[index]!
    if (currentThread.id !== nextThread.id) return false
    if (currentThread.resolved !== nextThread.resolved) return false
    if (currentThread.outdated !== nextThread.outdated) return false
    if (currentThread.line !== nextThread.line) return false
    if (currentThread.comments.length !== nextThread.comments.length) return false
    for (let commentIndex = 0; commentIndex < currentThread.comments.length; commentIndex += 1) {
      const currentComment = currentThread.comments[commentIndex]!
      const nextComment = nextThread.comments[commentIndex]!
      if (currentComment.id !== nextComment.id || currentComment.body !== nextComment.body) return false
    }
  }
  for (let index = 0; index < current.reviews.length; index += 1) {
    const currentReview = current.reviews[index]!
    const nextReview = next.reviews[index]!
    if (currentReview.id !== nextReview.id || currentReview.state !== nextReview.state) return false
  }
  return true
}

export function groupRemoteThreadsByPath(
  threads: readonly RemoteReviewThread[]
): Map<string, RemoteReviewThread[]> {
  const byPath = new Map<string, RemoteReviewThread[]>()
  for (const thread of threads) {
    const existing = byPath.get(thread.path)
    if (existing == null) byPath.set(thread.path, [thread])
    else existing.push(thread)
  }
  return byPath
}

// GitHub is the source of truth for other people's comments, so an open review
// re-reads the conversation on a timer and after every write of our own.
export function usePullRequestConversation(
  repositoryReview: RepositoryReview | null,
  onError: (message: string | null) => void
): PullRequestConversationApi {
  const selector = repositoryReview?.kind === 'github' ? repositoryReview.selector : null
  const [conversation, setConversation] = useState<PullRequestConversation | null>(null)
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    if (selector == null) {
      setConversation(null)
      return
    }
    let cancelled = false
    let loading = false
    const load = async (): Promise<void> => {
      const repository = window.repository
      if (repository == null || loading) return
      loading = true
      try {
        const next = await repository.getPullRequestConversation(selector)
        if (cancelled) return
        // An unchanged conversation must keep its identity, or every poll would
        // rebuild every annotated review item.
        setConversation((current) => sameConversation(current, next) ? current : next)
      } finally {
        loading = false
      }
    }
    const tick = (): void => {
      if (document.hidden) return
      void load()
    }
    void load()
    const timer = window.setInterval(tick, CONVERSATION_POLL_INTERVAL_MS)
    // A hidden window must not keep spawning GitHub reads; returning focus
    // catches up immediately instead of waiting out the interval.
    const handleVisibility = (): void => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshRevision, selector])

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), [])

  const runThreadAction = useCallback(async (
    threadId: string,
    action: (repository: NonNullable<typeof window.repository>) => Promise<void>
  ) => {
    const repository = window.repository
    if (repository == null) return
    setPendingThreadId(threadId)
    try {
      await action(repository)
      setRefreshRevision((revision) => revision + 1)
    } catch (error) {
      onErrorRef.current(getErrorMessage(error))
    } finally {
      setPendingThreadId(null)
    }
  }, [])

  const reply = useCallback((threadId: string, body: string) => {
    void runThreadAction(threadId, (repository) => repository.replyToPullRequestThread(threadId, body))
  }, [runThreadAction])

  const setResolved = useCallback((threadId: string, resolved: boolean) => {
    void runThreadAction(threadId, (repository) => repository.setPullRequestThreadResolved(threadId, resolved))
  }, [runThreadAction])

  const threadsByPath = useMemo(
    () => groupRemoteThreadsByPath(conversation?.threads ?? []),
    [conversation]
  )

  return { conversation, threadsByPath, pendingThreadId, reply, setResolved, refresh }
}
