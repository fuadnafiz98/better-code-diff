import { describe, expect, test } from 'bun:test'

import { contentSearchMarkers, markersEqual, searchMarkerProvider } from './markers'

const results = [
  { path: 'src/a.ts', line: 3, column: 5, preview: '  const value = 1  ' },
  { path: 'src/b.ts', line: 9, column: 1, preview: 'other file' }
]

describe('contentSearchMarkers', () => {
  test('keeps only the current file and converts to zero-based ranges', () => {
    const markers = contentSearchMarkers(results, 'src/a.ts', 'value')
    expect(markers).toHaveLength(1)
    expect(markers[0]?.start).toEqual({ line: 2, character: 4 })
    expect(markers[0]?.end).toEqual({ line: 2, character: 9 })
    expect(markers[0]?.severity).toBe('hint')
    expect(markers[0]?.message).toBe('const value = 1')
  })

  test('produces nothing for a blank query', () => {
    expect(contentSearchMarkers(results, 'src/a.ts', '   ')).toEqual([])
  })

  test('clamps one-based positions that would go negative', () => {
    const markers = contentSearchMarkers([{ path: 'a', line: 0, column: 0, preview: 'x' }], 'a', 'x')
    expect(markers[0]?.start).toEqual({ line: 0, character: 0 })
  })

  test('is reachable through the provider', () => {
    expect(searchMarkerProvider.id).toBe('search')
    expect(searchMarkerProvider.toMarkers({ results, query: 'value' }, 'src/a.ts')).toHaveLength(1)
  })
})

describe('markersEqual', () => {
  test('compares by content so unchanged results skip setMarkers', () => {
    const left = contentSearchMarkers(results, 'src/a.ts', 'value')
    const right = contentSearchMarkers(results, 'src/a.ts', 'value')
    expect(left).not.toBe(right)
    expect(markersEqual(left, right)).toBe(true)
    expect(markersEqual(left, [])).toBe(false)
    expect(markersEqual(left, contentSearchMarkers(results, 'src/a.ts', 'v'))).toBe(false)
  })
})
