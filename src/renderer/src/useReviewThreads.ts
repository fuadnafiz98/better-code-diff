import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { CodeViewItem, CodeViewLineSelection, SelectedLineRange } from '@pierre/diffs'

import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { pathFromReviewItemId as pathFromItemId } from './reviewItems'

export interface DraftReviewComment {
  path: string
  range: SelectedLineRange
}

export type UpdateReviewThread = (
  path: string,
  threadId: string,
  update: (thread: ReviewThread) => ReviewThread | null
) => void

function incrementItemVersions(
  current: Readonly<Record<string, number>>,
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
): Record<string, number> {
  const next = { ...current }
  for (const item of items) {
    const path = pathFromItemId(item.id)
    next[path] = (next[path] ?? 0) + 1
  }
  return next
}

interface ReviewThreadsOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
}

interface ReviewThreadsApi {
  selectedLines: CodeViewLineSelection | null
  draftComment: DraftReviewComment | null
  annotationVersions: Readonly<Record<string, number>>
  collapsedItemIds: ReadonlySet<string>
  bumpPathVersions(paths: readonly string[]): void
  toggleItemCollapsed(item: CodeViewItem<ReviewAnnotationMetadata>): void
  toggleCollapsedById(itemId: string): void
  setCollapsedById(itemId: string, collapsed: boolean): void
  collapseAllFiles(): void
  expandAllFiles(): void
  beginComment(selection: CodeViewLineSelection): void
  handleSelectedLinesChange(selection: CodeViewLineSelection | null): void
  saveComment(body: string): void
  cancelComment(): void
  updateThread: UpdateReviewThread
}

export function useReviewThreads({ items, setThreadsByPath }: ReviewThreadsOptions): ReviewThreadsApi {
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null)
  const [draftComment, setDraftComment] = useState<DraftReviewComment | null>(null)
  const [annotationVersions, setAnnotationVersions] = useState<Record<string, number>>({})
  const [collapsedItemIds, setCollapsedItemIds] = useState<Set<string>>(() => new Set())

  const bumpAnnotationVersion = useCallback((path: string) => {
    setAnnotationVersions((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1
    }))
  }, [])

  const bumpPathVersions = useCallback((paths: readonly string[]) => {
    setAnnotationVersions((current) => {
      const next = { ...current }
      for (const path of paths) next[path] = (next[path] ?? 0) + 1
      return next
    })
  }, [])

  const toggleCollapsedById = useCallback((itemId: string) => {
    setCollapsedItemIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
    bumpAnnotationVersion(pathFromItemId(itemId))
  }, [bumpAnnotationVersion])

  const setCollapsedById = useCallback((itemId: string, collapsed: boolean) => {
    setCollapsedItemIds((current) => {
      if (current.has(itemId) === collapsed) return current
      const next = new Set(current)
      if (collapsed) next.add(itemId)
      else next.delete(itemId)
      return next
    })
    bumpAnnotationVersion(pathFromItemId(itemId))
  }, [bumpAnnotationVersion])

  const toggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    toggleCollapsedById(item.id)
  }, [toggleCollapsedById])

  const collapseAllFiles = useCallback(() => {
    setCollapsedItemIds(new Set(items.map((item) => item.id)))
    setAnnotationVersions((current) => incrementItemVersions(current, items))
  }, [items])

  const expandAllFiles = useCallback(() => {
    setCollapsedItemIds(new Set())
    setAnnotationVersions((current) => incrementItemVersions(current, items))
  }, [items])

  const beginComment = useCallback((selection: CodeViewLineSelection) => {
    setSelectedLines(selection)
    setDraftComment({ path: pathFromItemId(selection.id), range: selection.range })
  }, [])

  const handleSelectedLinesChange = useCallback((selection: CodeViewLineSelection | null) => {
    setSelectedLines(selection)
  }, [])

  const saveComment = useCallback((body: string) => {
    if (draftComment == null) return
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: draftComment.range.start,
      side: draftComment.range.side,
      range: draftComment.range,
      replies: [],
      resolved: false
    }
    setThreadsByPath((current) => ({
      ...current,
      [draftComment.path]: [...(current[draftComment.path] ?? []), thread]
    }))
    bumpAnnotationVersion(draftComment.path)
    setDraftComment(null)
  }, [bumpAnnotationVersion, draftComment, setThreadsByPath])

  const cancelComment = useCallback(() => {
    setDraftComment(null)
    setSelectedLines(null)
  }, [])

  const updateThread = useCallback<UpdateReviewThread>((path, threadId, update) => {
    setThreadsByPath((current) => ({
      ...current,
      [path]: (current[path] ?? []).flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const nextThread = update(thread)
        return nextThread == null ? [] : [nextThread]
      })
    }))
    bumpAnnotationVersion(path)
  }, [bumpAnnotationVersion, setThreadsByPath])

  return {
    selectedLines,
    draftComment,
    annotationVersions,
    collapsedItemIds,
    bumpPathVersions,
    toggleItemCollapsed,
    toggleCollapsedById,
    setCollapsedById,
    collapseAllFiles,
    expandAllFiles,
    beginComment,
    handleSelectedLinesChange,
    saveComment,
    cancelComment,
    updateThread
  }
}
