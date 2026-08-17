import { describe, expect, it } from 'bun:test'

import { getEditorThemeType } from './preferences'

describe('getEditorThemeType', () => {
  it('classifies bundled light and dark themes', () => {
    expect(getEditorThemeType('pierre-light')).toBe('light')
    expect(getEditorThemeType('light-plus')).toBe('light')
    expect(getEditorThemeType('pierre-dark-soft')).toBe('dark')
  })
})
