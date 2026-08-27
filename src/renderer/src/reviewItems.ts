import { parseDiffFromFile, parsePatchFiles, type CodeViewItem } from '@pierre/diffs'

import type { FileComparison } from '../../shared/contracts'

export function reviewItemId(path: string): string {
  return `review:${path}`
}

export function pathFromReviewItemId(id: string): string {
  return id.startsWith('review:') ? id.slice('review:'.length) : id
}

export function createReviewItem<Metadata>(comparison: FileComparison): CodeViewItem<Metadata> | null {
  if (comparison.binary || comparison.oversized) return null

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return { id: reviewItemId(comparison.path), type: 'file', file: comparison.newFile }
  }

  if (comparison.oldFile == null && comparison.newFile == null) return null
  return {
    id: reviewItemId(comparison.path),
    type: 'diff',
    fileDiff: parseDiffFromFile(comparison.oldFile, comparison.newFile)
  }
}

export function createPatchReviewItems<Metadata>(patch: string, version: string): CodeViewItem<Metadata>[] {
  const seenPaths = new Set<string>()
  const items: CodeViewItem<Metadata>[] = []
  for (const parsedPatch of parsePatchFiles(patch, version)) {
    for (const fileDiff of parsedPatch.files) {
      if (seenPaths.has(fileDiff.name)) continue
      seenPaths.add(fileDiff.name)
      items.push({ id: reviewItemId(fileDiff.name), type: 'diff', fileDiff })
    }
  }
  return items
}

export function mergeReviewItems<Metadata>(
  currentItems: readonly CodeViewItem<Metadata>[],
  incomingItems: readonly CodeViewItem<Metadata>[]
): CodeViewItem<Metadata>[] {
  const itemsById = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) itemsById.set(item.id, item)
  return [...itemsById.values()]
}

// A path set that changed keeps whatever it still contains: the viewer reconciles
// the difference, where clearing the list first would have unmounted it.
export function retainReviewItems<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  paths: readonly string[]
): CodeViewItem<Metadata>[] {
  const visiblePaths = new Set(paths)
  return items.filter((item) => visiblePaths.has(pathFromReviewItemId(item.id)))
}

export function orderReviewItems<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  orderedPaths: readonly string[]
): CodeViewItem<Metadata>[] {
  const itemsByPath = new Map(items.map((item) => [pathFromReviewItemId(item.id), item]))
  const orderedItems = orderedPaths.flatMap((path) => {
    const item = itemsByPath.get(path)
    if (item == null) return []
    itemsByPath.delete(path)
    return [item]
  })
  return [...orderedItems, ...itemsByPath.values()]
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
