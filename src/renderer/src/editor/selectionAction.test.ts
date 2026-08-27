import { describe, expect, test } from 'bun:test'

import { selectionLineRange } from './selectionAction'

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  }
}

describe('selectionLineRange', () => {
  test('converts a single-line selection to one-based lines', () => {
    expect(selectionLineRange(range(0, 2, 0, 8))).toEqual({ startLine: 1, endLine: 1 })
  })

  test('includes the last line when the selection reaches into it', () => {
    expect(selectionLineRange(range(4, 0, 6, 3))).toEqual({ startLine: 5, endLine: 7 })
  })

  test('excludes a trailing line the selection only touched at character zero', () => {
    expect(selectionLineRange(range(4, 0, 6, 0))).toEqual({ startLine: 5, endLine: 6 })
  })

  test('keeps a caret-only selection on its own line', () => {
    expect(selectionLineRange(range(9, 0, 9, 0))).toEqual({ startLine: 10, endLine: 10 })
  })
})
