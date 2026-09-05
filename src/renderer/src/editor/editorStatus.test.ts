import { describe, expect, test } from 'bun:test'

import { EMPTY_CARET } from './caret'
import { caretSelectionLabel, editorStatusLabel } from './editorStatus'

describe('editorStatusLabel', () => {
  test('editing and draft preview ignore the document view', () => {
    expect(editorStatusLabel('edit', 'preview')).toBe('Editing')
    expect(editorStatusLabel('preview', 'source')).toBe('Draft preview')
  })

  test('read mode names the document view', () => {
    expect(editorStatusLabel('read', 'preview')).toBe('Preview')
    expect(editorStatusLabel('read', 'split')).toBe('Source and preview')
    expect(editorStatusLabel('read', 'source')).toBe('Read only')
  })
})

describe('caretSelectionLabel', () => {
  test('lines win over characters', () => {
    expect(caretSelectionLabel({ ...EMPTY_CARET, selectedLines: 3, selectedCharacters: 40 }))
      .toBe('3 lines selected')
  })

  test('characters report on their own', () => {
    expect(caretSelectionLabel({ ...EMPTY_CARET, selectedCharacters: 12 })).toBe('12 selected')
  })

  test('nothing selected reports nothing', () => {
    expect(caretSelectionLabel(EMPTY_CARET)).toBeNull()
  })
})
