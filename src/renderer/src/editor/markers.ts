import type { Range } from '@pierre/diffs/edit'

import type { ContentSearchResult } from '../../../shared/contracts'

// @pierre/diffs does not export `Marker` from a public entry point, so the shape
// is mirrored here; `Editor.setMarkers` accepts it structurally.
export interface EditorMarker extends Range {
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string | { html: string } | HTMLElement
  source?: string
  metadata?: Record<string, unknown>
}

/**
 * A marker source. Providers are pure: they map application state for one path
 * to the markers the editor should show, so a new source is a function plus a
 * unit test rather than another effect wired into the surface.
 */
export interface MarkerProvider<TInput> {
  id: string
  toMarkers(input: TInput, path: string): EditorMarker[]
}

// Ripgrep reports one-based lines and columns; editor ranges are zero-based.
function toMarkerRange(result: ContentSearchResult, length: number): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  const line = Math.max(0, result.line - 1)
  const character = Math.max(0, result.column - 1)
  return {
    start: { line, character },
    end: { line, character: character + length }
  }
}

export function contentSearchMarkers(
  results: readonly ContentSearchResult[],
  path: string,
  query: string
): EditorMarker[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const markers: EditorMarker[] = []
  for (const result of results) {
    if (result.path !== path) continue
    markers.push({
      ...toMarkerRange(result, trimmed.length),
      severity: 'hint',
      message: result.preview.trim(),
      source: 'search',
      metadata: { query: trimmed }
    })
  }
  return markers
}

export const searchMarkerProvider: MarkerProvider<{
  results: readonly ContentSearchResult[]
  query: string
}> = {
  id: 'search',
  toMarkers: (input, path) => contentSearchMarkers(input.results, path, input.query)
}

export function markersEqual(left: readonly EditorMarker[], right: readonly EditorMarker[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((marker, index) => {
    const other = right[index]
    if (other == null) return false
    return marker.severity === other.severity
      && marker.message === other.message
      && marker.source === other.source
      && marker.start.line === other.start.line
      && marker.start.character === other.start.character
      && marker.end.line === other.end.line
      && marker.end.character === other.end.character
  })
}
