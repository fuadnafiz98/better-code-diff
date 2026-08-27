import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import type {
  FileComparison,
  RepositoryReview,
  RepositorySnapshot
} from '../../shared/contracts'
import { createComparisonCache } from './comparisonCache'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import type { WorkspaceView } from './AppView'

export interface ComparisonLoaderOptions {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  /** Supplies the reading order the prefetch follows. */
  repositoryReview: RepositoryReview | null
  onError(message: string | null): void
}

export interface ComparisonLoader {
  comparison: FileComparison | null
  loading: boolean
  /** Records a comparison the app produced itself, such as a saved edit. */
  save(comparison: FileComparison): void
  /** Drops cached entries for paths the watcher reported as changed. */
  invalidate(changedPaths: readonly string[]): void
  /** Re-reads the open file after the watcher reported it changed. */
  markRevision(revision: number): void
}

/**
 * Keeps the single-file view's comparison loaded, cached and warm. Navigating
 * back to a file used to re-read it from disk, re-hash it and re-parse the diff
 * every time; the watcher's `changedPaths` is precise enough to invalidate by
 * path, and HEAD moving invalidates everything at once.
 */
export function useComparisonLoader({
  snapshot,
  selectedPath,
  workspaceView,
  repositoryReview,
  onError
}: ComparisonLoaderOptions): ComparisonLoader {
  const [comparison, setComparison] = useState<FileComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const requestRef = useRef(0)
  const lastPathRef = useRef<string | null>(null)
  const [cache] = useState(createComparisonCache)

  const save = useCallback((nextComparison: FileComparison) => {
    cache.set(nextComparison)
    setComparison(nextComparison)
  }, [cache])

  const invalidate = useCallback((changedPaths: readonly string[]) => {
    cache.invalidate(changedPaths)
  }, [cache])

  // A commit, a branch switch or a checkout replaces the old side of every file at
  // once, and nothing reports that per path.
  const repositoryIdentity = snapshot == null
    ? null
    : `${snapshot.root}\0${snapshot.head ?? ''}\0${snapshot.branch ?? ''}`

  useEffect(() => {
    cache.clear()
  }, [cache, repositoryIdentity])

  useEffect(() => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    if (selectedPath == null) {
      setComparison(null)
      setLoading(false)
      return
    }
    // The review keeps the current comparison in memory. Clearing it made the
    // return trip render the empty state for a whole round trip, because the path
    // had not changed and so nothing marked the view as loading.
    if (workspaceView === 'multi') {
      setLoading(false)
      return
    }
    const pathChanged = lastPathRef.current !== selectedPath
    lastPathRef.current = selectedPath
    const cached = cache.get(selectedPath)
    if (cached != null) {
      setComparison(cached)
      setLoading(false)
      onError(null)
      return
    }
    if (pathChanged) setLoading(true)
    onError(null)
    void requireRepositoryApi()
      .getComparison(selectedPath)
      .then((nextComparison) => {
        cache.set(nextComparison)
        if (requestRef.current === requestId) setComparison(nextComparison)
      })
      .catch((comparisonError: unknown) => {
        if (requestRef.current === requestId) onError(getErrorMessage(comparisonError))
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false)
      })
  }, [cache, onError, revision, selectedPath, workspaceView])

  // The next file in the review is the one a reader asks for next, so it is fetched
  // while the main thread is idle rather than on the click.
  const prefetchNeighbours = useEffectEvent((path: string): void => {
    const reviewFiles = repositoryReview?.files
    const neighbourPaths = reviewFiles != null
      ? reviewFiles.map((file) => file.path)
      : snapshot?.kind === 'git' ? snapshot.statuses.map((status) => status.path) : null
    const index = neighbourPaths?.indexOf(path) ?? -1
    if (neighbourPaths == null || index < 0) return
    for (const neighbour of [neighbourPaths[index + 1], neighbourPaths[index - 1]]) {
      if (neighbour == null || cache.has(neighbour)) continue
      void requireRepositoryApi().getComparison(neighbour)
        .then((neighbourComparison) => cache.set(neighbourComparison))
        .catch(() => {
          // A neighbour that cannot be read is simply left uncached; navigating to
          // it for real is what surfaces the error.
        })
    }
  })

  useEffect(() => {
    if (selectedPath == null || workspaceView !== 'file') return
    const handle = window.requestIdleCallback(() => prefetchNeighbours(selectedPath))
    return () => window.cancelIdleCallback(handle)
  }, [selectedPath, workspaceView])

  return { comparison, loading, save, invalidate, markRevision: setRevision }
}
