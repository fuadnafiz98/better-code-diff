import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeViewItem } from '@pierre/diffs'

import type { OmittedDiffFile, RepositoryChangeEvent, RepositoryReview } from '../../shared/contracts'
import { COMPARISON_FETCH_CONCURRENCY } from './diffWorkerConfig'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import {
  createPatchReviewItems,
  createReviewItem,
  mergeReviewItems,
  orderReviewItems,
  pathFromReviewItemId as pathFromItemId,
  reviewItemId as itemId
} from './reviewItems'
import { resetReviewFileMetrics, setLoadedReviewItemCount } from './reviewMetrics'

export interface ReviewLoadState {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  loadedPaths: Set<string>
  omittedFiles: OmittedDiffFile[]
  failedCount: number
  skippedCount: number
  paged: boolean
}

const EMPTY_LOAD_STATE: ReviewLoadState = {
  items: [],
  loadedPaths: new Set(),
  omittedFiles: [],
  failedCount: 0,
  skippedCount: 0,
  paged: false
}

export const FOLDER_REVIEW_PAGE_SIZE = 50

interface ReviewLoadStateOptions {
  pathsKey: string
  stablePaths: string[]
  repositoryReview: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
  onPathsReloaded(paths: readonly string[]): void
}

interface ReviewLoadStateApi {
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  loadMoreFiles(): void
}

export function useReviewLoadState({
  pathsKey,
  stablePaths,
  repositoryReview,
  repositoryChange,
  onPathsReloaded
}: ReviewLoadStateOptions): ReviewLoadStateApi {
  const loadedPathsKeyRef = useRef<string | null>(null)
  const loadedPageCountRef = useRef(0)
  const [loadState, setLoadState] = useState<ReviewLoadState>(EMPTY_LOAD_STATE)
  const [pagination, setPagination] = useState({ key: '', limit: FOLDER_REVIEW_PAGE_SIZE })
  const loadLimit = pagination.key === pathsKey ? pagination.limit : FOLDER_REVIEW_PAGE_SIZE
  const targetPathCount = loadState.paged
    ? Math.min(loadLimit, stablePaths.length)
    : stablePaths.length
  const loading = repositoryReview == null && loadState.loadedPaths.size < targetPathCount
  const loadMoreFiles = useCallback(() => {
    setPagination({ key: pathsKey, limit: loadLimit + FOLDER_REVIEW_PAGE_SIZE })
  }, [loadLimit, pathsKey])

  const externalReviewItems = useMemo<CodeViewItem<ReviewAnnotationMetadata>[] | null>(() => {
    if (repositoryReview == null) return null
    return orderReviewItems(createPatchReviewItems(
      repositoryReview.patch,
      repositoryReview.kind === 'github'
        ? `pr-${repositoryReview.pullRequest.number}-${repositoryReview.pullRequest.updatedAt}`
        : repositoryReview.id
    ), stablePaths)
  }, [repositoryReview, stablePaths])

  useEffect(() => {
    let cancelled = false
    if (externalReviewItems != null) {
      setLoadState({
        items: externalReviewItems,
        loadedPaths: new Set(stablePaths),
        omittedFiles: repositoryReview?.omittedFiles ?? [],
        failedCount: 0,
        skippedCount: Math.max(0, stablePaths.length - externalReviewItems.length),
        paged: false
      })
      return
    }
    const isNewPathSet = loadedPathsKeyRef.current !== pathsKey
    loadedPathsKeyRef.current = pathsKey
    if (isNewPathSet) {
      loadedPageCountRef.current = 0
      setLoadState(EMPTY_LOAD_STATE)
    }

    async function loadComparisons(): Promise<void> {
      const repository = window.repository
      if (repository == null) {
        setLoadState({
          ...EMPTY_LOAD_STATE,
          loadedPaths: new Set(stablePaths),
          failedCount: stablePaths.length
        })
        return
      }

      if (isNewPathSet) {
        try {
          const workingTreePatch = await repository.getWorkingTreePatch(stablePaths)
          if (cancelled) return
          const items = orderReviewItems(createPatchReviewItems<ReviewAnnotationMetadata>(
            workingTreePatch.patch,
            `working-tree-${Date.now()}`
          ), stablePaths)
          if (items.length > 0 || stablePaths.length === 0) {
            setLoadState({
              items,
              loadedPaths: new Set(stablePaths),
              omittedFiles: workingTreePatch.omittedFiles,
              failedCount: 0,
              skippedCount: Math.max(
                0,
                stablePaths.length - items.length - workingTreePatch.omittedFiles.length
              ),
              paged: false
            })
            return
          }
        } catch {
          // A plain folder has no Git patch. Load its files through the paged fallback below.
        }
      }

      const pageStart = loadedPageCountRef.current
      const pagedPaths = stablePaths.slice(pageStart, loadLimit)
      for (let start = 0; start < pagedPaths.length && !cancelled; start += COMPARISON_FETCH_CONCURRENCY) {
        const batchPaths = pagedPaths.slice(start, start + COMPARISON_FETCH_CONCURRENCY)
        const results = await Promise.all(batchPaths.map(async (path) => {
          try {
            const item = createReviewItem<ReviewAnnotationMetadata>(await repository.getComparison(path))
            return { path, item, failed: false }
          } catch {
            return { path, item: null, failed: true }
          }
        }))
        if (cancelled) return
        loadedPageCountRef.current = pageStart + start + batchPaths.length

        startTransition(() => {
          setLoadState((current) => {
            const loadedPaths = new Set(current.loadedPaths)
            const incomingItems: CodeViewItem<ReviewAnnotationMetadata>[] = []
            let failedCount = current.failedCount
            let skippedCount = current.skippedCount

            for (const result of results) {
              loadedPaths.add(result.path)
              if (result.failed) failedCount += 1
              else if (result.item == null) skippedCount += 1
              else incomingItems.push(result.item)
            }

            return {
              ...current,
              items: mergeReviewItems(current.items, incomingItems),
              loadedPaths,
              failedCount,
              skippedCount,
              paged: true
            }
          })
        })
      }
    }

    let loaded = false
    void loadComparisons().then(() => { loaded = true })
    return () => {
      cancelled = true
      // An interrupted first pass must not look like a completed one to the next run.
      if (isNewPathSet && !loaded) loadedPathsKeyRef.current = null
    }
  }, [externalReviewItems, loadLimit, pathsKey, repositoryReview, stablePaths])

  useEffect(() => {
    if (externalReviewItems != null || repositoryChange == null) return
    const visiblePaths = new Set(stablePaths)
    const pathsToReload = repositoryChange.changedPaths.filter((path) => visiblePaths.has(path))
    if (pathsToReload.length === 0) return
    let cancelled = false

    void (async () => {
      try {
        const workingTreePatch = await window.repository!.getWorkingTreePatch(pathsToReload)
        const patchItems = createPatchReviewItems<ReviewAnnotationMetadata>(
          workingTreePatch.patch,
          `working-tree-${repositoryChange.revision}`
        )
        const byPath = new Map(patchItems.map((item) => [pathFromItemId(item.id), item]))
        return pathsToReload.map((path) => ({ path, item: byPath.get(path) ?? null }))
      } catch {
        return Promise.all(pathsToReload.map(async (path) => {
          try {
            return { path, item: createReviewItem<ReviewAnnotationMetadata>(await window.repository!.getComparison(path)) }
          } catch {
            return { path, item: null }
          }
        }))
      }
    })().then((results) => {
      if (cancelled) return
      startTransition(() => {
        onPathsReloaded(results.map((result) => result.path))
        setLoadState((current) => {
          const replacements = new Map(results.map((result) => [itemId(result.path), result.item]))
          const nextItems = current.items.flatMap((item) => {
            if (!replacements.has(item.id)) return [item]
            const replacement = replacements.get(item.id)
            replacements.delete(item.id)
            return replacement == null ? [] : [replacement]
          })
          for (const replacement of replacements.values()) {
            if (replacement != null) nextItems.push(replacement)
          }
          return { ...current, items: orderReviewItems(mergeReviewItems([], nextItems), stablePaths) }
        })
      })
    })

    return () => { cancelled = true }
  }, [externalReviewItems, onPathsReloaded, repositoryChange, stablePaths])

  useEffect(() => {
    resetReviewFileMetrics()
    return resetReviewFileMetrics
  }, [])

  useEffect(() => {
    setLoadedReviewItemCount(loadState.items.length)
  }, [loadState.items])

  return { loadState, loading, targetPathCount, loadMoreFiles }
}
