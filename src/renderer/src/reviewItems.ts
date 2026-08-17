import type { CodeViewItem } from '@pierre/diffs'

export function mergeReviewItems<Metadata>(
  currentItems: readonly CodeViewItem<Metadata>[],
  incomingItems: readonly CodeViewItem<Metadata>[]
): CodeViewItem<Metadata>[] {
  const itemsById = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) itemsById.set(item.id, item)
  return [...itemsById.values()]
}

export interface ReviewItemPosition {
  id: string
  top: number
}

export function findActiveReviewItemId(
  scrollTop: number,
  positions: readonly ReviewItemPosition[],
  anchorOffset = 56
): string | null {
  const first = positions[0]
  if (first == null) return null
  const anchor = scrollTop + anchorOffset
  let activeId = first.id
  for (const position of positions) {
    if (position.top > anchor) break
    activeId = position.id
  }
  return activeId
}
