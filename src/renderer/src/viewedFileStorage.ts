import type { CodeViewItem } from '@pierre/diffs'

import { pathFromReviewItemId as pathFromItemId } from './reviewItems'

const STORAGE_PREFIX = 'better-code-diff:viewed-files:'
const MAX_SERIALIZED_BYTES = 256 * 1024

export type ViewedFileSignatures = Record<string, string>

export function viewedFileStorageKey(root: string, reviewIdentity: string): string {
  return `${STORAGE_PREFIX}${root}:${reviewIdentity}`
}

export function parseStoredViewedFiles(serialized: string | null): ViewedFileSignatures {
  if (serialized == null) return {}
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return {}
    const signatures: ViewedFileSignatures = {}
    for (const [path, signature] of Object.entries(parsed)) {
      if (path === '' || typeof signature !== 'string' || signature === '') continue
      signatures[path] = signature
    }
    return signatures
  } catch {
    return {}
  }
}

export function loadStoredViewedFiles(key: string): ViewedFileSignatures {
  try {
    return parseStoredViewedFiles(localStorage.getItem(key))
  } catch {
    return {}
  }
}

export function saveStoredViewedFiles(key: string, signatures: Readonly<ViewedFileSignatures>): void {
  try {
    if (Object.keys(signatures).length === 0) {
      localStorage.removeItem(key)
      return
    }
    const serialized = JSON.stringify(signatures)
    if (serialized.length > MAX_SERIALIZED_BYTES) return
    localStorage.setItem(key, serialized)
  } catch {
    // Persistence is best effort; viewed state still holds for the session.
  }
}

// A file marked viewed becomes unviewed again once its contents change.
export function dropChangedViewedFiles(
  signatures: Readonly<ViewedFileSignatures>,
  changedPaths: readonly string[]
): ViewedFileSignatures {
  let changed = false
  const next: ViewedFileSignatures = {}
  const dropped = new Set(changedPaths)
  for (const [path, signature] of Object.entries(signatures)) {
    if (dropped.has(path)) {
      changed = true
      continue
    }
    next[path] = signature
  }
  return changed ? next : signatures
}

// Patch cache keys carry the load timestamp, so they cannot identify content.
// Git object IDs identify it exactly; patch line counts approximate it otherwise.
export function reviewFileSignature<Metadata>(item: CodeViewItem<Metadata>): string {
  if (item.type === 'file') return item.file.cacheKey ?? `contents:${item.file.contents.length}`
  const { fileDiff } = item
  if (fileDiff.newObjectId != null) return `${fileDiff.prevObjectId ?? 'none'}..${fileDiff.newObjectId}`
  return `${fileDiff.type}:${fileDiff.additionLines.length}:${fileDiff.deletionLines.length}`
}

export function markViewedFile<Metadata>(
  signatures: Readonly<ViewedFileSignatures>,
  item: CodeViewItem<Metadata>
): ViewedFileSignatures {
  return { ...signatures, [pathFromItemId(item.id)]: reviewFileSignature(item) }
}

// Content can change while the review is closed, which leaves a stored
// signature behind that no longer describes the file on disk.
export function findStaleViewedPaths<Metadata>(
  signatures: Readonly<ViewedFileSignatures>,
  items: readonly CodeViewItem<Metadata>[]
): string[] {
  const stalePaths: string[] = []
  for (const item of items) {
    const path = pathFromItemId(item.id)
    const signature = signatures[path]
    if (signature != null && signature !== reviewFileSignature(item)) stalePaths.push(path)
  }
  return stalePaths
}
