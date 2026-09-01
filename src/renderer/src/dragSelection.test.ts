import { describe, expect, test } from 'bun:test'

import { findClosestDragLine, type DragLineGeometry } from './dragSelection'

const lines: DragLineGeometry[] = [
  { index: 10, lineNumber: 100, top: 0, bottom: 20 },
  { index: 11, lineNumber: 101, top: 20, bottom: 60 },
  { index: 14, lineNumber: 104, top: 60, bottom: 80 }
]

describe('findClosestDragLine', () => {
  test('finds the nearest line center with a binary search', () => {
    expect(findClosestDragLine(lines, 4)).toMatchObject({ index: 10, lineNumber: 100 })
    expect(findClosestDragLine(lines, 35)).toMatchObject({ index: 11, lineNumber: 101 })
    expect(findClosestDragLine(lines, 76)).toMatchObject({ index: 14, lineNumber: 104 })
  })

  test('clamps outside the measured range and handles an empty cache', () => {
    expect(findClosestDragLine(lines, -100)?.index).toBe(10)
    expect(findClosestDragLine(lines, 500)?.index).toBe(14)
    expect(findClosestDragLine([], 10)).toBeNull()
  })
})
