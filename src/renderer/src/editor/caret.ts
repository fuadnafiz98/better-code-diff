import type { EditorSelection } from '@pierre/diffs'

export interface CaretReadout {
  line: number
  column: number
  selectedLines: number
  selectedCharacters: number
}

export const EMPTY_CARET: CaretReadout = { line: 1, column: 1, selectedLines: 0, selectedCharacters: 0 }

/**
 * Ln/Col and selection size for the status bar. Editor positions are zero-based
 * and the readout is one-based, and the primary selection is the last one so a
 * multi-cursor edit reports where the user is actually typing.
 */
export function caretFromSelections(selections: readonly EditorSelection[] | undefined): CaretReadout {
  const primary = selections?.at(-1)
  if (primary == null) return EMPTY_CARET
  const { start, end } = primary
  const spansLines = end.line !== start.line
  const selectedCharacters = spansLines ? 0 : Math.abs(end.character - start.character)
  return {
    line: end.line + 1,
    column: end.character + 1,
    selectedLines: spansLines ? end.line - start.line + 1 : 0,
    selectedCharacters
  }
}

export function readCaret(editor: { getState(): { selections?: EditorSelection[] } } | null): CaretReadout {
  return caretFromSelections(editor?.getState().selections)
}
