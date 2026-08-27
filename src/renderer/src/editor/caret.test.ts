import { describe, expect, test } from 'bun:test'

import { caretFromSelections, EMPTY_CARET, readCaret } from './caret'

function selection(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    direction: 1 as const
  }
}

describe('caretFromSelections', () => {
  test('reports one-based line and column at the selection end', () => {
    expect(caretFromSelections([selection(4, 7, 4, 7)])).toEqual({
      line: 5, column: 8, selectedLines: 0, selectedCharacters: 0
    })
  })

  test('counts characters inside a single line', () => {
    expect(caretFromSelections([selection(0, 2, 0, 9)]).selectedCharacters).toBe(7)
  })

  test('counts lines for a multi-line selection', () => {
    const caret = caretFromSelections([selection(2, 0, 5, 4)])
    expect(caret.selectedLines).toBe(4)
    expect(caret.selectedCharacters).toBe(0)
  })

  test('follows the last selection so multi-cursor reports the active caret', () => {
    expect(caretFromSelections([selection(0, 0, 0, 0), selection(9, 3, 9, 3)]).line).toBe(10)
  })

  test('falls back to the empty readout', () => {
    expect(caretFromSelections(undefined)).toEqual(EMPTY_CARET)
    expect(caretFromSelections([])).toEqual(EMPTY_CARET)
    expect(readCaret(null)).toEqual(EMPTY_CARET)
    expect(readCaret({ getState: () => ({}) })).toEqual(EMPTY_CARET)
  })
})
