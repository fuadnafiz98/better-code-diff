import type { DiffLineAnnotation, LineAnnotation } from '@pierre/diffs'

import type { ReviewAnnotationMetadata } from './ReviewComments'

export function annotationLine(metadata: ReviewAnnotationMetadata): number {
  // The action bar and the draft that can replace it anchor to the same line, so
  // the bar does not jump when a selection turns into a comment.
  if (metadata.kind === 'selection' || metadata.kind === 'draft') return metadata.range.end
  if (metadata.kind === 'remote') return metadata.thread.line ?? metadata.thread.startLine ?? 1
  return metadata.thread.lineNumber
}

export function annotationSide(metadata: ReviewAnnotationMetadata): 'additions' | 'deletions' {
  if (metadata.kind === 'selection' || metadata.kind === 'draft') return metadata.range.side ?? 'additions'
  if (metadata.kind === 'remote') return metadata.thread.side === 'LEFT' ? 'deletions' : 'additions'
  return metadata.thread.side ?? 'additions'
}

// The library's annotation types distribute over the metadata union, so the
// shared shape is cast once here instead of at every call site.
export function createDiffAnnotation(
  metadata: ReviewAnnotationMetadata
): DiffLineAnnotation<ReviewAnnotationMetadata> {
  return {
    lineNumber: annotationLine(metadata),
    side: annotationSide(metadata),
    metadata
  } as DiffLineAnnotation<ReviewAnnotationMetadata>
}

export function createFileAnnotation(
  metadata: ReviewAnnotationMetadata
): LineAnnotation<ReviewAnnotationMetadata> {
  return {
    lineNumber: annotationLine(metadata),
    metadata
  } as LineAnnotation<ReviewAnnotationMetadata>
}
