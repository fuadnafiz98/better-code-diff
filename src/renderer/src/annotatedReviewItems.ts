import type { CodeViewItem, CodeViewLineSelection } from '@pierre/diffs'

import type { RemoteReviewThread } from '../../shared/contracts'
import { createDiffAnnotation, createFileAnnotation } from './reviewAnnotations'
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { pathFromReviewItemId as pathFromItemId } from './reviewItems'
import type { DraftReviewComment } from './useReviewThreads'

export interface AnnotatedReviewItemCacheEntry {
  baseItem: CodeViewItem<ReviewAnnotationMetadata>
  signature: string
  item: CodeViewItem<ReviewAnnotationMetadata>
}

export type AnnotatedReviewItemCache = Map<string, AnnotatedReviewItemCacheEntry>

interface DeriveAnnotatedReviewItemsOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  threadsByPath: Readonly<Record<string, ReviewThread[]>>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  draftComment: DraftReviewComment | null
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  collapsedItemIds: ReadonlySet<string>
  annotationVersions: Readonly<Record<string, number>>
  previousCache: AnnotatedReviewItemCache
}

interface AnnotatedReviewItemDerivation {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  cache: AnnotatedReviewItemCache
}

export interface AnnotatedReviewItemMutations {
  additions: CodeViewItem<ReviewAnnotationMetadata>[]
  updates: CodeViewItem<ReviewAnnotationMetadata>[]
  nextItems: ReadonlyMap<string, CodeViewItem<ReviewAnnotationMetadata>>
}

export function planAnnotatedReviewItemMutations(
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[],
  previousItems: ReadonlyMap<string, CodeViewItem<ReviewAnnotationMetadata>>,
  hasItem: (id: string) => boolean
): AnnotatedReviewItemMutations {
  const additions: CodeViewItem<ReviewAnnotationMetadata>[] = []
  const updates: CodeViewItem<ReviewAnnotationMetadata>[] = []
  const nextItems = new Map<string, CodeViewItem<ReviewAnnotationMetadata>>()

  for (const item of items) {
    nextItems.set(item.id, item)
    if (!hasItem(item.id)) additions.push(item)
    else if (previousItems.get(item.id) !== item) updates.push(item)
  }

  return { additions, updates, nextItems }
}

export function deriveAnnotatedReviewItems({
  items,
  threadsByPath,
  remoteThreadsByPath,
  draftComment,
  pendingSelection,
  collapsedItemIds,
  annotationVersions,
  previousCache
}: DeriveAnnotatedReviewItemsOptions): AnnotatedReviewItemDerivation {
  const nextCache: AnnotatedReviewItemCache = new Map()
  const nextItems = items.map((baseItem) => {
    const path = pathFromItemId(baseItem.id)
    const threads = threadsByPath[path] ?? []
    const remoteThreads = remoteThreadsByPath.get(path) ?? []
    const draftRange = draftComment?.path === path ? draftComment.range : null
    const selectionRange = draftComment == null && pendingSelection?.id === baseItem.id
      ? pendingSelection.range
      : null
    const collapsed = collapsedItemIds.has(baseItem.id)
    const signature = JSON.stringify([
      threads,
      remoteThreads,
      draftRange,
      selectionRange,
      collapsed,
      annotationVersions[path] ?? 0
    ])
    const previous = previousCache.get(baseItem.id)
    if (previous?.baseItem === baseItem && previous.signature === signature) {
      nextCache.set(baseItem.id, previous)
      return previous.item
    }

    const metadata: ReviewAnnotationMetadata[] = [
      ...remoteThreads.map((thread) => ({ kind: 'remote' as const, thread })),
      ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
      ...(draftRange == null ? [] : [{ kind: 'draft' as const, range: draftRange }]),
      ...(selectionRange == null ? [] : [{ kind: 'selection' as const, range: selectionRange }])
    ]
    const annotations = baseItem.type === 'diff'
      ? metadata.map(createDiffAnnotation)
      : metadata.map(createFileAnnotation)
    let remoteVersion = remoteThreads.length * 10_000_000
    for (const remoteThread of remoteThreads) {
      remoteVersion += remoteThread.comments.length * 1_000 + (remoteThread.resolved ? 1 : 0)
    }
    const draftVersion = draftRange != null
      ? 1_000_000 + draftRange.start * 1_000 + draftRange.end
      : selectionRange != null
        ? 2_000_000 + selectionRange.start * 1_000 + selectionRange.end
        : 0
    const item = {
      ...baseItem,
      annotations,
      collapsed,
      version: (annotationVersions[path] ?? 0) + draftVersion + remoteVersion
    } as CodeViewItem<ReviewAnnotationMetadata>
    nextCache.set(baseItem.id, { baseItem, signature, item })
    return item
  })

  return { items: nextItems, cache: nextCache }
}
